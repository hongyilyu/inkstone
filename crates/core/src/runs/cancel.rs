//! `run/cancel` handler (ADR-0014): cancel a Run and (if parked) its pending
//! Proposal. The Response outcome is `accepted` (was live/parked, now
//! cancelling), `already_terminal` (already finished), or `unknown_run`. A
//! malformed `run_id` is `invalid_params`.
//!
//! Parked cancellation is pure tier-2: one tx flips the Run and its pending
//! Proposal to `cancelled`. Running cancellation first wins the guarded
//! `running -> cancelled` transition, then publishes `RunEvent::Cancelled` and
//! signals the live Worker via the hub (cleanup; the DB transition is the
//! user-visible outcome).

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;

use super::handler::{self, HandlerError};
use super::reply::send_response;
use crate::db;
use crate::hub::{self, Hubs, RunHub};
use crate::protocol::{RunCancelParams, RunCancelResult, RunEvent};

pub(super) async fn handle_cancel(
    pool: &SqlitePool,
    hubs: &Hubs,
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    let params: RunCancelParams = match serde_json::from_value(params) {
        Ok(p) => p,
        Err(e) => {
            handler::frame_error(
                out_tx,
                id,
                HandlerError::InvalidParams(format!("invalid params: {e}")),
            );
            return;
        }
    };
    let run_id = params.run_id;

    let mut cancelled_hub: Option<RunHub> = None;
    let outcome = match db::run_status(pool, run_id).await {
        Ok(status) => match status {
            // Unknown run id — an ADR-0014 outcome value, not an error code.
            None => "unknown_run",
            Some(status) => match status.as_str() {
                "completed" | "errored" | "cancelled" => "already_terminal",
                // Parked Run has no live Worker: a pure tier-2 flip of the Run
                // + its pending Proposal.
                "parked" => {
                    match db::cancel_parked_run(pool, run_id, db::now_ms()).await {
                        Ok(true) => "accepted",
                        Ok(false) => {
                            // Raced off `parked` (a concurrent decide/cancel won).
                            "already_terminal"
                        }
                        Err(e) => {
                            handler::frame_error(out_tx, id, HandlerError::Internal(e.into()));
                            return;
                        }
                    }
                }
                "running" => {
                    match db::cancel_running_run(pool, run_id, db::now_ms()).await {
                        Ok(moved) if moved.won() => {
                            cancelled_hub = hub::get(hubs, run_id);
                            if let Some(run_hub) = &cancelled_hub {
                                run_hub.cancel();
                            }
                            "accepted"
                        }
                        Ok(_) => {
                            // The Worker committed a terminal transition first.
                            "already_terminal"
                        }
                        Err(e) => {
                            handler::frame_error(out_tx, id, HandlerError::Internal(e.into()));
                            return;
                        }
                    }
                }
                _ => "already_terminal",
            },
        },
        Err(e) => {
            handler::frame_error(out_tx, id, HandlerError::Internal(e.into()));
            return;
        }
    };

    match serde_json::to_value(RunCancelResult {
        outcome: outcome.to_string(),
    }) {
        Ok(result) => send_response(out_tx, id, result),
        Err(e) => {
            handler::frame_error(out_tx, id, HandlerError::Internal(anyhow::Error::new(e)));
            return;
        }
    }

    if cancelled_hub.is_some() {
        publish_cancelled(hubs, run_id, cancelled_hub).await;
    }
}

async fn publish_cancelled(hubs: &Hubs, run_id: uuid::Uuid, run_hub: Option<RunHub>) {
    let Some(run_hub) = run_hub else {
        return;
    };

    let guard = run_hub.gate.lock().await;
    let _ = run_hub.tx.send(RunEvent::Cancelled);
    drop(guard);

    hub::remove(hubs, run_id);
}
