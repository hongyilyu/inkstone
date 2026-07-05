//! The request-handler seam (ADR-0029).
//!
//! [`handle`] is the combinator every request→response method routes through:
//! decode `params` into `P`, run the body, frame `Ok(S)`/`Err(HandlerError)`,
//! log internal faults. A handler body is therefore just
//! `async fn(P) -> Result<S, HandlerError>`.
//!
//! [`HandlerError`] carries its own JSON-RPC `code` (ADR-0014) and client-facing
//! message, so the failure→wire-code map lives in one place. `run/subscribe` and
//! `proposal/decide` are not request→response and stay hand-written, framing
//! their own errors through [`frame_error`].

use std::future::Future;

use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::sync::mpsc::UnboundedSender;
use uuid::Uuid;

use super::reply::{send_response, send_rpc_error};

/// A protocol-level failure from a handler body. Each variant owns its JSON-RPC
/// code (ADR-0014) and client-facing message; [`frame_error`] puts it on the
/// wire.
#[derive(Debug)]
pub(super) enum HandlerError {
    /// `-32602`: malformed params — including a non-UUID id, which fails at
    /// decode inside [`handle`] before the body runs.
    InvalidParams(String),
    /// `-32001`: a well-formed id naming a Thread that does not exist.
    UnknownThread(Uuid),
    /// `-32002`: the Proposal is not pending (already decided, or its Run is not
    /// parked).
    ProposalNotPending(String),
    /// `-32003`: a provider login could not start or complete. Carries a
    /// sanitized message (not internal detail) for the settings UI (ADR-0014).
    ProviderLoginFailed(String),
    /// `-32004`: the LLM provider the resolved model belongs to has no stored
    /// credential (ADR-0062). A fresh Run is rejected BEFORE spawning a doomed
    /// tokenless Worker, so the send fails loud with "connect it" rather than
    /// streaming into an opaque provider 401. Carries the provider id (the Web
    /// renders friendlier copy off the code; the id is the sanitized fallback).
    ProviderNotConnected { provider: String },
    /// `-32603`: an internal fault. The full error is logged server-side; the
    /// client gets a generic message so SQL/internal detail never leaks.
    Internal(anyhow::Error),
}

impl HandlerError {
    /// The JSON-RPC error code (ADR-0014).
    fn code(&self) -> i64 {
        match self {
            HandlerError::InvalidParams(_) => -32602,
            HandlerError::UnknownThread(_) => -32001,
            HandlerError::ProposalNotPending(_) => -32002,
            HandlerError::ProviderLoginFailed(_) => -32003,
            HandlerError::ProviderNotConnected { .. } => -32004,
            HandlerError::Internal(_) => -32603,
        }
    }

    /// The client-facing message. `Internal` is deliberately generic (full error
    /// is logged, never sent); every other variant carries a sanitized message.
    fn client_message(&self) -> String {
        match self {
            HandlerError::InvalidParams(m) => m.clone(),
            HandlerError::UnknownThread(id) => format!("unknown thread_id {id}"),
            HandlerError::ProposalNotPending(m) => m.clone(),
            HandlerError::ProviderLoginFailed(m) => m.clone(),
            // Reuse the liveness phrasing (worker/liveness.rs) so a rejected send
            // and a failed provider/test speak the same words.
            HandlerError::ProviderNotConnected { provider } => {
                format!("{provider} is not configured")
            }
            HandlerError::Internal(_) => "internal error".to_string(),
        }
    }
}

/// Gate a fresh Run on its resolved provider being connected (ADR-0062): reject
/// BEFORE spawning a doomed tokenless Worker so the send fails loud with a typed
/// [`HandlerError::ProviderNotConnected`] ("connect it") instead of streaming into
/// an opaque provider 401. Shared by every Run-creation site (post_message,
/// thread_create, journal_entry, retry).
///
/// A missing credential is `ProviderNotConnected`; a present-but-UNPARSEABLE
/// credential file is `Internal` (fail loud on a corrupt store, matching
/// `credentials::read`'s contract), never a misleading "not connected".
pub(super) fn ensure_provider_connected(provider: &str) -> Result<(), HandlerError> {
    match crate::credentials::is_connected(provider) {
        Ok(true) => Ok(()),
        Ok(false) => Err(HandlerError::ProviderNotConnected {
            provider: provider.to_string(),
        }),
        Err(e) => Err(HandlerError::Internal(e)),
    }
}

/// Frame a [`HandlerError`] onto the connection: internal faults are logged in
/// full here, the client receives `code` + `client_message`. Hand-written
/// handlers (`run/subscribe`, `proposal/decide`) call this directly.
pub(super) fn frame_error(
    out_tx: &UnboundedSender<String>,
    id: serde_json::Value,
    err: HandlerError,
) {
    if let HandlerError::Internal(e) = &err {
        // Log the full fault server-side (ADR-0038); the client still gets only
        // the generic `client_message()` below (ADR-0029 single-framing-site).
        tracing::error!(event = "handler.internal_error", error = ?e);
    }
    send_rpc_error(out_tx, id, err.code(), err.client_message());
}

/// Decode `params` into `P`, or frame `invalid_params` (`-32602`) and return
/// `None`. This is the one site that owns the decode-failure message + framing
/// for both the [`handle`] combinator and the hand-written opt-out handlers
/// (`run/subscribe`, `proposal/decide`, `run/cancel`), so they cannot drift back
/// to `-32603` (ADR-0029). Takes `id` by value to match [`frame_error`]; a
/// caller that still needs `id` on its success path passes `id.clone()`.
pub(super) fn decode_params<P: DeserializeOwned>(
    out_tx: &UnboundedSender<String>,
    id: serde_json::Value,
    params: serde_json::Value,
) -> Option<P> {
    match serde_json::from_value(params) {
        Ok(p) => Some(p),
        Err(e) => {
            frame_error(out_tx, id, HandlerError::InvalidParams(format!("invalid params: {e}")));
            None
        }
    }
}

/// Run a request→response handler body behind the seam: decode `params` into
/// `P` (decode failure is `invalid_params`), run `body`, frame the outcome. The
/// body never touches the wire — it returns a value or a [`HandlerError`].
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
    let Some(decoded): Option<P> = decode_params(out_tx, id.clone(), params) else {
        return;
    };

    match body(decoded).await {
        Ok(value) => match serde_json::to_value(value) {
            Ok(result) => send_response(out_tx, id, result),
            // A result that fails to serialize is an internal fault, not a panic.
            Err(e) => frame_error(out_tx, id, HandlerError::Internal(anyhow::Error::new(e))),
        },
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

    #[tokio::test]
    async fn provider_login_failed_frames_minus_32003_with_message() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        handle(json!(1), json!({ "id": Uuid::nil() }), &tx, |_p: TestParams| async move {
            Err::<Value, _>(HandlerError::ProviderLoginFailed(
                "provider login failed: account locked".to_string(),
            ))
        })
        .await;
        let v = recv_json(&mut rx);
        assert_eq!(v["error"]["code"], json!(-32003));
        // Unlike Internal, the sanitized provider message reaches the client.
        assert_eq!(
            v["error"]["message"],
            json!("provider login failed: account locked")
        );
    }

    #[test]
    fn ensure_provider_connected_maps_missing_present_and_corrupt() {
        use crate::credentials::{self, StoredCredential};

        // Shared panic-safe fixture: points this thread's Config at a fresh
        // credentials tempdir and restores the previous config on drop.
        let env = credentials::test_credentials_dir();

        // No credential file → ProviderNotConnected carrying the provider id.
        match ensure_provider_connected("openai-codex") {
            Err(HandlerError::ProviderNotConnected { provider }) => {
                assert_eq!(provider, "openai-codex");
            }
            other => panic!("expected ProviderNotConnected, got {other:?}"),
        }

        // A stored credential → Ok.
        credentials::write(
            "openai-codex",
            &StoredCredential::ApiKey {
                key: "sk-test".to_string(),
            },
        )
        .expect("write credential");
        assert!(ensure_provider_connected("openai-codex").is_ok());

        // A present-but-UNPARSEABLE file → Internal (fail loud on a corrupt store),
        // never a misleading ProviderNotConnected.
        std::fs::write(env.dir().join("openrouter.json"), b"{ not valid json")
            .expect("write corrupt file");
        match ensure_provider_connected("openrouter") {
            Err(HandlerError::Internal(_)) => {}
            other => panic!("expected Internal for a corrupt store, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn provider_not_connected_frames_minus_32004_with_provider_name() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        handle(json!(1), json!({ "id": Uuid::nil() }), &tx, |_p: TestParams| async move {
            Err::<Value, _>(HandlerError::ProviderNotConnected {
                provider: "openai-codex".to_string(),
            })
        })
        .await;
        let v = recv_json(&mut rx);
        assert_eq!(v["error"]["code"], json!(-32004));
        // The sanitized "not configured" message reaches the client (like the
        // liveness probe's phrasing), carrying the provider name for fallback copy.
        assert_eq!(v["error"]["message"], json!("openai-codex is not configured"));
    }

    #[tokio::test]
    async fn unserializable_result_frames_internal_not_panic() {
        use std::collections::HashMap;
        let (tx, mut rx) = mpsc::unbounded_channel();
        // A map with non-string keys cannot serialize to a JSON object; the
        // combinator must frame -32603, not panic and tear down the task.
        handle(json!(1), json!({ "id": Uuid::nil() }), &tx, |_p: TestParams| async move {
            let mut m: HashMap<(u8, u8), u8> = HashMap::new();
            m.insert((1, 2), 3);
            Ok::<_, HandlerError>(m)
        })
        .await;
        let v = recv_json(&mut rx);
        assert_eq!(v["error"]["code"], json!(-32603));
        assert!(v.get("result").is_none());
    }
}
