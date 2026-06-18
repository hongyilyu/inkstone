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

/// One registered tool: its wire `name`, its manifest `descriptor`, how it
/// dispatches, and how to derive its display `arg` (ADR-0043) from its params.
/// `REGISTRY` is the single source the reads below derive from, so a tool can't
/// be described-but-undispatchable (or the reverse) — the gap the old three
/// parallel name-keyed matches left open.
struct ToolEntry {
    name: &'static str,
    descriptor: fn() -> CoreToolDescriptor,
    dispatch: Dispatch,
    /// Extracts the tool's display argument from its params for the
    /// tool-activity row (ADR-0043) — `None` for tools with no meaningful label
    /// argument. Each extractor deserializes the tool's typed `Input`, so a
    /// field rename is a compile error here, not a silently-dropped arg.
    display_arg: fn(&Value) -> Option<String>,
}

/// The default `display_arg`: a tool with no meaningful label argument.
fn no_arg(_params: &Value) -> Option<String> {
    None
}

/// Every registered tool, in manifest (descriptor) order.
const REGISTRY: &[ToolEntry] = &[
    ToolEntry {
        name: read_thread::NAME,
        descriptor: read_thread::descriptor,
        dispatch: Dispatch::Pool(|pool, params| Box::pin(read_thread::execute(pool, params))),
        display_arg: no_arg,
    },
    ToolEntry {
        name: read_current_thread_journal_entries::NAME,
        descriptor: read_current_thread_journal_entries::descriptor,
        dispatch: Dispatch::PoolRun(|pool, run_id, params| {
            Box::pin(read_current_thread_journal_entries::execute(pool, run_id, params))
        }),
        display_arg: no_arg,
    },
    ToolEntry {
        name: propose_workspace_mutation::NAME,
        descriptor: propose_workspace_mutation::descriptor,
        dispatch: Dispatch::Proposal,
        display_arg: no_arg,
    },
    ToolEntry {
        name: search_entities::NAME,
        descriptor: search_entities::descriptor,
        dispatch: Dispatch::Pool(|pool, params| Box::pin(search_entities::execute(pool, params))),
        display_arg: search_entities::display_arg,
    },
    ToolEntry {
        name: load_skill::NAME,
        descriptor: load_skill::descriptor,
        dispatch: Dispatch::NoContext(|params| Box::pin(load_skill::execute(params))),
        display_arg: load_skill::display_arg,
    },
];

/// The display argument for a registered tool's `params` (ADR-0043), or `None`
/// when the tool exposes none or is unregistered. Used by both the live
/// `tool_call` Run Event and the `thread/get` rehydration read, so the live and
/// reloaded rows show the same label.
pub fn display_arg(name: &str, params: &Value) -> Option<String> {
    REGISTRY
        .iter()
        .find(|e| e.name == name)
        .and_then(|e| (e.display_arg)(params))
}

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

/// The ambient tools appended to every Run (ADR-0036). One today: `load_skill`.
/// The single source of truth for ambient membership: both [`is_ambient`] (the
/// dispatch gate, via [`is_allowed`]) and [`run_descriptors`] (the manifest)
/// derive from this slice, so what the model *sees* and what Core *dispatches*
/// cannot drift apart.
const AMBIENT_TOOLS: &[&str] = &[load_skill::NAME];

/// Whether `name` is an *ambient* tool — allowed on every Run regardless of the
/// Workflow's own allowlist (ADR-0036 §"load_skill is always allowed"). The
/// Skills subsystem makes `load_skill` ambient so the model can always pull a
/// skill body, while domain tools stay per-Workflow opt-in. Both the manifest
/// build ([`run_descriptors`]) and the dispatch gate ([`is_allowed`]) consult
/// this same [`AMBIENT_TOOLS`] list, so they never disagree.
pub fn is_ambient(name: &str) -> bool {
    AMBIENT_TOOLS.contains(&name)
}

/// The descriptors shipped in a Run's manifest: the Workflow's allowlisted tools
/// (in order) followed by any ambient tool not already named (ADR-0036). This is
/// what the model is shown; [`is_allowed`] is the matching dispatch gate.
pub fn run_descriptors(allowlist: &[String]) -> Vec<CoreToolDescriptor> {
    let mut descriptors = descriptors_for(allowlist);
    for name in AMBIENT_TOOLS {
        if !allowlist.iter().any(|t| t == name)
            && let Some(descriptor) = descriptor_for(name)
        {
            descriptors.push(descriptor);
        }
    }
    descriptors
}

/// Whether a `tool_request` for `name` may be dispatched on a Run with this
/// `allowlist` (ADR-0018 dual gate): the tool must be registered AND either in
/// the Workflow's allowlist or ambient (ADR-0036). Mirrors [`run_descriptors`]
/// so an advertised tool is always dispatchable.
pub fn is_allowed(allowlist: &[String], name: &str) -> bool {
    is_registered(name) && (is_ambient(name) || allowlist.iter().any(|t| t == name))
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

    /// The `display_arg` dispatcher (ADR-0043) routes to a tool's extractor, and
    /// returns `None` for an unregistered name — the safety net when an unknown
    /// tool name reaches the live event or rehydration read.
    #[test]
    fn display_arg_dispatches_to_tool_and_none_for_unregistered() {
        // A registered tool with an extractor returns its display arg.
        assert_eq!(
            display_arg("search_entities", &serde_json::json!({ "type": "person", "query": "x" })),
            Some("x".to_string())
        );
        // A registered tool with no extractor (read_thread → no_arg) returns None.
        assert_eq!(
            display_arg("read_thread", &serde_json::json!({ "thread_id": "t" })),
            None
        );
        // An unregistered name returns None rather than panicking.
        assert_eq!(display_arg("nonexistent", &serde_json::json!({})), None);
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

    #[test]
    fn run_descriptors_appends_ambient_load_skill_once() {
        // An empty Workflow allowlist still ships load_skill (ambient).
        let ds = run_descriptors(&[]);
        let names: Vec<&str> = ds.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["load_skill"],
            "ambient load_skill is always shipped"
        );

        // A Workflow that already lists load_skill gets it exactly once, no dup.
        let ds = run_descriptors(&["load_skill".to_string()]);
        assert_eq!(
            ds.iter().filter(|d| d.name == "load_skill").count(),
            1,
            "load_skill is not duplicated when the Workflow already lists it"
        );

        // Domain tools keep their order, with load_skill appended after.
        let ds = run_descriptors(&["read_thread".to_string()]);
        let names: Vec<&str> = ds.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, vec!["read_thread", "load_skill"]);
    }

    #[test]
    fn is_allowed_permits_ambient_and_allowlisted_only() {
        // Ambient: allowed even with an empty allowlist.
        assert!(is_allowed(&[], "load_skill"), "load_skill is ambient");
        // Allowlisted domain tool: allowed.
        assert!(is_allowed(&["read_thread".to_string()], "read_thread"));
        // Off-allowlist domain tool: rejected.
        assert!(!is_allowed(&[], "read_thread"));
        // Unregistered name: rejected even if (absurdly) allowlisted.
        assert!(!is_allowed(&["nonexistent".to_string()], "nonexistent"));
    }

    #[test]
    fn ambient_gate_and_manifest_agree_for_every_ambient_tool() {
        // The two gates must never disagree (ADR-0036): a tool shown in the
        // manifest must dispatch, and a tool dispatched must be shown. Both derive
        // from AMBIENT_TOOLS, so this pins their agreement for EVERY ambient tool —
        // a future tool added to the set (or, were they to diverge, dropped from
        // one side) is caught here, not at runtime.
        let advertised: Vec<String> =
            run_descriptors(&[]).into_iter().map(|d| d.name).collect();
        for name in AMBIENT_TOOLS {
            assert!(is_ambient(name), "{name} is in AMBIENT_TOOLS but is_ambient() denies it");
            assert!(
                is_allowed(&[], name),
                "{name} is ambient but is_allowed rejects it with an empty allowlist"
            );
            assert!(
                advertised.iter().any(|d| d == name),
                "{name} is ambient but run_descriptors(&[]) does not advertise it"
            );
        }
        // Conversely, everything run_descriptors adds beyond an empty allowlist is
        // dispatchable — no advertised-but-undispatchable tool.
        for name in &advertised {
            assert!(
                is_allowed(&[], name),
                "{name} is advertised by run_descriptors(&[]) but is_allowed rejects it"
            );
        }
    }
}
