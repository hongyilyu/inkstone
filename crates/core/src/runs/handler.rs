//! The request-handler seam (ADR-0029).
//!
//! [`handle`] is the combinator every request→response method routes through:
//! decode `params` into `P`, run the body, frame `Ok(S)` as a JSON-RPC Response
//! and `Err(HandlerError)` as a JSON-RPC error, and log internal faults. A
//! handler body is therefore just `async fn(P) -> Result<S, HandlerError>` — the
//! decode/validate/frame/log spine lives here once, not copied per method.
//!
//! [`HandlerError`] carries its own JSON-RPC `code` (the enumerated vocabulary
//! of ADR-0014) and its own client-facing message, so the failure→wire-code map
//! lives in one place. `run/subscribe` and `proposal/decide` are NOT request→
//! response (a stream / an idempotent multi-step transaction) and stay
//! hand-written; they frame their own error replies through [`frame_error`].

use std::future::Future;

use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::sync::mpsc::UnboundedSender;
use uuid::Uuid;

use super::reply::{send_response, send_rpc_error};

/// A protocol-level failure from a request handler body. Each variant owns its
/// JSON-RPC code (ADR-0014) and client-facing message; [`frame_error`] is the
/// only place that puts it on the wire.
#[derive(Debug)]
pub(super) enum HandlerError {
    /// `-32602`: malformed params — including a non-UUID id, which fails at
    /// decode inside [`handle`] before the body runs.
    InvalidParams(String),
    /// `-32001`: a well-formed id naming a Thread that does not exist.
    UnknownThread(Uuid),
    /// `-32002`: the Proposal is not pending (already decided, or its Run is not
    /// parked). Consumed by the hand-written `proposal/decide` once it routes
    /// through [`frame_error`].
    #[allow(dead_code)] // first consumer lands when the framers collapse (later slice)
    ProposalNotPending(String),
    /// `-32603`: an internal fault. The full error is logged server-side; the
    /// client gets a generic message so SQL/internal detail never leaks.
    Internal(anyhow::Error),
}

impl HandlerError {
    /// The JSON-RPC error code (ADR-0014). The single source of the map.
    fn code(&self) -> i64 {
        match self {
            HandlerError::InvalidParams(_) => -32602,
            HandlerError::UnknownThread(_) => -32001,
            HandlerError::ProposalNotPending(_) => -32002,
            HandlerError::Internal(_) => -32603,
        }
    }

    /// The client-facing message. `Internal` is deliberately generic — the full
    /// error is logged, never sent over the wire.
    fn client_message(&self) -> String {
        match self {
            HandlerError::InvalidParams(m) => m.clone(),
            HandlerError::UnknownThread(id) => format!("unknown thread_id {id}"),
            HandlerError::ProposalNotPending(m) => m.clone(),
            HandlerError::Internal(_) => "internal error".to_string(),
        }
    }
}

/// Frame a [`HandlerError`] onto the connection. Internal faults are logged in
/// full here (the one site that replaces the per-handler `eprintln!`s); the
/// client receives `code` + `client_message`. Hand-written handlers
/// (`run/subscribe`, `proposal/decide`) call this directly.
pub(super) fn frame_error(
    out_tx: &UnboundedSender<String>,
    id: serde_json::Value,
    err: HandlerError,
) {
    if let HandlerError::Internal(e) = &err {
        eprintln!("handler internal error: {e:?}");
    }
    send_rpc_error(out_tx, id, err.code(), err.client_message());
}

/// Run a request→response handler body behind the seam: decode `params` into
/// `P` (a decode failure is `invalid_params`), run `body`, then frame the
/// outcome. The body never touches the wire — it returns a value or a
/// [`HandlerError`].
pub(super) async fn handle<P, S, F, Fut>(
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
    body: F,
) where
    P: DeserializeOwned,
    S: Serialize,
    F: FnOnce(P) -> Fut,
    Fut: Future<Output = Result<S, HandlerError>>,
{
    let decoded: P = match serde_json::from_value(params) {
        Ok(p) => p,
        Err(e) => {
            frame_error(out_tx, id, HandlerError::InvalidParams(format!("invalid params: {e}")));
            return;
        }
    };

    match body(decoded).await {
        Ok(value) => {
            let result = serde_json::to_value(value).expect("handler result serializes");
            send_response(out_tx, id, result);
        }
        Err(err) => frame_error(out_tx, id, err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::{Value, json};
    use tokio::sync::mpsc;

    #[derive(Deserialize)]
    struct TestParams {
        #[allow(dead_code)]
        id: Uuid,
    }

    fn recv_json(rx: &mut mpsc::UnboundedReceiver<String>) -> Value {
        let line = rx.try_recv().expect("a frame was queued");
        serde_json::from_str(&line).expect("frame is JSON")
    }

    #[tokio::test]
    async fn ok_body_frames_a_response() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        handle(json!(1), json!({ "id": Uuid::nil() }), &tx, |_p: TestParams| async move {
            Ok::<_, HandlerError>(json!({ "hello": "world" }))
        })
        .await;
        let v = recv_json(&mut rx);
        assert_eq!(v["result"], json!({ "hello": "world" }));
        assert!(v.get("error").is_none());
    }

    #[tokio::test]
    async fn unknown_thread_frames_minus_32001() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        handle(json!(1), json!({ "id": Uuid::nil() }), &tx, |_p: TestParams| async move {
            Err::<Value, _>(HandlerError::UnknownThread(Uuid::nil()))
        })
        .await;
        let v = recv_json(&mut rx);
        assert_eq!(v["error"]["code"], json!(-32001));
    }

    #[tokio::test]
    async fn malformed_id_frames_invalid_params() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        // The body would succeed, but the non-UUID id fails to decode first.
        handle(json!(1), json!({ "id": "not-a-uuid" }), &tx, |_p: TestParams| async move {
            Ok::<_, HandlerError>(json!({}))
        })
        .await;
        let v = recv_json(&mut rx);
        assert_eq!(v["error"]["code"], json!(-32602));
    }

    #[tokio::test]
    async fn internal_frames_generic_message_not_the_detail() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        handle(json!(1), json!({ "id": Uuid::nil() }), &tx, |_p: TestParams| async move {
            Err::<Value, _>(HandlerError::Internal(anyhow::anyhow!(
                "secret: SELECT token FROM credentials"
            )))
        })
        .await;
        let v = recv_json(&mut rx);
        assert_eq!(v["error"]["code"], json!(-32603));
        let msg = v["error"]["message"].as_str().unwrap();
        assert_eq!(msg, "internal error");
        assert!(!msg.contains("credentials"));
    }
}
