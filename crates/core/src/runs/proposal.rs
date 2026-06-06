//! `proposal/get` handler (ADR-0025): fetch a parked Run's pending Proposal.
//!
//! Pull-path observability of a park: a Client that learns a Run is `parked`
//! (via `run/subscribe`'s response status) follows with `proposal/get(run_id)`
//! to retrieve the awaiting Proposal — its kind, change_kind, proposed data,
//! rationale, and status. The `proposal/pending` push Notification + its
//! workspace bus arrive in a later (UI) slice; this slice makes the park fully
//! observable through the pull path alone.

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;
use uuid::Uuid;

use super::reply::{send_error, send_invalid_params, send_response};
use crate::db;
use crate::protocol::{ProposalGetParams, ProposalGetResult};

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
