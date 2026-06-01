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

/// `run/post_message` params: add a message (and its Run) to an EXISTING
/// Thread. Existing-thread-only (ADR-0022) — `thread_id` is required and
/// never optional; minting a new Thread is `thread/create`'s job. A
/// malformed `thread_id` is rejected with `invalid_params` (-32602); a
/// well-formed id for a Thread that does not exist with `unknown_thread`
/// (-32001). Field order is cosmetic (serde matches by name; `thread_id` is
/// snake_case to mirror the TS schema, slice 7).
#[derive(Debug, Deserialize)]
pub struct PostMessageParams {
    pub thread_id: String,
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

/// A single Thread row in a `thread/list` result: the sidebar's view of a
/// Thread (ADR-0017 `threads` columns). `last_activity_at` is the ms-epoch
/// the Thread was last touched (bumped on each new Run); the list orders by
/// it, newest-first.
#[derive(Debug, Serialize)]
pub struct ThreadSummary {
    pub id: String,
    pub title: String,
    pub last_activity_at: i64,
}

/// `thread/list` result: every Thread, ordered most-recent-activity-first.
/// Object-wrapper shape (`{threads: [...]}`) rather than a bare array so the
/// result stays forward-extensible and the TS mirror (slice 7) is a
/// `Schema.Struct`.
#[derive(Debug, Serialize)]
pub struct ThreadListResult {
    pub threads: Vec<ThreadSummary>,
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
