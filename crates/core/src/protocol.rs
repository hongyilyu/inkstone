//! Wire protocol types: JSON-RPC 2.0 envelope and hand-mirrored serde shapes of
//! the TypeScript schemas in `packages/protocol` (ADR-0009).

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

/// `run/post_message` params: add a message (and its Run) to an existing Thread
/// (ADR-0022). Minting a new Thread is `thread/create`'s job, so `thread_id` is
/// required; malformed → `invalid_params` (-32602), unknown → `unknown_thread`
/// (-32001).
#[derive(Debug, Deserialize)]
pub struct PostMessageParams {
    pub thread_id: uuid::Uuid,
    pub prompt: String,
}

/// `run/subscribe` params: the Run to attach to. Snapshot-then-tail (ADR-0022) —
/// Core replies with the cumulative text as a `text_delta`, then forwards the
/// live tail until `done`.
#[derive(Debug, Deserialize)]
pub struct SubscribeParams {
    pub run_id: uuid::Uuid,
}

/// `run/subscribe` result (ADR-0022, ADR-0025): the Run's `status` at subscribe
/// time — `running` while a live stream exists, else the persisted
/// `runs.status` (notably `parked`, which a refreshed Client must not mistake
/// for terminal).
#[derive(Debug, Serialize)]
pub struct SubscribeResult {
    pub run_id: String,
    pub status: String,
}

/// `run/cancel` params (ADR-0014): the Run to cancel.
#[derive(Debug, Deserialize)]
pub struct RunCancelParams {
    pub run_id: uuid::Uuid,
}

/// `run/cancel` result (ADR-0014): `accepted` (live/parked, now cancelling),
/// `already_terminal` (finished before the cancel arrived), or `unknown_run`.
#[derive(Debug, Serialize)]
pub struct RunCancelResult {
    pub outcome: String,
}

/// `proposal/get` params (ADR-0025): the parked Run whose pending Proposal to
/// fetch.
#[derive(Debug, Deserialize)]
pub struct ProposalGetParams {
    pub run_id: uuid::Uuid,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum JournalEntryBodyNode {
    Text { text: String },
    EntityRef { ref_id: String },
}

#[derive(Debug, Serialize)]
pub struct ProposalReviewCurrentJournalEntry {
    pub entity_id: String,
    pub occurred_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    pub body: Vec<JournalEntryBodyNode>,
}

#[derive(Debug, Serialize)]
pub struct ProposalReviewContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_journal_entry: Option<ProposalReviewCurrentJournalEntry>,
}

/// `proposal/get` result (ADR-0025): the Run's pending Proposal. `payload` is
/// opaque and mutation-specific; `rationale` may be `null`; `review_context` is
/// optional display-only context for review surfaces.
#[derive(Debug, Serialize)]
pub struct ProposalGetResult {
    pub proposal_id: String,
    pub run_id: String,
    pub mutation_kind: String,
    pub payload: serde_json::Value,
    pub rationale: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_context: Option<ProposalReviewContext>,
    pub status: String,
}

/// `proposal/decide` params (ADR-0025): the user's Decision on a pending
/// Proposal. `decision` is accept|reject|edit; `edited_payload` carries edits
/// for `edit`. `decision_idempotency_key` makes a retried decide safe — a repeat
/// with the same key returns the prior result without re-applying (ADR-0014).
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

/// `proposal/decide` result (ADR-0025): the post-decision `status`
/// (`accepted`|`rejected`) and, for an accept/edit that created an Entity, its
/// `entity_id` (omitted for a reject).
#[derive(Debug, Serialize)]
pub struct ProposalDecideResult {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<String>,
}

/// `proposal/pending` Notification (ADR-0025): pushed to a Run's subscribers the
/// moment it parks, so an attached chat surface shows the review card without
/// polling.
#[derive(Debug, Serialize)]
pub struct ProposalPendingNotification {
    pub run_id: String,
    pub proposal_id: String,
}

/// `proposal/changed` Notification (ADR-0025): pushed when a pending Proposal is
/// decided; `status` is `accepted`|`rejected`.
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
/// `thread/create` params: the first user message (ADR-0022, message-first
/// creation). An empty/whitespace `prompt` is rejected with `invalid_params`;
/// the trim-empty guard lives in [`crate::runs::handle_thread_create`].
#[derive(Debug, Deserialize)]
pub struct ThreadCreateParams {
    pub prompt: String,
}

/// `thread/create` result: the freshly-minted Thread and its first Run
/// (ADR-0022). The Client follows with `run/subscribe(run_id)` to receive
/// events.
#[derive(Debug, Serialize)]
pub struct ThreadCreateResult {
    pub thread_id: String,
    pub run_id: String,
}

/// A Thread row in `thread/list` (ADR-0017 `threads` columns).
/// `last_activity_at` is the ms-epoch the Thread was last touched (bumped per
/// Run); the list orders by it, newest-first.
#[derive(Debug, Serialize)]
pub struct ThreadSummary {
    pub id: String,
    pub title: String,
    pub last_activity_at: i64,
}

/// `thread/list` result: every Thread, most-recent-activity-first. Object-wrapper
/// shape (`{threads: [...]}`) keeps the result forward-extensible.
#[derive(Debug, Serialize)]
pub struct ThreadListResult {
    pub threads: Vec<ThreadSummary>,
}

/// `entity/list` params: the Entity `type` to list, one per call (e.g. `"todo"`,
/// `"person"`). `r#type` serializes as the wire field `"type"`.
#[derive(Debug, Deserialize)]
pub struct EntityListParams {
    pub r#type: String,
}

/// One Entity row in `entity/list` (ADR-0004 tier-2 `entities` columns).
/// `r#type` serializes as `"type"`; `data` is the opaque entity JSON;
/// `created_at`/`updated_at` are ms-epoch stamps.
#[derive(Debug, Serialize)]
pub struct EntityRow {
    pub id: String,
    pub r#type: String,
    pub data: serde_json::Value,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub refs: Vec<ResolvedEntityRef>,
    /// A Todo row's Person References (ADR-0031, ADR-0032). Empty (and omitted)
    /// for non-Todo rows and Todos with no references.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub person_refs: Vec<TodoPersonRefView>,
}

#[derive(Debug, Serialize)]
pub struct ResolvedEntityRef {
    pub id: String,
    pub source_entity_id: String,
    pub target_entity_id: String,
    pub target_entity_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label_snapshot: Option<String>,
}

/// One Todo Person Reference on a Todo `entity/list` row (ADR-0032). `role` is
/// `waiting_on` or `related` (`waiting_on` ⊇ `related`).
#[derive(Debug, Serialize)]
pub struct TodoPersonRefView {
    pub person_id: String,
    pub role: String,
}

/// `entity/list` result: the accepted Entities of the requested type,
/// newest-first. Object-wrapper shape (`{entities: [...]}`) keeps it
/// forward-extensible.
#[derive(Debug, Serialize)]
pub struct EntityListResult {
    pub entities: Vec<EntityRow>,
}

/// `entity/mutate` params (ADR-0033): a user-initiated CRUD request. `payload` is
/// the same discriminated `{mutation_kind, payload}` envelope the Worker's
/// `propose_workspace_mutation` tool uses (minus `rationale`), so it stays opaque
/// at the wire boundary — Core validates it per `mutation_kind`.
#[derive(Debug, Deserialize)]
pub struct EntityMutateParams {
    pub mutation_kind: String,
    pub payload: serde_json::Value,
}

/// `entity/mutate` result: the affected Entity id — present on create/update,
/// absent on delete (which leaves no row).
#[derive(Debug, Serialize)]
pub struct EntityMutateResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<String>,
}

/// `message/search` params (ADR-0035): a substring query over completed Message
/// text. Mirror of TS `MessageSearchParams`.
#[derive(Debug, Deserialize)]
pub struct MessageSearchParams {
    pub query: String,
}

/// One `message/search` hit (ADR-0035): a completed Message matching the
/// substring query, with a SQL-rendered snippet and its Thread title for
/// navigation. Mirror of TS `MessageHit` (field-for-field, snake_case wire);
/// aligns with `db::MessageHit`. `role` is `"user"`/`"assistant"` on the wire;
/// `created_at` is a ms-epoch stamp.
#[derive(Debug, Serialize)]
pub struct MessageHit {
    pub message_id: String,
    pub thread_id: String,
    pub run_id: String,
    pub role: String,
    pub snippet: String,
    pub thread_title: String,
    pub created_at: i64,
}

/// `message/search` result: the matching hits, newest-first. Object-wrapper
/// shape (`{hits: [...]}`) keeps it forward-extensible. Mirror of TS
/// `MessageSearchResult`.
#[derive(Debug, Serialize)]
pub struct MessageSearchResult {
    pub hits: Vec<MessageHit>,
}

/// `thread/get` params: the Thread to rehydrate. Malformed `thread_id` →
/// `invalid_params` (-32602), unknown → `unknown_thread` (-32001), as in
/// `run/post_message`.
#[derive(Debug, Deserialize)]
pub struct ThreadGetParams {
    pub thread_id: uuid::Uuid,
}

/// A Message in a `thread/get` result. `text` is the concatenation of the
/// Message's text parts in `seq` order — no `parts[]` array until attachments
/// exist (ADR-0017/Q15). `run_id` lets a refreshed Client resubscribe to a
/// `streaming` Message's Run.
#[derive(Debug, Serialize)]
pub struct MessageView {
    pub id: String,
    pub role: String,
    pub status: String,
    pub run_id: String,
    pub text: String,
}

/// `thread/get` result: the Thread header plus its Messages in chronological
/// order. A mid-stream Run yields a `streaming` assistant Message with partial
/// text and a `run_id`.
#[derive(Debug, Serialize)]
pub struct ThreadGetResult {
    pub thread_id: String,
    pub title: String,
    pub messages: Vec<MessageView>,
}

/// Lifecycle status of a tool call on the Run Event stream (ADR-0006).
/// `Started` is published on the `tool_request`; `Completed`/`Error` mirror the
/// dispatch outcome. Serializes snake_case.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallStatus {
    Started,
    Completed,
    Error,
}

/// Run Event forwarded to Clients as a `run/event` Notification (ADR-0006). Most
/// variants come from the Worker's stdout NDJSON stream. `ToolCall` and
/// `Cancelled` are the exceptions: Core synthesizes them (from `tool_request`s
/// and the guarded cancellation transition, respectively) — both are ephemeral.
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
    Cancelled,
    Error {
        message: String,
    },
}

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

/// One provider's connection status in `provider/status` (ADR-0023). `connected`
/// is true when a credential file exists for it.
#[derive(Debug, Serialize)]
pub struct ProviderStatus {
    pub id: String,
    pub connected: bool,
}

/// `provider/status` result: the connection state of each known provider.
/// Object-wrapper shape keeps it forward-extensible.
#[derive(Debug, Serialize)]
pub struct ProviderStatusResult {
    pub providers: Vec<ProviderStatus>,
}

/// `provider/login_start` params: which provider to begin an OAuth login for.
/// Malformed/unknown → `invalid_params`.
#[derive(Debug, Deserialize)]
pub struct ProviderLoginStartParams {
    pub provider: String,
}

/// `provider/login_start` result: the authorize URL the Client opens (ADR-0023).
/// The Provider Helper runs the OAuth loopback; the callback + credential write
/// happen out-of-band, and the Client re-queries `provider/status` on focus to
/// learn the outcome.
#[derive(Debug, Serialize)]
pub struct ProviderLoginStartResult {
    pub authorize_url: String,
}

/// One model in `model/catalog` (ADR-0024). Both directions: Core decodes these
/// from the embedded catalog JSON and re-encodes them onto the wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub reasoning: bool,
    pub input: Vec<String>,
    pub cost_input: f64,
    pub cost_output: f64,
}

/// One provider's model group in `model/catalog`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderModels {
    pub id: String,
    pub label: String,
    pub models: Vec<ModelInfo>,
}

/// `model/catalog` result: the models available per provider (ADR-0024).
/// Object-wrapper shape keeps it forward-extensible.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelCatalogResult {
    pub providers: Vec<ProviderModels>,
}

/// `settings/get` + `settings/set` result (ADR-0024): the effective model
/// selection and global effort for the default Workflow. `model` is `null` until
/// the user picks one (the resolver falls back to the per-provider default);
/// `effort` defaults to `off`.
#[derive(Debug, Serialize)]
pub struct SettingsResult {
    pub provider: String,
    pub model: Option<String>,
    pub effort: String,
}

/// `settings/set` params (ADR-0024): a partial update. An absent field is left
/// unchanged; a present `model` must be a known catalog id and a present
/// `effort` a valid thinking level, else `invalid_params`.
#[derive(Debug, Deserialize)]
pub struct SettingsSetParams {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
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
/// `messages` is the assembled prior history. `mode` selects the loop entry
/// point (ADR-0025): absent/`"fresh"` starts a new prompt, `"resume"` continues
/// a reconstructed transcript. `access_token` is `Some` only for OAuth providers
/// (ADR-0023), skipped on the wire otherwise.
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
    fn entity_mutate_params_decodes_kind_and_opaque_payload() {
        let wire = json!({
            "mutation_kind": "create_person",
            "payload": { "name": "Alice" }
        });
        let p: EntityMutateParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.mutation_kind, "create_person");
        assert_eq!(p.payload, json!({ "name": "Alice" }));
    }

    #[test]
    fn entity_mutate_result_encodes_entity_id() {
        let r = EntityMutateResult {
            entity_id: Some(UUID_A.to_string()),
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({ "entity_id": UUID_A }),
        );
    }

    #[test]
    fn entity_mutate_result_omits_entity_id_when_none() {
        // A delete carries no surviving Entity, so `entity_id` is omitted (the TS
        // mirror types it `S.optional`).
        let r = EntityMutateResult { entity_id: None };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v, json!({}));
        assert!(v.get("entity_id").is_none());
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
            review_context: None,
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
            review_context: None,
            status: "pending".to_string(),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["rationale"], json!(null));
    }

    #[test]
    fn proposal_get_result_encodes_review_context() {
        let r = ProposalGetResult {
            proposal_id: UUID_B.to_string(),
            run_id: UUID_A.to_string(),
            mutation_kind: "update_journal_entry".to_string(),
            payload: json!({
                "entity_id": UUID_B,
                "occurred_at": "2026-06-10T11:00:00",
                "body": [{ "type": "text", "text": "Bought oat milk." }]
            }),
            rationale: Some("because".to_string()),
            review_context: Some(ProposalReviewContext {
                current_journal_entry: Some(ProposalReviewCurrentJournalEntry {
                    entity_id: UUID_B.to_string(),
                    occurred_at: "2026-06-10T10:30:00".to_string(),
                    ended_at: Some("2026-06-10T10:45:00".to_string()),
                    body: vec![
                        JournalEntryBodyNode::Text {
                            text: "Bought ".to_string(),
                        },
                        JournalEntryBodyNode::EntityRef {
                            ref_id: UUID_A.to_string(),
                        },
                        JournalEntryBodyNode::Text {
                            text: ".".to_string(),
                        },
                    ],
                }),
            }),
            status: "pending".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({
                "proposal_id": UUID_B,
                "run_id": UUID_A,
                "mutation_kind": "update_journal_entry",
                "payload": {
                    "entity_id": UUID_B,
                    "occurred_at": "2026-06-10T11:00:00",
                    "body": [{ "type": "text", "text": "Bought oat milk." }]
                },
                "rationale": "because",
                "review_context": {
                    "current_journal_entry": {
                        "entity_id": UUID_B,
                        "occurred_at": "2026-06-10T10:30:00",
                        "ended_at": "2026-06-10T10:45:00",
                        "body": [
                            { "type": "text", "text": "Bought " },
                            { "type": "entity_ref", "ref_id": UUID_A },
                            { "type": "text", "text": "." }
                        ]
                    }
                },
                "status": "pending"
            }),
        );
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
        // A non-UUID thread_id is rejected at decode → invalid_params (ADR-0029).
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
        // Must be a bare JSON number, not a string (the TS mirror is `S.Number`).
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

    // --- RunEvent (Serialize + Deserialize): round-trip wire variants. ---

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
    fn run_event_cancelled_round_trips() {
        let wire = json!({ "kind": "cancelled" });
        let ev: RunEvent = serde_json::from_value(wire.clone()).unwrap();
        assert!(matches!(ev, RunEvent::Cancelled));
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

    // --- Manifest (Serialize-only): encode to the canonical wire JSON. ---

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
        // `access_token` skipped when None; the Worker treats absent as "no OAuth token".
        assert!(
            v.get("access_token").is_none(),
            "access_token must be omitted when None, got {v}"
        );
        // `mode` skipped when None; the Worker treats absent as `fresh` (ADR-0025).
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
        // The resume transcript (ADR-0025): a user turn, an assistant `tool_call`
        // with no text, and the awaited `tool_result`.
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
                    text: "I bought milk after daycare pickup and felt relieved.",
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
                { "role": "user", "text": "I bought milk after daycare pickup and felt relieved." },
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

    // --- provider/status (Serialize-only): encode to the canonical wire JSON. ---

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

    // --- model/catalog (round-trip, ADR-0024): `cost_input`/`cost_output` are
    // bare JSON numbers (the TS mirror is `S.Number`); `input` is a string array. ---

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

    // --- settings/* (ADR-0024): result encodes a `null` model when unset; params
    // decode partial updates (absent = leave). ---

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
