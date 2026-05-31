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

#[derive(Debug, Serialize)]
pub struct PostMessageResult {
    pub run_id: String,
}

/// Run Event emitted by the Worker over its stdout NDJSON stream
/// (per ADR-0006). Core deserializes each line into this enum, takes
/// the appropriate persistence action, and forwards it as a `run/event`
/// Notification.
#[derive(Debug, Serialize, Deserialize)]
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
