//! Tool registry (ADR-0018, ADR-0003). Tools are implemented once in Rust, each
//! with a `name`/`description`/`label`, `schemars`-derived schema, and async
//! `execute`. Core ships allowlist-filtered descriptors in the manifest; the
//! Worker proxies `tool_request`/`tool_result` over stdio with zero per-tool code.

mod propose_workspace_mutation;
mod read_current_thread_journal_entries;
mod read_thread;

use serde_json::Value;
use sqlx::SqlitePool;

use crate::protocol::CoreToolDescriptor;

/// A tool execution failure. Becomes the `err` half of a `ToolResult`
/// (`{code, message}`), fed back to the model by the Worker proxy.
#[derive(Debug)]
pub struct ToolError {
    pub code: String,
    pub message: String,
}

/// The descriptor for a registered tool by name, or `None` if unregistered.
fn descriptor_for(name: &str) -> Option<CoreToolDescriptor> {
    match name {
        read_thread::NAME => Some(read_thread::descriptor()),
        read_current_thread_journal_entries::NAME => {
            Some(read_current_thread_journal_entries::descriptor())
        }
        propose_workspace_mutation::NAME => Some(propose_workspace_mutation::descriptor()),
        _ => None,
    }
}

/// Build the descriptor list for a Workflow's tool allowlist, in allowlist
/// order. Unknown names are skipped — Core's registry, not the Workflow file,
/// decides what exists.
pub fn descriptors_for(allowlist: &[String]) -> Vec<CoreToolDescriptor> {
    allowlist
        .iter()
        .filter_map(|name| descriptor_for(name))
        .collect()
}

/// Whether `name` is a registered tool. Used for allowlist enforcement before
/// dispatch (ADR-0018).
pub fn is_registered(name: &str) -> bool {
    descriptor_for(name).is_some()
}

/// Whether `name` is a Proposal tool (ADR-0025). Core intercepts a Proposal
/// `tool_request` before dispatch and parks the Run instead of executing it;
/// non-Proposal tools dispatch synchronously. `propose_workspace_mutation` is
/// the only Proposal tool today.
pub fn is_proposal(name: &str) -> bool {
    name == propose_workspace_mutation::NAME
}

/// Dispatch a `tool_request` to the named tool's `execute`. The caller has
/// enforced the allowlist; an unregistered name is a defensive `unknown_tool`.
pub async fn execute(
    pool: &SqlitePool,
    run_id: uuid::Uuid,
    name: &str,
    params: Value,
) -> Result<crate::protocol::AgentToolResult, ToolError> {
    match name {
        read_thread::NAME => read_thread::execute(pool, params).await,
        read_current_thread_journal_entries::NAME => {
            read_current_thread_journal_entries::execute(pool, run_id, params).await
        }
        // Proposal tools never reach dispatch (ADR-0025); reaching here means
        // the park interception was bypassed, so refuse defensively.
        propose_workspace_mutation::NAME => Err(ToolError {
            code: "proposal_not_executable".to_string(),
            message: "propose_workspace_mutation parks the Run; it is not dispatched".to_string(),
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
        assert!(is_registered("read_current_thread_journal_entries"));
        assert!(!is_registered("nonexistent"));
    }
}
