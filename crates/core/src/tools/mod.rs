//! Tool registry (ADR-0018, ADR-0003). Tools are implemented once in Rust, each
//! with a `name`/`description`/`label`, `schemars`-derived schema, and async
//! `execute`. Core ships allowlist-filtered descriptors in the manifest; the
//! Worker proxies `tool_request`/`tool_result` over stdio with zero per-tool code.

mod load_skill;
mod propose_workspace_mutation;
mod read_current_thread_journal_entries;
mod read_thread;
mod search_entities;

use std::future::Future;
use std::pin::Pin;

use serde_json::Value;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::protocol::{AgentToolResult, CoreToolDescriptor};

/// A tool execution failure. Becomes the `err` half of a `ToolResult`
/// (`{code, message}`), fed back to the model by the Worker proxy.
#[derive(Debug)]
pub struct ToolError {
    pub code: String,
    pub message: String,
}

/// The boxed future a tool's async `execute` returns once erased behind a fn
/// pointer. Each `async fn` has a unique opaque return type, so the registry
/// can't name them directly; `Box::pin` unifies them under one type. `'a` ties
/// the future to the borrowed `pool` (Pool/PoolRun); `NoContext` borrows
/// nothing and is `'static`.
type ToolFuture<'a> = Pin<Box<dyn Future<Output = Result<AgentToolResult, ToolError>> + Send + 'a>>;

/// How a registered tool is reached. Encodes the `execute`-signature variance —
/// each tool wants a different slice of Run context — without flattening it to
/// one uniform signature, and keeps Proposal first-class (it has no `execute`).
/// A plain data enum, not a `dyn` router: ADR-0029 and ADR-0026 reject the trait
/// object here as indirection without leverage.
enum Dispatch {
    /// Not dispatchable. A Proposal Tool Request parks the Run on a pending
    /// Proposal before dispatch (ADR-0025); its Tool Result is a user Decision,
    /// so it has no `execute`. `propose_workspace_mutation` is the only one.
    Proposal,
    /// Reads durable state: `(pool, params)`. `read_thread`, `search_entities`.
    Pool(for<'a> fn(&'a SqlitePool, Value) -> ToolFuture<'a>),
    /// Reads state scoped to the current Run: `(pool, run_id, params)`.
    /// `read_current_thread_journal_entries`.
    PoolRun(for<'a> fn(&'a SqlitePool, Uuid, Value) -> ToolFuture<'a>),
    /// Needs neither pool nor run_id (ADR-0036): `(params)`. `load_skill` reads a
    /// Core-managed config file, not the DB.
    NoContext(fn(Value) -> ToolFuture<'static>),
}

/// One registered tool: its wire `name`, its manifest `descriptor`, and how it
/// dispatches. `REGISTRY` is the single source the reads below derive from, so a
/// tool can't be described-but-undispatchable (or the reverse) — the gap the old
/// three parallel name-keyed matches left open.
struct ToolEntry {
    name: &'static str,
    descriptor: fn() -> CoreToolDescriptor,
    dispatch: Dispatch,
}

/// Every registered tool, in manifest (descriptor) order.
const REGISTRY: &[ToolEntry] = &[
    ToolEntry {
        name: read_thread::NAME,
        descriptor: read_thread::descriptor,
        dispatch: Dispatch::Pool(|pool, params| Box::pin(read_thread::execute(pool, params))),
    },
    ToolEntry {
        name: read_current_thread_journal_entries::NAME,
        descriptor: read_current_thread_journal_entries::descriptor,
        dispatch: Dispatch::PoolRun(|pool, run_id, params| {
            Box::pin(read_current_thread_journal_entries::execute(pool, run_id, params))
        }),
    },
    ToolEntry {
        name: propose_workspace_mutation::NAME,
        descriptor: propose_workspace_mutation::descriptor,
        dispatch: Dispatch::Proposal,
    },
    ToolEntry {
        name: search_entities::NAME,
        descriptor: search_entities::descriptor,
        dispatch: Dispatch::Pool(|pool, params| Box::pin(search_entities::execute(pool, params))),
    },
    ToolEntry {
        name: load_skill::NAME,
        descriptor: load_skill::descriptor,
        dispatch: Dispatch::NoContext(|params| Box::pin(load_skill::execute(params))),
    },
];

/// The descriptor for a registered tool by name, or `None` if unregistered.
fn descriptor_for(name: &str) -> Option<CoreToolDescriptor> {
    REGISTRY
        .iter()
        .find(|e| e.name == name)
        .map(|e| (e.descriptor)())
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
/// the only Proposal tool today. `false` for an unregistered name — this is
/// called (run.rs) before the allowlist check.
pub fn is_proposal(name: &str) -> bool {
    REGISTRY
        .iter()
        .find(|e| e.name == name)
        .is_some_and(|e| matches!(e.dispatch, Dispatch::Proposal))
}

/// Dispatch a `tool_request` to the named tool's `execute`, handing it the exact
/// Run context its [`Dispatch`] variant needs. The caller has enforced the
/// allowlist; an unregistered name is a defensive `unknown_tool`.
pub async fn execute(
    pool: &SqlitePool,
    run_id: Uuid,
    name: &str,
    params: Value,
) -> Result<AgentToolResult, ToolError> {
    let Some(entry) = REGISTRY.iter().find(|e| e.name == name) else {
        return Err(ToolError {
            code: "unknown_tool".to_string(),
            message: format!("no tool registered as {name:?}"),
        });
    };
    match &entry.dispatch {
        Dispatch::Pool(execute) => execute(pool, params).await,
        Dispatch::PoolRun(execute) => execute(pool, run_id, params).await,
        Dispatch::NoContext(execute) => execute(params).await,
        // Proposal tools never reach dispatch (ADR-0025); reaching here means
        // the park interception was bypassed, so refuse defensively.
        Dispatch::Proposal => Err(ToolError {
            code: "proposal_not_executable".to_string(),
            message: "propose_workspace_mutation parks the Run; it is not dispatched".to_string(),
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

    /// The leverage the single-record collapse buys: a descriptor whose `name`
    /// drifts from its `REGISTRY` key, a duplicate name, or a wrong Proposal
    /// count now fails HERE; a dispatch pointing at a missing or wrong-arity
    /// `execute` fails at compile time — neither can slip through to a silent
    /// runtime miss the way the old parallel match tables allowed when one
    /// omitted a tool the others listed. Each entry's descriptor self-reports
    /// its own `name`, every name is non-empty and unique, and exactly one entry
    /// is the `Proposal` — `propose_workspace_mutation`.
    #[test]
    fn registry_is_complete_and_consistent() {
        let mut seen = std::collections::HashSet::new();
        for entry in REGISTRY {
            assert!(!entry.name.is_empty(), "every registry name is non-empty");
            assert!(
                seen.insert(entry.name),
                "registry names are unique, {:?} repeats",
                entry.name
            );
            assert_eq!(
                (entry.descriptor)().name,
                entry.name,
                "descriptor for {:?} self-reports a drifted name",
                entry.name
            );
        }

        let proposals: Vec<&str> = REGISTRY
            .iter()
            .filter(|e| matches!(e.dispatch, Dispatch::Proposal))
            .map(|e| e.name)
            .collect();
        assert_eq!(
            proposals,
            vec![propose_workspace_mutation::NAME],
            "exactly one Proposal tool, and it is propose_workspace_mutation"
        );
    }
}
