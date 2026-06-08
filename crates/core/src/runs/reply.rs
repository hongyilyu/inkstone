//! Shared JSON-RPC wire framing for Run handlers: response, `run/event`
//! notification, and error envelopes. All output is queued on the
//! per-connection `out_tx`; frame order is preserved because the connection
//! drains a single channel.

use tokio::sync::mpsc::UnboundedSender;
use uuid::Uuid;

use crate::protocol::{
    JsonRpcResponse, ProposalChangedNotification, ProposalPendingNotification, RunEvent,
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

/// Queue a `run/event` notification for `event` on the per-connection
/// channel. The ad-hoc shape `{run_id, event}` is the wire form the Client's
/// ui-sdk decodes.
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

/// Emit a cumulative-or-incremental `text_delta` Run Event (the snapshot
/// rides as one of these per ADR-0022 §17).
pub(super) fn send_text_delta(out_tx: &UnboundedSender<String>, run_id: Uuid, text: &str) {
    send_run_event(
        out_tx,
        run_id,
        &RunEvent::TextDelta {
            delta: text.to_string(),
        },
    );
}

/// Queue a `proposal/pending` notification (ADR-0025) on the per-connection
/// channel: the Run parked and `proposal_id` is its awaiting Proposal. A
/// subscribed Client renders the review card on receipt. Rides the
/// `proposal/*` channel, NOT a Run Event (the RunEvent enum stays frozen).
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

/// Queue a `proposal/changed` notification (ADR-0025) on the per-connection
/// channel: the Proposal `proposal_id` for `run_id` was decided to `status`
/// (`accepted`|`rejected`). Pushed on the deciding connection after the apply.
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

/// Frame a JSON-RPC 2.0 internal error (`-32603`, the JSON-RPC reserved code
/// per ADR-0014) and queue it on the per-connection channel.
pub(crate) fn send_error(
    out_tx: &UnboundedSender<String>,
    id: serde_json::Value,
    message: String,
) {
    send_rpc_error(out_tx, id, -32603, message);
}

/// Frame a JSON-RPC 2.0 `invalid_params` error (`-32602`, ADR-0014) and queue
/// it on the per-connection channel. Used for client-input rejections like an
/// empty `thread/create` prompt — distinct from the `-32603` internal-error
/// code [`send_error`] uses.
pub(crate) fn send_invalid_params(
    out_tx: &UnboundedSender<String>,
    id: serde_json::Value,
    message: String,
) {
    send_rpc_error(out_tx, id, -32602, message);
}

/// Frame a JSON-RPC `unknown_thread` error and queue it on the
/// per-connection channel. Code `-32001` sits in ADR-0014's Inkstone-specific
/// server-error band (`-32000..-32099`). Used by `run/post_message` when the
/// `thread_id` is well-formed but names a Thread that does not exist —
/// distinct from `invalid_params` (-32602), which is for a malformed
/// `thread_id`.
pub(crate) fn send_unknown_thread(
    out_tx: &UnboundedSender<String>,
    id: serde_json::Value,
    message: String,
) {
    send_rpc_error(out_tx, id, -32001, message);
}

/// Frame a JSON-RPC `proposal_not_pending` error (ADR-0025). Code `-32002`
/// sits in ADR-0014's Inkstone-specific server-error band. Used by
/// `proposal/decide` when the Proposal is not `pending` (already decided) or
/// its Run is not `parked` — a stale/duplicate decide that is not the
/// idempotent-retry case.
pub(crate) fn send_proposal_not_pending(
    out_tx: &UnboundedSender<String>,
    id: serde_json::Value,
    message: String,
) {
    send_rpc_error(out_tx, id, -32002, message);
}

/// Shared JSON-RPC error framer: builds the `{jsonrpc, id, error:{code,
/// message}}` envelope and queues it on the per-connection channel.
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
