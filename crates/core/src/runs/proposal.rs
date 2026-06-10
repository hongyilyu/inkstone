//! `proposal/get` handler (ADR-0025): fetch a parked Run's pending Proposal.
//!
//! Pull-path observability of a park: a Client that learns a Run is `parked`
//! (via `run/subscribe`'s response status) follows with `proposal/get(run_id)`
//! to retrieve the awaiting Proposal — its mutation_kind, payload, rationale,
//! and status. The `proposal/pending` push Notification + its
//! workspace bus arrive in a later (UI) slice; this slice makes the park fully
//! observable through the pull path alone.
//!
//! `proposal/decide` handler (ADR-0025, ADR-0016): apply a Decision on a
//! pending Proposal then resume the parked Run. The decide transaction —
//! idempotency, the guarded apply/reject, and resume + still-parked recovery —
//! lives in the deep [`crate::decide`] module; this handler is the thin
//! JSON-RPC shell: decode → `decide::apply` → map `DecideError` → notify.

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;

use super::handler::{self, HandlerError};
use super::reply::{send_proposal_changed, send_response};
use crate::db;
use crate::decide::{DecideError, DecideOutcome};
use crate::hub::Hubs;
use crate::protocol::{
    ProposalDecideParams, ProposalDecideResult, ProposalGetParams, ProposalGetResult,
};

pub(super) async fn handle_get(
    pool: &SqlitePool,
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    handler::handle(id, params, out_tx, |params: ProposalGetParams| async move {
        let run_id = params.run_id;
        let p = db::get_pending_proposal_for_run(pool, run_id)
            .await
            .map_err(|e| HandlerError::Internal(e.into()))?
            .ok_or_else(|| {
                HandlerError::ProposalNotPending(format!("no pending proposal for run {run_id}"))
            })?;

        Ok(ProposalGetResult {
            proposal_id: p.proposal_id,
            run_id: run_id.to_string(),
            mutation_kind: p.mutation_kind,
            payload: p.payload,
            rationale: p.rationale,
            status: p.status,
        })
    })
    .await;
}

/// `proposal/decide`: decode → [`crate::decide::apply`] (injecting
/// `worker::resume` as the resume closure) → map the typed `DecideError` to a
/// `HandlerError` at this one site → frame the result + push `proposal/changed`.
/// `frame_error` logs `Internal` server-side, so there are no per-branch
/// `eprintln!`s here.
pub(super) async fn handle_decide(
    pool: &SqlitePool,
    hubs: &Hubs,
    id: serde_json::Value,
    params: ProposalDecideParams,
    out_tx: &UnboundedSender<String>,
) {
    match crate::decide::apply(
        pool,
        params.proposal_id,
        &params.decision,
        params.edited_payload,
        params.decision_idempotency_key,
        |run_id| crate::worker::resume(run_id, pool, hubs),
    )
    .await
    {
        Ok(DecideOutcome::Accepted { run_id, entity_id }) => {
            send_decide_result(out_tx, id, "accepted", Some(entity_id));
            send_proposal_changed(out_tx, run_id, &params.proposal_id.to_string(), "accepted");
        }
        Ok(DecideOutcome::Rejected { run_id }) => {
            send_decide_result(out_tx, id, "rejected", None);
            send_proposal_changed(out_tx, run_id, &params.proposal_id.to_string(), "rejected");
        }
        Err(e) => handler::frame_error(out_tx, id, map_decide_error(e)),
    }
}

/// Map the decide module's typed failure to the handler's wire vocabulary
/// (ADR-0014): a lost race and a not-decidable Proposal both surface as
/// `proposal_not_pending` (`-32002`); invalid inputs as `invalid_params`
/// (`-32602`); an internal fault as `-32603`.
fn map_decide_error(e: DecideError) -> HandlerError {
    match e {
        DecideError::LostRace => {
            HandlerError::ProposalNotPending("proposal is no longer pending".to_string())
        }
        DecideError::NotDecidable(m) => HandlerError::ProposalNotPending(m),
        DecideError::Invalid(m) => HandlerError::InvalidParams(m),
        DecideError::Internal(e) => HandlerError::Internal(e),
    }
}

fn send_decide_result(
    out_tx: &UnboundedSender<String>,
    id: serde_json::Value,
    status: &str,
    entity_id: Option<String>,
) {
    send_response(
        out_tx,
        id,
        serde_json::to_value(ProposalDecideResult {
            status: status.to_string(),
            entity_id,
        })
        .expect("ProposalDecideResult serializes"),
    );
}
