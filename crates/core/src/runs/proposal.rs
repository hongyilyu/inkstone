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
//! `accept` and `reject`; `edit` (slice 5) reuses the same validate → apply →
//! resume spine. Accept is ONE atomic apply (`db::apply_proposal`); reject is
//! ONE atomic non-applying resolve (`db::reject_proposal`) — its Decision is a
//! NORMAL (non-error) decline. Both are followed by a fresh-Worker resume
//! seeded with the reconstructed transcript. Idempotent on
//! `decision_idempotency_key`: a repeated decide returns the prior result
//! without re-applying.

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;
use uuid::Uuid;

use super::handler::{self, HandlerError};
use super::reply::{send_proposal_changed, send_response};
use crate::db;
use crate::hub::Hubs;
use crate::protocol::{ProposalDecideParams, ProposalDecideResult, ProposalGetParams, ProposalGetResult};

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
            kind: p.kind,
            change_kind: p.change_kind,
            data: p.data,
            rationale: p.rationale,
            status: p.status,
        })
    })
    .await;
}

pub(super) async fn handle_decide(
    pool: &SqlitePool,
    hubs: &Hubs,
    id: serde_json::Value,
    params: ProposalDecideParams,
    out_tx: &UnboundedSender<String>,
) {
    // Slice 3 implements `accept`; slice 4 adds `reject`; slice 5 adds `edit`.
    // All reuse this validate → apply → resume spine; only the apply step
    // differs. Reject any other decision explicitly rather than silently
    // mis-applying.
    if params.decision != "accept" && params.decision != "reject" && params.decision != "edit" {
        handler::frame_error(
            out_tx,
            id,
            HandlerError::InvalidParams(format!(
                "decision {:?} not implemented in this slice",
                params.decision
            )),
        );
        return;
    }
    let is_reject = params.decision == "reject";
    let is_edit = params.decision == "edit";
    // proposal_id is typed at decode (ADR-0029 C2); the db layer takes it as a
    // string, so bind the canonical form once.
    let proposal_id = params.proposal_id.to_string();

    let proposal = match db::load_proposal_for_decide(pool, &proposal_id).await {
        Ok(Some(p)) => p,
        Ok(None) => {
            handler::frame_error(
                out_tx,
                id,
                HandlerError::ProposalNotPending(format!("no proposal {proposal_id}")),
            );
            return;
        }
        Err(e) => {
            eprintln!("load_proposal_for_decide failed for {}: {e}", proposal_id);
            handler::frame_error(out_tx, id, HandlerError::Internal(anyhow::anyhow!("proposal/decide: {e}")));
            return;
        }
    };

    // Idempotency (ADR-0025): a repeat decide with the same recorded key
    // returns the prior result, no re-apply. This also covers a duplicate of an
    // already-decided Proposal — its key was stored on the prior decide. The
    // prior result is derived from the recorded `proposals.status`: an accepted
    // Proposal returns its created `entity_id`; a rejected one returns no
    // entity_id.
    //
    // Resume-failure recovery (review M2): the apply/reject commits BEFORE the
    // resume spawn, so a resume failure (token resolution, missing assistant
    // message, spawn error) can leave a durably-decided Proposal on a
    // still-`parked` Run. A short-circuit-and-return here would wedge it
    // forever. Instead, if the Run is still `parked`, re-drive `worker::resume`
    // before returning — making the idempotent retry the genuine recovery path
    // it was claimed to be. A Run already `running`/`completed`/`errored` is
    // left untouched.
    if let Some(ref recorded) = proposal.decision_idempotency_key
        && params.decision_idempotency_key.as_deref() == Some(recorded.as_str())
    {
        let (status, entity_id) =
            match prior_decide_result(pool, &proposal_id, &proposal.status).await {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("prior_decide_result failed for {}: {e}", proposal_id);
                    handler::frame_error(out_tx, id, HandlerError::Internal(anyhow::anyhow!("proposal/decide: {e}")));
                    return;
                }
            };
        if let Err(e) = recover_resume_if_parked(pool, hubs, proposal.run_id).await {
            eprintln!("resume recovery failed for run {}: {e}", proposal.run_id);
            handler::frame_error(out_tx, id, HandlerError::Internal(anyhow::anyhow!("proposal/decide resume: {e}")));
            return;
        }
        send_decide_result(out_tx, id, &status, entity_id);
        send_proposal_changed(out_tx, proposal.run_id, &proposal_id, &status);
        return;
    }

    // Must be pending to decide afresh (a non-idempotent duplicate falls here).
    if proposal.status != "pending" {
        // Already-decided, but possibly wedged at `parked` from a resume that
        // failed after the apply/reject committed (review M2). Recover by
        // re-driving the resume and returning the prior result, rather than
        // reporting not-pending and leaving the Run stuck. A non-parked Run is
        // a genuine stale decide → not-pending.
        if proposal.status == "accepted" || proposal.status == "rejected" {
            match db::run_status(pool, proposal.run_id).await {
                Ok(Some(ref s)) if s == "parked" => {
                    let (status, entity_id) =
                        match prior_decide_result(pool, &proposal_id, &proposal.status).await
                        {
                            Ok(r) => r,
                            Err(e) => {
                                eprintln!(
                                    "prior_decide_result failed for {}: {e}",
                                    proposal_id
                                );
                                handler::frame_error(out_tx, id, HandlerError::Internal(anyhow::anyhow!("proposal/decide: {e}")));
                                return;
                            }
                        };
                    if let Err(e) = recover_resume_if_parked(pool, hubs, proposal.run_id).await {
                        eprintln!("resume recovery failed for run {}: {e}", proposal.run_id);
                        handler::frame_error(out_tx, id, HandlerError::Internal(anyhow::anyhow!("proposal/decide resume: {e}")));
                        return;
                    }
                    send_decide_result(out_tx, id, &status, entity_id);
                    send_proposal_changed(out_tx, proposal.run_id, &proposal_id, &status);
                    return;
                }
                Ok(_) => {}
                Err(e) => {
                    eprintln!("run_status failed for {}: {e}", proposal.run_id);
                    handler::frame_error(out_tx, id, HandlerError::Internal(anyhow::anyhow!("proposal/decide: {e}")));
                    return;
                }
            }
        }
        handler::frame_error(
            out_tx,
            id,
            HandlerError::ProposalNotPending(format!(
                "proposal {} is {} (not pending)",
                proposal_id, proposal.status
            )),
        );
        return;
    }

    // The Run must be parked at this Proposal's waitpoint.
    match db::run_status(pool, proposal.run_id).await {
        Ok(Some(ref s)) if s == "parked" => {}
        Ok(_) => {
            handler::frame_error(
                out_tx,
                id,
                HandlerError::ProposalNotPending(format!("run {} is not parked", proposal.run_id)),
            );
            return;
        }
        Err(e) => {
            eprintln!("run_status failed for {}: {e}", proposal.run_id);
            handler::frame_error(out_tx, id, HandlerError::Internal(anyhow::anyhow!("proposal/decide: {e}")));
            return;
        }
    }

    // The data this Decision will apply: the EDITED payload for an edit, else
    // the model's proposed data for a plain accept. An edit REQUIRES an
    // `edited_payload`; its absence is `invalid_params` (no write).
    let edited_payload = if is_edit {
        match params.edited_payload.as_ref() {
            Some(p) => Some(p),
            None => {
                handler::frame_error(
                    out_tx,
                    id,
                    HandlerError::InvalidParams("edit requires edited_payload".to_string()),
                );
                return;
            }
        }
    } else {
        None
    };
    let applied_data: &serde_json::Value = edited_payload.unwrap_or(&proposal.data);

    // Validate the data being applied against its entity schema (ADR-0016 —
    // Core is the authority) for accept AND edit. For an edit the EDITED
    // payload is validated (not the model's proposed data); an invalid edit is
    // rejected BEFORE any write, leaving the Proposal pending + Run parked
    // (re-decidable). Reject applies nothing, so there is no payload to
    // validate. Slice 3 models only `todo`.
    if !is_reject {
        if proposal.kind == "todo" {
            if let Err(reason) = crate::entities::validate_todo(applied_data) {
                handler::frame_error(out_tx, id, HandlerError::InvalidParams(format!("invalid todo: {reason}")));
                return;
            }
        } else {
            handler::frame_error(
                out_tx,
                id,
                HandlerError::InvalidParams(format!(
                    "entity kind {:?} not supported",
                    proposal.kind
                )),
            );
            return;
        }
    }

    // The Decision rendered as the awaited tool's result text — what the model
    // reads on resume (ADR-0025). Persisted as the tool_call's result_payload
    // inside the atomic apply/reject, then surfaced in the reconstructed
    // transcript. For reject it MUST render as a NON-error decline so the
    // resumed model continues conversationally (not a tool failure).
    let (result_status, entity_id) = if is_reject {
        let decision_payload = serde_json::json!({
            "decision": "reject",
            "content": "User declined this proposal.",
            "is_error": false,
        })
        .to_string();

        match db::reject_proposal(
            pool,
            proposal.run_id,
            &proposal_id,
            &proposal.tool_call_id,
            params.decision_idempotency_key.as_deref(),
            &decision_payload,
            db::now_ms(),
        )
        .await
        {
            Ok(()) => ("rejected", None),
            // Lost the decide race (review M1): a concurrent decide already
            // decided this Proposal. The guarded flip affected 0 rows and the
            // tx rolled back, so nothing changed here — report not-pending.
            Err(db::ApplyError::NotPending) => {
                handler::frame_error(
                    out_tx,
                    id,
                    HandlerError::ProposalNotPending(format!(
                        "proposal {proposal_id} is no longer pending"
                    )),
                );
                return;
            }
            Err(db::ApplyError::Sql(e)) => {
                eprintln!("reject_proposal failed for {}: {e}", proposal_id);
                handler::frame_error(out_tx, id, HandlerError::Internal(anyhow::anyhow!("proposal/decide reject: {e}")));
                return;
            }
        }
    } else {
        // Accept OR edit: ONE atomic apply. For an edit the entity data is the
        // validated `edited_payload` (apply-in-one-step, ADR-0025); the
        // rendered Decision the model reads on resume shows the FINAL (edited)
        // values. `edited_payload` is recorded on the `proposals` row.
        let decision_text = render_accept_decision(&proposal.kind, applied_data);
        let decision_payload = serde_json::json!({
            "decision": "accept",
            "content": decision_text,
        })
        .to_string();

        match db::apply_proposal(
            pool,
            proposal.run_id,
            &proposal_id,
            &proposal.tool_call_id,
            &proposal.kind,
            &proposal.data,
            edited_payload,
            params.decision_idempotency_key.as_deref(),
            &decision_payload,
            db::now_ms(),
        )
        .await
        {
            Ok(eid) => ("accepted", Some(eid)),
            // Lost the apply race (review M1): a concurrent decide already
            // accepted this Proposal. The guarded flip affected 0 rows and the
            // tx rolled back, so nothing was applied here — report not-pending.
            // The winner's resume drives the Run forward.
            Err(db::ApplyError::NotPending) => {
                handler::frame_error(
                    out_tx,
                    id,
                    HandlerError::ProposalNotPending(format!(
                        "proposal {proposal_id} is no longer pending"
                    )),
                );
                return;
            }
            Err(db::ApplyError::Sql(e)) => {
                eprintln!("apply_proposal failed for {}: {e}", proposal_id);
                handler::frame_error(out_tx, id, HandlerError::Internal(anyhow::anyhow!("proposal/decide apply: {e}")));
                return;
            }
        }
    };

    // Resume the Run in a fresh Worker (ADR-0025). Flip parked→running first so
    // a `run/subscribe` in the window sees `running`, then spawn.
    if let Err(e) = crate::worker::resume(proposal.run_id, pool, hubs).await {
        eprintln!("resume failed for run {}: {e}", proposal.run_id);
        // The apply/reject already committed; surface the resume failure. The
        // Proposal is durably decided and the Run stays `parked` (the running
        // flip is inside `resume`, so a pre-flip failure leaves it parked). A
        // later decide retry recovers it: the idempotent branch (keyed) and the
        // already-decided branch (keyless) both re-drive `worker::resume` when
        // the Run is still parked — see `recover_resume_if_parked`.
        handler::frame_error(out_tx, id, HandlerError::Internal(anyhow::anyhow!("proposal/decide resume: {e}")));
        return;
    }

    // Push `proposal/changed` (ADR-0025) on the deciding connection now the
    // Decision is durably applied and the resume is under way. Sent AFTER the
    // decide RESPONSE so the request's reply frames first; the notification is
    // a side-channel push. Best-effort to OTHER tabs this slice — the deciding
    // tab re-subscribes for the resume tail (slice 9); a workspace-wide
    // proposal bus is out of scope.
    send_decide_result(out_tx, id, result_status, entity_id);
    send_proposal_changed(out_tx, proposal.run_id, &proposal_id, result_status);
}

/// The prior result of an already-decided Proposal for the idempotent /
/// resume-recovery branches (ADR-0025): a `rejected` Proposal returns
/// `("rejected", None)`; an `accepted` Proposal returns `("accepted",
/// Some(entity_id))` (looked up via `created_via_proposal_id`). Any other
/// status is unreachable here (callers gate on accepted|rejected).
async fn prior_decide_result(
    pool: &SqlitePool,
    proposal_id: &str,
    status: &str,
) -> sqlx::Result<(String, Option<String>)> {
    if status == "rejected" {
        return Ok(("rejected".to_string(), None));
    }
    let entity_id = db::entity_id_for_proposal(pool, proposal_id).await?;
    Ok(("accepted".to_string(), entity_id))
}

/// Recovery seam for a resume that failed AFTER the atomic apply committed
/// (review M2). The Decision is durable but the Run can be wedged at `parked`
/// because `worker::resume` errored before flipping it to `running`. A repeat
/// `proposal/decide` (the documented idempotent retry) calls this: it reads the
/// Run's status and re-drives `worker::resume` ONLY when still `parked`. A Run
/// already `running`/`completed`/`errored` is left untouched (no double spawn).
async fn recover_resume_if_parked(
    pool: &SqlitePool,
    hubs: &Hubs,
    run_id: Uuid,
) -> anyhow::Result<()> {
    match db::run_status(pool, run_id).await? {
        Some(ref s) if s == "parked" => crate::worker::resume(run_id, pool, hubs).await,
        _ => Ok(()),
    }
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
