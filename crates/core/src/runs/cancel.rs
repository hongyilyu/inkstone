//! `run/cancel` handler (ADR-0014): cancel a Run and (if parked) its pending
//! Proposal. The Response answers "did Core accept the cancel command?" —
//! `accepted` (the Run was live/parked and is now being cancelled),
//! `already_terminal` (the Run had already finished), or `unknown_run` (the id
//! named no Run). A malformed `run_id` is `invalid_params`.
//!
//! This slice's tested path is the PARKED case: the Worker is already torn
//! down on park, so cancelling is pure tier-2 — `db::cancel_parked_run` flips
//! the Run to `cancelled` and its pending Proposal to `cancelled` in one tx.
//! A subsequent `proposal/decide` then sees a non-pending Proposal and returns
//! `proposal_not_pending` (the decide validation reuses that gate).

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;

use super::handler::{self, HandlerError};
use crate::db;
use crate::protocol::{RunCancelParams, RunCancelResult};

pub(super) async fn handle_cancel(
    pool: &SqlitePool,
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    handler::handle(id, params, out_tx, |params: RunCancelParams| async move {
        let run_id = params.run_id;

        let outcome = match db::run_status(pool, run_id)
            .await
            .map_err(|e| HandlerError::Internal(e.into()))?
        {
            // Unknown run id — an ADR-0014 outcome value, not an error code.
            None => "unknown_run",
            Some(status) => match status.as_str() {
                // Already over — the cancel is redundant.
                "completed" | "errored" | "cancelled" => "already_terminal",
                // The tested path: a parked Run has no live Worker, so cancel
                // is a pure tier-2 flip of the Run + its pending Proposal.
                "parked" => {
                    if db::cancel_parked_run(pool, run_id, db::now_ms())
                        .await
                        .map_err(|e| HandlerError::Internal(e.into()))?
                    {
                        "accepted"
                    } else {
                        // Raced off `parked` (a concurrent decide/cancel won).
                        "already_terminal"
                    }
                }
                // A live running Run: best-effort accept. Aborting the live
                // Worker is OUT OF SCOPE this slice — only the parked path is
                // exercised. TODO(slice N): signal the live Worker to abort.
                _ => "accepted",
            },
        };

        Ok(RunCancelResult {
            outcome: outcome.to_string(),
        })
    })
    .await;
}
