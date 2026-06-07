//! Tool registry (ADR-0018). Tools are implemented once, in Rust. Each has a
//! `name`/`description`/`label`, a `schemars`-derived input schema, and an
//! async `execute`. At spawn, Core ships the descriptors (filtered by the
//! Workflow's allowlist) in the manifest; the Worker builds proxy `AgentTool`s
//! that round-trip `tool_request`/`tool_result` over stdio. Tool impls live
//! here and nowhere else — the Worker has zero per-tool code (ADR-0003
//! chokepoint).
//!
//! Slice 2 registers exactly one tool, `read_thread`, with a stub body.

mod read_thread;
mod propose_entity;

use serde_json::Value;
use sqlx::SqlitePool;

use crate::protocol::CoreToolDescriptor;

/// A tool execution failure. Becomes the `err` half of a `ToolResult` outcome
/// (`{code, message}`); the Worker proxy throws so `pi-agent-core` feeds the
/// error back to the model.
#[derive(Debug)]
pub struct ToolError {
    pub code: String,
    pub message: String,
}

/// The descriptor for a single registered tool by name, or `None` if no tool
/// with that name is registered.
fn descriptor_for(name: &str) -> Option<CoreToolDescriptor> {
    match name {
        read_thread::NAME => Some(read_thread::descriptor()),
        propose_entity::NAME => Some(propose_entity::descriptor()),
        _ => None,
    }
}

/// Build the descriptor list for a Workflow's tool allowlist, in allowlist
/// order. Unknown names are skipped (a Workflow naming a tool Core doesn't
/// register simply doesn't expose it) — Core's authoritative registry, not the
/// Workflow file, decides what exists.
pub fn descriptors_for(allowlist: &[String]) -> Vec<CoreToolDescriptor> {
    allowlist.iter().filter_map(|name| descriptor_for(name)).collect()
}

/// Whether `name` is a registered tool. Used for allowlist enforcement on a
/// `tool_request` before dispatch (ADR-0018 "Tool allowlist enforcement").
pub fn is_registered(name: &str) -> bool {
    descriptor_for(name).is_some()
}

/// Whether `name` is a Proposal tool (ADR-0025). Core's Worker run loop
/// intercepts a Proposal-tool `tool_request` BEFORE dispatch and parks the Run
/// instead of executing it; non-Proposal tools take the synchronous
/// dispatch-and-reply path. `propose_entity` is the only Proposal tool today.
pub fn is_proposal(name: &str) -> bool {
    name == propose_entity::NAME
}

/// Dispatch a `tool_request` to the named tool's `execute`. The caller has
/// already enforced the allowlist; an unregistered name here is a defensive
/// `unknown_tool` error.
pub async fn execute(
    pool: &SqlitePool,
    name: &str,
    params: Value,
) -> Result<crate::protocol::AgentToolResult, ToolError> {
    match name {
        read_thread::NAME => read_thread::execute(pool, params).await,
        // Proposal tools never reach dispatch — the Worker run loop parks the
        // Run before `execute` (ADR-0025). A `propose_entity` here means the
        // park interception was bypassed; refuse defensively rather than treat
        // a Proposal as a synchronous tool.
        propose_entity::NAME => Err(ToolError {
            code: "proposal_not_executable".to_string(),
            message: "propose_entity parks the Run; it is not dispatched".to_string(),
        }),
        _ => Err(ToolError {
            code: "unknown_tool".to_string(),
            message: format!("no tool registered as {name:?}"),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptors_for_resolves_known_skips_unknown() {
        let ds = descriptors_for(&["read_thread".to_string(), "nope".to_string()]);
        assert_eq!(ds.len(), 1, "only the registered tool is described");
        assert_eq!(ds[0].name, "read_thread");
    }

    #[test]
    fn is_registered_reflects_the_registry() {
        assert!(is_registered("read_thread"));
        assert!(!is_registered("nonexistent"));
    }
}
