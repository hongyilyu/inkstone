//! The run-independent entity-mutation core (ADR-0016, ADR-0033). Both write
//! paths converge here: the agent path (`apply_proposal`, after the
//! `ProposalStatus::accept` flip) and the future user path (`entity/mutate`).
//! This layer takes **no** `run_id`/`tool_call_id` — the caller resolves any
//! Run/Proposal coupling (the awaited tool call, the source Message) and hands
//! down an already-resolved [`EntitySource`].

use sqlx::Sqlite;
use uuid::Uuid;

use super::ApplyError;
use super::queries;
use crate::mutation::{EntityType, MutationKind, WriteOp};

/// An already-resolved Entity Source row to write for this mutation (ADR-0030,
/// ADR-0033). The caller resolves the run-coupled bits (the user Message id from
/// the Run; the Journal-Entry anchor from the payload) into one of these before
/// calling [`apply_entity_mutation`]; the user path passes `None` (a plain
/// Library create has no Message and no Journal-Entry anchor — `created_by='user'`
/// is the origin marker).
pub(crate) enum EntitySource {
    /// `created_from`/`updated_from` a user Message (the agent path's default).
    FromMessage {
        message_id: String,
        relation: String,
    },
    /// `created_from` a Journal Entry (a create that carried a
    /// `source_journal_entry_id`), reusing the agent's provenance shape.
    FromJournalEntry {
        journal_entry_id: String,
        relation: String,
    },
}

/// What `apply_entity_mutation` writes, fully resolved by the caller so this
/// layer is run-independent. The `kind` is the single source of the Entity Type,
/// schema version, and write class (via [`MutationKind::describe`]) — the caller
/// no longer threads those as separate fields. `created_by` is the origin marker
/// (`'proposal'`/`'user'`); `proposal_id` is `Some` on the proposal path (it
/// stamps both `entities.created_via_proposal_id` and the `entity_revisions`
/// rows) and `None` on the user path (NULL columns, allowed by the schema CHECK).
/// `source` is the already-resolved Entity Source row, or `None`.
pub(crate) struct EntityMutationSpec<'a> {
    pub kind: MutationKind,
    pub target_entity_id: Option<&'a str>,
    pub payload: &'a serde_json::Value,
    pub edited_payload: Option<&'a serde_json::Value>,
    pub created_by: &'a str,
    /// `Some` for a proposal-born write, `None` for a direct user edit.
    pub proposal_id: Option<&'a str>,
    pub source: Option<EntitySource>,
    pub now_ms: i64,
}

/// The entity `data` to store for a `kind`, given its effective payload. The
/// per-kind extraction/normalization seam: every full-replace update kind
/// (`update_journal_entry`/`update_person`/`update_project`/`update_bookmark`)
/// strips `entity_id` (it targets the row but is not entity data);
/// `create_project` injects `status:"active"` when absent so the stored data
/// always carries an explicit status (validate tolerates a missing status), and
/// for a resulting active Project with no review fields supplied seeds the
/// default weekly review ritual (`review_every` + `next_review_at`) from the
/// review anchor (ADR-0031); `create_todo` unwraps the `{todo, person_refs?}`
/// envelope to store `payload.todo` (the TodoData) and likewise injects
/// `status:"active"` when absent; every other kind stores its payload as-is. The
/// `now_ms`/`offset_minutes` inputs anchor that review-date default. The in-tx
/// kinds (`update_todo`/`mark_project_reviewed`/reference weave) never reach this
/// seam — their data is computed inside the tx — so they fall to the as-is arm.
fn entity_data_payload(
    kind: MutationKind,
    payload: &serde_json::Value,
    now_ms: i64,
    offset_minutes: i64,
) -> serde_json::Value {
    use MutationKind as M;
    match kind {
        M::UpdateJournalEntry | M::UpdatePerson | M::UpdateProject | M::UpdateBookmark => {
            let Some(obj) = payload.as_object() else {
                return payload.clone();
            };
            let mut data = obj.clone();
            data.remove("entity_id");
            // `source_journal_entry_id` is a create-only provenance directive
            // (honored solely for `created_from`); strip it so an update payload
            // can never persist this transport field into entity data.
            data.remove("source_journal_entry_id");
            // Sentinel-null clear (ADR-0033): a `null`-valued optional field is a
            // clear directive — drop the key rather than persist a JSON null. The
            // person/project update is a full-document replace, so an omitted-or-
            // null optional field is simply absent in the stored data.
            data.retain(|_, value| !value.is_null());
            serde_json::Value::Object(data)
        }
        M::CreatePerson => {
            // `source_journal_entry_id` is a provenance directive, never Person
            // data — strip it before storing (validate already accepted it).
            let Some(obj) = payload.as_object() else {
                return payload.clone();
            };
            let mut data = obj.clone();
            data.remove("source_journal_entry_id");
            // A `null` optional field carries no value to store (ADR-0033).
            data.retain(|_, value| !value.is_null());
            serde_json::Value::Object(data)
        }
        M::CreateProject => {
            let Some(obj) = payload.as_object() else {
                return payload.clone();
            };
            let mut data = obj.clone();
            // `source_journal_entry_id` is provenance, never Project data.
            data.remove("source_journal_entry_id");
            // A `null` optional field carries no value to store (ADR-0033); drop it
            // before the review-default seeding so a `null` review field is treated
            // as absent (and thus seeded for an active Project).
            data.retain(|_, value| !value.is_null());
            let status = data
                .entry("status")
                .or_insert_with(|| serde_json::json!("active"));
            let is_active = status.as_str() == Some("active");
            if is_active
                && !data.contains_key("review_every")
                && !data.contains_key("next_review_at")
            {
                data.insert(
                    "review_every".to_string(),
                    serde_json::json!({ "interval": 1, "unit": "week" }),
                );
                data.insert(
                    "next_review_at".to_string(),
                    serde_json::json!(crate::entities::next_review_at_local(
                        now_ms,
                        offset_minutes
                    )),
                );
            }
            serde_json::Value::Object(data)
        }
        M::CreateTodo => {
            // Unwrap the `{todo, person_refs?}` envelope into Todo JSON;
            // person_refs persist separately in `todo_person_refs`, never in
            // `entities.data`.
            let Some(todo) = payload.get("todo").and_then(|t| t.as_object()) else {
                return payload.clone();
            };
            let mut data = todo.clone();
            data.entry("status")
                .or_insert_with(|| serde_json::json!("active"));
            serde_json::Value::Object(data)
        }
        M::CreateBookmark => {
            // A `null` optional field (url/note/tags) carries no value to store
            // (ADR-0033/0036): drop the key rather than persist a JSON null, so the
            // stored Bookmark data never holds null. No envelope, no defaults.
            let Some(obj) = payload.as_object() else {
                return payload.clone();
            };
            let mut data = obj.clone();
            data.retain(|_, value| !value.is_null());
            serde_json::Value::Object(data)
        }
        // The delete kinds touch no entity data, and the in-tx kinds
        // (update_todo/mark_project_reviewed/reference weave) compute their data
        // inside the tx — none reach this pre-write seam, so store as-is.
        M::CreateJournalEntry
        | M::DeleteJournalEntry
        | M::ReferenceExistingEntityFromJournalEntry
        | M::DeletePerson
        | M::DeleteProject
        | M::MarkProjectReviewed
        | M::DeleteTodo
        | M::UpdateTodo
        | M::DeleteBookmark => payload.clone(),
    }
}

/// De-dup a `create_todo` envelope's `person_refs` to at most one `(person_id,
/// role)` per Person (ADR-0031). A missing role defaults to `related`;
/// `waiting_on` wins over `related` when a Person appears twice (it includes
/// related semantics). First-seen order is preserved. The decide path has
/// already verified each `person_id` references an Accepted Person and the pure
/// validator has checked each ref's shape.
fn deduped_person_refs(envelope: &serde_json::Value) -> Vec<(String, &'static str)> {
    let Some(refs) = envelope.get("person_refs").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    deduped_refs(refs)
}

/// De-dup an `update_todo` ref array (`set_person_refs`/`add_person_refs`) to at
/// most one `(person_id, role)` per Person, mirroring [`deduped_person_refs`]:
/// missing role ⇒ `related`; `waiting_on` wins over `related`; first-seen order
/// preserved. The decide path has verified each `person_id` is an Accepted
/// Person and the validator has checked each ref's shape.
fn deduped_ref_array(refs: &serde_json::Value) -> Vec<(String, &'static str)> {
    let Some(refs) = refs.as_array() else {
        return Vec::new();
    };
    deduped_refs(refs)
}

/// Shared de-dup over a `[{person_id, role?}]` array (the body of both
/// [`deduped_person_refs`] and [`deduped_ref_array`]).
fn deduped_refs(refs: &[serde_json::Value]) -> Vec<(String, &'static str)> {
    let mut order: Vec<String> = Vec::new();
    let mut roles: std::collections::HashMap<String, &'static str> =
        std::collections::HashMap::new();
    for person_ref in refs {
        let Some(person_id) = person_ref
            .get("person_id")
            .and_then(|v| v.as_str())
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        let role = match person_ref.get("role").and_then(|v| v.as_str()) {
            Some("waiting_on") => "waiting_on",
            _ => "related",
        };
        match roles.get_mut(person_id) {
            // waiting_on includes related — upgrade, never downgrade.
            Some(existing) => {
                if role == "waiting_on" {
                    *existing = "waiting_on";
                }
            }
            None => {
                order.push(person_id.to_string());
                roles.insert(person_id.to_string(), role);
            }
        }
    }
    order
        .into_iter()
        .map(|id| {
            let role = roles[&id];
            (id, role)
        })
        .collect()
}

/// Re-check a Todo's `project_id` link inside the open tx (ADR-0031, ADR-0033).
/// `project_id` lives in the Todo JSON, not an FK column, so an earlier
/// pool-level validation does not guarantee the Project still exists at write
/// time. When `data` carries a non-empty `project_id`, confirm the Project still
/// exists in THIS tx. This is an AUXILIARY reference (not the mutation's primary
/// target), so a vanished Project is `InvalidMutation` (-32602), NOT `TargetMissing`.
///
/// Why a same-tx read suffices (no `BEGIN IMMEDIATE` / writer-lock dance needed):
/// the pool is `max_connections(1)` (see `db::open`), so every write path runs on
/// the single shared connection and is fully serialized — no second transaction
/// can `delete_project` between this read and the subsequent `update_entity` /
/// `insert_entity` on the same connection. The check closes the validate→apply gap
/// within one mutation; it is not defending against a concurrent writer (there
/// isn't one).
async fn recheck_todo_project_link(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    data: &serde_json::Value,
) -> Result<(), ApplyError> {
    let project_id = data
        .get("project_id")
        .and_then(serde_json::Value::as_str)
        .filter(|id| !id.is_empty());
    if let Some(project_id) = project_id
        && !queries::entity_is_type(&mut **tx, project_id, "project").await?
    {
        return Err(ApplyError::InvalidMutation(
            "project_id no longer references an Accepted Project".to_string(),
        ));
    }
    Ok(())
}

/// Apply an `update_todo` inside the caller's open tx (ADR-0031, ADR-0033).
/// THREE-WAY MERGE: load the current Todo `data`, overlay each key of the supplied
/// `payload["todo"]` partial — an absent key preserves the current value, a `null`
/// value REMOVES the key (sentinel-clear), and any other value sets it — then
/// RE-VALIDATE the merged whole via [`crate::entities::validate_todo_data`] so the
/// status↔timestamp invariants hold on the result. Write the entity update + next
/// revision. Then the REF OPS,
/// in a defined PRECEDENCE: `set_person_refs` (full replace: delete-all then
/// insert the deduped set) FIRST, then `add_person_refs` (upsert/upgrade each
/// deduped ref) — set replaces wholesale, add/remove adjust on top — then
/// `remove_person_ids` (delete each). Refs live ONLY in `todo_person_refs`, never
/// in the Todo JSON, so the merged data must not carry `person_refs`.
async fn apply_update_todo(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    todo_id: &str,
    payload: &serde_json::Value,
    schema_version: i64,
    proposal_id: Option<&str>,
    now_ms: i64,
) -> Result<(), ApplyError> {
    let current = queries::current_todo_data(&mut **tx, todo_id)
        .await?
        // The target Todo vanished under the parked Proposal (a user deleted it):
        // ADR-0033's target-gone case → TargetMissing (decide maps to
        // NotDecidable/-32002), NOT InvalidMutation/-32602.
        .ok_or(ApplyError::TargetMissing)?;
    let mut merged: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&current)
        .map_err(|e| ApplyError::InvalidMutation(format!("current Todo data is not JSON: {e}")))?;

    if let Some(partial) = payload.get("todo").and_then(|t| t.as_object()) {
        for (key, value) in partial {
            // Three-way overlay (ADR-0033): a `null` value clears the field
            // (remove the key); any other value sets it. Absent keys never reach
            // this loop, so they preserve the current value.
            if value.is_null() {
                merged.remove(key);
            } else {
                merged.insert(key.clone(), value.clone());
            }
        }
    }
    let merged = serde_json::Value::Object(merged);
    crate::entities::validate_todo_data(&merged).map_err(ApplyError::InvalidMutation)?;
    // Re-check the merged-data project link in THIS tx: a concurrent
    // delete_project could otherwise persist a dangling project_id (ADR-0033).
    recheck_todo_project_link(tx, &merged).await?;
    let data_str = merged.to_string();

    let updated = queries::update_entity(
        &mut **tx,
        todo_id,
        "todo",
        schema_version,
        &data_str,
        now_ms,
    )
    .await?;
    if updated != 1 {
        // The target Todo row vanished (a user deleted it under the parked
        // Proposal) — ADR-0033's target-gone case, distinct from a DB fault.
        return Err(ApplyError::TargetMissing);
    }
    let next_seq = queries::next_entity_revision_seq(&mut **tx, todo_id).await?;
    queries::insert_entity_revision(&mut **tx, todo_id, next_seq, &data_str, proposal_id, now_ms)
        .await?;

    // Ref-op precedence: set (wholesale replace) → add (upsert/upgrade) → remove.
    if let Some(set_refs) = payload.get("set_person_refs") {
        queries::delete_all_todo_person_refs(&mut **tx, todo_id).await?;
        for (person_id, role) in deduped_ref_array(set_refs) {
            queries::insert_todo_person_ref(&mut **tx, todo_id, &person_id, role, now_ms).await?;
        }
    }
    if let Some(add_refs) = payload.get("add_person_refs") {
        for (person_id, role) in deduped_ref_array(add_refs) {
            queries::upsert_todo_person_ref(&mut **tx, todo_id, &person_id, role, now_ms).await?;
        }
    }
    if let Some(remove) = payload.get("remove_person_ids").and_then(|v| v.as_array()) {
        for person_id in remove.iter().filter_map(|v| v.as_str()) {
            queries::delete_todo_person_ref(&mut **tx, todo_id, person_id).await?;
        }
    }

    Ok(())
}

/// Apply `mark_project_reviewed` (ADR-0034): a read-modify-write that stamps a
/// Project's review fields and appends a new revision, all in the caller's tx.
///
/// Loads the current Project `data`, then:
/// - REJECTS a `completed`/`dropped` Project (`InvalidMutation`): only active and
///   on-hold Projects are reviewable (ADR-0031), and the UI never offers the
///   action for a terminal one, so such a request is a stale/buggy client.
/// - stamps `last_reviewed_at = now` (local wall-clock at the review anchor),
/// - sets `next_review_at` to the next Sunday 20:00 STRICTLY AFTER now (the
///   Workspace review anchor; advance, not the create-time same-day seed),
/// - NORMALIZES `review_every` to `{interval:1, unit:"week"}`. The advance is
///   always weekly (Sunday anchor), so the stored cadence must be weekly too —
///   preserving an agent-set non-weekly cadence (month/year, reachable via the
///   propose schema) would read "Every month" yet fall due in a week. A
///   non-weekly advance is deferred (ADR-0034); normalize until it exists.
///
/// The merged data is re-validated as a whole before the write (defense in depth:
/// the stored data should already be valid, but the recompute must not persist an
/// invalid Project).
async fn apply_mark_project_reviewed(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    project_id: &str,
    schema_version: i64,
    proposal_id: Option<&str>,
    now_ms: i64,
    offset_minutes: i64,
) -> Result<(), ApplyError> {
    let current = queries::current_project_data(&mut **tx, project_id)
        .await?
        // The target Project vanished (a concurrent delete) — ADR-0033's
        // target-gone case, distinct from a DB fault.
        .ok_or(ApplyError::TargetMissing)?;
    let mut data: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&current)
        .map_err(|e| {
            ApplyError::InvalidMutation(format!("current Project data is not JSON: {e}"))
        })?;

    // Only active/on-hold Projects are reviewable (ADR-0031). An absent status
    // defaults to active (mirrors the create-time default).
    let status = data
        .get("status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("active");
    if matches!(status, "completed" | "dropped") {
        return Err(ApplyError::InvalidMutation(format!(
            "a {status} project is not reviewable"
        )));
    }

    data.insert(
        "last_reviewed_at".to_string(),
        serde_json::json!(crate::entities::now_local(now_ms, offset_minutes)),
    );
    // Advance (not seed): always the NEXT Sunday strictly after now, so a Project
    // reviewed on a Sunday afternoon does not re-enter the Review view that same
    // evening (ADR-0034). `next_review_at_local` is the create-time SEED variant.
    data.insert(
        "next_review_at".to_string(),
        serde_json::json!(crate::entities::advance_review_at_local(
            now_ms,
            offset_minutes
        )),
    );
    // Normalize the cadence to weekly. The advance always snaps to the Sunday
    // anchor (a weekly rhythm), so an agent-set non-weekly cadence (month/year —
    // reachable via the propose schema) would otherwise read "Every month" yet
    // fall due in a week. Until a non-weekly advance exists, the stored cadence
    // must match the always-Sunday advance (ADR-0034).
    data.insert(
        "review_every".to_string(),
        serde_json::json!({ "interval": 1, "unit": "week" }),
    );

    let merged = serde_json::Value::Object(data);
    crate::entities::validate_project_data(&merged).map_err(ApplyError::InvalidMutation)?;
    let data_str = merged.to_string();

    let updated = queries::update_entity(
        &mut **tx,
        project_id,
        "project",
        schema_version,
        &data_str,
        now_ms,
    )
    .await?;
    if updated != 1 {
        return Err(ApplyError::TargetMissing);
    }
    let next_seq = queries::next_entity_revision_seq(&mut **tx, project_id).await?;
    queries::insert_entity_revision(
        &mut **tx,
        project_id,
        next_seq,
        &data_str,
        proposal_id,
        now_ms,
    )
    .await?;

    Ok(())
}

/// Apply one Entity mutation inside the caller's open tx (ADR-0016, ADR-0033):
/// the run-independent half of the write. Mints (create) or resolves (update/
/// delete) the `entity_id`, runs the per-kind data/revision/ref work, and writes
/// the resolved Entity Source row. Returns the affected `entity_id`. Takes **no**
/// `run_id`/`tool_call_id`: the caller owns any Proposal flip, tool-call resolve,
/// and `tx.commit()`. Both the agent path (`apply_proposal`) and the user path
/// (`entity/mutate`, a later slice) call this.
///
/// EDIT (ADR-0025): when `edited_payload` is `Some`, the entity `data` is the
/// edited payload (Core-validated by the caller); an unedited write passes `None`
/// and writes the proposed `data`.
pub(crate) async fn apply_entity_mutation(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    spec: EntityMutationSpec<'_>,
) -> Result<String, ApplyError> {
    let EntityMutationSpec {
        kind,
        target_entity_id,
        payload,
        edited_payload,
        created_by,
        proposal_id,
        source,
        now_ms,
    } = spec;
    let desc = kind.describe();
    let entity_type = desc.entity_type;
    let schema_version = entity_type.schema_version();
    let mutation_kind = kind.as_wire();

    let entity_id = if desc.write_op == WriteOp::Create {
        if target_entity_id.is_some() {
            return Err(ApplyError::InvalidMutation(format!(
                "{mutation_kind} must not target an existing entity"
            )));
        }
        Uuid::now_v7().to_string()
    } else {
        target_entity_id.map(str::to_string).ok_or_else(|| {
            ApplyError::InvalidMutation(format!("{mutation_kind} requires a target entity id"))
        })?
    };
    let effective_payload = edited_payload.unwrap_or(payload);

    // The review-anchor offset seeds an active Project's default next_review_at.
    // Read it INSIDE the tx (via the executor-generic query) so the derived
    // default comes from the same serialized state we commit — a concurrent
    // `settings/set` can't make us persist a stale offset.
    let review_anchor_offset =
        queries::get_setting(&mut **tx, crate::settings::REVIEW_ANCHOR_UTC_OFFSET_KEY)
            .await?
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0);
    // Effective entity data: edited payload when present, else the proposed
    // data, run through the per-kind extraction seam. Delete kinds touch no
    // entity data; `update_todo` MERGES against current DB state inside the tx,
    // so it computes its data there, not here; the
    // `reference_existing_entity_from_journal_entry` kind likewise rewrites the
    // target Journal Entry body against current state inside the tx (it needs the
    // freshly-minted entity_ref id), so it is computed there too.
    let mut data_str = match kind {
        // `update_todo` MERGES, `mark_project_reviewed` recomputes from current
        // state, and the reference kind rewrites the target body against current
        // state — all compute their data inside the tx below, not at this seam.
        // Deletes touch no entity data. This is an exhaustive `match kind` (no
        // wildcard) so a new Entity Type must DECLARE its data-seam routing here —
        // it cannot silently default to the pre-write `entity_data_payload` path,
        // which would be wrong for a new in-tx-computed kind. (The reference weave
        // is a WriteOp::Update, so a `match write_op` could not express this.)
        MutationKind::UpdateTodo
        | MutationKind::MarkProjectReviewed
        | MutationKind::ReferenceExistingEntityFromJournalEntry
        | MutationKind::DeleteJournalEntry
        | MutationKind::DeletePerson
        | MutationKind::DeleteProject
        | MutationKind::DeleteTodo
        | MutationKind::DeleteBookmark => None,
        MutationKind::CreateJournalEntry
        | MutationKind::CreatePerson
        | MutationKind::CreateProject
        | MutationKind::CreateTodo
        | MutationKind::CreateBookmark
        | MutationKind::UpdateJournalEntry
        | MutationKind::UpdatePerson
        | MutationKind::UpdateProject
        | MutationKind::UpdateBookmark => Some(
            entity_data_payload(kind, effective_payload, now_ms, review_anchor_offset).to_string(),
        ),
    };

    if kind == MutationKind::UpdateJournalEntry {
        for ref_id in crate::entities::body_entity_ref_ids(effective_payload) {
            let belongs =
                queries::entity_ref_belongs_to_source(&mut **tx, &entity_id, ref_id).await?;
            if !belongs {
                return Err(ApplyError::InvalidMutation(format!(
                    "entity_ref ref_id {ref_id:?} must exist and belong to the target Journal Entry"
                )));
            }
        }
    }

    let reference_ref_id = if kind == MutationKind::ReferenceExistingEntityFromJournalEntry {
        let target_entity_id = crate::entities::reference_target_entity_id(effective_payload)
            .ok_or_else(|| {
                ApplyError::InvalidMutation(
                    "reference_existing_entity_from_journal_entry requires a target entity id"
                        .to_string(),
                )
            })?;
        let label_snapshot = effective_payload
            .get("label_snapshot")
            .and_then(serde_json::Value::as_str);
        let proposed_ref_id = Uuid::now_v7().to_string();
        queries::insert_entity_ref(
            &mut **tx,
            &proposed_ref_id,
            &entity_id,
            target_entity_id,
            label_snapshot,
            now_ms,
        )
        .await?;
        Some(
            queries::entity_ref_id_for_source_target(&mut **tx, &entity_id, target_entity_id)
                .await?
                .ok_or_else(|| {
                    ApplyError::InvalidMutation(
                        "failed to create or find entity_ref for source and target".to_string(),
                    )
                })?,
        )
    } else {
        None
    };

    // The reference kind's stored data is the target Journal Entry's CURRENT body
    // with the new entity_ref placeholder rewritten to carry the freshly-minted
    // `ref_id`. It needs committed state + that ref id, so it is computed here
    // (the pre-write seam left it `None`); every other kind already has its data_str.
    if kind == MutationKind::ReferenceExistingEntityFromJournalEntry {
        let ref_id = reference_ref_id
            .as_deref()
            .expect("reference mutation creates or reuses an entity_ref");
        let current_data = queries::current_journal_entry_by_id(&mut **tx, &entity_id)
            .await?
            // The target Journal Entry vanished under the parked Proposal
            // (ADR-0033) — surface TargetMissing, not an opaque DB fault.
            .ok_or(ApplyError::TargetMissing)?
            .1;
        let current_data: serde_json::Value = serde_json::from_str(&current_data).map_err(|e| {
            ApplyError::InvalidMutation(format!("stored Journal Entry data is malformed JSON: {e}"))
        })?;
        if !current_data.is_object() {
            return Err(ApplyError::InvalidMutation(
                "stored Journal Entry data must be a JSON object".to_string(),
            ));
        }
        data_str = Some(
            crate::entities::reference_existing_entity_data_payload(
                &current_data,
                effective_payload,
                ref_id,
            )
            .to_string(),
        );
    }

    match kind {
        // delete_project is the ONE non-FK cascade (ADR-0031): project_id lives in
        // the Todo JSON, not an FK column. In THIS tx, unset project_id on every
        // owning Todo (rewriting each Todo's data + a new revision) FIRST, then
        // delete the Project entity. Only project_id is removed — the Todo's
        // title/note and its todo_person_refs are untouched. Handled ahead of the
        // generic delete arm so the plain delete does not also run for it.
        MutationKind::DeleteProject => {
            let affected = queries::todos_with_project(&mut **tx, &entity_id).await?;
            for (todo_id, todo_data) in affected {
                let mut data: serde_json::Map<String, serde_json::Value> =
                    serde_json::from_str(&todo_data).map_err(|e| {
                        ApplyError::InvalidMutation(format!("Todo data is not JSON: {e}"))
                    })?;
                data.remove("project_id");
                let new_data = serde_json::Value::Object(data).to_string();
                // The rewritten rows are TODOS, so stamp the Todo schema version —
                // NOT this mutation's entity_type (Project). This is the one site
                // where the cascade touches a different Entity Type than `kind`.
                let updated = queries::update_entity(
                    &mut **tx,
                    &todo_id,
                    EntityType::Todo.as_str(),
                    EntityType::Todo.schema_version(),
                    &new_data,
                    now_ms,
                )
                .await?;
                if updated != 1 {
                    // An owning Todo row vanished mid-cascade (ADR-0033 target-gone).
                    return Err(ApplyError::TargetMissing);
                }
                let next_seq = queries::next_entity_revision_seq(&mut **tx, &todo_id).await?;
                queries::insert_entity_revision(
                    &mut **tx,
                    &todo_id,
                    next_seq,
                    &new_data,
                    proposal_id,
                    now_ms,
                )
                .await?;
            }
            let deleted =
                queries::delete_entity(&mut **tx, &entity_id, entity_type.as_str()).await?;
            if deleted != 1 {
                // The target Project vanished under the parked Proposal (ADR-0033).
                return Err(ApplyError::TargetMissing);
            }
        }
        // Delete kinds (journal_entry, person, todo, bookmark): remove the entity
        // of this `entity_type`. Its revisions/sources and a Person's or Todo's
        // `todo_person_refs` rows cascade away via FK ON DELETE CASCADE — no
        // explicit ref-delete SQL here.
        MutationKind::DeleteJournalEntry
        | MutationKind::DeletePerson
        | MutationKind::DeleteTodo
        | MutationKind::DeleteBookmark => {
            let deleted =
                queries::delete_entity(&mut **tx, &entity_id, entity_type.as_str()).await?;
            if deleted != 1 {
                // The delete target vanished under the parked Proposal (ADR-0033).
                return Err(ApplyError::TargetMissing);
            }
        }
        // update_todo MERGES a Partial<TodoData> onto the current Todo, then
        // performs its ref ops, all in THIS tx (ADR-0031 atomicity). The merge
        // needs committed state, so it loads current data here rather than via
        // the pre-write `entity_data_payload` seam.
        MutationKind::UpdateTodo => {
            apply_update_todo(
                tx,
                &entity_id,
                effective_payload,
                schema_version,
                proposal_id,
                now_ms,
            )
            .await?;
        }
        // mark_project_reviewed READS the current Project, stamps the review
        // fields, and writes a new revision — all in THIS tx (ADR-0034). The
        // recompute needs committed state + the in-tx review-anchor offset, so it
        // loads current data here rather than via the pre-write seam.
        MutationKind::MarkProjectReviewed => {
            apply_mark_project_reviewed(
                tx,
                &entity_id,
                schema_version,
                proposal_id,
                now_ms,
                review_anchor_offset,
            )
            .await?;
        }
        // Update kinds (journal_entry, person, project, bookmark): replace the
        // target entity's data of this `entity_type` + append the next revision
        // snapshot. The journal-entry body-ref check above is gated to journal
        // kinds; person/project/bookmark carry no body refs.
        // `reference_existing_entity_from_journal_entry` also writes a new
        // revision of the target Journal Entry (the body rewritten above to carry
        // the new entity_ref placeholder), so it joins this update branch.
        MutationKind::UpdateJournalEntry
        | MutationKind::UpdatePerson
        | MutationKind::UpdateProject
        | MutationKind::UpdateBookmark
        | MutationKind::ReferenceExistingEntityFromJournalEntry => {
            let data_str = data_str
                .as_deref()
                .expect("non-delete mutations always carry entity data");
            let updated = queries::update_entity(
                &mut **tx,
                &entity_id,
                entity_type.as_str(),
                schema_version,
                data_str,
                now_ms,
            )
            .await?;
            if updated != 1 {
                // The update target vanished under the parked Proposal (ADR-0033).
                return Err(ApplyError::TargetMissing);
            }
            let next_seq = queries::next_entity_revision_seq(&mut **tx, &entity_id).await?;
            queries::insert_entity_revision(
                &mut **tx,
                &entity_id,
                next_seq,
                data_str,
                proposal_id,
                now_ms,
            )
            .await?;
        }
        // Create kinds (journal_entry, person, project, todo, bookmark): insert
        // the entity of this `entity_type` + its seq-1 revision. The query is
        // already generic on `entity_type`.
        MutationKind::CreateJournalEntry
        | MutationKind::CreatePerson
        | MutationKind::CreateProject
        | MutationKind::CreateTodo
        | MutationKind::CreateBookmark => {
            let data_str = data_str
                .as_deref()
                .expect("non-delete mutations always carry entity data");
            if kind == MutationKind::CreateTodo
                && let Some(todo) = effective_payload.get("todo")
            {
                // Re-check the new Todo's project link in THIS tx: a concurrent
                // delete_project could otherwise persist a dangling project_id
                // (ADR-0033). Auxiliary ref → InvalidMutation, not TargetMissing.
                recheck_todo_project_link(tx, todo).await?;
            }
            queries::insert_entity(
                &mut **tx,
                &entity_id,
                entity_type.as_str(),
                schema_version,
                data_str,
                created_by,
                proposal_id,
                now_ms,
            )
            .await?;
            queries::insert_entity_revision(
                &mut **tx,
                &entity_id,
                1,
                data_str,
                proposal_id,
                now_ms,
            )
            .await?;
            if kind == MutationKind::CreateTodo {
                // Persist the Todo's Person References (ADR-0031) in the SAME tx
                // so the refs are atomic with the Todo entity. They live in
                // `todo_person_refs`, NOT in the Todo JSON, so read them from the
                // proposal envelope (`effective_payload`), not the stored data.
                for (person_id, role) in deduped_person_refs(effective_payload) {
                    queries::insert_todo_person_ref(
                        &mut **tx, &entity_id, &person_id, role, now_ms,
                    )
                    .await?;
                }
            }
        }
    }

    // Write the already-resolved Entity Source row, if any. The run-coupled
    // resolution (which user Message, which Journal-Entry anchor) happened in the
    // caller; this layer just persists the descriptor (ADR-0030/0033).
    if let Some(source) = source {
        let source_row_id = Uuid::now_v7().to_string();
        match source {
            EntitySource::FromJournalEntry {
                journal_entry_id,
                relation,
            } => {
                queries::insert_entity_source_from_entity(
                    &mut **tx,
                    &source_row_id,
                    &entity_id,
                    &journal_entry_id,
                    &relation,
                    now_ms,
                )
                .await?;
            }
            EntitySource::FromMessage {
                message_id,
                relation,
            } => {
                queries::insert_entity_source_from_message(
                    &mut **tx,
                    &source_row_id,
                    &entity_id,
                    &message_id,
                    &relation,
                    now_ms,
                )
                .await?;
            }
        }
    }

    Ok(entity_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::SqlitePool;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    async fn memory_pool() -> SqlitePool {
        let options = SqliteConnectOptions::new()
            .filename(":memory:")
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("open in-memory sqlite");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        pool
    }

    /// Locks the new seam: a trivial `create_person` through
    /// `apply_entity_mutation` with the USER-path spec (`created_by='user'`,
    /// `proposal_id=None`, `source=None`) writes a canonical Entity with a NULL
    /// `created_via_proposal_id` and a seq-1 NULL-proposal revision — the shape
    /// slice 2's user path depends on. The caller owns the tx (begin/commit).
    #[tokio::test]
    async fn apply_entity_mutation_user_create_person_writes_null_proposal_row() {
        let pool = memory_pool().await;
        let mut tx = pool.begin().await.expect("begin");

        let entity_id = apply_entity_mutation(
            &mut tx,
            EntityMutationSpec {
                kind: MutationKind::CreatePerson,
                target_entity_id: None,
                payload: &serde_json::json!({ "name": "Alice" }),
                edited_payload: None,
                created_by: "user",
                proposal_id: None,
                source: None,
                now_ms: 42,
            },
        )
        .await
        .expect("apply user create_person");

        tx.commit().await.expect("commit");

        let (created_by, created_via): (String, Option<String>) = sqlx::query_as(
            "SELECT created_by, created_via_proposal_id FROM entities WHERE id = ?1",
        )
        .bind(&entity_id)
        .fetch_one(&pool)
        .await
        .expect("entity row");
        assert_eq!(created_by, "user");
        assert_eq!(
            created_via, None,
            "a user-authored Entity carries no proposal id"
        );

        let (seq, rev_proposal): (i64, Option<String>) =
            sqlx::query_as("SELECT seq, proposal_id FROM entity_revisions WHERE entity_id = ?1")
                .bind(&entity_id)
                .fetch_one(&pool)
                .await
                .expect("revision row");
        assert_eq!(seq, 1, "fresh Entity gets seq-1 revision");
        assert_eq!(
            rev_proposal, None,
            "a direct user edit writes a NULL-proposal revision"
        );

        let source_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM entity_sources WHERE entity_id = ?1")
                .bind(&entity_id)
                .fetch_one(&pool)
                .await
                .expect("count sources");
        assert_eq!(
            source_count, 0,
            "a plain user create writes no entity_source row"
        );
    }

    /// A user-path `create_*` spec through `apply_entity_mutation`, committed.
    /// Returns the minted entity id.
    async fn create(pool: &SqlitePool, kind: MutationKind, payload: serde_json::Value) -> String {
        let mut tx = pool.begin().await.expect("begin");
        let entity_id = apply_entity_mutation(
            &mut tx,
            EntityMutationSpec {
                kind,
                target_entity_id: None,
                payload: &payload,
                edited_payload: None,
                created_by: "user",
                proposal_id: None,
                source: None,
                now_ms: 1,
            },
        )
        .await
        .expect("create succeeds");
        tx.commit().await.expect("commit");
        entity_id
    }

    /// FIX #9: an `update_todo` whose target Todo has vanished surfaces
    /// `TargetMissing` (a user deleted it under the parked Proposal — ADR-0033),
    /// NOT `InvalidMutation`. Decide maps TargetMissing → NotDecidable (-32002),
    /// so the parked Run resolves cleanly rather than the model getting a -32602
    /// it would try to "fix".
    #[tokio::test]
    async fn update_todo_vanished_target_is_target_missing() {
        let pool = memory_pool().await;
        let mut tx = pool.begin().await.expect("begin");
        let missing_todo_id = Uuid::now_v7().to_string();

        let result = apply_entity_mutation(
            &mut tx,
            EntityMutationSpec {
                kind: MutationKind::UpdateTodo,
                target_entity_id: Some(&missing_todo_id),
                payload: &serde_json::json!({
                    "todo_id": missing_todo_id,
                    "todo": { "title": "Edited" }
                }),
                edited_payload: None,
                created_by: "user",
                proposal_id: None,
                source: None,
                now_ms: 1,
            },
        )
        .await;

        assert!(
            matches!(result, Err(ApplyError::TargetMissing)),
            "a vanished update_todo target is TargetMissing, not InvalidMutation: {result:?}"
        );
    }

    /// FIX #8 (create_todo): a `create_todo` carrying a `project_id` whose Project
    /// no longer exists at apply time persists no dangling link — the in-tx
    /// re-check returns `InvalidMutation` (project_id is an AUXILIARY ref, not the
    /// primary target, so -32602, not TargetMissing). Nothing is written.
    #[tokio::test]
    async fn create_todo_with_missing_project_is_invalid_mutation() {
        let pool = memory_pool().await;
        let missing_project_id = Uuid::now_v7().to_string();
        let mut tx = pool.begin().await.expect("begin");

        let result = apply_entity_mutation(
            &mut tx,
            EntityMutationSpec {
                kind: MutationKind::CreateTodo,
                target_entity_id: None,
                payload: &serde_json::json!({
                    "todo": { "title": "Ship it", "project_id": missing_project_id }
                }),
                edited_payload: None,
                created_by: "user",
                proposal_id: None,
                source: None,
                now_ms: 1,
            },
        )
        .await;

        assert!(
            matches!(result, Err(ApplyError::InvalidMutation(_))),
            "a create_todo with a vanished project_id is InvalidMutation: {result:?}"
        );
        drop(tx);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM entities")
            .fetch_one(&pool)
            .await
            .expect("count entities");
        assert_eq!(count, 0, "nothing is written when the project is gone");
    }

    /// FIX #8 (update_todo): an `update_todo` whose merged data carries a
    /// `project_id` whose Project was deleted in-tx surfaces `InvalidMutation`
    /// (auxiliary ref). Seeds a real Todo so the merge proceeds, then deletes the
    /// Project before the update so the in-tx re-check fires.
    #[tokio::test]
    async fn update_todo_with_deleted_project_is_invalid_mutation() {
        let pool = memory_pool().await;
        let project_id = create(
            &pool,
            MutationKind::CreateProject,
            serde_json::json!({ "name": "P" }),
        )
        .await;
        let todo_id = create(
            &pool,
            MutationKind::CreateTodo,
            serde_json::json!({ "todo": { "title": "Ship it" } }),
        )
        .await;

        // The Project is deleted out from under the pending update.
        sqlx::query("DELETE FROM entities WHERE id = ?1")
            .bind(&project_id)
            .execute(&pool)
            .await
            .expect("delete project");

        let mut tx = pool.begin().await.expect("begin");
        let result = apply_entity_mutation(
            &mut tx,
            EntityMutationSpec {
                kind: MutationKind::UpdateTodo,
                target_entity_id: Some(&todo_id),
                payload: &serde_json::json!({
                    "todo_id": todo_id,
                    "todo": { "project_id": project_id }
                }),
                edited_payload: None,
                created_by: "user",
                proposal_id: None,
                source: None,
                now_ms: 2,
            },
        )
        .await;

        assert!(
            matches!(result, Err(ApplyError::InvalidMutation(_))),
            "an update_todo linking a vanished project is InvalidMutation: {result:?}"
        );
    }

    /// Apply a `mark_project_reviewed` against `project_id` at `now_ms`, returning
    /// the apply result. Owns its own tx (begin/commit on success).
    async fn mark_reviewed(
        pool: &SqlitePool,
        project_id: &str,
        now_ms: i64,
    ) -> Result<(), ApplyError> {
        let mut tx = pool.begin().await.expect("begin");
        let result = apply_entity_mutation(
            &mut tx,
            EntityMutationSpec {
                kind: MutationKind::MarkProjectReviewed,
                target_entity_id: Some(project_id),
                payload: &serde_json::json!({ "entity_id": project_id }),
                edited_payload: None,
                created_by: "user",
                proposal_id: None,
                source: None,
                now_ms,
            },
        )
        .await
        .map(|_| ());
        if result.is_ok() {
            tx.commit().await.expect("commit");
        }
        result
    }

    async fn project_data(pool: &SqlitePool, id: &str) -> serde_json::Value {
        let data: String = sqlx::query_scalar("SELECT data FROM entities WHERE id = ?1")
            .bind(id)
            .fetch_one(pool)
            .await
            .expect("project row");
        serde_json::from_str(&data).expect("project data is JSON")
    }

    /// mark_project_reviewed stamps both review timestamps, advances next_review_at
    /// to a Sunday 20:00, seeds the weekly cadence when absent, preserves the
    /// Project's other fields, and appends a new revision (ADR-0034).
    #[tokio::test]
    async fn mark_project_reviewed_stamps_and_advances() {
        let pool = memory_pool().await;
        // An on-hold Project (no review fields, so create-time seeding does NOT
        // fire — only active Projects seed) exercises the absent-cadence default.
        let project_id = create(
            &pool,
            MutationKind::CreateProject,
            serde_json::json!({ "name": "Migrate DB", "outcome": "Done", "status": "on_hold" }),
        )
        .await;

        let before = project_data(&pool, &project_id).await;
        assert!(
            before.get("review_every").is_none(),
            "on-hold create seeds no review cadence: {before}"
        );

        // 2025-06-09T12:00:00Z is a Monday; next Sunday 20:00 local is 2025-06-15.
        let now_ms = 1_749_470_400_000;
        mark_reviewed(&pool, &project_id, now_ms)
            .await
            .expect("mark reviewed succeeds");

        let after = project_data(&pool, &project_id).await;
        assert_eq!(
            after["last_reviewed_at"].as_str(),
            Some(crate::entities::now_local(now_ms, 0).as_str()),
            "last_reviewed_at stamped to local now"
        );
        assert_eq!(
            after["next_review_at"].as_str(),
            Some("2025-06-15T20:00:00"),
            "next_review_at advanced to the next Sunday 20:00"
        );
        assert_eq!(
            after["review_every"],
            serde_json::json!({ "interval": 1, "unit": "week" }),
            "absent cadence materializes the weekly default"
        );
        assert_eq!(after["name"].as_str(), Some("Migrate DB"), "name preserved");
        assert_eq!(after["outcome"].as_str(), Some("Done"), "outcome preserved");
        assert_eq!(
            after["status"].as_str(),
            Some("on_hold"),
            "status preserved"
        );

        let max_seq: i64 =
            sqlx::query_scalar("SELECT MAX(seq) FROM entity_revisions WHERE entity_id = ?1")
                .bind(&project_id)
                .fetch_one(&pool)
                .await
                .expect("revision seq");
        assert_eq!(max_seq, 2, "review write appends a second revision");
    }

    /// mark_project_reviewed NORMALIZES a non-weekly cadence to weekly: the advance
    /// is always the Sunday anchor, so an agent-set monthly cadence must not survive
    /// (it would read "Every month" yet fall due in a week). ADR-0034.
    #[tokio::test]
    async fn mark_project_reviewed_normalizes_cadence_to_weekly() {
        let pool = memory_pool().await;
        let project_id = create(
            &pool,
            MutationKind::CreateProject,
            serde_json::json!({
                "name": "Quarterly OKRs",
                "review_every": { "interval": 1, "unit": "month" },
                "next_review_at": "2026-01-01T20:00:00",
            }),
        )
        .await;

        mark_reviewed(&pool, &project_id, 1_749_470_400_000)
            .await
            .expect("mark reviewed succeeds");

        let after = project_data(&pool, &project_id).await;
        assert_eq!(
            after["review_every"],
            serde_json::json!({ "interval": 1, "unit": "week" }),
            "a non-weekly cadence is normalized to weekly to match the always-Sunday advance"
        );
    }

    /// Reviewing ON a Sunday before 20:00 must advance to the FOLLOWING Sunday,
    /// not the same evening (ADR-0034 advance ≠ the create-time same-day seed).
    /// Regression for the deep-review correctness finding: a same-day next_review_at
    /// would re-enter the Review view hours later (web due predicate is
    /// `next_review_at <= now`).
    #[tokio::test]
    async fn mark_project_reviewed_on_sunday_afternoon_advances_a_full_week() {
        let pool = memory_pool().await;
        let project_id = create(
            &pool,
            MutationKind::CreateProject,
            serde_json::json!({ "name": "Weekly review", "status": "active" }),
        )
        .await;

        // 2025-06-15T12:00:00Z is a Sunday, well before the 20:00 anchor.
        let sunday_noon_ms = 1_749_988_800_000;
        mark_reviewed(&pool, &project_id, sunday_noon_ms)
            .await
            .expect("mark reviewed succeeds");

        let after = project_data(&pool, &project_id).await;
        assert_eq!(
            after["next_review_at"].as_str(),
            Some("2025-06-22T20:00:00"),
            "a Sunday-afternoon review advances to the NEXT Sunday, not today"
        );
    }

    /// mark_project_reviewed rejects a completed or dropped Project (not reviewable,
    /// ADR-0031) with InvalidMutation, writing nothing.
    #[tokio::test]
    async fn mark_project_reviewed_rejects_terminal_status() {
        for (status, ts_field) in [("completed", "completed_at"), ("dropped", "dropped_at")] {
            let pool = memory_pool().await;
            let project_id = create(
                &pool,
                MutationKind::CreateProject,
                serde_json::json!({
                    "name": "Old",
                    "status": status,
                    ts_field: "2026-01-01T09:00:00",
                }),
            )
            .await;

            let result = mark_reviewed(&pool, &project_id, 1_749_470_400_000).await;
            assert!(
                matches!(result, Err(ApplyError::InvalidMutation(_))),
                "a {status} project is not reviewable: {result:?}"
            );

            let after = project_data(&pool, &project_id).await;
            assert!(
                after.get("last_reviewed_at").is_none(),
                "a rejected review writes nothing: {after}"
            );
        }
    }

    /// mark_project_reviewed against a missing Project id surfaces TargetMissing.
    #[tokio::test]
    async fn mark_project_reviewed_missing_target() {
        let pool = memory_pool().await;
        let result = mark_reviewed(&pool, &Uuid::now_v7().to_string(), 1_749_470_400_000).await;
        assert!(
            matches!(result, Err(ApplyError::TargetMissing)),
            "a vanished Project is TargetMissing: {result:?}"
        );
    }
}
