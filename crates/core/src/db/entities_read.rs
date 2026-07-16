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
/// read. Shared by [`list_by_type`] and [`mentioned_in_journal_entries`] so the
/// two reads can't drift.
async fn attach_provenance(pool: &SqlitePool, rows: &mut [EntityRow]) -> sqlx::Result<()> {
    let entity_ids = rows.iter().map(|row| row.id.clone()).collect::<Vec<_>>();
    let provenance = queries::provenance_for_entities(pool, &entity_ids).await?;
    let mut provenance_by_entity = HashMap::<String, EntityProvenance>::new();
    for (entity_id, source_entity_id, thread_id, thread_title, message_id) in provenance {
        provenance_by_entity.insert(
            entity_id,
            match source_entity_id {
                Some(journal_entry_id) => EntityProvenance::JournalEntry { journal_entry_id },
                None => EntityProvenance::Message {
                    thread_id: thread_id.unwrap_or_default(),
                    thread_title: thread_title.unwrap_or_default(),
                    message_id,
                },
            },
        );
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

/// One accepted Entity snapshot for `proposal/get` review context; `data` is
/// the parsed current `entities.data` snapshot.
pub struct CurrentEntityRow {
    pub entity_id: String,
    pub data: serde_json::Value,
}

/// Read one accepted Entity of `entity_type` by id. `None` when it does not
/// exist or is not of that type. A malformed stored snapshot also yields
/// `None` — the `proposal/get` review preview is optional; corruption is
/// rejected loudly on the decide path (`db::apply` → `-32602`).
pub async fn current_entity_review_data(
    pool: &SqlitePool,
    entity_id: &str,
    entity_type: crate::mutation::EntityType,
) -> sqlx::Result<Option<CurrentEntityRow>> {
    let Some(data) = queries::current_entity_data(pool, entity_id, entity_type.as_str()).await?
    else {
        return Ok(None);
    };
    let Ok(data) = serde_json::from_str(&data) else {
        return Ok(None);
    };
    Ok(Some(CurrentEntityRow {
        entity_id: entity_id.to_string(),
        data,
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

#[cfg(test)]
mod tests {
    use crate::db::test_support::{memory_pool, seed_entity, seed_source, seed_thread_message};

    use super::*;

    /// Insert one `todo_person_refs` row directly.
    async fn seed_ref(pool: &SqlitePool, todo_id: &str, person_id: &str, role: &str) {
        sqlx::query(
            "INSERT INTO todo_person_refs \
             (todo_id, person_id, role, created_at, updated_at) VALUES (?, ?, ?, 1, 1)",
        )
        .bind(todo_id)
        .bind(person_id)
        .bind(role)
        .execute(pool)
        .await
        .expect("insert ref");
    }

    #[tokio::test]
    async fn todos_by_project_returns_only_that_projects_todos() {
        let pool = memory_pool().await;
        seed_entity(&pool, "proj-a", "project", r#"{"name":"A"}"#).await;
        seed_entity(&pool, "proj-b", "project", r#"{"name":"B"}"#).await;
        seed_entity(
            &pool,
            "t1",
            "todo",
            r#"{"title":"t1","project_id":"proj-a"}"#,
        )
        .await;
        seed_entity(
            &pool,
            "t2",
            "todo",
            r#"{"title":"t2","project_id":"proj-a"}"#,
        )
        .await;
        seed_entity(
            &pool,
            "t3",
            "todo",
            r#"{"title":"t3","project_id":"proj-b"}"#,
        )
        .await;
        seed_entity(&pool, "t4", "todo", r#"{"title":"t4"}"#).await;

        let mut ids: Vec<String> = todos_by_project(&pool, "proj-a")
            .await
            .expect("todos_by_project")
            .into_iter()
            .map(|row| row.id)
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["t1".to_string(), "t2".to_string()]);
    }

    #[tokio::test]
    async fn todos_by_person_optionally_filters_by_role() {
        let pool = memory_pool().await;
        seed_entity(&pool, "alice", "person", r#"{"name":"Alice"}"#).await;
        seed_entity(&pool, "t1", "todo", r#"{"title":"t1"}"#).await;
        seed_entity(&pool, "t2", "todo", r#"{"title":"t2"}"#).await;
        seed_ref(&pool, "t1", "alice", "waiting_on").await;
        seed_ref(&pool, "t2", "alice", "related").await;

        let mut all: Vec<String> = todos_by_person(&pool, "alice", None)
            .await
            .expect("all roles")
            .into_iter()
            .map(|row| row.id)
            .collect();
        all.sort();
        assert_eq!(all, vec!["t1".to_string(), "t2".to_string()]);

        let waiting: Vec<String> = todos_by_person(&pool, "alice", Some("waiting_on"))
            .await
            .expect("waiting only")
            .into_iter()
            .map(|row| row.id)
            .collect();
        assert_eq!(
            waiting,
            vec!["t1".to_string()],
            "role filter keeps only waiting_on"
        );
    }

    #[tokio::test]
    async fn list_by_type_todo_attaches_person_refs() {
        let pool = memory_pool().await;
        seed_entity(&pool, "alice", "person", r#"{"name":"Alice"}"#).await;
        seed_entity(&pool, "bob", "person", r#"{"name":"Bob"}"#).await;
        seed_entity(&pool, "t1", "todo", r#"{"title":"t1","status":"active"}"#).await;
        seed_entity(&pool, "t2", "todo", r#"{"title":"t2","status":"active"}"#).await;
        seed_ref(&pool, "t1", "alice", "waiting_on").await;
        seed_ref(&pool, "t1", "bob", "related").await;
        // t2 has no refs.

        let rows = list_by_type(&pool, "todo").await.expect("list todos");
        let t1 = rows.iter().find(|r| r.id == "t1").expect("t1 present");
        let mut t1_refs = t1.person_refs.clone();
        t1_refs.sort();
        assert_eq!(
            t1_refs,
            vec![
                ("alice".to_string(), "waiting_on".to_string()),
                ("bob".to_string(), "related".to_string()),
            ],
            "t1 carries both Person References with roles"
        );

        let t2 = rows.iter().find(|r| r.id == "t2").expect("t2 present");
        assert!(
            t2.person_refs.is_empty(),
            "a Todo with no refs carries none"
        );
    }

    #[tokio::test]
    async fn list_by_type_non_todo_has_no_person_refs() {
        let pool = memory_pool().await;
        seed_entity(&pool, "alice", "person", r#"{"name":"Alice"}"#).await;
        let rows = list_by_type(&pool, "person").await.expect("list people");
        assert!(
            rows.iter().all(|r| r.person_refs.is_empty()),
            "non-Todo rows never carry person_refs"
        );
    }

    /// `list_by_type` attaches each Entity's origin provenance ("Captured from",
    /// ADR-0030): a Message source resolves to its Thread; a Journal-Entry source
    /// resolves to the source Entity id; a user-authored Entity (no `created_from`)
    /// carries no source.
    #[tokio::test]
    async fn list_by_type_attaches_captured_from_provenance() {
        let pool = memory_pool().await;
        seed_thread_message(&pool, "thr-1", "Morning brain dump", "msg-1").await;

        // (a) A Todo extracted from a Journal Entry → JournalEntry provenance.
        seed_entity(&pool, "je-1", "journal_entry", r#"{"occurred_at":"x"}"#).await;
        seed_entity(&pool, "t-from-je", "todo", r#"{"title":"Email Alice"}"#).await;
        seed_source(
            &pool,
            "src-je",
            "t-from-je",
            None,
            Some("je-1"),
            "created_from",
            10,
        )
        .await;

        // (b) A Todo created directly from a user Message → Message provenance.
        seed_entity(&pool, "t-from-msg", "todo", r#"{"title":"Buy milk"}"#).await;
        seed_source(
            &pool,
            "src-msg",
            "t-from-msg",
            Some("msg-1"),
            None,
            "created_from",
            10,
        )
        .await;

        // (c) A user-authored Todo (direct Library write) → no source row.
        seed_entity(&pool, "t-user", "todo", r#"{"title":"Hand-made"}"#).await;

        // A later `updated_from` row on (b) must NOT override its origin.
        seed_source(
            &pool,
            "src-msg-upd",
            "t-from-msg",
            Some("msg-1"),
            None,
            "updated_from",
            20,
        )
        .await;

        let rows = list_by_type(&pool, "todo").await.expect("list todos");
        let from_je = rows.iter().find(|r| r.id == "t-from-je").expect("t-from-je");
        assert!(
            matches!(
                from_je.source.as_ref(),
                Some(EntityProvenance::JournalEntry { journal_entry_id }) if journal_entry_id == "je-1"
            ),
            "JE-sourced Todo reports its source Journal Entry"
        );

        let from_msg = rows
            .iter()
            .find(|r| r.id == "t-from-msg")
            .expect("t-from-msg");
        assert!(
            matches!(
                from_msg.source.as_ref(),
                Some(EntityProvenance::Message { thread_id, thread_title, message_id })
                    if thread_id == "thr-1"
                        && thread_title == "Morning brain dump"
                        && message_id.as_deref() == Some("msg-1")
            ),
            "Message-sourced Todo reports its Thread + capturing message; updated_from does not override created_from"
        );

        let user = rows.iter().find(|r| r.id == "t-user").expect("t-user");
        assert!(
            user.source.is_none(),
            "a user-authored Entity carries no Captured-from provenance"
        );
    }

    /// A canonical `entities.data` row holding malformed JSON makes `list_by_type`
    /// fail the read (logged `db.entity_data_parse_failed` + `sqlx::Error::Decode`)
    /// rather than silently returning an `EntityRow` with `data: Null`. The column
    /// has no `json_valid` CHECK, so `seed_entity` writes the bad row directly.
    #[tokio::test]
    async fn list_by_type_errors_on_malformed_entity_data() {
        let pool = memory_pool().await;
        seed_entity(&pool, "t-bad", "todo", "{not json").await;

        assert!(
            list_by_type(&pool, "todo").await.is_err(),
            "a malformed entities.data row errors the read, no silent Null"
        );

        // A well-formed row in the same type still reads back fine once the bad
        // row is gone — the helper only fails on actual parse errors.
        sqlx::query("DELETE FROM entities WHERE id = 't-bad'")
            .execute(&pool)
            .await
            .expect("delete bad row");
        seed_entity(&pool, "t-ok", "todo", r#"{"title":"ok"}"#).await;
        let rows = list_by_type(&pool, "todo")
            .await
            .expect("well-formed reads ok");
        assert_eq!(rows.len(), 1, "the well-formed row reads back");
        assert_eq!(
            rows[0].data.get("title").and_then(|v| v.as_str()),
            Some("ok")
        );
    }

    // ─── entity/backlinks read (ADR-0050) ──────────────────────────────────

    /// Seed one `entities` row with an explicit `created_at`/`updated_at`, so a
    /// read's newest-first ordering can be exercised (the bare `seed_entity`
    /// pins both to `1`).
    async fn seed_entity_at(
        pool: &SqlitePool,
        id: &str,
        entity_type: &str,
        data: &str,
        created_at: i64,
    ) {
        sqlx::query(
            "INSERT INTO entities \
             (id, type, schema_version, data, created_by, created_via_proposal_id, \
              created_at, updated_at) \
             VALUES (?, ?, 1, ?, 'user', NULL, ?, ?)",
        )
        .bind(id)
        .bind(entity_type)
        .bind(data)
        .bind(created_at)
        .bind(created_at)
        .execute(pool)
        .await
        .expect("insert entity at");
    }

    /// Insert one `entity_refs` row directly (a Journal Entry → target link).
    async fn seed_entity_ref(pool: &SqlitePool, id: &str, source_je: &str, target: &str) {
        sqlx::query(
            "INSERT INTO entity_refs \
             (id, source_entity_id, target_entity_id, label_snapshot, created_at) \
             VALUES (?, ?, ?, NULL, 1)",
        )
        .bind(id)
        .bind(source_je)
        .bind(target)
        .execute(pool)
        .await
        .expect("insert entity_ref");
    }

    fn je_data(occurred_at: &str, text: &str) -> String {
        serde_json::json!({
            "occurred_at": occurred_at,
            "body": [{ "type": "text", "text": text }],
        })
        .to_string()
    }

    /// `backlinks_for_entity` resolves the two reverse sets for a Person, Project,
    /// or Todo: `mentioned_in` (DISTINCT Journal Entries referencing it, with their
    /// `refs` + `source` attached, newest-occurred first) and `linked_todos` (the
    /// Todos linked via `person_refs` for a Person / `project_id` for a Project,
    /// each carrying its `person_refs`, newest-first; empty for a Todo target).
    #[tokio::test]
    async fn backlinks_resolves_mentioned_in_and_linked_todos() {
        let pool = memory_pool().await;

        // Provenance for the mentioning JEs (so each JE row carries its `source`).
        seed_thread_message(&pool, "thr-1", "Morning dump", "msg-1").await;

        // Targets.
        seed_entity(&pool, "person-a", "person", r#"{"name":"Alice"}"#).await;
        seed_entity(&pool, "proj-a", "project", r#"{"name":"Lead Ads"}"#).await;
        seed_entity(&pool, "todo-standalone", "todo", r#"{"title":"Standalone"}"#).await;
        seed_entity(&pool, "person-zero", "person", r#"{"name":"Nobody"}"#).await;

        // Journal Entries with refs. JE-older and JE-newer both reference Alice;
        // JE-newer occurred later. JE-newer references Alice via TWO ref rows would
        // be blocked by the (source,target) UNIQUE constraint, so dedupe is proven
        // by asserting each distinct JE appears exactly ONCE.
        seed_entity_at(
            &pool,
            "je-older",
            "journal_entry",
            &je_data("2026-06-01T09:00:00", "Met Alice"),
            10,
        )
        .await;
        seed_entity_at(
            &pool,
            "je-newer",
            "journal_entry",
            &je_data("2026-06-05T09:00:00", "Alice again, re Lead Ads"),
            20,
        )
        .await;
        seed_entity_at(
            &pool,
            "je-proj",
            "journal_entry",
            &je_data("2026-06-03T09:00:00", "Lead Ads kickoff"),
            15,
        )
        .await;
        seed_entity_at(
            &pool,
            "je-todo",
            "journal_entry",
            &je_data("2026-06-02T09:00:00", "Mentioned the standalone todo"),
            12,
        )
        .await;

        // Each mentioning JE is `created_from` the user Message (so `source`
        // attaches), exercising the same provenance assembly as `entity/list`.
        for (src_id, je) in [
            ("s-older", "je-older"),
            ("s-newer", "je-newer"),
            ("s-proj", "je-proj"),
            ("s-todo", "je-todo"),
        ] {
            seed_source(&pool, src_id, je, Some("msg-1"), None, "created_from", 5).await;
        }

        // Refs: both JEs → Alice; JE-newer also → the Project (so JE-newer carries
        // multiple refs). JE-proj → Project, JE-todo → the standalone Todo.
        seed_entity_ref(&pool, "ref-1", "je-older", "person-a").await;
        seed_entity_ref(&pool, "ref-2", "je-newer", "person-a").await;
        seed_entity_ref(&pool, "ref-3", "je-newer", "proj-a").await;
        seed_entity_ref(&pool, "ref-4", "je-proj", "proj-a").await;
        seed_entity_ref(&pool, "ref-5", "je-todo", "todo-standalone").await;

        // Linked todos. Alice is on two todos (waiting_on + related → all roles);
        // the Project owns one todo. `t-wait` is newer than `t-rel` so newest-first
        // ordering is observable.
        seed_entity_at(&pool, "t-rel", "todo", r#"{"title":"Older task"}"#, 30).await;
        seed_entity_at(
            &pool,
            "t-wait",
            "todo",
            r#"{"title":"Newer task"}"#,
            40,
        )
        .await;
        seed_ref(&pool, "t-rel", "person-a", "related").await;
        seed_ref(&pool, "t-wait", "person-a", "waiting_on").await;
        seed_entity_at(
            &pool,
            "t-proj",
            "todo",
            r#"{"title":"Project task","project_id":"proj-a"}"#,
            35,
        )
        .await;

        // ── Person target ──────────────────────────────────────────────────
        let person = backlinks_for_entity(&pool, "person-a")
            .await
            .expect("backlinks for person");

        let mentioned_ids: Vec<&str> = person
            .mentioned_in
            .iter()
            .map(|row| row.id.as_str())
            .collect();
        assert_eq!(
            mentioned_ids,
            vec!["je-newer", "je-older"],
            "distinct JEs mentioning the Person, newest-occurred first"
        );
        // Each JE row carries its refs (reuse of the entity/list JE assembly) and
        // its source provenance.
        let je_newer = person
            .mentioned_in
            .iter()
            .find(|r| r.id == "je-newer")
            .expect("je-newer row");
        assert_eq!(
            je_newer.refs.len(),
            2,
            "je-newer carries both of its entity_refs (Alice + Project)"
        );
        assert!(
            matches!(
                je_newer.source.as_ref(),
                Some(EntityProvenance::Message { thread_id, .. }) if thread_id == "thr-1"
            ),
            "mentioned-in JE carries its Captured-from provenance"
        );

        let linked_ids: Vec<&str> = person
            .linked_todos
            .iter()
            .map(|row| row.id.as_str())
            .collect();
        assert_eq!(
            linked_ids,
            vec!["t-wait", "t-rel"],
            "Person's linked todos across all roles, newest-first"
        );
        // person_refs ride along on each linked Todo (the GTD Waiting/Tasks split).
        let wait = person
            .linked_todos
            .iter()
            .find(|r| r.id == "t-wait")
            .expect("t-wait row");
        assert_eq!(
            wait.person_refs,
            vec![("person-a".to_string(), "waiting_on".to_string())],
            "linked Todo carries its person_refs"
        );

        // ── Project target (same result shape) ───────────────────────────────
        let project = backlinks_for_entity(&pool, "proj-a")
            .await
            .expect("backlinks for project");
        let proj_mentioned: Vec<&str> = project
            .mentioned_in
            .iter()
            .map(|row| row.id.as_str())
            .collect();
        assert_eq!(
            proj_mentioned,
            vec!["je-newer", "je-proj"],
            "distinct JEs mentioning the Project, newest-occurred first"
        );
        let proj_linked: Vec<&str> = project
            .linked_todos
            .iter()
            .map(|row| row.id.as_str())
            .collect();
        assert_eq!(
            proj_linked,
            vec!["t-proj"],
            "Project's linked todos via project_id"
        );

        // ── Todo target (Mentioned-in only; no linked todos) ─────────────────
        let todo = backlinks_for_entity(&pool, "todo-standalone")
            .await
            .expect("backlinks for todo");
        let todo_mentioned: Vec<&str> = todo
            .mentioned_in
            .iter()
            .map(|row| row.id.as_str())
            .collect();
        assert_eq!(todo_mentioned, vec!["je-todo"], "the JE mentioning the Todo");
        assert!(
            todo.linked_todos.is_empty(),
            "a Todo has no linked todos (Mentioned-in only)"
        );

        // ── Zero-backlink entity → both sets empty ───────────────────────────
        let empty = backlinks_for_entity(&pool, "person-zero")
            .await
            .expect("backlinks for zero-backlink person");
        assert!(
            empty.mentioned_in.is_empty() && empty.linked_todos.is_empty(),
            "a referenced-by-nothing entity yields empty sets"
        );
    }
}
