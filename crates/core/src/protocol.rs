//! Wire protocol types: JSON-RPC 2.0 envelope and serde mirrors of the
//! TypeScript schemas in `packages/protocol`.
//!
//! Mirrored by hand per ADR-0009. `WorkerInbound` and `RunEvent` are
//! defined now even though Core only consumes them in slice 7 — this
//! establishes the snake_case mirror up front.

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
    #[allow(dead_code)] // unused this slice; consumed in slice 7 when Worker is spawned
    pub prompt: String,
}

#[derive(Debug, Serialize)]
pub struct PostMessageResult {
    pub run_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[allow(dead_code)] // consumed in slice 7 when Worker output is forwarded
pub enum RunEvent {
    TextDelta { delta: String },
    Done,
}

#[derive(Debug, Serialize)]
#[allow(dead_code)] // emitted in slice 7 when Core spawns the Worker
pub struct WorkerInbound<'a> {
    pub prompt: &'a str,
}
