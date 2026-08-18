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

/// Write a new revision of an existing Entity: replace its `data` and append the
/// next revision snapshot, in the caller's open tx (ADR-0004, ADR-0033). The
/// composite every in-place write shares, so its rowcount⇒`TargetMissing` guard
/// and monotonic seq allocation live in ONE place.
///
/// The rows-affected guard is the target-gone signal: `update_entity` filters
/// `WHERE id = ? AND type = ?`, so a vanished OR wrong-type target updates zero
/// rows and surfaces [`ApplyError::TargetMissing`] (the parked Proposal's target
/// was deleted — ADR-0033), which decide maps to `NotDecidable`. `schema_version`
/// is derived from `entity_type` (the type is the home of the version), so callers
/// pass only the type.
pub(super) async fn update_entity_with_revision(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    entity_id: &str,
    entity_type: EntityType,
    data: &str,
    proposal_id: Option<&str>,
    now_ms: i64,
) -> Result<(), ApplyError> {
    let updated = queries::update_entity(
        &mut **tx,
        entity_id,
        entity_type.as_str(),
        entity_type.schema_version(),
        data,
        now_ms,
    )
    .await?;
    if updated != 1 {
        return Err(ApplyError::TargetMissing);
    }
    let next_seq = queries::next_entity_revision_seq(&mut **tx, entity_id).await?;
    queries::insert_entity_revision(&mut **tx, entity_id, next_seq, data, proposal_id, now_ms)
        .await?;
    Ok(())
}

/// Insert a freshly-minted Entity plus its seq-1 revision in the caller's open tx
/// (ADR-0004) — the create counterpart of [`update_entity_with_revision`], sharing
/// the same schema-version-from-`entity_type` derivation. `created_by` is the
/// origin marker (`'proposal'`/`'user'`); `proposal_id` stamps both the entity's
/// `created_via_proposal_id` and the revision (`None` on the user path).
pub(super) async fn insert_entity_with_first_revision(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    entity_id: &str,
    entity_type: EntityType,
    data: &str,
    created_by: &str,
    proposal_id: Option<&str>,
    now_ms: i64,
) -> Result<(), ApplyError> {
    queries::insert_entity(
        &mut **tx,
        entity_id,
        entity_type.as_str(),
        entity_type.schema_version(),
        data,
        created_by,
        proposal_id,
        now_ms,
    )
    .await?;
    queries::insert_entity_revision(&mut **tx, entity_id, 1, data, proposal_id, now_ms).await?;
    Ok(())
}

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
/// The `InTx` kinds (`mark_project_reviewed`/the reference weave) compute
/// their data inside the tx — they never reach this seam — and the
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
    proposal_id: Option<&str>,
    now_ms: i64,
    offset_minutes: i64,
) -> Result<(), ApplyError> {
    let current = queries::current_entity_data(&mut **tx, project_id, "project")
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

    update_entity_with_revision(tx, project_id, EntityType::Project, &data_str, proposal_id, now_ms)
        .await
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
        update_entity_with_revision(
            tx,
            &journal_entry_id,
            EntityType::JournalEntry,
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
    // No surface writes an offset setting, so every install runs at 0
    // (local == UTC); the offset_minutes params stay as the unit-test seam.
    let review_anchor_offset = 0;
    // Effective entity data: edited payload when present, else the proposed
    // data, routed by the contract's `write_class` facet. `NoData` deletes touch
    // no entity data; the `InTx` kinds compute their data inside the tx below,
    // not at this seam — `mark_project_reviewed` recomputes from current state, and the
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

    // The reference kind computes its data_str here (the `InTx` seam above left it
    // `None`). Load-then-write: the source load runs
    // BEFORE the `entity_refs` insert, so a gone source surfaces as TargetMissing
    // rather than tripping the insert's FK.
    if kind == MutationKind::ReferenceExistingEntityFromJournalEntry {
        let current_data = queries::current_entity_data(&mut **tx, &entity_id, "journal_entry")
            .await?
            // The target Journal Entry vanished under the parked Proposal
            // (ADR-0033) — surface TargetMissing, not an opaque DB fault.
            .ok_or(ApplyError::TargetMissing)?;
        let current_data: serde_json::Value = serde_json::from_str(&current_data).map_err(|e| {
            ApplyError::InvalidMutation(format!("stored Journal Entry data is malformed JSON: {e}"))
        })?;
        if !current_data.is_object() {
            return Err(ApplyError::InvalidMutation(
                "stored Journal Entry data must be a JSON object".to_string(),
            ));
        }
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
        let ref_id =
            queries::entity_ref_id_for_source_target(&mut **tx, &entity_id, target_entity_id)
                .await?
                .ok_or_else(|| {
                    ApplyError::InvalidMutation(
                        "failed to create or find entity_ref for source and target".to_string(),
                    )
                })?;
        data_str = Some(
            crate::entities::reference_existing_entity_data_payload(
                &current_data,
                effective_payload,
                &ref_id,
            )
            .to_string(),
        );
    }

    // The in-tx write dispatch: every kind with a per-kind write body keeps a
    // named arm — MarkProjectReviewed's recompute and the reference weave (its
    // `data_str` was computed in the pre-match block above) — so EVERY
    // `WriteClass::InTx` kind is named; ApplyIntentGraph keeps its
    // unreachable-after-guard arm; every other kind routes generically by the
    // contract's `write_op`.
    match kind {
        // mark_project_reviewed READS the current Project, stamps the review
        // fields, and writes a new revision — all in THIS tx (ADR-0034). The
        // recompute needs committed state + the in-tx review-anchor offset, so it
        // loads current data here rather than via the pre-write seam.
        MutationKind::MarkProjectReviewed => {
            apply_mark_project_reviewed(
                tx,
                &entity_id,
                proposal_id,
                now_ms,
                review_anchor_offset,
            )
            .await?;
        }
        // The reference weave writes a new revision of the SOURCE Journal Entry
        // whose body gained the entity_ref — a `WriteClass::InTx` update whose
        // `data_str` was computed in the pre-match block above (the entity_ref is
        // inserted there FIRST so the body can embed its minted id). Named here so
        // every InTx kind has its own arm; the write itself is the shared composite.
        MutationKind::ReferenceExistingEntityFromJournalEntry => {
            let data_str = data_str
                .as_deref()
                .expect("the reference weave computes its data_str before this match");
            update_entity_with_revision(tx, &entity_id, entity_type, data_str, proposal_id, now_ms)
                .await?;
        }
        // Rejected at the guard above (the graph is not a single-entity
        // mutation) — named BEFORE the generic write_op arms so its
        // `write_op: Create` cannot route it onto the create path.
        MutationKind::ApplyIntentGraph => {
            unreachable!("apply_intent_graph is rejected before this seam")
        }
        // A `WriteClass::InTx` kind computes its data inside the tx and MUST have a
        // named arm above (both do). Reaching here means a new InTx kind was
        // declared without one, so fail loud rather than write its un-computed
        // `data_str` down the generic path below. This structural guard replaces the
        // old prose TRAP: a mis-declared InTx kind now stops at a named arm, not at
        // the generic arm's `data_str` expect.
        _ if desc.write_class == WriteClass::InTx => unreachable!(
            "a WriteClass::InTx kind must have a named dispatch arm ({mutation_kind})"
        ),
        // Every remaining kind (NoData / Normalized) routes generically by the
        // contract's `write_op` — an exhaustive inner match, so a new WriteOp
        // variant must declare its write body here, and a new KIND is forced
        // through `describe()`'s contract block instead of this dispatch.
        _ => match desc.write_op {
            // Generic delete (journal_entry, person, project, media, habit):
            // remove the entity of this `entity_type`. Its revisions/sources
            // cascade away via FK ON DELETE CASCADE — no explicit ref-delete
            // SQL here.
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
                // bodies as entity_refs — textualize those to their label snapshots
                // (Person and Project; journal/media/habit types are not
                // referenceable).
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
            // is gated to journal kinds; person/project/media carry no body refs.
            // The InTx kinds (mark_project_reviewed, the reference weave) took
            // their named in-tx arms above.
            WriteOp::Update => {
                let data_str = data_str
                    .as_deref()
                    .expect("non-delete mutations always carry entity data");
                update_entity_with_revision(
                    tx,
                    &entity_id,
                    entity_type,
                    data_str,
                    proposal_id,
                    now_ms,
                )
                .await?;
            }
            // Generic create (journal_entry, person, project, media, habit):
            // insert the entity of this `entity_type` + its seq-1 revision.
            WriteOp::Create => {
                let data_str = data_str
                    .as_deref()
                    .expect("non-delete mutations always carry entity data");
                insert_entity_with_first_revision(
                    tx,
                    &entity_id,
                    entity_type,
                    data_str,
                    created_by,
                    proposal_id,
                    now_ms,
                )
                .await?;
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
    use crate::db::test_support::memory_pool;
    use super::*;
    use serde_json::json;
    use sqlx::SqlitePool;

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

    /// The apply-layer backstop for the reference weave's load-before-write
    /// ordering: a SOURCE Journal Entry gone AT APPLY TIME (decide's pool-level
    /// pre-validation bypassed — this layer must not depend on it) surfaces
    /// `TargetMissing`. The in-tx source load runs BEFORE the `entity_refs`
    /// insert, whose `source_entity_id` FK would otherwise trip into an opaque
    /// `Sql` error.
    #[tokio::test]
    async fn reference_weave_gone_source_at_apply_is_target_missing() {
        let pool = memory_pool().await;
        // A real referenceable target, so the gone SOURCE is the only fault.
        let target_person_id = create(
            &pool,
            MutationKind::CreatePerson,
            serde_json::json!({ "name": "Alice" }),
        )
        .await;
        let missing_source_je_id = Uuid::now_v7().to_string();

        let mut tx = pool.begin().await.expect("begin");
        let result = apply_entity_mutation(
            &mut tx,
            EntityMutationSpec {
                kind: MutationKind::ReferenceExistingEntityFromJournalEntry,
                target_entity_id: Some(&missing_source_je_id),
                payload: &serde_json::json!({
                    "source_entity_id": missing_source_je_id,
                    "target_entity_id": target_person_id,
                    "label_snapshot": "Alice",
                    "body": [
                        { "type": "text", "text": "Linked " },
                        { "type": "entity_ref" }
                    ]
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
            matches!(result, Err(ApplyError::TargetMissing)),
            "a gone reference source at apply is TargetMissing, not the entity_refs FK's Sql error: {result:?}"
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

}
