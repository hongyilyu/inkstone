//! `run/cancel` handler (ADR-0014): the thin JSON-RPC shell over the
//! [`crate::cancel`] verb (ADR-0029, the `proposal/decide` → [`crate::decide`]
//! precedent applied to cancel). Decode params → call `cancel::cancel` (injecting
//! `hub::get` as the hub lookup) → frame the typed [`Outcome`] as the unchanged
//! `RunCancelResult` wire strings (`accepted` / `already_terminal` / `unknown_run`)
//! → frame a DB fault as `Internal`. A malformed `run_id` is `invalid_params`.
//!
//! The parked-vs-running decision and the running-won Worker signal live in the
//! verb. On a won running-cancel the verb returns the live `RunHub`; this shell
//! publishes the terminal `RunEvent::Cancelled` + removes the hub via
//! [`crate::cancel::publish_cancelled`] AFTER framing the Response, preserving the
//! deterministic `response → cancelled` wire order.

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;

use super::handler::{self, HandlerError};
use super::reply::send_response;
use crate::cancel::{self, Outcome};
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

    // The verb owns the decision + the Worker signal; the hub lookup is injected so
    // it stays testable against `:memory:` (ADR-0029).
    let (outcome, cancelled_hub) = match cancel::cancel(pool, run_id, |id| hub::get(hubs, id)).await
    {
        Ok(Outcome::Accepted { hub }) => ("accepted", hub),
        Ok(Outcome::AlreadyTerminal) => ("already_terminal", None),
        Ok(Outcome::UnknownRun) => ("unknown_run", None),
        Err(e) => {
            handler::frame_error(out_tx, id, HandlerError::Internal(e));
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

    // Publish the terminal Cancelled + remove the hub AFTER the Response is framed,
    // so the client sees `response → cancelled`. A parked/lost/terminal/unknown
    // outcome carries no hub, and `publish_cancelled` is then a no-op.
    cancel::publish_cancelled(hubs, run_id, cancelled_hub).await;
}
