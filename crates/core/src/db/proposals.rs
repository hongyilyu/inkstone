//! Proposal storage facade (park, read, decide-time apply/reject, and the
//! user-mutation twin). SQL stays in [`queries`], matching the DB module's
//! one-statement query convention; this module owns the Proposal shapes,
//! [`ApplyError`], and the accept/reject transaction boundaries.

use sqlx::SqlitePool;
use uuid::Uuid;

use super::apply;
use super::{Moved, ProposalStatus, RunStatus};
use super::queries;
use super::runs::persist_tool_call_rows;
use super::run_log;

/// Park a Run on a Proposal tool request (ADR-0025): persist the tool call +
/// timeline step + pending Proposal, then move the Run `running -> parked` with
/// the waitpoint and lifecycle events (`parked`, `proposal_pending`), all in one
/// transaction. If the Run is no longer `running` the guarded park loses and the
/// transaction rolls back.
#[allow(clippy::too_many_arguments)]
pub async fn park_on_proposal(
    pool: &SqlitePool,
    run_id: Uuid,
    proposal_id: &str,
    tool_call_id: &str,
    name: &str,
    request_payload: &str,
    mutation_kind: &str,
    now_ms: i64,
) -> sqlx::Result<Moved> {
    let mut tx = pool.begin().await?;

    persist_tool_call_rows(&mut tx, run_id, tool_call_id, name, request_payload, now_ms).await?;
    queries::insert_proposal(&mut *tx, proposal_id, tool_call_id, mutation_kind).await?;

    let moved = RunStatus::park(&mut *tx, run_id, tool_call_id, now_ms).await?;
    if !moved.won() {
        return Ok(moved);
    }

    let payload = serde_json::json!({
        "proposal_id": proposal_id,
        "tool_call_id": tool_call_id,
        "mutation_kind": mutation_kind,
    })
    .to_string();
    run_log::append(
        &mut *tx,
        run_id,
        run_log::RunLogKind::ProposalPending,
        Some(&payload),
        now_ms,
    )
    .await?;

    tx.commit().await?;
    Ok(moved)
}

/// A Run's pending Proposal for `proposal/get` (ADR-0025). `payload` and
/// `rationale` come from the tool call's stored `request_payload`;
/// `mutation_kind` and `status` from the `proposals` row.
pub struct ProposalRow {
    pub proposal_id: String,
    pub mutation_kind: String,
    pub status: String,
    pub payload: serde_json::Value,
    pub rationale: Option<String>,
}

/// Read the Run's pending Proposal, or `None`. A malformed `request_payload`
/// degrades to `payload: null` / `rationale: None` rather than failing the read.
pub async fn get_pending_proposal_for_run(
    pool: &SqlitePool,
    run_id: Uuid,
) -> sqlx::Result<Option<ProposalRow>> {
    let Some((proposal_id, mutation_kind, status, request_payload)) =
        queries::pending_proposal_for_run(pool, run_id).await?
    else {
        return Ok(None);
    };
    let payload: serde_json::Value =
        serde_json::from_str(&request_payload).unwrap_or(serde_json::Value::Null);
    let proposal_payload = payload
        .get("payload")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let rationale = payload
        .get("rationale")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    Ok(Some(ProposalRow {
        proposal_id,
        mutation_kind,
        status,
        payload: proposal_payload,
        rationale,
    }))
}

/// Auto-approve seam (ADR-0025, ADR-0016). Always `false` for now — every
/// Proposal is manual, so every `propose_workspace_mutation` parks the Run.
pub fn should_auto_approve() -> bool {
    false
}

/// A Proposal loaded by id for `proposal/decide` (ADR-0025): owning Run, awaited
/// `tool_call_id`, lifecycle columns, the proposed `payload` (from the tool
/// call's `request_payload`), and any recorded `decision_idempotency_key`.
pub struct DecidableProposal {
    pub run_id: Uuid,
    pub tool_call_id: String,
    pub mutation_kind: String,
    pub status: String,
    pub payload: serde_json::Value,
    pub decision_idempotency_key: Option<String>,
}

/// Load a Proposal by id for `proposal/decide`; `None` when it does not exist.
/// A malformed `request_payload` degrades the proposed `payload` to `null`.
pub async fn load_proposal_for_decide(
    pool: &SqlitePool,
    proposal_id: &str,
) -> sqlx::Result<Option<DecidableProposal>> {
    let Some((run_id, tool_call_id, mutation_kind, status, request_payload, idem)) =
        queries::proposal_by_id(pool, proposal_id).await?
    else {
        return Ok(None);
    };
    let Ok(run_id) = Uuid::parse_str(&run_id) else {
        return Ok(None);
    };
    let payload: serde_json::Value =
        serde_json::from_str(&request_payload).unwrap_or(serde_json::Value::Null);
    let proposal_payload = payload
        .get("payload")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    Ok(Some(DecidableProposal {
        run_id,
        tool_call_id,
        mutation_kind,
        status,
        payload: proposal_payload,
        decision_idempotency_key: idem,
    }))
}

/// The `entities.id` already created via `proposal_id`, or `None`. Backs the
/// idempotent-decide check: a repeated accept returns the prior `entity_id`
/// instead of re-applying.
pub async fn entity_id_for_proposal(
    pool: &SqlitePool,
    proposal_id: &str,
) -> sqlx::Result<Option<String>> {
    queries::entity_id_for_proposal(pool, proposal_id).await
}

pub async fn journal_entry_target_is_valid(
    pool: &SqlitePool,
    run_id: Uuid,
    entity_id: &str,
) -> sqlx::Result<bool> {
    queries::journal_entry_target_is_valid(pool, run_id, entity_id).await
}

/// The origin Thread a `journal_entry` was `created_from` (ADR-0042) — the
/// destination a `journal_entry/rescan` Run starts in. `None` if `je_id` names
/// no `journal_entry` or has no resolvable origin Thread.
pub async fn journal_entry_origin_thread_id(
    pool: &SqlitePool,
    je_id: &str,
) -> sqlx::Result<Option<String>> {
    queries::journal_entry_origin_thread_id(pool, je_id).await
}

/// Failure modes of [`apply_proposal`] the caller must distinguish (review M1).
#[derive(Debug)]
pub enum ApplyError {
    /// An impossible mutation contract, e.g. an update without a target id.
    InvalidMutation(String),
    /// The guarded `proposals` flip found the row non-`pending` (a concurrent
    /// decide won); the tx rolled back, nothing applied. Maps to
    /// `proposal_not_pending`.
    NotPending,
    /// An update/delete found its target Entity row already gone (the
    /// affected-0-rows case): a user deleted the Entity out from under a parked
    /// Proposal (ADR-0033). Distinct from a genuine DB fault so the caller can
    /// resolve the parked Run cleanly (decide maps it to `NotDecidable`).
    TargetMissing,
    /// Any other SQL error inside the apply transaction.
    Sql(sqlx::Error),
}

impl From<sqlx::Error> for ApplyError {
    fn from(e: sqlx::Error) -> Self {
        ApplyError::Sql(e)
    }
}

impl std::fmt::Display for ApplyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApplyError::InvalidMutation(reason) => write!(f, "{reason}"),
            ApplyError::NotPending => write!(f, "proposal is not pending (lost the apply race)"),
            ApplyError::TargetMissing => write!(f, "proposal target entity no longer exists"),
            ApplyError::Sql(e) => write!(f, "{e}"),
        }
    }
}

/// Apply an accepted Proposal in one atomic transaction (ADR-0016, ADR-0025):
/// flip the `proposals` row to `accepted` under the `status='pending'` guard,
/// run the shared [`apply::apply_entity_mutation`] core, and resolve the awaited
/// `tool_calls` row to `completed` with the Decision the model reads on resume.
/// Returns the new `entity_id`. `entity_type`/`schema_version` are
/// caller-resolved, so this layer names no specific Entity Type.
///
/// This function owns the run-coupled work the shared core deliberately does not:
/// the guarded accept flip, resolving the Entity Source (the JE anchor from the
/// payload for a `created_from` create, else the user Message from `run_id`), the
/// trailing tool-call resolve, and the commit. Everything else — the per-kind
/// entity data/revision/ref/source writes — lives in `apply_entity_mutation`,
/// shared with the user path (ADR-0033).
///
/// EDIT (ADR-0025): when `edited_payload` is `Some`, the entity `data` is the
/// edited payload (Core-validated by the caller) and `proposals.edited_payload`
/// records the edit; an unedited accept passes `None` and writes the proposed
/// `data`.
///
/// `decision_result_payload` is rendered after the entity write returns so the
/// resume transcript can carry the real affected Entity id. This matters for
/// follow-up agent proposals that must target or source from the accepted Entity.
///
/// Self-guarding (review M1): the `proposals` flip is guarded on
/// `status='pending'`. On 0 rows a racing decide already won, so the tx rolls
/// back and [`ApplyError::NotPending`] is returned — exactly one concurrent
/// decide applies.
#[allow(clippy::too_many_arguments)]
pub async fn apply_proposal(
    pool: &SqlitePool,
    run_id: Uuid,
    proposal_id: &str,
    tool_call_id: &str,
    kind: crate::mutation::MutationKind,
    target_entity_id: Option<&str>,
    payload: &serde_json::Value,
    edited_payload: Option<&serde_json::Value>,
    source_relation_from_user_message: Option<crate::mutation::SourceRelation>,
    decision_idempotency_key: Option<&str>,
    decision_result_payload: impl FnOnce(&str) -> String,
    now_ms: i64,
) -> Result<String, ApplyError> {
    use crate::mutation::SourceRelation;
    let edited_str = edited_payload.map(|v| v.to_string());
    let effective_payload = edited_payload.unwrap_or(payload);

    let mut tx = pool.begin().await?;

    // Flip the Proposal first under the `status='pending'` guard (the single
    // concurrency choke); on 0 rows a racing decide won, so bail before applying.
    let accepted = ProposalStatus::accept(
        &mut *tx,
        run_id,
        proposal_id,
        edited_str.as_deref(),
        decision_idempotency_key,
        now_ms,
    )
    .await?;
    if !accepted.won() {
        // tx drops without commit → rollback; no entity inserted.
        return Err(ApplyError::NotPending);
    }

    // Resolve the run-coupled Entity Source descriptor for the shared core. A
    // create carrying `source_journal_entry_id` is sourced `created_from` that
    // Journal Entry (source_entity_id), not the user Message. Absent the field,
    // the Message-sourcing path is unchanged: read the Run's immutable
    // `user_message_id` here (inside this tx). JournalEntry provenance is
    // `created_from` only (ADR-0030/0031): an `updated_from` source always points
    // at the user Message, so the field is honored solely for creates.
    let source = match source_relation_from_user_message {
        Some(relation) => {
            let je_id = (relation == SourceRelation::CreatedFrom)
                .then(|| crate::entities::source_journal_entry_id(effective_payload))
                .flatten();
            Some(match je_id {
                Some(journal_entry_id) => apply::EntitySource::FromJournalEntry {
                    journal_entry_id: journal_entry_id.to_string(),
                    relation: relation.as_str().to_string(),
                },
                None => apply::EntitySource::FromMessage {
                    message_id: queries::user_message_id_for_run(&mut *tx, run_id).await?,
                    relation: relation.as_str().to_string(),
                },
            })
        }
        None => None,
    };

    let entity_id = apply::apply_entity_mutation(
        &mut tx,
        apply::EntityMutationSpec {
            kind,
            target_entity_id,
            payload,
            edited_payload,
            created_by: "proposal",
            proposal_id: Some(proposal_id),
            source,
            now_ms,
        },
    )
    .await?;

    let decision_result_payload = decision_result_payload(&entity_id);
    queries::resolve_tool_call(
        &mut *tx,
        tool_call_id,
        "completed",
        &decision_result_payload,
        now_ms,
    )
    .await?;

    tx.commit().await?;
    Ok(entity_id)
}

/// Apply a user-initiated Entity mutation in one atomic transaction (ADR-0033):
/// the user write-path's `begin → apply_entity_mutation → commit`, with no
/// Proposal flip and no tool-call resolve (there is no Run). The shared core is
/// driven with `created_by='user'`, `proposal_id=None`, and `source=None` — a
/// plain Library write has no Run, user Message, or Journal-Entry anchor, so it
/// writes no Entity Source row (ADR-0033 "source row iff a real source").
/// The `kind` carries the Entity Type / schema version / target-key, and the
/// `target_entity_id` is caller-resolved, so this layer names no specific Entity
/// Type, mirroring [`apply_proposal`].
pub async fn apply_user_mutation(
    pool: &SqlitePool,
    kind: crate::mutation::MutationKind,
    target_entity_id: Option<&str>,
    payload: &serde_json::Value,
    now_ms: i64,
) -> Result<String, ApplyError> {
    let mut tx = pool.begin().await?;
    let entity_id = apply::apply_entity_mutation(
        &mut tx,
        apply::EntityMutationSpec {
            kind,
            target_entity_id,
            payload,
            edited_payload: None,
            created_by: "user",
            proposal_id: None,
            source: None,
            now_ms,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(entity_id)
}

/// Reject a Proposal in one atomic transaction (ADR-0025), touching no entity
/// store: flip the `proposals` row to `rejected` and resolve the awaited
/// `tool_calls` row to `completed` with the Decision the model reads on resume —
/// a normal (non-error) decline so it continues conversationally. Self-guarding
/// on `status='pending'` like [`apply_proposal`]: 0 rows → rollback +
/// [`ApplyError::NotPending`].
pub async fn reject_proposal(
    pool: &SqlitePool,
    run_id: Uuid,
    proposal_id: &str,
    tool_call_id: &str,
    decision_idempotency_key: Option<&str>,
    decision_result_payload: &str,
    now_ms: i64,
) -> Result<(), ApplyError> {
    let mut tx = pool.begin().await?;

    // Flip the Proposal first under the `status='pending'` guard; on 0 rows a
    // racing decide won, so bail before resolving the tool call.
    let rejected = ProposalStatus::reject(
        &mut *tx,
        run_id,
        proposal_id,
        decision_idempotency_key,
        now_ms,
    )
    .await?;
    if !rejected.won() {
        // tx drops without commit → rollback; nothing changed.
        return Err(ApplyError::NotPending);
    }

    queries::resolve_tool_call(
        &mut *tx,
        tool_call_id,
        "completed",
        decision_result_payload,
        now_ms,
    )
    .await?;

    tx.commit().await?;
    Ok(())
}
