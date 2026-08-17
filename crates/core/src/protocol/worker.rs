//! Worker↔Core wire types: the stdout frame union, the Tool Protocol duplex
//! (ADR-0018), and the spawn manifest shapes (ADR-0009 hand-mirror).

use serde::{Deserialize, Serialize};

// Tool Protocol (ADR-0018): the Worker↔Core duplex. The Worker emits
// `tool_request` on stdout (a `WorkerStdout` variant); Core replies with a
// `ToolResult` on the kept-open stdin. Core re-validates `params` against each
// tool's Input struct.

/// One `content` block of an `AgentToolResult`. Text-only today; `r#type`
/// serializes as `"type"`.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
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

/// The single transcript result type for ALL tools (external-task-views A4):
/// the model-visible content blocks plus the ONE error flag. Carried by the
/// `external_tool_finished` frame, persisted in `tool_calls.result_payload`
/// for external (`ticktick_*`) calls, served on terminal `tool_call` Run
/// Events and `Segment::ToolCall`, and replayed in the resume manifest's
/// `tool_result` blocks. Deliberately no runtime `details`/`terminate` — those
/// are Worker-runtime control flow, never durable transcript state.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct TranscriptToolResult {
    pub content: Vec<ToolTextContent>,
    pub is_error: bool,
}

impl TranscriptToolResult {
    /// A single-text-block result.
    pub fn text(text: impl Into<String>, is_error: bool) -> Self {
        Self {
            content: vec![ToolTextContent {
                r#type: "text".to_string(),
                text: text.into(),
            }],
            is_error,
        }
    }

    /// The Core-generated result a Run-termination settle writes into every
    /// still-pending external call (external-task-views A4): the one case where
    /// an expansion shows Core-synthesized text rather than content the model
    /// received (the model saw nothing; the Run died first).
    pub fn interrupted() -> Self {
        Self::text("interrupted", true)
    }
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

/// Which external lifecycle frame Core is acknowledging.
#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExternalToolPhase {
    Started,
    Finished,
}

/// Core → Worker: durable acceptance or rejection of one external lifecycle
/// frame. The dedicated Worker pipe already identifies the Run, so correlation
/// needs only `tool_call_id` + `phase`. Failure detail stays in Core's log.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct ExternalToolAck {
    pub kind: &'static str,
    pub tool_call_id: String,
    pub phase: ExternalToolPhase,
    pub ok: bool,
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
    /// An EXTERNAL (Worker-executed MCP, `ticktick_*`) call began
    /// (external-task-views A4), from pi's `tool_execution_start` event. Core
    /// persists the pending row and publishes the started `tool_call` event.
    ExternalToolStarted {
        tool_call_id: String,
        name: String,
        arguments: serde_json::Value,
    },
    /// The external call's ONE terminal frame, from pi's finalized
    /// `tool_execution_end`. No outer error flag — `result.is_error` is the
    /// single source; `tool_calls.status` derives from it.
    ExternalToolFinished {
        tool_call_id: String,
        result: TranscriptToolResult,
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
    /// The paired result for a prior tool_call (ADR-0025), carried as the ONE
    /// transcript result type (external-task-views A4): Core tool results,
    /// Proposal Decisions, the not-executed placeholder, and MCP results all
    /// ride this same shape.
    ToolResult {
        tool_call_id: &'a str,
        result: &'a TranscriptToolResult,
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

/// One current-turn image attachment shipped in the spawn manifest
/// (chat-image-attachments, ADR-0058 consumer). `data_base64` is the RAW
/// base64 of the stored bytes — never `data:`-URL prefixed (providers build
/// their own framing; Anthropic/Google/Bedrock corrupt on a prefix). Owned
/// `String`s deliberately: the `<'a>` manifest borrows everything else from
/// long-lived Workflow state, but these bytes are read+encoded per spawn and
/// have no owner to borrow from.
#[derive(Debug, Serialize)]
pub struct ManifestAttachment {
    pub mime: String,
    pub data_base64: String,
}

/// The full spawn manifest written to the Worker's stdin (ADR-0018, ADR-0013).
/// `run_id` carries the Run's id in-band so the Worker can stamp its trail.
/// `messages` is the assembled prior history. `mode` selects the loop entry
/// point (ADR-0025): absent/`"fresh"` starts a new prompt, `"resume"` continues
/// a reconstructed transcript. `access_token` is `Some` only for OAuth providers
/// (ADR-0023), skipped on the wire otherwise. `attachments` carries the CURRENT
/// turn's images (fresh mode only — resume never replays them), skipped when
/// the turn has none.
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<ManifestAttachment>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_tools: Option<ExternalToolsManifest<'a>>,
}

/// External (Worker-executed MCP) tool config shipped in the spawn manifest
/// (external-task-views A3/A5): the TickTick MCP endpoint + auth from Core's
/// boot-read credential state. Absent = no external tools this Run.
///
/// `Debug` is hand-implemented to redact `access_token` — the bearer secret
/// must never reach a log line (mirrors [`crate::credentials::Credentials`]).
/// Core's tracing logs structs with `{:?}`, so a deriving Debug is the exact
/// leak primitive that convention forbids.
#[derive(Serialize)]
pub struct ExternalToolsManifest<'a> {
    pub endpoint: &'a str,
    pub access_token: &'a str,
    pub timeout_ms: u64,
}

impl std::fmt::Debug for ExternalToolsManifest<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExternalToolsManifest")
            .field("endpoint", &self.endpoint)
            .field("access_token", &"<redacted>")
            .field("timeout_ms", &self.timeout_ms)
            .finish()
    }
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

    #[test]
    fn worker_stdout_decodes_external_tool_started() {
        let wire = json!({
            "kind": "external_tool_started",
            "tool_call_id": "tc_ext",
            "name": "ticktick_filter_tasks",
            "arguments": { "filter": { "status": [0] } }
        });
        let ev: WorkerStdout = serde_json::from_value(wire).unwrap();
        match ev {
            WorkerStdout::ExternalToolStarted {
                tool_call_id,
                name,
                arguments,
            } => {
                assert_eq!(tool_call_id, "tc_ext");
                assert_eq!(name, "ticktick_filter_tasks");
                assert_eq!(arguments["filter"]["status"], json!([0]));
            }
            other => panic!("expected ExternalToolStarted, got {other:?}"),
        }
    }

    #[test]
    fn worker_stdout_decodes_external_tool_finished() {
        let wire = json!({
            "kind": "external_tool_finished",
            "tool_call_id": "tc_ext",
            "result": {
                "content": [{ "type": "text", "text": "1 task found" }],
                "is_error": false
            }
        });
        let ev: WorkerStdout = serde_json::from_value(wire).unwrap();
        match ev {
            WorkerStdout::ExternalToolFinished {
                tool_call_id,
                result,
            } => {
                assert_eq!(tool_call_id, "tc_ext");
                assert_eq!(result, TranscriptToolResult::text("1 task found", false));
            }
            other => panic!("expected ExternalToolFinished, got {other:?}"),
        }
        // A frame missing `result.is_error` fails strict decode — the error flag
        // lives once, inside the result, and is never defaulted.
        assert!(
            serde_json::from_value::<WorkerStdout>(json!({
                "kind": "external_tool_finished",
                "tool_call_id": "tc_ext",
                "result": { "content": [] }
            }))
            .is_err()
        );
    }

    #[test]
    fn external_tool_ack_serializes() {
        let ack = ExternalToolAck {
            kind: "external_tool_ack",
            tool_call_id: "tc_ext".to_string(),
            phase: ExternalToolPhase::Started,
            ok: true,
        };
        assert_eq!(
            serde_json::to_value(ack).unwrap(),
            json!({
                "kind": "external_tool_ack",
                "tool_call_id": "tc_ext",
                "phase": "started",
                "ok": true
            })
        );
    }

    #[test]
    fn external_tools_manifest_debug_redacts_the_token() {
        let manifest = ExternalToolsManifest {
            endpoint: "https://mcp.ticktick.com/",
            access_token: "SECRET_TICKTICK_TOKEN",
            timeout_ms: 30_000,
        };
        let rendered = format!("{manifest:?}");
        assert!(
            !rendered.contains("SECRET_TICKTICK_TOKEN"),
            "the bearer token must never reach a Debug line"
        );
        assert!(
            rendered.contains("https://mcp.ticktick.com/"),
            "the non-secret endpoint may show"
        );
    }

    #[test]
    fn transcript_tool_result_round_trips() {
        let r = TranscriptToolResult::interrupted();
        let wire = serde_json::to_value(&r).unwrap();
        assert_eq!(
            wire,
            json!({
                "content": [{ "type": "text", "text": "interrupted" }],
                "is_error": true
            })
        );
        let back: TranscriptToolResult = serde_json::from_value(wire).unwrap();
        assert_eq!(back, r);
    }

    #[test]
    fn manifest_tool_result_block_carries_transcript_result() {
        let result = TranscriptToolResult::text("Accepted.", false);
        let block = ManifestMessage::ToolResult {
            tool_call_id: "tc_1",
            result: &result,
        };
        assert_eq!(
            serde_json::to_value(&block).unwrap(),
            json!({
                "role": "tool_result",
                "tool_call_id": "tc_1",
                "result": {
                    "content": [{ "type": "text", "text": "Accepted." }],
                    "is_error": false
                }
            })
        );
    }

    #[test]
    fn worker_manifest_external_tools_serializes_and_skips_when_absent() {
        let manifest = WorkerManifest {
            run_id: uuid::Uuid::parse_str(UUID_A).unwrap(),
            workflow: WorkflowManifest {
                name: "default",
                version: "1",
                provider: "faux",
                model: "m",
                system_prompt: "sp",
                thinking_level: "off",
                tools: Vec::new(),
            },
            prompt: "hi",
            messages: Vec::new(),
            mode: None,
            access_token: None,
            attachments: None,
            external_tools: Some(ExternalToolsManifest {
                endpoint: "https://mcp.ticktick.com/",
                access_token: "tok",
                timeout_ms: 30_000,
            }),
        };
        let wire = serde_json::to_value(&manifest).unwrap();
        assert_eq!(
            wire["external_tools"],
            json!({
                "endpoint": "https://mcp.ticktick.com/",
                "access_token": "tok",
                "timeout_ms": 30_000
            })
        );

        let manifest = WorkerManifest {
            external_tools: None,
            ..manifest
        };
        let wire = serde_json::to_value(&manifest).unwrap();
        assert!(
            wire.get("external_tools").is_none(),
            "absent external_tools is skipped, not null"
        );
    }
}
