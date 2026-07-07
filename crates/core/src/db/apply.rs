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
use crate::mutation::{
    EntityType, MutationKind, OBSERVATION_RELATIONS, ObservationRelation, WriteClass, WriteOp,
};

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
/// pre-write extraction/normalization seam, routed by the contract's
/// `write_class` facet and policy-driven in its bodies: each Entity Type
/// declares its `create_normalize` on the spec row; the shared update policy
/// lives at [`crate::mutation::UPDATE_NORMALIZE`]. The `now_ms`/`offset_minutes`
/// inputs anchor the Project review-date default.
///
/// The `InTx` kinds (`update_todo`/`mark_project_reviewed`/reference weave)
/// compute their data inside the tx — they never reach this seam — and the
/// `NoData` deletes touch no entity data; both store as-is here.
/// ApplyIntentGraph never reaches this single-entity seam — decide
/// short-circuits in slice 1, and slice 2's resolver loops
/// `apply_entity_mutation` per node (each node carrying its OWN single-entity
/// kind), never `apply_entity_mutation(ApplyIntentGraph)`.
fn entity_data_payload(
    kind: MutationKind,
    payload: &serde_json::Value,
    now_ms: i64,
    offset_minutes: i64,
) -> serde_json::Value {
    let desc = kind.describe();
    match desc.write_class {
        WriteClass::Normalized => {
            if desc.write_op == WriteOp::Create {
                // Create family: per-type policy on the spec row (extract →
                // strip → null-drop → post).
                desc.entity_type
                    .spec()
                    .create_normalize
                    .apply(payload, now_ms, offset_minutes)
            } else {
                // Full-replace update family: shared policy (strip entity_id +
                // source_journal_entry_id, null-clear).
                crate::mutation::UPDATE_NORMALIZE.apply(payload, now_ms, offset_minutes)
            }
        }
        WriteClass::NoData | WriteClass::InTx => payload.clone(),
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
    created_by: &str,
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

    // The PRE-merge status decides whether this write is a fresh completion: a
    // recurrence successor fires only on the transition INTO completed, so a
    // re-save of an already-completed Todo never re-spawns (ADR-0039).
    let prior_status = merged
        .get("status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("active")
        .to_string();

    if let Some(partial) = crate::entities::todo_envelope(payload).and_then(|t| t.as_object()) {
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

    // Recurrence: completing a recurring Todo spawns its next occurrence in THIS
    // tx (ADR-0039). Gate on the ACTIVE→completed transition specifically: a
    // re-save of an already-done Todo never re-spawns, and a dropped→completed
    // edit does NOT resurrect a series that dropping ended (the editor permits
    // that status change, clearing dropped_at). `merged` is the just-written
    // successor template (carrying the rule, project, dates).
    if prior_status == "active"
        && merged.get("status").and_then(serde_json::Value::as_str) == Some("completed")
        && merged.get("recurrence").is_some()
    {
        spawn_recurrence_successor(tx, todo_id, &merged, created_by, proposal_id, now_ms).await?;
    }

    Ok(())
}

/// Spawn the next occurrence of a just-completed recurring Todo (ADR-0039), in
/// the caller's tx so the completion and its successor are atomic. `completed` is
/// the merged data of the Todo that was just completed (its `recurrence` rule and
/// stable context are read from here). Computes the next dates via the pure
/// [`crate::recurrence`] math; when the series has ended (end condition reached),
/// does NOTHING. Otherwise inserts a fresh active Todo + its seq-1 revision and
/// copies every Todo Person Reference forward, inheriting the completing
/// mutation's `created_by`/`proposal_id`.
async fn spawn_recurrence_successor(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    completed_todo_id: &str,
    completed: &serde_json::Value,
    created_by: &str,
    proposal_id: Option<&str>,
    now_ms: i64,
) -> Result<(), ApplyError> {
    let rule = match completed.get("recurrence") {
        Some(rule) => rule,
        None => return Ok(()),
    };
    let defer_at = completed.get("defer_at").and_then(serde_json::Value::as_str);
    let due_at = completed.get("due_at").and_then(serde_json::Value::as_str);

    let Some(next) = crate::recurrence::next_occurrence(rule, defer_at, due_at) else {
        // The series has ended (until exceeded or after_count exhausted): no
        // successor. The completed Todo stays completed.
        return Ok(());
    };

    // Build the successor data from the completed Todo: carry title/note/
    // project_id/recurrence forward, reset to active, set the advanced dates, and
    // drop the resolution timestamps (a fresh occurrence is freshly active).
    let mut data = completed
        .as_object()
        .cloned()
        .unwrap_or_default();
    data.insert("status".to_string(), serde_json::json!("active"));
    data.remove("completed_at");
    data.remove("dropped_at");
    data.insert("recurrence".to_string(), next.recurrence);
    set_or_remove(&mut data, "defer_at", next.defer_at);
    set_or_remove(&mut data, "due_at", next.due_at);

    let successor = serde_json::Value::Object(data);
    // Defense in depth: the successor must be a valid Todo before it is written
    // (the recompute must not persist an invalid entity — mirrors
    // apply_mark_project_reviewed).
    crate::entities::validate_todo_data(&successor).map_err(ApplyError::InvalidMutation)?;
    let data_str = successor.to_string();

    let successor_id = Uuid::now_v7().to_string();
    queries::insert_entity(
        &mut **tx,
        &successor_id,
        EntityType::Todo.as_str(),
        EntityType::Todo.schema_version(),
        &data_str,
        created_by,
        proposal_id,
        now_ms,
    )
    .await?;
    queries::insert_entity_revision(&mut **tx, &successor_id, 1, &data_str, proposal_id, now_ms)
        .await?;

    // Carry every Todo Person Reference forward, role preserved (ADR-0039): the
    // rule is a repeating template and its People are part of it.
    let refs = queries::person_refs_by_todo(&mut **tx, completed_todo_id).await?;
    for (person_id, role) in refs {
        queries::insert_todo_person_ref(&mut **tx, &successor_id, &person_id, &role, now_ms)
            .await?;
    }

    Ok(())
}

/// Set `key` to `value` when present, else remove it — the successor mirrors the
/// completed Todo's date presence (an absent anchor stays absent).
fn set_or_remove(
    data: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    value: Option<String>,
) {
    match value {
        Some(v) => {
            data.insert(key.to_string(), serde_json::Value::String(v));
        }
        None => {
            data.remove(key);
        }
    }
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
        serde_json::json!(crate::localtime::now_local(now_ms, offset_minutes)),
    );
    // Advance (not seed): always the NEXT Sunday strictly after now, so a Project
    // reviewed on a Sunday afternoon does not re-enter the Review view that same
    // evening (ADR-0034). `next_review_at_local` is the create-time SEED variant.
    data.insert(
        "next_review_at".to_string(),
        serde_json::json!(crate::localtime::advance_review_at_local(
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

async fn textualize_journal_refs_targeting_deleted_entity(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    target_entity_id: &str,
    proposal_id: Option<&str>,
    now_ms: i64,
) -> Result<(), ApplyError> {
    let refs = queries::journal_entry_refs_targeting(&mut **tx, target_entity_id).await?;
    for (ref_id, journal_entry_id, journal_data, label) in refs {
        let mut data: serde_json::Value = serde_json::from_str(&journal_data).map_err(|e| {
            ApplyError::InvalidMutation(format!("Journal Entry data is not JSON: {e}"))
        })?;
        let Some(body) = data
            .get_mut("body")
            .and_then(serde_json::Value::as_array_mut)
        else {
            return Err(ApplyError::InvalidMutation(
                "Journal Entry data must contain a body array".to_string(),
            ));
        };
        for node in body {
            let is_deleted_ref = node.get("type").and_then(serde_json::Value::as_str)
                == Some("entity_ref")
                && node.get("ref_id").and_then(serde_json::Value::as_str) == Some(ref_id.as_str());
            if is_deleted_ref {
                *node = serde_json::json!({ "type": "text", "text": label });
            }
        }
        let new_data = data.to_string();
        let updated = queries::update_entity(
            &mut **tx,
            &journal_entry_id,
            EntityType::JournalEntry.as_str(),
            EntityType::JournalEntry.schema_version(),
            &new_data,
            now_ms,
        )
        .await?;
        if updated != 1 {
            return Err(ApplyError::TargetMissing);
        }
        let next_seq = queries::next_entity_revision_seq(&mut **tx, &journal_entry_id).await?;
        queries::insert_entity_revision(
            &mut **tx,
            &journal_entry_id,
            next_seq,
            &new_data,
            proposal_id,
            now_ms,
        )
        .await?;
    }
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

    // `apply_entity_mutation` is the SINGLE-ENTITY write core. The intent graph
    // (ADR-0042) is not a single-entity mutation: its slice-2 resolver loops THIS
    // function once per resolved node (each with its own single-entity kind), and
    // is never called with `ApplyIntentGraph` itself. Reject it here so the
    // routing below (the `write_class` data seam and the in-tx write dispatch)
    // stays over single-entity kinds and a graph that somehow reaches here fails
    // loud rather than mis-applying. (Slice 1 decide short-circuits before
    // apply, so this is unreached today.)
    if kind == MutationKind::ApplyIntentGraph {
        return Err(ApplyError::InvalidMutation(
            "apply_intent_graph is not a single-entity mutation".to_string(),
        ));
    }

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
    // data, routed by the contract's `write_class` facet. `NoData` deletes touch
    // no entity data; the `InTx` kinds compute their data inside the tx below,
    // not at this seam — `update_todo` MERGES against current DB state,
    // `mark_project_reviewed` recomputes from current state, and the
    // `reference_existing_entity_from_journal_entry` kind rewrites the target
    // Journal Entry body against current state (it needs the freshly-minted
    // entity_ref id). A new Entity Type must DECLARE its `write_class` in
    // `describe()` — it cannot silently default to the pre-write
    // `entity_data_payload` path, which would be wrong for a new in-tx-computed
    // kind. (The reference weave is a WriteOp::Update, so `write_op` alone could
    // not express this.) ApplyIntentGraph's facet value is never read: the graph
    // is rejected at the guard above (ADR-0042).
    let mut data_str = match desc.write_class {
        WriteClass::NoData | WriteClass::InTx => None,
        WriteClass::Normalized => Some(
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

    // The in-tx write dispatch: the THREE kinds with irreducibly per-kind write
    // bodies keep named arms (DeleteProject's cascade, UpdateTodo's merge,
    // MarkProjectReviewed's recompute — the residual in-tx dispatch the write
    // contract deliberately leaves here), ApplyIntentGraph keeps its
    // unreachable-after-guard arm, and every other kind routes generically by
    // the contract's `write_op`.
    match kind {
        // delete_project is the ONE non-FK cascade (ADR-0031): project_id lives in
        // the Todo JSON, not an FK column. In THIS tx, unset project_id on every
        // owning Todo (rewriting each Todo's data + a new revision) FIRST, then
        // delete the Project entity. Only project_id is removed — the Todo's
        // title/note and its todo_person_refs are untouched. Named ahead of the
        // generic delete arm so the plain delete does not also run for it.
        MutationKind::DeleteProject => {
            textualize_journal_refs_targeting_deleted_entity(tx, &entity_id, proposal_id, now_ms)
                .await?;
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
                created_by,
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
        // Rejected at the guard above (the graph is not a single-entity
        // mutation) — named BEFORE the generic write_op arms so its
        // `write_op: Create` cannot route it onto the create path.
        MutationKind::ApplyIntentGraph => {
            unreachable!("apply_intent_graph is rejected before this seam")
        }
        // Every remaining kind routes generically by the contract's `write_op`
        // (an exhaustive inner match — a new WriteOp variant must declare its
        // write body here; a new KIND is forced through `describe()`'s contract
        // block instead of this dispatch). TRAP for a future `InTx` kind: an
        // InTx kind reaching these generic Update/Create arms must have
        // computed its `data_str` BEFORE this match — the reference weave does,
        // in its pre-match blocks above. A new InTx kind without that hits the
        // "carry entity data" expect below; give it a named arm instead. (No
        // blanket InTx guard here: the weave legitimately rides the generic
        // update arm.)
        _ => match desc.write_op {
            // Generic delete (journal_entry, person, todo, media, habit): remove
            // the entity of this `entity_type`. Its revisions/sources and a
            // Person's or Todo's `todo_person_refs` rows cascade away via FK ON
            // DELETE CASCADE — no explicit ref-delete SQL here. (delete_project
            // took its named cascade arm above.)
            WriteOp::Delete => {
                // Surface a gone/wrong-type target as TargetMissing BEFORE the
                // descriptor-block below — otherwise a future `OBSERVATION_RELATIONS`
                // entry targeting another entity type could report `InvalidMutation`
                // for a missing target that only appears in observation history,
                // which would also force re-touching this guard per new descriptor.
                // (Other delete kinds otherwise get TargetMissing from `delete_entity`'s
                // rowcount below; this just moves that check earlier, behavior-preserving.)
                if !queries::entity_is_type(&mut **tx, &entity_id, entity_type.as_str()).await? {
                    return Err(ApplyError::TargetMissing);
                }
                // Descriptor-driven delete-block (ADR-0053): deleting an Entity is
                // blocked while any relation-bearing observation — current row OR
                // historical revision — still references it. The blocking schemas are
                // the `OBSERVATION_RELATIONS` whose `target` is this `entity_type`;
                // today only habit.checkin→Habit exists, so only DeleteHabit is
                // affected (every other delete kind gets an empty subset → skipped).
                let relations: Vec<ObservationRelation> = OBSERVATION_RELATIONS
                    .iter()
                    .filter(|relation| relation.target == entity_type)
                    .copied()
                    .collect();
                if !relations.is_empty()
                    && queries::entity_referenced_by_observation(&mut **tx, &entity_id, &relations)
                        .await?
                {
                    return Err(ApplyError::InvalidMutation(format!(
                        "delete_{0} is blocked while observations reference the {0}",
                        entity_type.as_str()
                    )));
                }
                // A deleted REFERENCEABLE Entity may be woven into Journal Entry
                // bodies as entity_refs — textualize those to their label snapshots.
                // Within this arm referenceable = exactly Person and Todo (Project
                // takes the named cascade arm above; journal/media/habit types are
                // not referenceable).
                if desc.entity_type.is_referenceable() {
                    textualize_journal_refs_targeting_deleted_entity(
                        tx,
                        &entity_id,
                        proposal_id,
                        now_ms,
                    )
                    .await?;
                }
                let deleted =
                    queries::delete_entity(&mut **tx, &entity_id, entity_type.as_str()).await?;
                if deleted != 1 {
                    // The delete target vanished under the parked Proposal (ADR-0033).
                    return Err(ApplyError::TargetMissing);
                }
            }
            // Generic update (journal_entry, person, project, media, habit):
            // replace the target entity's data of this `entity_type` + append
            // the next revision snapshot. The journal-entry body-ref check above
            // is gated to journal kinds; person/project/media carry no body
            // refs. `reference_existing_entity_from_journal_entry` is a
            // `WriteOp::Update` too, so it joins this branch (its data_str was
            // rewritten above to carry the new entity_ref placeholder);
            // update_todo and mark_project_reviewed took their named in-tx arms
            // above.
            WriteOp::Update => {
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
            // Generic create (journal_entry, person, project, todo, media,
            // habit): insert the entity of this `entity_type` + its seq-1
            // revision. The query is already generic on `entity_type`; the
            // CreateTodo-only blocks inside are per-kind residuals (the
            // envelope's refs live outside entity data).
            WriteOp::Create => {
                let data_str = data_str
                    .as_deref()
                    .expect("non-delete mutations always carry entity data");
                if kind == MutationKind::CreateTodo
                    && let Some(todo) = crate::entities::todo_envelope(effective_payload)
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
        },
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
    use serde_json::json;
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

    // ─── entity_data_payload: pure per-kind default-injection / normalization ──
    //
    // `entity_data_payload` is the pool-free pre-write seam that shapes the stored
    // `entities.data` for each kind. These `#[test]`s pin its contract WITHOUT a
    // pool or transaction (the 23 #[tokio::test]s below only observe it indirectly
    // through a full write): default-injection, envelope unwrap, transport-field
    // strip, and sentinel-null clear.

    // A fixed non-Sunday instant so the seeded review anchor is deterministic:
    // 2025-06-09T12:00:00Z (Monday) ⇒ the coming Sunday 2025-06-15 at 20:00.
    const MON_NOON_MS: i64 = 1_749_470_400_000;

    #[test]
    fn create_project_injects_active_status_and_seeds_weekly_review() {
        let data = entity_data_payload(
            MutationKind::CreateProject,
            &json!({ "name": "Roadmap" }),
            MON_NOON_MS,
            0,
        );
        assert_eq!(data["status"], json!("active"), "absent status ⇒ active");
        assert_eq!(
            data["review_every"],
            json!({ "interval": 1, "unit": "week" }),
            "active Project with no review fields seeds the weekly ritual"
        );
        assert_eq!(
            data["next_review_at"], json!("2025-06-15T20:00:00"),
            "review anchor seeded from now_ms/offset (coming Sunday 20:00)"
        );
    }

    #[test]
    fn create_project_non_active_does_not_seed_review() {
        let data = entity_data_payload(
            MutationKind::CreateProject,
            &json!({ "name": "Someday", "status": "on_hold" }),
            MON_NOON_MS,
            0,
        );
        assert_eq!(data["status"], json!("on_hold"), "explicit status preserved");
        assert!(
            data.get("review_every").is_none() && data.get("next_review_at").is_none(),
            "only an active Project seeds the review ritual"
        );
    }

    #[test]
    fn create_project_respects_supplied_review_fields() {
        let data = entity_data_payload(
            MutationKind::CreateProject,
            &json!({
                "name": "Roadmap",
                "review_every": { "interval": 2, "unit": "week" },
                "next_review_at": "2025-07-06T20:00:00"
            }),
            MON_NOON_MS,
            0,
        );
        // Supplied review fields are not overwritten by the default seed.
        assert_eq!(data["review_every"], json!({ "interval": 2, "unit": "week" }));
        assert_eq!(data["next_review_at"], json!("2025-07-06T20:00:00"));
    }

    #[test]
    fn create_todo_unwraps_envelope_and_injects_active_status() {
        let data = entity_data_payload(
            MutationKind::CreateTodo,
            &json!({
                "todo": { "title": "Buy milk" },
                "person_refs": [{ "person_id": "p1", "role": "related" }]
            }),
            MON_NOON_MS,
            0,
        );
        assert_eq!(data["title"], json!("Buy milk"), "stores payload.todo, not the envelope");
        assert_eq!(data["status"], json!("active"), "absent status ⇒ active");
        // person_refs persist separately; they must NOT bleed into entities.data.
        assert!(data.get("person_refs").is_none(), "person_refs are not entity data");
        assert!(data.get("todo").is_none(), "the envelope wrapper is unwrapped away");
    }

    #[test]
    fn create_todo_preserves_explicit_status() {
        let data = entity_data_payload(
            MutationKind::CreateTodo,
            &json!({ "todo": { "title": "Ship it", "status": "waiting" } }),
            MON_NOON_MS,
            0,
        );
        assert_eq!(data["status"], json!("waiting"), "explicit status not overwritten");
    }

    #[test]
    fn update_kind_strips_entity_id_and_transport_and_clears_sentinel_null() {
        let data = entity_data_payload(
            MutationKind::UpdatePerson,
            &json!({
                "entity_id": "person-123",
                "source_journal_entry_id": "je-9",
                "name": "Alice",
                "note": null
            }),
            MON_NOON_MS,
            0,
        );
        assert!(data.get("entity_id").is_none(), "entity_id targets the row, not data");
        assert!(
            data.get("source_journal_entry_id").is_none(),
            "create-only provenance transport field never persists into update data"
        );
        assert!(
            data.get("note").is_none(),
            "sentinel-null optional (ADR-0033) drops the key rather than storing JSON null"
        );
        assert_eq!(data["name"], json!("Alice"), "real fields survive");
    }

    #[test]
    fn create_media_drops_null_optionals_with_no_defaults() {
        let data = entity_data_payload(
            MutationKind::CreateMedia,
            &json!({ "title": "Dune", "medium": "book", "state": "backlog", "note": null }),
            MON_NOON_MS,
            0,
        );
        assert!(data.get("note").is_none(), "null optional dropped");
        assert_eq!(data["title"], json!("Dune"));
        assert_eq!(data["state"], json!("backlog"), "no default injection for media");
    }

    #[test]
    fn delete_and_intx_kinds_store_payload_as_is() {
        // Delete + in-tx kinds never inject/normalize at this seam — they pass the
        // payload through verbatim (the in-tx kinds compute their data inside the tx).
        for kind in [
            MutationKind::DeletePerson,
            MutationKind::UpdateTodo,
            MutationKind::MarkProjectReviewed,
            MutationKind::CreateJournalEntry,
            MutationKind::ApplyIntentGraph,
        ] {
            let payload = json!({ "entity_id": "x", "note": null, "arbitrary": 1 });
            assert_eq!(
                entity_data_payload(kind, &payload, MON_NOON_MS, 0),
                payload,
                "{kind:?} stores its payload as-is (no strip/inject/clear)"
            );
        }
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

    #[tokio::test]
    async fn delete_habit_vanished_target_with_stale_checkin_is_target_missing() {
        let pool = memory_pool().await;
        let missing_habit_id = Uuid::now_v7().to_string();
        sqlx::query(
            "INSERT INTO observations \
             (id, schema_key, schema_version, occurred_at, values_json, created_by, \
              created_at, updated_at) \
             VALUES (?1, 'habit.checkin', 1, '2026-06-01T07:30:00', ?2, 'user', 1, 1)",
        )
        .bind(Uuid::now_v7().to_string())
        .bind(serde_json::json!({
            "habit_id": missing_habit_id,
            "state": "done"
        })
        .to_string())
        .execute(&pool)
        .await
        .expect("insert stale check-in");

        let mut tx = pool.begin().await.expect("begin");
        let result = apply_entity_mutation(
            &mut tx,
            EntityMutationSpec {
                kind: MutationKind::DeleteHabit,
                target_entity_id: Some(&missing_habit_id),
                payload: &serde_json::json!({ "entity_id": missing_habit_id }),
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
            "a vanished Habit target stays TargetMissing even if stale check-ins reference it: {result:?}"
        );
    }

    #[tokio::test]
    async fn delete_habit_rejects_historical_checkin_revision_reference() {
        let pool = memory_pool().await;
        let original_habit_id = create(
            &pool,
            MutationKind::CreateHabit,
            serde_json::json!({
                "name": "Original habit",
                "cadence": { "interval": 1, "unit": "day" }
            }),
        )
        .await;
        let corrected_habit_id = create(
            &pool,
            MutationKind::CreateHabit,
            serde_json::json!({
                "name": "Corrected habit",
                "cadence": { "interval": 1, "unit": "day" }
            }),
        )
        .await;
        let observation_id = Uuid::now_v7().to_string();
        let original_values = serde_json::json!({
            "habit_id": original_habit_id,
            "state": "done"
        })
        .to_string();
        let corrected_values = serde_json::json!({
            "habit_id": corrected_habit_id,
            "state": "skipped"
        })
        .to_string();
        sqlx::query(
            "INSERT INTO observations \
             (id, schema_key, schema_version, occurred_at, values_json, created_by, \
              created_at, updated_at) \
             VALUES (?1, 'habit.checkin', 1, '2026-06-02T07:30:00', ?2, 'user', 1, 2)",
        )
        .bind(&observation_id)
        .bind(&corrected_values)
        .execute(&pool)
        .await
        .expect("insert corrected current check-in");
        sqlx::query(
            "INSERT INTO observation_revisions \
             (observation_id, seq, schema_key, schema_version, occurred_at, values_json, created_at) \
             VALUES \
             (?1, 1, 'habit.checkin', 1, '2026-06-01T07:30:00', ?2, 1), \
             (?1, 2, 'habit.checkin', 1, '2026-06-02T07:30:00', ?3, 2)",
        )
        .bind(&observation_id)
        .bind(&original_values)
        .bind(&corrected_values)
        .execute(&pool)
        .await
        .expect("insert revision history");

        let mut tx = pool.begin().await.expect("begin");
        let result = apply_entity_mutation(
            &mut tx,
            EntityMutationSpec {
                kind: MutationKind::DeleteHabit,
                target_entity_id: Some(&original_habit_id),
                payload: &serde_json::json!({ "entity_id": original_habit_id }),
                edited_payload: None,
                created_by: "user",
                proposal_id: None,
                source: None,
                now_ms: 3,
            },
        )
        .await;

        assert!(
            matches!(result, Err(ApplyError::InvalidMutation(_))),
            "delete_habit is blocked by historical habit.checkin revisions: {result:?}"
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
            Some(crate::localtime::now_local(now_ms, 0).as_str()),
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

    // ─── recurrence successor generation (ADR-0039) ────────────────────────

    /// Apply an `update_todo` with the given partial, authored by
    /// `created_by`/`proposal_id`, committing on success. Returns the apply result.
    async fn update_todo(
        pool: &SqlitePool,
        todo_id: &str,
        partial: serde_json::Value,
        created_by: &str,
        proposal_id: Option<&str>,
        now_ms: i64,
    ) -> Result<(), ApplyError> {
        let mut tx = pool.begin().await.expect("begin");
        let result = apply_entity_mutation(
            &mut tx,
            EntityMutationSpec {
                kind: MutationKind::UpdateTodo,
                target_entity_id: Some(todo_id),
                payload: &serde_json::json!({ "todo_id": todo_id, "todo": partial }),
                edited_payload: None,
                created_by,
                proposal_id,
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

    async fn todo_data(pool: &SqlitePool, id: &str) -> serde_json::Value {
        let data: String = sqlx::query_scalar("SELECT data FROM entities WHERE id = ?1")
            .bind(id)
            .fetch_one(pool)
            .await
            .expect("todo row");
        serde_json::from_str(&data).expect("todo data is JSON")
    }

    /// Every todo row OTHER than `original_id`, as parsed data — the successor(s).
    async fn other_todos(pool: &SqlitePool, original_id: &str) -> Vec<serde_json::Value> {
        let rows: Vec<(String, String)> =
            sqlx::query_as("SELECT id, data FROM entities WHERE type = 'todo' AND id != ?1")
                .bind(original_id)
                .fetch_all(pool)
                .await
                .expect("query todos");
        rows.into_iter()
            .map(|(_, data)| serde_json::from_str(&data).expect("todo data is JSON"))
            .collect()
    }

    /// Seed the FK chain (thread → run → user message → tool_call → accepted
    /// proposal) so an entity can carry `created_via_proposal_id` on the agent
    /// path. Returns the proposal id. Adapted from decide.rs's `seed_parked_proposal`.
    async fn seed_accepted_proposal(pool: &SqlitePool) -> String {
        let run = Uuid::now_v7().to_string();
        let thread = format!("thr-{run}");
        let user_msg = format!("umsg-{run}");
        let tool_call_id = format!("tc-{run}");
        let proposal_id = Uuid::now_v7().to_string();
        let mut tx = pool.begin().await.expect("begin seed");

        sqlx::query(
            "INSERT INTO threads (id, title, created_at, last_activity_at) VALUES (?, 't', 1, 1)",
        )
        .bind(&thread)
        .execute(&mut *tx)
        .await
        .expect("insert thread");
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, \
              thinking_level, user_message_id, status, started_at) \
             VALUES (?, ?, 'w', '1', 'p', 'm', 'off', ?, 'parked', 1)",
        )
        .bind(&run)
        .bind(&thread)
        .bind(&user_msg)
        .execute(&mut *tx)
        .await
        .expect("insert run");
        sqlx::query(
            "INSERT INTO messages (id, thread_id, run_id, role, status, created_at, updated_at) \
             VALUES (?, ?, ?, 'user', 'completed', 1, 1)",
        )
        .bind(&user_msg)
        .bind(&thread)
        .bind(&run)
        .execute(&mut *tx)
        .await
        .expect("insert user message");
        sqlx::query(
            "INSERT INTO tool_calls (id, run_id, name, request_payload, status, requested_at) \
             VALUES (?, ?, 'propose_workspace_mutation', '{}', 'pending', 1)",
        )
        .bind(&tool_call_id)
        .bind(&run)
        .execute(&mut *tx)
        .await
        .expect("insert tool_call");
        sqlx::query(
            "INSERT INTO proposals (id, tool_call_id, mutation_kind, status) \
             VALUES (?, ?, 'update_todo', 'accepted')",
        )
        .bind(&proposal_id)
        .bind(&tool_call_id)
        .execute(&mut *tx)
        .await
        .expect("insert proposal");
        tx.commit().await.expect("commit seed");
        proposal_id
    }

    /// Completing a recurring Todo spawns ONE successor with the advanced anchor
    /// date, the original's project_id carried forward, and the original left
    /// completed. The canonical happy path (ADR-0039).
    #[tokio::test]
    async fn completing_recurring_todo_spawns_successor() {
        let pool = memory_pool().await;
        let project_id = create(
            &pool,
            MutationKind::CreateProject,
            serde_json::json!({ "name": "Ops" }),
        )
        .await;
        let todo_id = create(
            &pool,
            MutationKind::CreateTodo,
            serde_json::json!({
                "todo": {
                    "title": "Weekly report",
                    "due_at": "2026-06-19T17:00:00",
                    "project_id": project_id,
                    "recurrence": { "interval": 1, "unit": "week", "anchor": "due_at" }
                }
            }),
        )
        .await;

        update_todo(
            &pool,
            &todo_id,
            serde_json::json!({ "status": "completed", "completed_at": "2026-06-19T18:00:00" }),
            "user",
            None,
            100,
        )
        .await
        .expect("completion succeeds");

        // The original stays completed.
        let original = todo_data(&pool, &todo_id).await;
        assert_eq!(original["status"].as_str(), Some("completed"));

        // Exactly one successor, active, with the advanced due date + carried project.
        let successors = other_todos(&pool, &todo_id).await;
        assert_eq!(successors.len(), 1, "exactly one successor spawned");
        let successor = &successors[0];
        assert_eq!(successor["status"].as_str(), Some("active"));
        assert_eq!(
            successor["title"].as_str(),
            Some("Weekly report"),
            "title carried forward"
        );
        assert_eq!(
            successor["due_at"].as_str(),
            Some("2026-06-26T17:00:00"),
            "due advanced one week"
        );
        assert_eq!(
            successor["project_id"].as_str(),
            Some(project_id.as_str()),
            "project carried forward"
        );
        assert!(
            successor.get("completed_at").is_none(),
            "the successor is freshly active, no completed_at: {successor}"
        );
        assert_eq!(
            successor["recurrence"],
            serde_json::json!({ "interval": 1, "unit": "week", "anchor": "due_at" }),
            "the rule carries forward"
        );
    }

    /// The successor carries every Todo Person Reference forward, role preserved
    /// (ADR-0039), and inherits the completing mutation's authorship
    /// (created_by='proposal' + the proposal_id) on the agent path.
    #[tokio::test]
    async fn successor_carries_refs_and_inherits_proposal_authorship() {
        let pool = memory_pool().await;
        let alice = create(
            &pool,
            MutationKind::CreatePerson,
            serde_json::json!({ "name": "Alice" }),
        )
        .await;
        let bob = create(
            &pool,
            MutationKind::CreatePerson,
            serde_json::json!({ "name": "Bob" }),
        )
        .await;
        let todo_id = create(
            &pool,
            MutationKind::CreateTodo,
            serde_json::json!({
                "todo": {
                    "title": "Sync",
                    "due_at": "2026-06-19T17:00:00",
                    "recurrence": { "interval": 2, "unit": "day", "anchor": "due_at" }
                },
                "person_refs": [
                    { "person_id": alice, "role": "waiting_on" },
                    { "person_id": bob, "role": "related" }
                ]
            }),
        )
        .await;

        // Seed the FK chain (thread → run → message → tool_call → proposal) so the
        // successor's `created_via_proposal_id` FK holds, then complete via the
        // agent path (created_by='proposal').
        let proposal_id = seed_accepted_proposal(&pool).await;

        update_todo(
            &pool,
            &todo_id,
            serde_json::json!({ "status": "completed", "completed_at": "2026-06-19T18:00:00" }),
            "proposal",
            Some(&proposal_id),
            100,
        )
        .await
        .expect("completion succeeds");

        let successors = other_todos(&pool, &todo_id).await;
        assert_eq!(successors.len(), 1);
        let successor_id: String = sqlx::query_scalar(
            "SELECT id FROM entities WHERE type = 'todo' AND id != ?1",
        )
        .bind(&todo_id)
        .fetch_one(&pool)
        .await
        .expect("successor id");

        // Authorship inherited from the completing proposal.
        let (created_by, created_via): (String, Option<String>) = sqlx::query_as(
            "SELECT created_by, created_via_proposal_id FROM entities WHERE id = ?1",
        )
        .bind(&successor_id)
        .fetch_one(&pool)
        .await
        .expect("successor row");
        assert_eq!(created_by, "proposal");
        assert_eq!(created_via.as_deref(), Some(proposal_id.as_str()));

        // Both refs carried forward, roles preserved.
        let mut refs: Vec<(String, String)> =
            sqlx::query_as("SELECT person_id, role FROM todo_person_refs WHERE todo_id = ?1")
                .bind(&successor_id)
                .fetch_all(&pool)
                .await
                .expect("successor refs");
        refs.sort();
        let mut expected = vec![
            (alice, "waiting_on".to_string()),
            (bob, "related".to_string()),
        ];
        expected.sort();
        assert_eq!(refs, expected, "both refs carried forward with roles");
    }

    /// Completing a NON-recurring Todo spawns no successor.
    #[tokio::test]
    async fn completing_non_recurring_todo_spawns_nothing() {
        let pool = memory_pool().await;
        let todo_id = create(
            &pool,
            MutationKind::CreateTodo,
            serde_json::json!({ "todo": { "title": "One-off", "due_at": "2026-06-19T17:00:00" } }),
        )
        .await;

        update_todo(
            &pool,
            &todo_id,
            serde_json::json!({ "status": "completed", "completed_at": "2026-06-19T18:00:00" }),
            "user",
            None,
            100,
        )
        .await
        .expect("completion succeeds");

        assert!(
            other_todos(&pool, &todo_id).await.is_empty(),
            "a non-recurring Todo spawns no successor"
        );
    }

    /// DROPPING a recurring Todo ends the series — no successor (ADR-0039).
    #[tokio::test]
    async fn dropping_recurring_todo_spawns_nothing() {
        let pool = memory_pool().await;
        let todo_id = create(
            &pool,
            MutationKind::CreateTodo,
            serde_json::json!({
                "todo": {
                    "title": "Stop me",
                    "due_at": "2026-06-19T17:00:00",
                    "recurrence": { "interval": 1, "unit": "week", "anchor": "due_at" }
                }
            }),
        )
        .await;

        update_todo(
            &pool,
            &todo_id,
            serde_json::json!({ "status": "dropped", "dropped_at": "2026-06-19T18:00:00" }),
            "user",
            None,
            100,
        )
        .await
        .expect("drop succeeds");

        assert!(
            other_todos(&pool, &todo_id).await.is_empty(),
            "dropping a recurring Todo ends the series"
        );
    }

    /// Re-completing a DROPPED recurring Todo (the editor allows dropped→completed,
    /// clearing dropped_at) must NOT resurrect the series: generation fires only on
    /// the ACTIVE→completed transition (PR #172 review). Seeds a dropped recurring
    /// Todo, then completes it; no successor.
    #[tokio::test]
    async fn completing_a_dropped_recurring_todo_spawns_nothing() {
        let pool = memory_pool().await;
        let todo_id = create(
            &pool,
            MutationKind::CreateTodo,
            serde_json::json!({
                "todo": {
                    "title": "Was dropped",
                    "status": "dropped",
                    "dropped_at": "2026-06-19T18:00:00",
                    "due_at": "2026-06-19T17:00:00",
                    "recurrence": { "interval": 1, "unit": "week", "anchor": "due_at" }
                }
            }),
        )
        .await;

        // dropped → completed: clear dropped_at, set completed_at (the editor's
        // three-way merge for a status change).
        update_todo(
            &pool,
            &todo_id,
            serde_json::json!({
                "status": "completed",
                "completed_at": "2026-06-20T09:00:00",
                "dropped_at": null
            }),
            "user",
            None,
            100,
        )
        .await
        .expect("re-complete succeeds");

        assert!(
            other_todos(&pool, &todo_id).await.is_empty(),
            "dropped→completed does not resurrect the series — only active→completed spawns"
        );
    }

    /// Re-saving an already-completed recurring Todo never spawns a SECOND
    /// successor: generation fires only on the transition into completed (ADR-0039).
    #[tokio::test]
    async fn re_saving_completed_recurring_todo_spawns_no_second_successor() {
        let pool = memory_pool().await;
        let todo_id = create(
            &pool,
            MutationKind::CreateTodo,
            serde_json::json!({
                "todo": {
                    "title": "Weekly",
                    "due_at": "2026-06-19T17:00:00",
                    "recurrence": { "interval": 1, "unit": "week", "anchor": "due_at" }
                }
            }),
        )
        .await;

        // First completion spawns one successor.
        update_todo(
            &pool,
            &todo_id,
            serde_json::json!({ "status": "completed", "completed_at": "2026-06-19T18:00:00" }),
            "user",
            None,
            100,
        )
        .await
        .expect("first completion succeeds");
        assert_eq!(other_todos(&pool, &todo_id).await.len(), 1);

        // Editing the still-completed Todo's note must NOT spawn another.
        update_todo(
            &pool,
            &todo_id,
            serde_json::json!({ "note": "tweaked" }),
            "user",
            None,
            200,
        )
        .await
        .expect("note edit succeeds");
        assert_eq!(
            other_todos(&pool, &todo_id).await.len(),
            1,
            "re-saving a completed Todo spawns no second successor"
        );
    }

    /// Completing a recurring Todo whose `after_count == 1` (the last occurrence)
    /// spawns no successor (ADR-0039 end condition).
    #[tokio::test]
    async fn completing_last_after_count_occurrence_spawns_nothing() {
        let pool = memory_pool().await;
        let todo_id = create(
            &pool,
            MutationKind::CreateTodo,
            serde_json::json!({
                "todo": {
                    "title": "Final occurrence",
                    "due_at": "2026-06-19T17:00:00",
                    "recurrence": {
                        "interval": 1, "unit": "week", "anchor": "due_at",
                        "end": { "after_count": 1 }
                    }
                }
            }),
        )
        .await;

        update_todo(
            &pool,
            &todo_id,
            serde_json::json!({ "status": "completed", "completed_at": "2026-06-19T18:00:00" }),
            "user",
            None,
            100,
        )
        .await
        .expect("completion succeeds");

        assert!(
            other_todos(&pool, &todo_id).await.is_empty(),
            "after_count == 1 is the last occurrence, no successor"
        );
    }

    /// The successor's `after_count` is decremented: completing an after_count: 3
    /// recurring Todo leaves a successor carrying after_count: 2 (ADR-0039).
    #[tokio::test]
    async fn successor_decrements_after_count() {
        let pool = memory_pool().await;
        let todo_id = create(
            &pool,
            MutationKind::CreateTodo,
            serde_json::json!({
                "todo": {
                    "title": "Three times",
                    "due_at": "2026-06-19T17:00:00",
                    "recurrence": {
                        "interval": 1, "unit": "week", "anchor": "due_at",
                        "end": { "after_count": 3 }
                    }
                }
            }),
        )
        .await;

        update_todo(
            &pool,
            &todo_id,
            serde_json::json!({ "status": "completed", "completed_at": "2026-06-19T18:00:00" }),
            "user",
            None,
            100,
        )
        .await
        .expect("completion succeeds");

        let successors = other_todos(&pool, &todo_id).await;
        assert_eq!(successors.len(), 1);
        assert_eq!(
            successors[0]["recurrence"]["end"]["after_count"].as_u64(),
            Some(2),
            "after_count decremented on the successor"
        );
    }

    /// Completing a recurring Todo whose next occurrence would fall past its
    /// `until` bound spawns no successor — the until end-condition wired through
    /// the apply layer (ADR-0039), not just the pure module.
    #[tokio::test]
    async fn completing_until_exhausted_occurrence_spawns_nothing() {
        let pool = memory_pool().await;
        let todo_id = create(
            &pool,
            MutationKind::CreateTodo,
            serde_json::json!({
                "todo": {
                    "title": "Until the end of June",
                    "due_at": "2026-06-26T17:00:00",
                    "recurrence": {
                        "interval": 1, "unit": "week", "anchor": "due_at",
                        "end": { "until": "2026-06-30T00:00:00" }
                    }
                }
            }),
        )
        .await;

        update_todo(
            &pool,
            &todo_id,
            serde_json::json!({ "status": "completed", "completed_at": "2026-06-26T18:00:00" }),
            "user",
            None,
            100,
        )
        .await
        .expect("completion succeeds");

        assert!(
            other_todos(&pool, &todo_id).await.is_empty(),
            "the next occurrence (2026-07-03) is past until (2026-06-30): no successor"
        );
    }

    /// A defer-anchored, due-absent recurring Todo: the successor advances
    /// `defer_at`, leaves `due_at` absent (presence mirrored), and carries the
    /// title forward (ADR-0039 set_or_remove + carried context, at the DB layer).
    #[tokio::test]
    async fn defer_anchored_successor_advances_defer_and_omits_due() {
        let pool = memory_pool().await;
        let todo_id = create(
            &pool,
            MutationKind::CreateTodo,
            serde_json::json!({
                "todo": {
                    "title": "Deferred chore",
                    "defer_at": "2026-06-14T09:00:00",
                    "recurrence": { "interval": 2, "unit": "day", "anchor": "defer_at" }
                }
            }),
        )
        .await;

        update_todo(
            &pool,
            &todo_id,
            serde_json::json!({ "status": "completed", "completed_at": "2026-06-14T10:00:00" }),
            "user",
            None,
            100,
        )
        .await
        .expect("completion succeeds");

        let successors = other_todos(&pool, &todo_id).await;
        assert_eq!(successors.len(), 1);
        let successor = &successors[0];
        assert_eq!(
            successor["defer_at"].as_str(),
            Some("2026-06-16T09:00:00"),
            "defer advanced two days"
        );
        assert!(
            successor.get("due_at").is_none(),
            "the absent due date stays absent on the successor: {successor}"
        );
        assert_eq!(
            successor["title"].as_str(),
            Some("Deferred chore"),
            "the title carries forward"
        );
    }

    /// delete_project is a hand-rolled JSON cascade (ADR-0031/0055): it unsets
    /// `project_id` on every owning Todo and deletes the Project row, but leaves
    /// the Todo's `title`/`note` and its `todo_person_refs` rows intact.
    #[tokio::test]
    async fn delete_project_unsets_project_id_keeps_title_note_refs() {
        let pool = memory_pool().await;
        let alice = create(
            &pool,
            MutationKind::CreatePerson,
            serde_json::json!({ "name": "Alice" }),
        )
        .await;
        let project = create(
            &pool,
            MutationKind::CreateProject,
            serde_json::json!({ "name": "Roadmap", "status": "active" }),
        )
        .await;
        let todo = create(
            &pool,
            MutationKind::CreateTodo,
            serde_json::json!({
                "todo": {
                    "title": "Ship it",
                    "note": "the note",
                    "project_id": project,
                    "status": "active"
                },
                "person_refs": [{ "person_id": alice, "role": "related" }]
            }),
        )
        .await;

        let mut tx = pool.begin().await.unwrap();
        apply_entity_mutation(
            &mut tx,
            EntityMutationSpec {
                kind: MutationKind::DeleteProject,
                target_entity_id: Some(&project),
                payload: &serde_json::json!({ "entity_id": project }),
                edited_payload: None,
                created_by: "user",
                proposal_id: None,
                source: None,
                now_ms: 200,
            },
        )
        .await
        .expect("delete_project applies");
        tx.commit().await.unwrap();

        let data = todo_data(&pool, &todo).await;
        assert!(
            data.get("project_id").is_none(),
            "the cascade unsets project_id: {data}"
        );
        assert_eq!(data["title"].as_str(), Some("Ship it"), "title is preserved");
        assert_eq!(data["note"].as_str(), Some("the note"), "note is preserved");

        let ref_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM todo_person_refs WHERE todo_id = ?1 AND person_id = ?2",
        )
        .bind(&todo)
        .bind(&alice)
        .fetch_one(&pool)
        .await
        .expect("count refs");
        assert_eq!(ref_count, 1, "the Todo Person Reference is preserved");

        let project_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM entities WHERE id = ?1")
                .bind(&project)
                .fetch_one(&pool)
                .await
                .expect("count project");
        assert_eq!(project_count, 0, "the Project entity is deleted");
    }

    /// update_todo ref-op precedence (ADR-0031/0055): `set_person_refs` replaces the
    /// whole set wholesale, THEN `add_person_refs` upserts on top — and the upsert
    /// never downgrades an existing `waiting_on` to `related`.
    #[tokio::test]
    async fn set_then_add_person_refs_replaces_then_upserts_no_downgrade() {
        let pool = memory_pool().await;
        let alice = create(
            &pool,
            MutationKind::CreatePerson,
            serde_json::json!({ "name": "Alice" }),
        )
        .await;
        let bob = create(
            &pool,
            MutationKind::CreatePerson,
            serde_json::json!({ "name": "Bob" }),
        )
        .await;
        let carol = create(
            &pool,
            MutationKind::CreatePerson,
            serde_json::json!({ "name": "Carol" }),
        )
        .await;
        let todo = create(
            &pool,
            MutationKind::CreateTodo,
            serde_json::json!({
                "todo": { "title": "Coordinate", "status": "active" },
                "person_refs": [{ "person_id": carol, "role": "related" }]
            }),
        )
        .await;

        let mut tx = pool.begin().await.unwrap();
        apply_entity_mutation(
            &mut tx,
            EntityMutationSpec {
                kind: MutationKind::UpdateTodo,
                target_entity_id: Some(&todo),
                payload: &serde_json::json!({
                    "todo_id": todo,
                    "set_person_refs": [{ "person_id": alice, "role": "waiting_on" }],
                    "add_person_refs": [
                        { "person_id": alice, "role": "related" },
                        { "person_id": bob, "role": "related" }
                    ]
                }),
                edited_payload: None,
                created_by: "user",
                proposal_id: None,
                source: None,
                now_ms: 200,
            },
        )
        .await
        .expect("update_todo ref-ops apply");
        tx.commit().await.unwrap();

        let refs: Vec<(String, String)> = sqlx::query_as(
            "SELECT person_id, role FROM todo_person_refs WHERE todo_id = ?1 ORDER BY person_id",
        )
        .bind(&todo)
        .fetch_all(&pool)
        .await
        .expect("query refs");

        let alice_role = refs
            .iter()
            .find(|(id, _)| id == &alice)
            .map(|(_, role)| role.as_str());
        let bob_role = refs
            .iter()
            .find(|(id, _)| id == &bob)
            .map(|(_, role)| role.as_str());
        let has_carol = refs.iter().any(|(id, _)| id == &carol);

        assert!(!has_carol, "set replaced the carol ref wholesale");
        assert_eq!(
            alice_role,
            Some("waiting_on"),
            "add upserts but never downgrades alice's waiting_on"
        );
        assert_eq!(bob_role, Some("related"), "add inserted bob as related");
        assert_eq!(refs.len(), 2, "exactly two refs after set+add");
    }
}
