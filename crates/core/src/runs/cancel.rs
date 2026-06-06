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
use uuid::Uuid;

use super::reply::{send_error, send_invalid_params, send_response};
use crate::db;
use crate::protocol::{RunCancelParams, RunCancelResult};

pub(super) async fn handle_cancel(
    pool: &SqlitePool,
    id: serde_json::Value,
    params: RunCancelParams,
    out_tx: &UnboundedSender<String>,
) {
    let Ok(run_id) = Uuid::parse_str(&params.run_id) else {
        send_invalid_params(out_tx, id, format!("invalid run_id {:?}", params.run_id));
        return;
    };

    let status = match db::run_status(pool, run_id).await {
        Ok(Some(s)) => s,
        Ok(None) => {
            send_outcome(out_tx, id, "unknown_run");
            return;
        }
        Err(e) => {
            eprintln!("run_status failed for {run_id}: {e}");
            send_error(out_tx, id, format!("run/cancel: {e}"));
            return;
        }
    };

    match status.as_str() {
        // Already over — the cancel is redundant (ADR-0014 already_terminal).
        "completed" | "errored" | "cancelled" => {
            send_outcome(out_tx, id, "already_terminal");
        }
        // The tested path: a parked Run has no live Worker, so cancel is a pure
        // tier-2 flip of the Run + its pending Proposal in one tx.
        "parked" => match db::cancel_parked_run(pool, run_id, db::now_ms()).await {
            Ok(true) => send_outcome(out_tx, id, "accepted"),
            // Raced off `parked` (a concurrent decide/cancel won) — nothing
            // changed here; report already_terminal.
            Ok(false) => send_outcome(out_tx, id, "already_terminal"),
            Err(e) => {
                eprintln!("cancel_parked_run failed for {run_id}: {e}");
                send_error(out_tx, id, format!("run/cancel: {e}"));
            }
        },
        // A live (running/pending) Run: best-effort accept. Aborting the live
        // Worker process is OUT OF SCOPE this slice — only the parked path is
        // exercised. A later slice wires the Worker-abort signal; for now we
        // accept the command so the Client UX ("cancelling…") is consistent.
        _ => {
            // TODO(slice N): signal the live Worker to abort + mark the Run
            // cancelled. The parked case above is the slice's tested behavior.
            send_outcome(out_tx, id, "accepted");
        }
    }
}

fn send_outcome(out_tx: &UnboundedSender<String>, id: serde_json::Value, outcome: &str) {
    send_response(
        out_tx,
        id,
        serde_json::to_value(RunCancelResult {
            outcome: outcome.to_string(),
        })
        .expect("RunCancelResult serializes"),
    );
}
