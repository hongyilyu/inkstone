//! `proposal/get` handler (ADR-0025): fetch a parked Run's pending Proposal.
//!
//! Pull-path observability of a park: a Client that learns a Run is `parked`
//! (via `run/subscribe`'s response status) follows with `proposal/get(run_id)`
//! to retrieve the awaiting Proposal — its kind, change_kind, proposed data,
//! rationale, and status. The `proposal/pending` push Notification + its
//! workspace bus arrive in a later (UI) slice; this slice makes the park fully
//! observable through the pull path alone.
//!
//! `proposal/decide` handler (ADR-0025, ADR-0016): apply a Decision on a
//! pending Proposal then resume the parked Run. This slice implements
//! `accept`; `reject`/`edit` (slices 4/5) reuse the same validate → apply →
//! resume spine. Accept is ONE atomic apply (`db::apply_proposal`) followed by
//! a fresh-Worker resume seeded with the reconstructed transcript. Idempotent
//! on `decision_idempotency_key`: a repeated decide returns the prior result
//! without re-applying.

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;
use uuid::Uuid;

use super::reply::{
    send_error, send_invalid_params, send_proposal_not_pending, send_response,
};
use crate::db;
use crate::hub::Hubs;
use crate::protocol::{ProposalDecideParams, ProposalDecideResult, ProposalGetParams, ProposalGetResult};

pub(super) async fn handle_get(
    pool: &SqlitePool,
    id: serde_json::Value,
    params: ProposalGetParams,
    out_tx: &UnboundedSender<String>,
) {
    let Ok(run_id) = Uuid::parse_str(&params.run_id) else {
        send_invalid_params(out_tx, id, format!("invalid run_id {:?}", params.run_id));
        return;
    };

    match db::get_pending_proposal_for_run(pool, run_id).await {
        Ok(Some(p)) => {
            send_response(
                out_tx,
                id,
                serde_json::to_value(ProposalGetResult {
                    proposal_id: p.proposal_id,
                    run_id: run_id.to_string(),
                    kind: p.kind,
                    change_kind: p.change_kind,
                    data: p.data,
                    rationale: p.rationale,
                    status: p.status,
                })
                .expect("ProposalGetResult serializes"),
            );
        }
        Ok(None) => {
            send_error(out_tx, id, format!("no pending proposal for run {run_id}"));
        }
        Err(e) => {
            eprintln!("get_pending_proposal_for_run failed for {run_id}: {e}");
            send_error(out_tx, id, format!("proposal/get: {e}"));
        }
    }
}

pub(super) async fn handle_decide(
    pool: &SqlitePool,
    hubs: &Hubs,
    id: serde_json::Value,
    params: ProposalDecideParams,
    out_tx: &UnboundedSender<String>,
) {
    // Slice 3 implements `accept`; reject/edit are Core-only follow-ups that
    // reuse this spine. Reject the other decisions explicitly rather than
    // silently mis-applying.
    if params.decision != "accept" {
        send_invalid_params(
            out_tx,
            id,
            format!("decision {:?} not implemented in this slice", params.decision),
        );
        return;
    }

    let proposal = match db::load_proposal_for_decide(pool, &params.proposal_id).await {
        Ok(Some(p)) => p,
        Ok(None) => {
            send_proposal_not_pending(
                out_tx,
                id,
                format!("no proposal {}", params.proposal_id),
            );
            return;
        }
        Err(e) => {
            eprintln!("load_proposal_for_decide failed for {}: {e}", params.proposal_id);
            send_error(out_tx, id, format!("proposal/decide: {e}"));
            return;
        }
    };

    // Idempotency (ADR-0025): a repeat decide with the same recorded key
    // returns the prior result, no re-apply. This also covers a duplicate of an
    // already-accepted Proposal — its key was stored on accept.
    if let Some(ref recorded) = proposal.decision_idempotency_key
        && params.decision_idempotency_key.as_deref() == Some(recorded.as_str())
    {
        match db::entity_id_for_proposal(pool, &params.proposal_id).await {
            Ok(entity_id) => {
                send_decide_result(out_tx, id, "accepted", entity_id);
            }
            Err(e) => {
                eprintln!("entity_id_for_proposal failed for {}: {e}", params.proposal_id);
                send_error(out_tx, id, format!("proposal/decide: {e}"));
            }
        }
        return;
    }

    // Must be pending to decide afresh (a non-idempotent duplicate falls here).
    if proposal.status != "pending" {
        send_proposal_not_pending(
            out_tx,
            id,
            format!("proposal {} is {} (not pending)", params.proposal_id, proposal.status),
        );
        return;
    }

    // The Run must be parked at this Proposal's waitpoint.
    match db::run_status(pool, proposal.run_id).await {
        Ok(Some(ref s)) if s == "parked" => {}
        Ok(_) => {
            send_proposal_not_pending(
                out_tx,
                id,
                format!("run {} is not parked", proposal.run_id),
            );
            return;
        }
        Err(e) => {
            eprintln!("run_status failed for {}: {e}", proposal.run_id);
            send_error(out_tx, id, format!("proposal/decide: {e}"));
            return;
        }
    }

    // Validate the proposed data against its entity schema (ADR-0016 — Core is
    // the authority). Slice 3 models only `todo`.
    if proposal.kind == "todo" {
        if let Err(reason) = crate::entities::validate_todo(&proposal.data) {
            send_invalid_params(out_tx, id, format!("invalid todo: {reason}"));
            return;
        }
    } else {
        send_invalid_params(
            out_tx,
            id,
            format!("entity kind {:?} not supported", proposal.kind),
        );
        return;
    }

    // The Decision rendered as the awaited tool's result text — what the model
    // reads on resume (ADR-0025). Persisted as the tool_call's result_payload
    // inside the atomic apply, then surfaced in the reconstructed transcript.
    let decision_text = render_accept_decision(&proposal.kind, &proposal.data);
    let decision_payload = serde_json::json!({
        "decision": "accept",
        "content": decision_text,
    })
    .to_string();

    let entity_id = match db::apply_proposal(
        pool,
        &params.proposal_id,
        &proposal.tool_call_id,
        &proposal.kind,
        &proposal.data,
        None,
        params.decision_idempotency_key.as_deref(),
        &decision_payload,
        db::now_ms(),
    )
    .await
    {
        Ok(eid) => eid,
        Err(e) => {
            eprintln!("apply_proposal failed for {}: {e}", params.proposal_id);
            send_error(out_tx, id, format!("proposal/decide apply: {e}"));
            return;
        }
    };

    // Resume the Run in a fresh Worker (ADR-0025). Flip parked→running first so
    // a `run/subscribe` in the window sees `running`, then spawn.
    if let Err(e) = crate::worker::resume(proposal.run_id, pool, hubs).await {
        eprintln!("resume failed for run {}: {e}", proposal.run_id);
        // The apply already committed; surface the resume failure but the
        // Proposal is durably accepted. The Run stays parked (running flip is
        // inside `resume`), recoverable by a later decide retry (idempotent).
        send_error(out_tx, id, format!("proposal/decide resume: {e}"));
        return;
    }

    send_decide_result(out_tx, id, "accepted", Some(entity_id));
}

/// Render the human-readable Decision text the model reads on resume as the
/// awaited tool's result (ADR-0025). For an accepted Todo: a short confirmation
/// naming the created entity.
fn render_accept_decision(kind: &str, data: &serde_json::Value) -> String {
    let title = data.get("title").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "todo" => format!("Accepted. Created Todo {title:?}."),
        other => format!("Accepted. Created {other} {title:?}."),
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
