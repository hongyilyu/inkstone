//! Worker↔Core wire types: the stdout frame union, the Tool Protocol duplex
//! (ADR-0018), and the spawn manifest shapes (ADR-0009 hand-mirror).

use serde::{Deserialize, Serialize};

// Tool Protocol (ADR-0018): the Worker↔Core duplex. The Worker emits
// `tool_request` on stdout (a `WorkerStdout` variant); Core replies with a
// `ToolResult` on the kept-open stdin. Core re-validates `params` against each
// tool's Input struct.

/// One `content` block of an `AgentToolResult`. Text-only today; `r#type`
/// serializes as `"type"`.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ToolTextContent {
    pub r#type: String,
    pub text: String,
}

/// Hand-mirror of `pi-agent-core`'s `AgentToolResult` (ADR-0018). No `isError`
/// field — a tool error is a `ToolResult` `err` outcome, not a flag.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentToolResult {
    pub content: Vec<ToolTextContent>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub details: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub terminate: Option<bool>,
}

/// One tool the Workflow exposes, shipped (allowlist-filtered) in the spawn
/// manifest. `json_schema` is the `schemars`-derived Draft-07 schema of the
/// tool's Rust `Input` struct.
#[derive(Debug, Serialize, Clone)]
pub struct CoreToolDescriptor {
    pub name: String,
    pub description: String,
    pub label: String,
    pub json_schema: serde_json::Value,
}

/// The error half of a `ToolResult` outcome.
#[derive(Debug, Serialize)]
pub struct ToolErrorWire {
    pub code: String,
    pub message: String,
}

/// A `ToolResult`'s outcome. Untagged so it serializes as `{"ok": …}` or
/// `{"err": …}` to match the TS `outcome` union.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum ToolOutcome {
    Ok { ok: AgentToolResult },
    Err { err: ToolErrorWire },
}

/// Core → Worker: the outcome of a tool call, written to the Worker's kept-open
/// stdin, correlated by `tool_call_id`.
#[derive(Debug, Serialize)]
pub struct ToolResult {
    pub kind: &'static str,
    pub run_id: String,
    pub tool_call_id: String,
    pub outcome: ToolOutcome,
}

/// What Core reads off the Worker's stdout: the one-way `RunEvent`s plus the
/// bidirectional `tool_request`. The `tool_request`'s `run_id` is Core-ignored
/// (Core uses the spawn's authoritative run id) — kept for symmetry with the TS
/// `ToolRequest`.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkerStdout {
    TextDelta {
        delta: String,
    },
    /// A reasoning (thinking) delta the Worker maps from pi's `thinking_delta`
    /// (ADR-0045 reasoning amendment, #202). Core opens/appends the open reasoning
    /// part and republishes it as `RunEvent::ReasoningDelta`.
    ReasoningDelta {
        delta: String,
    },
    Done,
    Error {
        message: String,
    },
    ToolRequest {
        #[allow(dead_code)]
        run_id: String,
        tool_call_id: String,
        name: String,
        params: serde_json::Value,
    },
}

/// One NDJSON line of the Provider Helper's stdout (ADR-0023): `authorize_url`
/// appears only in login mode; refresh mode emits credentials or error.
/// TS mirror: `ProviderHelperLine` in packages/protocol.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HelperLine {
    AuthorizeUrl {
        url: String,
    },
    Credentials {
        access: String,
        refresh: String,
        expires: i64,
        account_id: String,
    },
    Error {
        message: String,
    },
}

/// One tool call inside an assistant manifest message (ADR-0025 resume).
/// Produced by the resume reconstruction; not yet built.
#[derive(Debug, Serialize)]
#[allow(dead_code)]
pub struct ManifestToolCall<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub arguments: serde_json::Value,
}

/// One prior message in the assembled Thread history shipped in the spawn
/// manifest (ADR-0018, ADR-0025), a `role`-tagged snake_case union. The fresh
/// path emits `User`/`Assistant{text}`; the resume path adds
/// `Assistant.tool_calls` and `ToolResult` blocks so the reconstructed
/// transcript is provider-valid (those variants are `#[allow(dead_code)]` until
/// the resume slice builds them).
#[derive(Debug, Serialize)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum ManifestMessage<'a> {
    User {
        text: &'a str,
    },
    Assistant {
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[allow(dead_code)]
        tool_calls: Option<Vec<ManifestToolCall<'a>>>,
    },
    #[allow(dead_code)]
    ToolResult {
        tool_call_id: &'a str,
        content: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        is_error: Option<bool>,
    },
}

/// The Workflow fields shipped in the manifest (ADR-0018). Built by borrowing
/// from [`crate::workflow::Workflow`] at spawn; this struct is the wire
/// contract.
#[derive(Debug, Serialize)]
pub struct WorkflowManifest<'a> {
    pub name: &'a str,
    pub version: &'a str,
    pub provider: &'a str,
    pub model: &'a str,
    pub system_prompt: &'a str,
    pub thinking_level: &'a str,
    pub tools: Vec<CoreToolDescriptor>,
}

/// The full spawn manifest written to the Worker's stdin (ADR-0018, ADR-0013).
/// `run_id` carries the Run's id in-band so the Worker can stamp its trail.
/// `messages` is the assembled prior history. `mode` selects the loop entry
/// point (ADR-0025): absent/`"fresh"` starts a new prompt, `"resume"` continues
/// a reconstructed transcript. `access_token` is `Some` only for OAuth providers
/// (ADR-0023), skipped on the wire otherwise.
#[derive(Debug, Serialize)]
pub struct WorkerManifest<'a> {
    /// The Run's id, carried in-band (ADR-0038 / #146) so the Worker stamps its
    /// `worker.jsonl` lines without an out-of-band spawn-time env var.
    pub run_id: uuid::Uuid,
    pub workflow: WorkflowManifest<'a>,
    pub prompt: &'a str,
    pub messages: Vec<ManifestMessage<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[allow(dead_code)]
    pub mode: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_token: Option<&'a str>,
}

/// Mirror tests: lock the Rust serde shapes to the canonical snake_case wire
/// JSON the TS `Schema` definitions in `packages/protocol` produce (ADR-0009).
/// Each test asserts agreement in the type's available direction; a renamed
/// field or changed type fails the matching test. This is the reconciliation
/// point that guards against TS/Rust divergence.
#[cfg(test)]
mod mirror_tests {
    use super::*;
    use serde_json::json;

    // A fixed UUID-shaped string; the wire carries ids as plain strings.
    const UUID_A: &str = "0190d3c1-0000-7000-8000-000000000001";

    #[test]
    fn worker_stdout_decodes_tool_request() {
        let wire = json!({
            "kind": "tool_request",
            "run_id": "",
            "tool_call_id": "tc_01",
            "name": "read_thread",
            "params": { "thread_id": UUID_A }
        });
        let ev: WorkerStdout = serde_json::from_value(wire).unwrap();
        match ev {
            WorkerStdout::ToolRequest {
                tool_call_id,
                name,
                params,
                ..
            } => {
                assert_eq!(tool_call_id, "tc_01");
                assert_eq!(name, "read_thread");
                assert_eq!(params["thread_id"], json!(UUID_A));
            }
            other => panic!("expected ToolRequest, got {other:?}"),
        }
    }

    #[test]
    fn worker_stdout_decodes_text_delta_and_done() {
        let d: WorkerStdout =
            serde_json::from_value(json!({ "kind": "text_delta", "delta": "x" })).unwrap();
        assert!(matches!(d, WorkerStdout::TextDelta { .. }));
        let done: WorkerStdout = serde_json::from_value(json!({ "kind": "done" })).unwrap();
        assert!(matches!(done, WorkerStdout::Done));
    }
}
