//! Wire protocol types: JSON-RPC 2.0 envelope and hand-mirrored serde shapes of
//! the TypeScript schemas in `packages/protocol` (ADR-0009), split by method
//! namespace (mirroring the dispatch arms in [`crate::runs`]). Every type stays
//! reachable as `crate::protocol::TypeName` via the glob re-exports — the domain
//! files are pure type declarations, so a glob cannot shadow anything.

mod entity;
mod observation;
mod proposal;
mod provider;
mod run;
mod thread;
mod worker;

#[cfg(test)]
mod parity;

pub use entity::*;
pub use observation::*;
pub use proposal::*;
pub use provider::*;
pub use run::*;
pub use thread::*;
pub use worker::*;

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
