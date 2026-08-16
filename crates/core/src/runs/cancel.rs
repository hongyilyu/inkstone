//! `run/cancel` handler (ADR-0014): the thin JSON-RPC shell over the
//! [`crate::cancel`] verb (ADR-0029, the `proposal/decide` → [`crate::decide`]
//! precedent applied to cancel). Decode params → call [`crate::cancel::cancel`],
//! injecting `hub::get` as the hub lookup AND a `respond` closure that frames the
//! unchanged `RunCancelResult` wire strings (`accepted` / `already_terminal` /
//! `unknown_run`) with `live_tail`.
//!
//! The whole decision, the settle transition, the interrupted publications, and
//! the terminal `Cancelled` publish live in the verb — for a running-cancel, all
//! under ONE hub-gate acquisition (review P1 #3). The verb calls the injected
//! `respond` at the right point (inside the gate, BEFORE the events) so the wire
//! order `response → interrupted → cancelled` holds. A DB fault rides
//! `anyhow::Error` and is framed here as `Internal` (`-32603`); a malformed
//! `run_id` is `invalid_params` at decode.

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;

use super::handler::{self, HandlerError};
use super::reply::send_response;
use crate::cancel;
use crate::hub::{self, Hubs};
use crate::protocol::{RunCancelParams, RunCancelResult};

pub(super) async fn handle_cancel(
    pool: &SqlitePool,
    hubs: &Hubs,
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    let Some(params): Option<RunCancelParams> =
        handler::decode_params(out_tx, id.clone(), params)
    else {
        return;
    };
    let run_id = params.run_id;

    // The verb frames the Response via this callback — for a running-cancel,
    // INSIDE its gated section and BEFORE the terminal event, pinning the wire
    // order response → interrupted → cancelled. A DB fault is the only `Err` and
    // leaves the callback uncalled, so frame that error here.
    let respond_id = id.clone();
    let result = cancel::cancel(
        pool,
        hubs,
        run_id,
        |id| hub::get(hubs, id),
        |outcome, live_tail| {
            match serde_json::to_value(RunCancelResult {
                outcome: outcome.to_string(),
                live_tail,
            }) {
                Ok(value) => send_response(out_tx, respond_id, value),
                Err(e) => handler::frame_error(
                    out_tx,
                    respond_id,
                    HandlerError::Internal(anyhow::Error::new(e)),
                ),
            }
        },
    )
    .await;
    if let Err(e) = result {
        handler::frame_error(out_tx, id, HandlerError::Internal(e));
    }
}
