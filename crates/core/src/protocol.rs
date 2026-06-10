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
    pub thread_id: uuid::Uuid,
    pub prompt: String,
}

/// `run/subscribe` params: the Run to attach to. Snapshot-then-tail
/// (ADR-0022) — Core replies with the cumulative assistant text as a
/// `text_delta` snapshot, then forwards the live tail until `done`.
#[derive(Debug, Deserialize)]
pub struct SubscribeParams {
    pub run_id: uuid::Uuid,
}

/// `run/subscribe` result (ADR-0022 + ADR-0025): the Run's `status` at the
/// subscribe instant. `running` while a live stream (hub) exists, else the
/// persisted `runs.status` — notably `parked`, which a refreshed Client must
/// distinguish from a terminal state so it does not treat the stopped Run
/// Event stream as a false `done`. Serialize-only — Core produces it.
#[derive(Debug, Serialize)]
pub struct SubscribeResult {
    pub run_id: String,
    pub status: String,
}

/// `run/cancel` params (ADR-0014): the Run to cancel. Deserialize-only.
#[derive(Debug, Deserialize)]
pub struct RunCancelParams {
    pub run_id: uuid::Uuid,
}

/// `run/cancel` result (ADR-0014): whether Core accepted the cancel command.
/// `accepted` — the Run was live/parked and is being cancelled;
/// `already_terminal` — the Run had already finished before the cancel arrived;
/// `unknown_run` — the `run_id` named no Run. Serialize-only — Core produces it.
#[derive(Debug, Serialize)]
pub struct RunCancelResult {
    pub outcome: String,
}

/// `proposal/get` params (ADR-0025): the parked Run whose pending Proposal to
/// fetch. Deserialize-only.
#[derive(Debug, Deserialize)]
pub struct ProposalGetParams {
    pub run_id: uuid::Uuid,
}

/// `proposal/get` result (ADR-0025): the Run's pending Proposal.
/// `mutation_kind` is the logical Workspace mutation; `payload` is the opaque
/// mutation-specific payload; `rationale` is the model's reason (may be
/// `null`); `status` is the Proposal's lifecycle state.
/// Serialize-only — Core produces it.
#[derive(Debug, Serialize)]
pub struct ProposalGetResult {
    pub proposal_id: String,
    pub run_id: String,
    pub mutation_kind: String,
    pub payload: serde_json::Value,
    pub rationale: Option<String>,
    pub status: String,
}

/// `proposal/decide` params (ADR-0025): the user's Decision on a pending
/// Proposal. `decision` ships the full enum now (accept|reject|edit) so
/// reject/edit are Core-only follow-up slices; `edited_payload` carries the
/// user's edits for `edit`. `decision_idempotency_key` makes a retried decide
/// safe (ADR-0014 retry-safety): a repeat with the same key returns the prior
/// result without re-applying. Deserialize-only — Core consumes it.
#[derive(Debug, Deserialize)]
pub struct ProposalDecideParams {
    pub proposal_id: uuid::Uuid,
    pub decision: String,
    #[serde(default)]
    #[allow(dead_code)] // consumed by `edit` (slice 5); accept ignores it
    pub edited_payload: Option<serde_json::Value>,
    #[serde(default)]
    pub decision_idempotency_key: Option<String>,
}

/// `proposal/decide` result (ADR-0025): the Proposal's post-decision `status`
/// (`accepted`|`rejected`) and, for an accept/edit that created an Entity, its
/// `entity_id` (omitted on the wire for a reject). Serialize-only — Core
/// produces it.
#[derive(Debug, Serialize)]
pub struct ProposalDecideResult {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<String>,
}

/// `proposal/pending` Notification params (ADR-0025): pushed to a Run's
/// subscribers the moment it parks so an attached chat surface shows the
/// review card without polling. Serialize-only — Core produces it.
#[derive(Debug, Serialize)]
pub struct ProposalPendingNotification {
    pub run_id: String,
    pub proposal_id: String,
}

/// `proposal/changed` Notification params (ADR-0025): pushed when a pending
/// Proposal is decided. `status` is the post-decision lifecycle state
/// (`accepted`|`rejected`). Serialize-only — Core produces it.
#[derive(Debug, Serialize)]
pub struct ProposalChangedNotification {
    pub run_id: String,
    pub proposal_id: String,
    pub status: String,
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

/// `entity/list` params: the Entity `type` to list (one type per call, e.g.
/// `"todo"` or `"person"`). The wire field is `type`; `r#type` is the raw
/// identifier escape and serde maps it to `"type"` automatically (same
/// convention as `EntityRow`). Deserialize-only — Core consumes it. Mirrors the
/// TS `EntityListParams`.
#[derive(Debug, Deserialize)]
pub struct EntityListParams {
    pub r#type: String,
}

/// One Entity row in an `entity/list` result (ADR-0004): the raw tier-2
/// `entities` columns. `r#type` serializes as `"type"`; `data` is the opaque
/// entity JSON (for a Todo, `{title, done, due?}`); `created_at`/`updated_at`
/// are ms-epoch stamps. Serialize-only — Core produces it. Mirrors the TS
/// `EntityRow`.
#[derive(Debug, Serialize)]
pub struct EntityRow {
    pub id: String,
    pub r#type: String,
    pub data: serde_json::Value,
    pub created_at: i64,
    pub updated_at: i64,
}

/// `entity/list` result: the accepted Entities of the requested type,
/// newest-first. Object-wrapper shape (`{entities: [...]}`) so the result stays
/// forward-extensible and the TS mirror is a `Schema.Struct` (mirrors
/// `thread/list`'s `{threads: [...]}`). Serialize-only — Core produces it.
#[derive(Debug, Serialize)]
pub struct EntityListResult {
    pub entities: Vec<EntityRow>,
}

/// `thread/get` params: the Thread to rehydrate. A malformed `thread_id` is
/// rejected with `invalid_params` (-32602); a well-formed id for a Thread
/// that does not exist with `unknown_thread` (-32001), same as
/// `run/post_message`.
#[derive(Debug, Deserialize)]
pub struct ThreadGetParams {
    pub thread_id: uuid::Uuid,
}

/// A single Message in a `thread/get` result. Flat assembled `text`
/// (ADR-0017/Q15): NO `parts[]` array on the wire until attachments exist —
/// `text` is the concatenation of the Message's text parts in `seq` order.
/// `run_id` lets a refreshed Client resubscribe to a `streaming` Message's
/// Run (the rehydration source for refresh-durability).
#[derive(Debug, Serialize)]
pub struct MessageView {
    pub id: String,
    pub role: String,
    pub status: String,
    pub run_id: String,
    pub text: String,
}

/// `thread/get` result: the Thread header (`thread_id`, `title`) plus its
/// Messages in chronological order (`messages`). A completed Run yields full
/// user + assistant text; a mid-stream Run yields a `streaming` assistant
/// Message with its partial text and `run_id`.
#[derive(Debug, Serialize)]
pub struct ThreadGetResult {
    pub thread_id: String,
    pub title: String,
    pub messages: Vec<MessageView>,
}

/// Lifecycle status of a tool call surfaced to the Client on the Run Event
/// stream (ADR-0006). `Started` is published when Core receives the
/// `tool_request`; the terminal `Completed`/`Error` mirrors the dispatch
/// outcome. Serializes snake_case (`"started"`/`"completed"`/`"error"`).
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallStatus {
    Started,
    Completed,
    Error,
}

/// Run Event emitted by the Worker over its stdout NDJSON stream
/// (per ADR-0006). Core deserializes each line into this enum, takes
/// the appropriate persistence action, and forwards it as a `run/event`
/// Notification.
///
/// `ToolCall` is the exception: it is NOT a Worker stdout line. Core
/// SYNTHESIZES it when it receives a `tool_request` from the Worker (a
/// separate stdio channel) and publishes it onto the same hub as the text
/// stream, so the Client can surface "a tool is running" live. It is
/// ephemeral — unlike `text_delta` it is not persisted, so it is not
/// replayed on a `run/subscribe` snapshot/reconnect (ADR-0022:38 defers
/// durable coarse-event replay to a future `run/get_history`).
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RunEvent {
    TextDelta {
        delta: String,
    },
    ToolCall {
        tool_call_id: String,
        name: String,
        status: ToolCallStatus,
    },
    Done,
    Error {
        message: String,
    },
}

// --- Tool Protocol (ADR-0018): the Worker↔Core duplex. Rust mirror of the TS
// shapes in `packages/protocol`. The Worker emits `tool_request` on stdout
// (a `WorkerStdout` variant, alongside RunEvents); Core replies with a
// `ToolResult` on the kept-open stdin. `params`/`json_schema` are opaque JSON
// (`serde_json::Value`): Core re-validates `params` against each tool's Input
// struct; the Worker wraps `json_schema` in `Type.Unsafe`.

/// One `content` block of an `AgentToolResult`. Text-only today (image
/// content is out of scope for this slice). `r#type` serializes as `"type"`.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ToolTextContent {
    pub r#type: String,
    pub text: String,
}

/// Hand-mirror of `pi-agent-core`'s `AgentToolResult` (ADR-0018:201). No
/// `isError` field — a tool error is a `ToolResult` `err` outcome, not a flag.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentToolResult {
    pub content: Vec<ToolTextContent>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub details: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub terminate: Option<bool>,
}

/// One tool the Workflow exposes; shipped (filtered by the allowlist) inside
/// the spawn manifest. `json_schema` is the `schemars`-derived Draft-07 schema
/// of the tool's Rust `Input` struct.
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

/// A `ToolResult`'s outcome: success carries an `AgentToolResult` under `ok`;
/// failure carries `{code, message}` under `err`. Untagged so it serializes
/// as `{"ok": …}` or `{"err": …}` to match the TS `outcome` union.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum ToolOutcome {
    Ok { ok: AgentToolResult },
    Err { err: ToolErrorWire },
}

/// Core → Worker: the outcome of a tool call, written to the Worker's
/// kept-open stdin, correlated by `tool_call_id`. Serialize-only.
#[derive(Debug, Serialize)]
pub struct ToolResult {
    pub kind: &'static str,
    pub run_id: String,
    pub tool_call_id: String,
    pub outcome: ToolOutcome,
}

/// What Core reads off the Worker's stdout: the one-way `RunEvent`s plus the
/// bidirectional `tool_request`. Deserialize-only. The `tool_request`'s
/// `run_id` is Core-ignored (Core uses the spawn's authoritative run id);
/// it is part of the wire shape for symmetry with the TS `ToolRequest`.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkerStdout {
    TextDelta {
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

/// One provider's connection status in a `provider/status` result
/// (ADR-0023). `id` is the provider key (`"openai-codex"`); `connected` is
/// true when a credential file exists for it.
#[derive(Debug, Serialize)]
pub struct ProviderStatus {
    pub id: String,
    pub connected: bool,
}

/// `provider/status` result: the connection state of each known provider.
/// Object-wrapper shape (`{providers: [...]}`) so the result stays
/// forward-extensible and the TS mirror is a `Schema.Struct`.
#[derive(Debug, Serialize)]
pub struct ProviderStatusResult {
    pub providers: Vec<ProviderStatus>,
}

/// `provider/login_start` params: which provider to begin an OAuth login for.
/// A malformed/unknown provider is rejected with `invalid_params`.
#[derive(Debug, Deserialize)]
pub struct ProviderLoginStartParams {
    pub provider: String,
}

/// `provider/login_start` result: the authorize URL the Client opens in a new
/// tab (ADR-0023, ADR-0014 amendment). Core spawns the Provider Helper, which
/// runs the OAuth loopback and prints this URL; Core relays it here. The
/// callback + credential write happen out-of-band; the Client re-queries
/// `provider/status` on focus to learn the outcome.
#[derive(Debug, Serialize)]
pub struct ProviderLoginStartResult {
    pub authorize_url: String,
}

/// One model in the `model/catalog` result (ADR-0024). Mirrors the TS
/// `ModelInfo`. Derives both directions: Core deserializes these from the
/// embedded catalog JSON and serializes them onto the wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub reasoning: bool,
    pub input: Vec<String>,
    pub cost_input: f64,
    pub cost_output: f64,
}

/// One provider's model group in `model/catalog`. Mirrors the TS
/// `ProviderModels`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderModels {
    pub id: String,
    pub label: String,
    pub models: Vec<ModelInfo>,
}

/// `model/catalog` result: the models available per provider (ADR-0024).
/// Object-wrapper shape (`{providers: [...]}`) so the result stays
/// forward-extensible and the TS mirror is a `Schema.Struct`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelCatalogResult {
    pub providers: Vec<ProviderModels>,
}

/// `settings/get` + `settings/set` result (ADR-0024): the effective model
/// selection and global effort for the default Workflow. `model` is `null`
/// until the user picks one (the resolver falls back to the per-provider
/// default); `provider` is the Workflow's provider; `effort` is the global
/// thinking level (default `off`). Serialize-only — Core produces it.
#[derive(Debug, Serialize)]
pub struct SettingsResult {
    pub provider: String,
    pub model: Option<String>,
    pub effort: String,
}

/// `settings/set` params (ADR-0024): a partial update. An absent field is
/// left unchanged (`#[serde(default)]` → `None`); a present `model` must be a
/// known catalog id and a present `effort` a valid thinking level, else
/// `invalid_params`. Deserialize-only — Core consumes it.
#[derive(Debug, Deserialize)]
pub struct SettingsSetParams {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
}

/// One tool call inside an assistant manifest message (ADR-0025 resume).
/// Mirrors the TS `ManifestToolCall`. Produced by the resume reconstruction
/// (slice 3); not yet built here.
#[derive(Debug, Serialize)]
#[allow(dead_code)]
pub struct ManifestToolCall<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub arguments: serde_json::Value,
}

/// One prior message in the assembled Thread history shipped in the spawn
/// manifest (ADR-0018 as-built `messages[]`), now a tagged union (ADR-0025).
/// The fresh path emits `User{text}` / `Assistant{text}` exactly as before;
/// the resume path (slice 3) adds `assistant.tool_calls` and `ToolResult`
/// blocks so the reconstructed transcript is provider-valid. Tagged on
/// `role`, snake_case; a backward-compatible superset of the slice-1 shape.
/// Serialize-only — Core produces these, the Worker consumes them. The
/// `Assistant.tool_calls` and `ToolResult` variants are produced in slice 3;
/// marked `#[allow(dead_code)]` until then.
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

/// The Workflow fields shipped in the manifest (ADR-0018). Mirrors the TS
/// `WorkflowManifest`. Built by borrowing from [`crate::workflow::Workflow`]
/// at spawn (the field sets match); this struct is the wire contract and
/// anchors the mirror test.
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

/// The full spawn manifest written to the Worker's stdin (ADR-0018 as-built,
/// ADR-0013 stdin transport). Replaces the slice-1 `WorkerInbound{prompt}`.
/// `messages` is the assembled prior history. `mode` selects the loop entry
/// point (ADR-0025): `"fresh"` (default; omitted on the wire when the fresh
/// path) starts a new prompt; `"resume"` continues a reconstructed transcript
/// (slice 3 produces it). `access_token` is `Some` only for OAuth providers
/// (ADR-0023); `None` (and skipped on the wire) for the faux/env providers.
/// Mirrors the TS `WorkerManifest`.
#[derive(Debug, Serialize)]
pub struct WorkerManifest<'a> {
    pub workflow: WorkflowManifest<'a>,
    pub prompt: &'a str,
    pub messages: Vec<ManifestMessage<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[allow(dead_code)]
    pub mode: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_token: Option<&'a str>,
}

/// Mirror tests: lock the Rust serde shapes to the canonical wire JSON the
/// TypeScript `Schema` definitions in `packages/protocol/src/index.ts`
/// produce (hand-mirrored per ADR-0009). Each `#[test]` asserts agreement in
/// the type's available direction — Deserialize-only params decode from the
/// wire literal; Serialize-only results encode to it; `RunEvent` (both)
/// round-trips. The JSON literals are the exact snake_case wire form the TS
/// schemas encode; if a Rust type ever drifts (a renamed field, a changed
/// type), the matching test fails. This is the reconciliation point that
/// guards against future TS/Rust divergence — the mirror of the TS suite's
/// snake_case-preservation cases.
#[cfg(test)]
mod mirror_tests {
    use super::*;
    use serde_json::json;

    // A fixed UUID-shaped string; the wire carries ids as plain strings.
    const UUID_A: &str = "0190d3c1-0000-7000-8000-000000000001";
    const UUID_B: &str = "0190d3c1-0000-7000-8000-000000000002";

    // --- Deserialize-only params: decode the canonical wire JSON. ---

    #[test]
    fn post_message_params_decodes_thread_id_and_prompt() {
        let wire = json!({ "thread_id": UUID_A, "prompt": "hi" });
        let p: PostMessageParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.thread_id.to_string(), UUID_A);
        assert_eq!(p.prompt, "hi");
    }

    #[test]
    fn subscribe_params_decodes_run_id() {
        let wire = json!({ "run_id": UUID_A });
        let p: SubscribeParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.run_id.to_string(), UUID_A);
    }

    #[test]
    fn entity_list_params_decodes_type() {
        let wire = json!({ "type": "person" });
        let p: EntityListParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.r#type, "person");
    }

    #[test]
    fn subscribe_result_encodes_run_id_and_status() {
        let r = SubscribeResult {
            run_id: UUID_A.to_string(),
            status: "parked".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({ "run_id": UUID_A, "status": "parked" }),
        );
    }

    #[test]
    fn run_cancel_params_decodes_run_id() {
        let wire = json!({ "run_id": UUID_A });
        let p: RunCancelParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.run_id.to_string(), UUID_A);
    }

    #[test]
    fn run_cancel_result_encodes_outcome() {
        for outcome in ["accepted", "already_terminal", "unknown_run"] {
            let r = RunCancelResult {
                outcome: outcome.to_string(),
            };
            assert_eq!(
                serde_json::to_value(&r).unwrap(),
                json!({ "outcome": outcome }),
            );
        }
    }

    #[test]
    fn proposal_get_params_decodes_run_id() {
        let wire = json!({ "run_id": UUID_A });
        let p: ProposalGetParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.run_id.to_string(), UUID_A);
    }

    #[test]
    fn proposal_get_result_encodes_full_shape() {
        let r = ProposalGetResult {
            proposal_id: UUID_B.to_string(),
            run_id: UUID_A.to_string(),
            mutation_kind: "create_journal_entry".to_string(),
            payload: json!({
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "text", "text": "Bought milk." }]
            }),
            rationale: Some("because".to_string()),
            status: "pending".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({
                "proposal_id": UUID_B,
                "run_id": UUID_A,
                "mutation_kind": "create_journal_entry",
                "payload": {
                    "occurred_at": "2026-06-10T10:30:00",
                    "body": [{ "type": "text", "text": "Bought milk." }]
                },
                "rationale": "because",
                "status": "pending"
            }),
        );
    }

    #[test]
    fn proposal_get_result_encodes_null_rationale() {
        let r = ProposalGetResult {
            proposal_id: UUID_B.to_string(),
            run_id: UUID_A.to_string(),
            mutation_kind: "create_journal_entry".to_string(),
            payload: json!({}),
            rationale: None,
            status: "pending".to_string(),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["rationale"], json!(null));
    }

    #[test]
    fn proposal_decide_params_decodes_accept_with_key() {
        let wire = json!({
            "proposal_id": UUID_B,
            "decision": "accept",
            "decision_idempotency_key": "k1"
        });
        let p: ProposalDecideParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.proposal_id.to_string(), UUID_B);
        assert_eq!(p.decision, "accept");
        assert_eq!(p.decision_idempotency_key.as_deref(), Some("k1"));
        assert!(p.edited_payload.is_none());
    }

    #[test]
    fn proposal_decide_params_decodes_bare_accept_and_edit() {
        let bare: ProposalDecideParams =
            serde_json::from_value(json!({ "proposal_id": UUID_B, "decision": "accept" })).unwrap();
        assert_eq!(bare.decision_idempotency_key, None);
        assert!(bare.edited_payload.is_none());

        let edit: ProposalDecideParams = serde_json::from_value(json!({
            "proposal_id": UUID_B,
            "decision": "edit",
            "edited_payload": {
                "occurred_at": "2026-06-10T10:35:00",
                "body": [{ "type": "text", "text": "Bought oat milk." }]
            }
        }))
        .unwrap();
        assert_eq!(edit.decision, "edit");
        assert_eq!(
            edit.edited_payload.unwrap()["body"][0]["text"],
            json!("Bought oat milk.")
        );
    }

    #[test]
    fn proposal_decide_result_encodes_accepted_with_entity_id() {
        let r = ProposalDecideResult {
            status: "accepted".to_string(),
            entity_id: Some(UUID_A.to_string()),
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({ "status": "accepted", "entity_id": UUID_A }),
        );
    }

    #[test]
    fn proposal_decide_result_omits_entity_id_when_none() {
        let r = ProposalDecideResult {
            status: "rejected".to_string(),
            entity_id: None,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v, json!({ "status": "rejected" }));
        assert!(v.get("entity_id").is_none());
    }

    #[test]
    fn proposal_pending_notification_encodes_run_id_and_proposal_id() {
        let n = ProposalPendingNotification {
            run_id: UUID_A.to_string(),
            proposal_id: UUID_B.to_string(),
        };
        assert_eq!(
            serde_json::to_value(&n).unwrap(),
            json!({ "run_id": UUID_A, "proposal_id": UUID_B }),
        );
    }

    #[test]
    fn proposal_changed_notification_encodes_full_shape() {
        for status in ["accepted", "rejected"] {
            let n = ProposalChangedNotification {
                run_id: UUID_A.to_string(),
                proposal_id: UUID_B.to_string(),
                status: status.to_string(),
            };
            assert_eq!(
                serde_json::to_value(&n).unwrap(),
                json!({ "run_id": UUID_A, "proposal_id": UUID_B, "status": status }),
            );
        }
    }

    #[test]
    fn thread_create_params_decodes_prompt() {
        let wire = json!({ "prompt": "hi" });
        let p: ThreadCreateParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.prompt, "hi");
    }

    #[test]
    fn thread_get_params_decodes_thread_id() {
        let wire = json!({ "thread_id": UUID_A });
        let p: ThreadGetParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.thread_id.to_string(), UUID_A);
        // C2 (ADR-0029): a non-UUID thread_id is rejected at decode (the
        // combinator frames it as invalid_params).
        assert!(serde_json::from_value::<ThreadGetParams>(json!({ "thread_id": "nope" })).is_err());
    }

    // --- Serialize-only results: encode to the canonical snake_case wire JSON. ---

    #[test]
    fn thread_create_result_encodes_snake_case() {
        let r = ThreadCreateResult {
            thread_id: UUID_A.to_string(),
            run_id: UUID_B.to_string(),
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({ "thread_id": UUID_A, "run_id": UUID_B }),
        );
    }

    #[test]
    fn thread_summary_encodes_with_numeric_last_activity_at() {
        let r = ThreadSummary {
            id: UUID_A.to_string(),
            title: "Title".to_string(),
            last_activity_at: 1_700_000_000_000,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(
            v,
            json!({ "id": UUID_A, "title": "Title", "last_activity_at": 1_700_000_000_000_i64 }),
        );
        // `last_activity_at` must be a bare JSON number (i64 ms-epoch), not a
        // string — the TS mirror is `S.Number`.
        assert!(v["last_activity_at"].is_number());
    }

    #[test]
    fn thread_list_result_encodes_threads_array() {
        let r = ThreadListResult {
            threads: vec![ThreadSummary {
                id: UUID_A.to_string(),
                title: "Title".to_string(),
                last_activity_at: 42,
            }],
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({
                "threads": [
                    { "id": UUID_A, "title": "Title", "last_activity_at": 42 }
                ]
            }),
        );
    }

    #[test]
    fn message_view_encodes_all_string_fields() {
        let r = MessageView {
            id: UUID_A.to_string(),
            role: "assistant".to_string(),
            status: "complete".to_string(),
            run_id: UUID_B.to_string(),
            text: "hello".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({
                "id": UUID_A,
                "role": "assistant",
                "status": "complete",
                "run_id": UUID_B,
                "text": "hello"
            }),
        );
    }

    #[test]
    fn thread_get_result_encodes_header_and_messages() {
        let r = ThreadGetResult {
            thread_id: UUID_A.to_string(),
            title: "Title".to_string(),
            messages: vec![MessageView {
                id: UUID_B.to_string(),
                role: "user".to_string(),
                status: "complete".to_string(),
                run_id: UUID_A.to_string(),
                text: "hi".to_string(),
            }],
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({
                "thread_id": UUID_A,
                "title": "Title",
                "messages": [
                    {
                        "id": UUID_B,
                        "role": "user",
                        "status": "complete",
                        "run_id": UUID_A,
                        "text": "hi"
                    }
                ]
            }),
        );
    }

    // --- RunEvent (Serialize + Deserialize): round-trip both variants (frozen). ---

    #[test]
    fn run_event_text_delta_round_trips() {
        let wire = json!({ "kind": "text_delta", "delta": "x" });
        let ev: RunEvent = serde_json::from_value(wire.clone()).unwrap();
        match &ev {
            RunEvent::TextDelta { delta } => assert_eq!(delta, "x"),
            other => panic!("expected TextDelta, got {other:?}"),
        }
        assert_eq!(serde_json::to_value(&ev).unwrap(), wire);
    }

    #[test]
    fn run_event_done_round_trips() {
        let wire = json!({ "kind": "done" });
        let ev: RunEvent = serde_json::from_value(wire.clone()).unwrap();
        assert!(matches!(ev, RunEvent::Done));
        assert_eq!(serde_json::to_value(&ev).unwrap(), wire);
    }

    #[test]
    fn run_event_error_round_trips() {
        let wire = json!({ "kind": "error", "message": "boom" });
        let ev: RunEvent = serde_json::from_value(wire.clone()).unwrap();
        match &ev {
            RunEvent::Error { message } => assert_eq!(message, "boom"),
            other => panic!("expected Error, got {other:?}"),
        }
        assert_eq!(serde_json::to_value(&ev).unwrap(), wire);
    }

    #[test]
    fn run_event_tool_call_round_trips_each_status() {
        for (status, wire_status) in [
            (ToolCallStatus::Started, "started"),
            (ToolCallStatus::Completed, "completed"),
            (ToolCallStatus::Error, "error"),
        ] {
            let wire = json!({
                "kind": "tool_call",
                "tool_call_id": "tc_01",
                "name": "read_thread",
                "status": wire_status,
            });
            let ev: RunEvent = serde_json::from_value(wire.clone()).unwrap();
            match &ev {
                RunEvent::ToolCall {
                    tool_call_id,
                    name,
                    status: got,
                } => {
                    assert_eq!(tool_call_id, "tc_01");
                    assert_eq!(name, "read_thread");
                    assert_eq!(*got, status);
                }
                other => panic!("expected ToolCall, got {other:?}"),
            }
            assert_eq!(serde_json::to_value(&ev).unwrap(), wire);
        }
    }

    // --- Manifest (Serialize-only): encode to the canonical wire JSON the TS
    // `WorkerManifest`/`WorkflowManifest`/`ManifestMessage` schemas decode. ---

    #[test]
    fn worker_manifest_encodes_full_shape_with_history_and_token() {
        let manifest = WorkerManifest {
            workflow: WorkflowManifest {
                name: "default",
                version: "1.0.0",
                provider: "openai-codex",
                model: "gpt-5.5",
                system_prompt: "hi",
                thinking_level: "off",
                tools: vec![CoreToolDescriptor {
                    name: "read_thread".to_string(),
                    description: "Read a thread".to_string(),
                    label: "Read thread".to_string(),
                    json_schema: json!({ "type": "object" }),
                }],
            },
            prompt: "now",
            messages: vec![
                ManifestMessage::User { text: "earlier q" },
                ManifestMessage::Assistant {
                    text: Some("earlier a"),
                    tool_calls: None,
                },
            ],
            mode: None,
            access_token: Some("tok_abc"),
        };
        assert_eq!(
            serde_json::to_value(&manifest).unwrap(),
            json!({
                "workflow": {
                    "name": "default",
                    "version": "1.0.0",
                    "provider": "openai-codex",
                    "model": "gpt-5.5",
                    "system_prompt": "hi",
                    "thinking_level": "off",
                    "tools": [{
                        "name": "read_thread",
                        "description": "Read a thread",
                        "label": "Read thread",
                        "json_schema": { "type": "object" }
                    }]
                },
                "prompt": "now",
                "messages": [
                    { "role": "user", "text": "earlier q" },
                    { "role": "assistant", "text": "earlier a" }
                ],
                "access_token": "tok_abc"
            }),
        );
    }

    #[test]
    fn worker_manifest_omits_access_token_when_none() {
        let manifest = WorkerManifest {
            workflow: WorkflowManifest {
                name: "default",
                version: "1.0.0",
                provider: "faux",
                model: "faux-1",
                system_prompt: "hi",
                thinking_level: "off",
                tools: vec![],
            },
            prompt: "now",
            messages: vec![],
            mode: None,
            access_token: None,
        };
        let v = serde_json::to_value(&manifest).unwrap();
        // `access_token` is skipped entirely (TS schema marks it optional);
        // the Worker treats absent as "no OAuth token".
        assert!(
            v.get("access_token").is_none(),
            "access_token must be omitted when None, got {v}"
        );
        // `mode` is likewise skipped when None (fresh path); the Worker treats
        // absent as `fresh` (ADR-0025).
        assert!(
            v.get("mode").is_none(),
            "mode must be omitted when None, got {v}"
        );
        assert_eq!(v["workflow"]["tools"], json!([]));
        assert_eq!(v["messages"], json!([]));
    }

    // --- Tool Protocol (ADR-0018): the duplex frames mirror the TS shapes. ---

    #[test]
    fn worker_manifest_encodes_resume_transcript_with_typed_blocks() {
        // The EXACT resume transcript slice 3 reconstructs (ADR-0025): a user
        // turn, an assistant `tool_call`, and the awaited `tool_result`. The
        // assistant carries no text. Mirrors the TS resume shape test.
        let manifest = WorkerManifest {
            workflow: WorkflowManifest {
                name: "default",
                version: "1.0.0",
                provider: "faux",
                model: "faux-1",
                system_prompt: "hi",
                thinking_level: "off",
                tools: vec![],
            },
            prompt: "",
            messages: vec![
                ManifestMessage::User {
                    text: "remember to buy milk",
                },
                ManifestMessage::Assistant {
                    text: None,
                    tool_calls: Some(vec![ManifestToolCall {
                        id: "tc_1",
                        name: "propose_workspace_mutation",
                        arguments: json!({
                            "mutation_kind": "create_journal_entry",
                            "payload": {
                                "occurred_at": "2026-06-10T10:30:00",
                                "body": [{ "type": "text", "text": "Bought milk." }]
                            }
                        }),
                    }]),
                },
                ManifestMessage::ToolResult {
                    tool_call_id: "tc_1",
                    content: "Accepted. Created Journal Entry.",
                    is_error: None,
                },
            ],
            mode: Some("resume"),
            access_token: None,
        };
        let v = serde_json::to_value(&manifest).unwrap();
        assert_eq!(v["mode"], json!("resume"));
        assert_eq!(
            v["messages"],
            json!([
                { "role": "user", "text": "remember to buy milk" },
                {
                    "role": "assistant",
                    "tool_calls": [{
                        "id": "tc_1",
                        "name": "propose_workspace_mutation",
                        "arguments": {
                            "mutation_kind": "create_journal_entry",
                            "payload": {
                                "occurred_at": "2026-06-10T10:30:00",
                                "body": [{ "type": "text", "text": "Bought milk." }]
                            }
                        }
                    }]
                },
                {
                    "role": "tool_result",
                    "tool_call_id": "tc_1",
                    "content": "Accepted. Created Journal Entry."
                }
            ]),
        );
    }

    #[test]
    fn core_tool_descriptor_encodes_snake_case_with_schema() {
        let d = CoreToolDescriptor {
            name: "read_thread".to_string(),
            description: "Read a thread by id".to_string(),
            label: "Read thread".to_string(),
            json_schema: json!({ "type": "object", "properties": { "thread_id": { "type": "string" } } }),
        };
        assert_eq!(
            serde_json::to_value(&d).unwrap(),
            json!({
                "name": "read_thread",
                "description": "Read a thread by id",
                "label": "Read thread",
                "json_schema": { "type": "object", "properties": { "thread_id": { "type": "string" } } }
            }),
        );
    }

    #[test]
    fn tool_result_ok_encodes_outcome_ok() {
        let r = ToolResult {
            kind: "tool_result",
            run_id: UUID_A.to_string(),
            tool_call_id: "tc_01".to_string(),
            outcome: ToolOutcome::Ok {
                ok: AgentToolResult {
                    content: vec![ToolTextContent {
                        r#type: "text".to_string(),
                        text: "{\"messages\":[]}".to_string(),
                    }],
                    details: None,
                    terminate: None,
                },
            },
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({
                "kind": "tool_result",
                "run_id": UUID_A,
                "tool_call_id": "tc_01",
                "outcome": { "ok": { "content": [{ "type": "text", "text": "{\"messages\":[]}" }] } }
            }),
        );
    }

    #[test]
    fn tool_result_err_encodes_outcome_err() {
        let r = ToolResult {
            kind: "tool_result",
            run_id: UUID_A.to_string(),
            tool_call_id: "tc_01".to_string(),
            outcome: ToolOutcome::Err {
                err: ToolErrorWire {
                    code: "tool_not_allowed".to_string(),
                    message: "no".to_string(),
                },
            },
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({
                "kind": "tool_result",
                "run_id": UUID_A,
                "tool_call_id": "tc_01",
                "outcome": { "err": { "code": "tool_not_allowed", "message": "no" } }
            }),
        );
    }

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

    // --- provider/status (Serialize-only): encode to the canonical wire JSON
    // the TS `ProviderStatusResult` schema decodes. ---

    #[test]
    fn provider_status_result_encodes_providers_array() {
        let r = ProviderStatusResult {
            providers: vec![ProviderStatus {
                id: "openai-codex".to_string(),
                connected: true,
            }],
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({ "providers": [{ "id": "openai-codex", "connected": true }] }),
        );
    }

    #[test]
    fn provider_login_start_params_decodes_provider() {
        let wire = json!({ "provider": "openai-codex" });
        let p: ProviderLoginStartParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.provider, "openai-codex");
    }

    #[test]
    fn provider_login_start_result_encodes_authorize_url() {
        let r = ProviderLoginStartResult {
            authorize_url: "https://auth.openai.com/oauth/authorize?x=1".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({ "authorize_url": "https://auth.openai.com/oauth/authorize?x=1" }),
        );
    }

    // --- model/catalog (Serialize + Deserialize): the embedded JSON decodes
    // and re-encodes to the canonical wire shape the TS `ModelCatalogResult`
    // schema produces (ADR-0024). `cost_input`/`cost_output` are bare JSON
    // numbers (the TS mirror is `S.Number`); `input` is a string array.

    #[test]
    fn model_catalog_result_round_trips_snake_case() {
        let wire = json!({
            "providers": [{
                "id": "openai-codex",
                "label": "OpenAI",
                "models": [{
                    "id": "gpt-5.5",
                    "name": "GPT-5.5",
                    "reasoning": true,
                    "input": ["text", "image"],
                    "cost_input": 5.0,
                    "cost_output": 30.0
                }]
            }]
        });
        let decoded: ModelCatalogResult = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(decoded.providers[0].id, "openai-codex");
        assert_eq!(decoded.providers[0].models[0].id, "gpt-5.5");
        assert!(decoded.providers[0].models[0].reasoning);
        assert_eq!(serde_json::to_value(&decoded).unwrap(), wire);
    }

    // --- settings/* (ADR-0024): result encodes provider/model/effort with a
    // `null` model when unset; params decode partial updates (absent = leave).

    #[test]
    fn settings_result_encodes_null_model_when_unset() {
        let r = SettingsResult {
            provider: "openai-codex".to_string(),
            model: None,
            effort: "off".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({ "provider": "openai-codex", "model": null, "effort": "off" }),
        );
    }

    #[test]
    fn settings_result_encodes_selected_model() {
        let r = SettingsResult {
            provider: "openai-codex".to_string(),
            model: Some("gpt-5.5".to_string()),
            effort: "high".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({ "provider": "openai-codex", "model": "gpt-5.5", "effort": "high" }),
        );
    }

    #[test]
    fn settings_set_params_decodes_partial_updates() {
        let only_effort: SettingsSetParams =
            serde_json::from_value(json!({ "effort": "low" })).unwrap();
        assert_eq!(only_effort.model, None);
        assert_eq!(only_effort.effort.as_deref(), Some("low"));

        let only_model: SettingsSetParams =
            serde_json::from_value(json!({ "model": "gpt-5.4" })).unwrap();
        assert_eq!(only_model.model.as_deref(), Some("gpt-5.4"));
        assert_eq!(only_model.effort, None);

        let empty: SettingsSetParams = serde_json::from_value(json!({})).unwrap();
        assert_eq!(empty.model, None);
        assert_eq!(empty.effort, None);
    }
}
