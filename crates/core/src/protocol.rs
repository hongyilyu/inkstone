//! Wire protocol types: JSON-RPC 2.0 envelope and serde mirrors of the
//! TypeScript schemas in `packages/protocol`. Mirrored by hand per
//! ADR-0009.

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct JsonRpcRequest {
    #[allow(dead_code)] // validated implicitly by deserialize; not branched on yet
    pub jsonrpc: String,
    pub id: serde_json::Value,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: &'static str,
    pub id: serde_json::Value,
    pub result: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub struct PostMessageParams {
    pub prompt: String,
}

/// `run/subscribe` params: the Run to attach to. Snapshot-then-tail
/// (ADR-0022) — Core replies with the cumulative assistant text as a
/// `text_delta` snapshot, then forwards the live tail until `done`.
#[derive(Debug, Deserialize)]
pub struct SubscribeParams {
    pub run_id: String,
}

#[derive(Debug, Serialize)]
pub struct PostMessageResult {
    pub run_id: String,
}

/// `thread/create` params: the first user message. Message-first thread
/// creation (ADR-0022) — a Thread is born only with its first message, so
/// `prompt` is required. An empty/whitespace prompt is rejected with
/// `invalid_params` before any row is written (the trim-empty guard lives
/// in [`crate::runs::handle_thread_create`], not here).
#[derive(Debug, Deserialize)]
pub struct ThreadCreateParams {
    pub prompt: String,
}

/// `thread/create` result: the freshly-minted Thread and its first Run.
/// Pure-subscribe (ADR-0022) — the response carries only these ids; the
/// Client follows with `run/subscribe(run_id)` to receive events.
#[derive(Debug, Serialize)]
pub struct ThreadCreateResult {
    pub thread_id: String,
    pub run_id: String,
}

/// Run Event emitted by the Worker over its stdout NDJSON stream
/// (per ADR-0006). Core deserializes each line into this enum, takes
/// the appropriate persistence action, and forwards it as a `run/event`
/// Notification.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RunEvent {
    TextDelta { delta: String },
    Done,
}

/// Single line written to the Worker's stdin at spawn time, carrying the
/// user prompt the Worker should act on.
#[derive(Debug, Serialize)]
pub struct WorkerInbound<'a> {
    pub prompt: &'a str,
}
