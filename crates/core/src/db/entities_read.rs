//! Entity read facade (`entity/list`, `entity/backlinks`, review-context and
//! GTD relationship reads). SQL stays in [`queries`], matching the DB module's
//! one-statement query convention; this module owns the entity read shapes and
//! their batched enrichment (refs, person refs, provenance).

use std::collections::HashMap;

use sqlx::SqlitePool;
use uuid::Uuid;

use super::queries;
use crate::mutation::EntityType;

/// Parse a stored Canonical Entity's `data` JSON (tier-2 `entities.data` /
/// `entity_revisions.data`). A malformed value is a corrupt tier-2 row, not a
/// blank entity: log a `db.entity_data_parse_failed` Diagnostic Log event
/// (ADR-0038) and surface a loud `sqlx::Error::Decode` rather than degrading to
/// `Value::Null`. Mirrors `entity_type_by_id`'s loud-decode precedent.
fn parse_entity_data(entity_id: &str, raw: &str) -> sqlx::Result<serde_json::Value> {
    serde_json::from_str(raw).map_err(|e| {
        tracing::error!(event = "db.entity_data_parse_failed", entity_id, error = ?e);
        sqlx::Error::Decode(format!("entity {entity_id} data is malformed JSON: {e}").into())
    })
}

/// One accepted Entity for `entity/list`. `data` is parsed from the stored
/// JSON; a malformed row now fails the read with a logged `sqlx::Error`
/// (`db.entity_data_parse_failed`, ADR-0038) rather than silently degrading to
/// `null`.
pub struct EntityRow {
    pub id: String,
    pub r#type: String,
    pub data: serde_json::Value,
    pub created_at: i64,
    pub updated_at: i64,
    pub refs: Vec<ResolvedEntityRef>,
    /// `(person_id, role)` pairs for a Todo row's Person References (ADR-0032).
    /// Empty for non-Todo rows and Todos with no references.
    pub person_refs: Vec<(String, String)>,
    /// The Entity's origin provenance (`created_from`, ADR-0030), or `None` for a
    /// user-authored Entity (a direct Library write records no source row). Backs
    /// the Inspector's "Captured from" footer.
    pub source: Option<EntityProvenance>,
}

/// The resolved origin of an Entity for the "Captured from" read (ADR-0030). One
/// of two shapes, mirroring the `entity_sources` CHECK (exactly one source kind):
/// a user Message (carrying the Thread to link back to) or a source Journal Entry.
pub enum EntityProvenance {
    /// `created_from` a user Message: link back to its Thread, plus the capturing
    /// message id so the Client can deep-link to the exact message (#184).
    Message {
        thread_id: String,
        thread_title: String,
        message_id: Option<String>,
    },
    /// `created_from` a source Entity (a Journal Entry): link to it in the Library.
    JournalEntry { journal_entry_id: String },
}

pub struct ResolvedEntityRef {
    pub id: String,
    pub source_entity_id: String,
    pub target_entity_id: String,
    pub target_entity_type: String,
    pub target_title: Option<String>,
    pub label_snapshot: Option<String>,
}

/// Read every accepted Entity of `entity_type` for `entity/list`, newest-first.
pub async fn list_by_type(pool: &SqlitePool, entity_type: &str) -> sqlx::Result<Vec<EntityRow>> {
    let rows = queries::list_by_type(pool, entity_type).await?;
    let mut rows = rows
        .into_iter()
        .map(|(id, r#type, data, created_at, updated_at)| {
            let data = parse_entity_data(&id, &data)?;
            Ok(EntityRow {
                id,
                r#type,
                data,
                created_at,
                updated_at,
                refs: Vec::new(),
                person_refs: Vec::new(),
                source: None,
            })
        })
        .collect::<sqlx::Result<Vec<_>>>()?;

    // Attach each row's origin provenance ("Captured from", ADR-0030), batched to
    // avoid an N+1 over the listed Entities.
    attach_provenance(pool, &mut rows).await?;

    // A Journal Entry row carries its outgoing refs; a Todo row carries its Person
    // References (ADR-0032), each batched. The same helpers back the targeted
    // `entity/backlinks` read so the row shapes can't drift.
    if entity_type == "journal_entry" {
        attach_journal_entry_refs(pool, &mut rows).await?;
    }
    if entity_type == "todo" {
        attach_person_refs(pool, &mut rows).await?;
    }

    Ok(rows)
}

async fn resolved_entity_refs_for_sources(
    pool: &SqlitePool,
    source_entity_ids: &[String],
) -> sqlx::Result<Vec<ResolvedEntityRef>> {
    let rows = queries::entity_refs_for_sources(pool, source_entity_ids).await?;
    rows.into_iter()
        .map(
            |(
                id,
                source_entity_id,
                target_entity_id,
                target_entity_type,
                target_data,
                label_snapshot,
            )| {
                let data = parse_entity_data(&target_entity_id, &target_data)?;
                Ok(ResolvedEntityRef {
                    id,
                    source_entity_id,
                    target_entity_id,
                    target_title: entity_title(&target_entity_type, &data),
                    target_entity_type,
                    label_snapshot,
                })
            },
        )
        .collect()
}

fn entity_title(entity_type: &str, data: &serde_json::Value) -> Option<String> {
    EntityType::from_str(entity_type)?.spec().reference_title_from_data(data)
}

/// The two reverse relation sets the detail Inspector reads for one Entity
/// (`entity/backlinks`, ADR-0050): the distinct Journal Entries that reference it
/// and the Todos linked to it. Both are full [`EntityRow`]s so the Web client
/// renders them through the existing entity codec.
pub struct Backlinks {
    /// DISTINCT Journal Entries referencing this Entity, newest-occurred first,
    /// each carrying its `refs` + `source` (the `entity/list` JE assembly).
    pub mentioned_in: Vec<EntityRow>,
    /// Todos linked to this Entity (Person → all `person_refs`; Project →
    /// `project_id`; Todo → none), newest-first, each carrying its `person_refs`.
    pub linked_todos: Vec<EntityRow>,
}

/// Resolve the backlinks for a Person, Project, or Todo (ADR-0050). A narrow
/// per-entity read fired on detail-open — it does NOT fatten `entity/list` rows
/// (ADR-0032's pattern) nor resolve the joined Person→Projects / Project→People /
/// Progress derivations (those stay client-side). An entity of any other type (or
/// an absent id) simply yields empty sets.
pub async fn backlinks_for_entity(pool: &SqlitePool, entity_id: &str) -> sqlx::Result<Backlinks> {
    let mentioned_in = mentioned_in_journal_entries(pool, entity_id).await?;

    // `linked_todos` dispatches on the target's Entity Type: a Person's Todos
    // (all roles), a Project's Todos, and nothing for a Todo (it is Mentioned-in
    // only). An unknown / absent target yields no linked Todos.
    let linked_todos = match entity_type_by_id(pool, entity_id).await? {
        Some(crate::mutation::EntityType::Person) => {
            let mut rows = todos_by_person(pool, entity_id, None).await?;
            attach_person_refs(pool, &mut rows).await?;
            rows
        }
        Some(crate::mutation::EntityType::Project) => {
            let mut rows = todos_by_project(pool, entity_id).await?;
            attach_person_refs(pool, &mut rows).await?;
            rows
        }
        _ => Vec::new(),
    };

    Ok(Backlinks {
        mentioned_in,
        linked_todos,
    })
}

/// Build the DISTINCT-Journal-Entry "Mentioned in" set for `target_entity_id`,
/// reusing the `entity/list` JE-row assembly so each row carries its `refs` +
/// `source`. `journal_entry_refs_targeting` returns one row per `entity_ref`; the
/// `(source_entity_id, target_entity_id)` UNIQUE constraint already caps that at
/// one row per JE for a given target, but the collapse is kept so a JE can never
/// list twice. Ordered newest-occurred first by the JE's `data.occurred_at` (an
/// ISO-8601 string, so lexical order is chronological), tie-broken by JE id.
async fn mentioned_in_journal_entries(
    pool: &SqlitePool,
    target_entity_id: &str,
) -> sqlx::Result<Vec<EntityRow>> {
    let refs = queries::journal_entry_refs_targeting(pool, target_entity_id).await?;
    let mut je_ids = Vec::<String>::new();
    for (_ref_id, source_entity_id, _source_data, _label) in &refs {
        if !je_ids.contains(source_entity_id) {
            je_ids.push(source_entity_id.clone());
        }
    }

    let mut rows = queries::journal_entries_by_ids(pool, &je_ids)
        .await?
        .into_iter()
        .map(|(id, data, created_at, updated_at)| {
            let data = parse_entity_data(&id, &data)?;
            Ok(EntityRow {
                id,
                r#type: "journal_entry".to_string(),
                data,
                created_at,
                updated_at,
                refs: Vec::new(),
                person_refs: Vec::new(),
                source: None,
            })
        })
        .collect::<sqlx::Result<Vec<_>>>()?;

    // Attach each JE's refs + Captured-from source via the same helpers
    // `list_by_type`'s `journal_entry` branch uses, so the two reads can't drift.
    attach_journal_entry_refs(pool, &mut rows).await?;
    attach_provenance(pool, &mut rows).await?;

    // Newest-occurred first; the JE's `occurred_at` is an ISO-8601 string in
    // `data`, so a reverse string compare is chronological. Stable tie-break by id.
    rows.sort_by(|a, b| {
        let a_occurred = a.data.get("occurred_at").and_then(|v| v.as_str()).unwrap_or("");
        let b_occurred = b.data.get("occurred_at").and_then(|v| v.as_str()).unwrap_or("");
        b_occurred.cmp(a_occurred).then_with(|| a.id.cmp(&b.id))
    });

    Ok(rows)
}

/// Attach each row's origin provenance ("Captured from", ADR-0030) in one batched
/// read. The query returns oldest-first per Entity, so the FIRST row per id is the
/// true origin `created_from`; later cross-Thread sources (if any) are ignored.
/// Exactly one source kind is non-NULL (schema CHECK); a Message source carries
/// its Thread id + title, defaulted defensively rather than dropping the whole
/// provenance if the join is somehow thin. Shared by [`list_by_type`] (all rows)
/// and [`mentioned_in_journal_entries`] (the JE rows) so the two reads can't drift.
async fn attach_provenance(pool: &SqlitePool, rows: &mut [EntityRow]) -> sqlx::Result<()> {
    let entity_ids = rows.iter().map(|row| row.id.clone()).collect::<Vec<_>>();
    let provenance = queries::provenance_for_entities(pool, &entity_ids).await?;
    let mut provenance_by_entity = HashMap::<String, EntityProvenance>::new();
    for (entity_id, source_entity_id, thread_id, thread_title, message_id) in provenance {
        provenance_by_entity
            .entry(entity_id)
            .or_insert_with(|| match source_entity_id {
                Some(journal_entry_id) => EntityProvenance::JournalEntry { journal_entry_id },
                None => EntityProvenance::Message {
                    thread_id: thread_id.unwrap_or_default(),
                    thread_title: thread_title.unwrap_or_default(),
                    message_id,
                },
            });
    }
    for row in &mut *rows {
        row.source = provenance_by_entity.remove(&row.id);
    }
    Ok(())
}

/// Attach each Journal-Entry row's outgoing Entity References (ADR-0030) in one
/// batched read. Shared by [`list_by_type`]'s `journal_entry` branch and
/// [`mentioned_in_journal_entries`] so a JE row carries the same `refs` whichever
/// read produced it.
async fn attach_journal_entry_refs(pool: &SqlitePool, rows: &mut [EntityRow]) -> sqlx::Result<()> {
    let source_entity_ids = rows.iter().map(|row| row.id.clone()).collect::<Vec<_>>();
    let refs = resolved_entity_refs_for_sources(pool, &source_entity_ids).await?;
    let mut refs_by_source = HashMap::<String, Vec<ResolvedEntityRef>>::new();
    for entity_ref in refs {
        refs_by_source
            .entry(entity_ref.source_entity_id.clone())
            .or_default()
            .push(entity_ref);
    }
    for row in rows {
        row.refs = refs_by_source.remove(&row.id).unwrap_or_default();
    }
    Ok(())
}

/// Attach each Todo row's Person References (ADR-0032) in one batched read,
/// mirroring the `entity_type == "todo"` branch of [`list_by_type`]. The
/// `todos_by_*` reads zero `person_refs`; the GTD Waiting/Tasks split (ADR-0031)
/// depends on these riding along.
async fn attach_person_refs(pool: &SqlitePool, rows: &mut [EntityRow]) -> sqlx::Result<()> {
    let todo_ids = rows.iter().map(|row| row.id.clone()).collect::<Vec<_>>();
    let refs = queries::person_refs_for_todos(pool, &todo_ids).await?;
    let mut refs_by_todo = HashMap::<String, Vec<(String, String)>>::new();
    for (todo_id, person_id, role) in refs {
        refs_by_todo
            .entry(todo_id)
            .or_default()
            .push((person_id, role));
    }
    for row in rows {
        row.person_refs = refs_by_todo.remove(&row.id).unwrap_or_default();
    }
    Ok(())
}

/// One Journal Entry returned to the Worker for same-Thread correction context.
/// `data` is the latest accepted revision snapshot. `anchored_entities` names the
/// People/Projects/Todos ALREADY captured from this entry (its outgoing
/// `entity_ref`s, resolved to labels) — the re-scan recognition prompt reads it to
/// SUPPRESS re-proposing an already-chipped entity (ADR-0042).
pub struct CurrentThreadJournalEntryRow {
    pub entity_id: String,
    pub data: serde_json::Value,
    pub anchored_entities: Vec<String>,
}

/// One accepted Journal Entry for `proposal/get` review context. `data` is the
/// current `entities.data` snapshot. Unlike the canonical [`EntityRow`] reads,
/// this is a display-only review-context snapshot: a malformed `data` degrades to
/// `Value::Null` rather than failing the read (see [`current_journal_entry_by_id`]).
pub struct CurrentJournalEntryRow {
    pub entity_id: String,
    pub data: serde_json::Value,
}

/// Read one accepted Journal Entry by id. `None` when it does not exist or is
/// not a journal entry.
///
/// Display-only review read: its sole caller is `proposal/get`'s
/// `review_context_for_proposal` preview, which is designed to degrade gracefully
/// when the current-entry snapshot is unparseable. So a malformed `data` falls
/// back to `Value::Null` here rather than routing through [`parse_entity_data`] —
/// deliberately NOT a canonical authoritative read. The loud parse-failure
/// guarantee for this Journal Entry's data lives on the decide/apply path
/// (`db::apply`, which parses the same snapshot and returns
/// `ApplyError::InvalidMutation` → `-32602`), so corruption is rejected where it
/// matters without breaking the optional review preview.
pub async fn current_journal_entry_by_id(
    pool: &SqlitePool,
    entity_id: &str,
) -> sqlx::Result<Option<CurrentJournalEntryRow>> {
    let Some((entity_id, data)) = queries::current_journal_entry_by_id(pool, entity_id).await?
    else {
        return Ok(None);
    };
    Ok(Some(CurrentJournalEntryRow {
        entity_id,
        data: serde_json::from_str(&data).unwrap_or(serde_json::Value::Null),
    }))
}

/// One accepted GTD Entity (Person/Project) for `proposal/get` review
/// context (lamplit-desk-alignment). `data` is the current `entities.data`
/// snapshot. Like [`CurrentJournalEntryRow`], this is a display-only review read:
/// a malformed `data` degrades to `Value::Null` rather than failing the read. The
/// loud parse-failure guarantee for an accepted update lives on the decide/apply
/// path, so corruption is rejected where it matters without breaking the optional
/// review preview.
pub struct CurrentEntityRow {
    pub entity_id: String,
    pub data: serde_json::Value,
}

/// Read one accepted Person by id. `None` when it does not exist or is not a
/// person. Display-only review read (see [`current_journal_entry_by_id`]).
pub async fn current_person_by_id(
    pool: &SqlitePool,
    entity_id: &str,
) -> sqlx::Result<Option<CurrentEntityRow>> {
    let Some(data) = queries::current_person_data(pool, entity_id).await? else {
        return Ok(None);
    };
    Ok(Some(CurrentEntityRow {
        entity_id: entity_id.to_string(),
        data: serde_json::from_str(&data).unwrap_or(serde_json::Value::Null),
    }))
}

/// Read one accepted Project by id. `None` when it does not exist or is not a
/// project. Display-only review read (see [`current_journal_entry_by_id`]).
pub async fn current_project_by_id(
    pool: &SqlitePool,
    entity_id: &str,
) -> sqlx::Result<Option<CurrentEntityRow>> {
    let Some(data) = queries::current_project_data(pool, entity_id).await? else {
        return Ok(None);
    };
    Ok(Some(CurrentEntityRow {
        entity_id: entity_id.to_string(),
        data: serde_json::from_str(&data).unwrap_or(serde_json::Value::Null),
    }))
}

/// Read accepted Journal Entries originally created from `run_id`'s Thread,
/// ordered newest-first by each Entity's latest revision time.
pub async fn current_thread_journal_entries(
    pool: &SqlitePool,
    run_id: Uuid,
) -> sqlx::Result<Vec<CurrentThreadJournalEntryRow>> {
    let rows = queries::current_thread_journal_entries(pool, run_id).await?;
    let mut entries = rows
        .into_iter()
        .map(|(entity_id, data)| {
            let data = parse_entity_data(&entity_id, &data)?;
            Ok(CurrentThreadJournalEntryRow {
                entity_id,
                data,
                anchored_entities: Vec::new(),
            })
        })
        .collect::<sqlx::Result<Vec<_>>>()?;

    // Resolve each entry's already-captured entities (its outgoing `entity_ref`s,
    // labeled by current name / mint-time snapshot) in one batched read, so the
    // re-scan prompt can suppress already-chipped names. Reuses the same
    // `entity/list` resolver so the labels can't drift.
    let source_ids = entries.iter().map(|e| e.entity_id.clone()).collect::<Vec<_>>();
    let refs = resolved_entity_refs_for_sources(pool, &source_ids).await?;
    let mut by_source = HashMap::<String, Vec<String>>::new();
    for entity_ref in refs {
        if let Some(label) = entity_ref.target_title.or(entity_ref.label_snapshot) {
            by_source.entry(entity_ref.source_entity_id).or_default().push(label);
        }
    }
    for entry in &mut entries {
        entry.anchored_entities = by_source.remove(&entry.entity_id).unwrap_or_default();
    }
    Ok(entries)
}

/// The Entity Type of an accepted Entity, parsed into [`crate::mutation::EntityType`].
/// `None` means the row is genuinely absent (→ a target-gone `TargetMissing` on the
/// agent path, ADR-0033). A row whose stored `type` string fails to parse — the
/// column has no CHECK constraint — surfaces as a loud `sqlx::Error::Decode`
/// (every caller routes it to `Internal`), never silently collapsing to `None`.
pub async fn entity_type_by_id(
    pool: &SqlitePool,
    entity_id: &str,
) -> sqlx::Result<Option<crate::mutation::EntityType>> {
    match queries::entity_type_by_id(pool, entity_id).await? {
        None => Ok(None),
        Some(raw) => crate::mutation::EntityType::from_str(&raw)
            .map(Some)
            .ok_or_else(|| {
                sqlx::Error::Decode(format!("unknown stored entity type {raw:?}").into())
            }),
    }
}

/// Whether an accepted Entity with `entity_id` exists and is of `entity_type`.
/// Backs decide-time target-type checks (e.g. a Todo's `project_id` must point at
/// a `project`).
pub async fn entity_is_type(
    pool: &SqlitePool,
    entity_id: &str,
    entity_type: &str,
) -> sqlx::Result<bool> {
    queries::entity_is_type(pool, entity_id, entity_type).await
}

// ─── GTD relationship read layer (Slice 11, ADR-0031) ──────────────────────
//
// Core-internal in V0 — exposed to client APIs in V1, so currently uncalled
// (`#[allow(dead_code)]`). Entity-returning helpers map raw rows into
// [`EntityRow`] like [`list_by_type`]: a malformed `data` JSON now fails the read
// with a logged `sqlx::Error` (`db.entity_data_parse_failed`, ADR-0038) rather
// than degrading to `null`.

/// Map a raw `(id, type, data, created_at, updated_at)` row to an [`EntityRow`].
fn entity_row(row: (String, String, String, i64, i64)) -> sqlx::Result<EntityRow> {
    let (id, r#type, data, created_at, updated_at) = row;
    let data = parse_entity_data(&id, &data)?;
    Ok(EntityRow {
        id,
        r#type,
        data,
        created_at,
        updated_at,
        refs: Vec::new(),
        person_refs: Vec::new(),
        source: None,
    })
}

/// Read every Todo owning `project_id` (its `data.project_id` matches), reusing
/// the `json_extract` project match. Returns full [`EntityRow`]s with real
/// `created_at`/`updated_at`, newest-first.
pub async fn todos_by_project(pool: &SqlitePool, project_id: &str) -> sqlx::Result<Vec<EntityRow>> {
    let rows = queries::todos_by_project(pool, project_id).await?;
    rows.into_iter()
        .map(|(id, data, created_at, updated_at)| {
            entity_row((id, "todo".to_string(), data, created_at, updated_at))
        })
        .collect::<sqlx::Result<Vec<_>>>()
}

/// Read every Todo linked to `person_id` via `todo_person_refs`, optionally
/// filtered to `role` (ADR-0031). Returns full [`EntityRow`]s, newest-first.
pub async fn todos_by_person(
    pool: &SqlitePool,
    person_id: &str,
    role: Option<&str>,
) -> sqlx::Result<Vec<EntityRow>> {
    let rows = queries::todos_by_person(pool, person_id, role).await?;
    rows.into_iter()
        .map(entity_row)
        .collect::<sqlx::Result<Vec<_>>>()
}
