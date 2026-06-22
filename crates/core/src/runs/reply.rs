//! Shared JSON-RPC wire framing for Run handlers: response, `run/event`
//! notification, and error envelopes. All output is queued on the
//! per-connection `out_tx` (a single channel, so frame order is preserved).

use tokio::sync::mpsc::UnboundedSender;
use uuid::Uuid;

use crate::protocol::{
    JsonRpcResponse, ProposalChangedNotification, ProposalPendingNotification, RunEvent,
    ThreadTitledNotification,
};

/// Frame a JSON-RPC RESPONSE carrying `result` for request `id` and queue it.
pub(super) fn send_response(
    out_tx: &UnboundedSender<String>,
    id: serde_json::Value,
    result: serde_json::Value,
) {
    let response = JsonRpcResponse {
        jsonrpc: "2.0",
        id,
        result,
    };
    let body = serde_json::to_string(&response).expect("JsonRpcResponse always serializes");
    let _ = out_tx.send(body);
}

/// Queue a `run/event` notification. The shape `{run_id, event}` is the wire
/// form the Client's ui-sdk decodes.
pub(super) fn send_run_event(
    out_tx: &UnboundedSender<String>,
    run_id: Uuid,
    event: &RunEvent,
) {
    let notification = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "run/event",
        "params": {
            "run_id": run_id.to_string(),
            "event": event,
        },
    });
    let body = serde_json::to_string(&notification).expect("notification serializes");
    let _ = out_tx.send(body);
}

/// Emit a `text_delta` Run Event (the snapshot rides as one of these,
/// ADR-0022 §17).
pub(super) fn send_text_delta(out_tx: &UnboundedSender<String>, run_id: Uuid, text: &str) {
    send_run_event(
        out_tx,
        run_id,
        &RunEvent::TextDelta {
            delta: text.to_string(),
        },
    );
}

/// Queue a `proposal/pending` notification (ADR-0025): the Run parked and
/// `proposal_id` is its awaiting Proposal. Rides the `proposal/*` channel, not
/// a Run Event.
pub(super) fn send_proposal_pending(
    out_tx: &UnboundedSender<String>,
    run_id: Uuid,
    proposal_id: &str,
) {
    let notification = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "proposal/pending",
        "params": ProposalPendingNotification {
            run_id: run_id.to_string(),
            proposal_id: proposal_id.to_string(),
        },
    });
    let body = serde_json::to_string(&notification).expect("notification serializes");
    let _ = out_tx.send(body);
}

/// Queue a `proposal/changed` notification (ADR-0025): `proposal_id` for
/// `run_id` was decided to `status` (`accepted`|`rejected`). Pushed on the
/// deciding connection after the apply.
pub(super) fn send_proposal_changed(
    out_tx: &UnboundedSender<String>,
    run_id: Uuid,
    proposal_id: &str,
    status: &str,
) {
    let notification = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "proposal/changed",
        "params": ProposalChangedNotification {
            run_id: run_id.to_string(),
            proposal_id: proposal_id.to_string(),
            status: status.to_string(),
        },
    });
    let body = serde_json::to_string(&notification).expect("notification serializes");
    let _ = out_tx.send(body);
}

/// Frame a run-less server→client notification (ADR-0047) — `{jsonrpc, method,
/// params}` — and queue it on `out_tx`. The foundation of the connection
/// notification channel: a detached, non-Run task with a durable result delivers
/// it live over the originating connection, keyed by `method` rather than a Run
/// subscription. A dead `out_tx` (the tab closed) makes the send a silent no-op
/// (`let _ = …`); delivery is best-effort / at-most-once, DB-is-truth.
pub(crate) fn send_notification(
    out_tx: &UnboundedSender<String>,
    method: &str,
    params: serde_json::Value,
) {
    let notification = serde_json::json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
    });
    let body = serde_json::to_string(&notification).expect("notification serializes");
    let _ = out_tx.send(body);
}

/// Queue a `thread/titled` notification (ADR-0047): the one-shot titler
/// (ADR-0046) generated `title` for `thread_id`, pushed to the connection that
/// created the thread so its sidebar updates without a `thread/list` poll.
pub(crate) fn send_thread_titled(out_tx: &UnboundedSender<String>, thread_id: Uuid, title: &str) {
    let params = serde_json::to_value(ThreadTitledNotification {
        thread_id: thread_id.to_string(),
        title: title.to_string(),
    })
    .expect("ThreadTitledNotification serializes");
    send_notification(out_tx, "thread/titled", params);
}

/// Shared JSON-RPC error framer: builds and queues the `{jsonrpc, id,
/// error:{code, message}}` envelope. The failure→code map lives on
/// [`super::handler::HandlerError`] (ADR-0029).
pub(super) fn send_rpc_error(
    out_tx: &UnboundedSender<String>,
    id: serde_json::Value,
    code: i64,
    message: String,
) {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
    .to_string();
    let _ = out_tx.send(body);
}
