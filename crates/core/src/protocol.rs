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

/// `run/retry` params (ADR-0028 retry amendment, #230): the errored Run to
/// re-drive in place. Malformed → `invalid_params`, mirroring `run/cancel`.
#[derive(Debug, Deserialize)]
pub struct RunRetryParams {
    pub run_id: uuid::Uuid,
}

/// `run/retry` result (ADR-0028 retry amendment, #230): `accepted` (the errored
/// Run won the `errored → running` flip and is re-driving), `not_errored` (the
/// Run was not in `errored` — a normal response value, not an error frame, like
/// `RunCancelResult`'s `already_terminal`), or `unknown_run`.
#[derive(Debug, Serialize)]
pub struct RunRetryResult {
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

/// The stored Person surfaced for an `update_person` Proposal's Current section
/// (mirror of [`ProposalReviewCurrentJournalEntry`], lamplit-desk-alignment).
/// Carries exactly the fields the create/update renderer displays — `name` plus
/// optional `note`/`aliases` — so the Client renders Current row-for-row against
/// the Proposed payload, making an omitted (thus removed, ADR-0033) field visible
/// before accept. Non-identity fields are `skip_serializing_if = None`.
#[derive(Debug, Serialize)]
pub struct ProposalReviewCurrentPerson {
    pub entity_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aliases: Option<Vec<String>>,
}

/// The stored Project surfaced for an `update_project` Proposal's Current section
/// (sibling of [`ProposalReviewCurrentPerson`]). Carries `name` plus optional
/// `outcome`/`status`/`note`.
#[derive(Debug, Serialize)]
pub struct ProposalReviewCurrentProject {
    pub entity_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ProposalReviewContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_journal_entry: Option<ProposalReviewCurrentJournalEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_person: Option<ProposalReviewCurrentPerson>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_project: Option<ProposalReviewCurrentProject>,
}

/// One node of an `apply_intent_graph` proposal's resolved plan (ADR-0042),
/// computed READ-ONLY at `proposal/get` so the Client renders create/reuse/
/// ambiguous badges without re-resolving. Mirrors the TS `ResolvedNode`. A flat
/// shape (not a tagged union) keyed by `disposition`: `entity_id` is present only
/// for `reuse`, `candidates` only for `ambiguous` — both skipped otherwise. This
/// is ADVISORY: Core re-resolves authoritatively at decide, so a node that is
/// `reuse` here but raced to deleted by decide-time is fine (decide handles it).
#[derive(Debug, Serialize)]
pub struct ResolvedNode {
    pub handle: String,
    pub r#type: String,
    pub disposition: String,
    pub label: String,
    /// The reused entity's id — present only when `disposition == "reuse"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<String>,
    /// The competing exact matches — present only when `disposition == "ambiguous"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidates: Option<Vec<ResolvedNodeCandidate>>,
    /// Advisory near-matches (ADR-0042 near-match amendment) — present only on a
    /// `create` node that token-overlaps (subset/superset) an accepted same-type
    /// entity. NEVER authority: the apply path stays exact-only. The Client uses a
    /// single near-match to default the node to reuse-that-entity via the per-node
    /// `entity_id` override; 2+ are surfaced advisorily (the picker, #181).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub near_matches: Option<Vec<ResolvedNodeCandidate>>,
}

/// One competing exact match for an `ambiguous` [`ResolvedNode`] (ADR-0042).
#[derive(Debug, Serialize)]
pub struct ResolvedNodeCandidate {
    pub entity_id: String,
    pub label: String,
}

/// `proposal/get` result (ADR-0025): the Run's pending Proposal. `payload` is
/// opaque and mutation-specific; `rationale` may be `null`; `review_context` is
/// optional display-only context for review surfaces. `resolved_plan` is the
/// per-node create/reuse/ambiguous plan for an `apply_intent_graph` proposal only
/// (ADR-0042) — `None` (omitted) for non-graph proposal kinds.
#[derive(Debug, Serialize)]
pub struct ProposalGetResult {
    pub proposal_id: String,
    pub run_id: String,
    pub mutation_kind: String,
    pub payload: serde_json::Value,
    pub rationale: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_context: Option<ProposalReviewContext>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_plan: Option<Vec<ResolvedNode>>,
    pub status: String,
}

/// One per-node decision in an `apply_intent_graph` decision vector (ADR-0042),
/// mirroring the TS `NodeDecision`. Keyed by the graph-local `handle`; `decision`
/// is `accept`|`reject`; an accept may carry an `entity_id` override (collapse a
/// reuse/ambiguous node to that id) OR `edited_fields` (correct a CREATE node's
/// content before it is minted) — mutually exclusive per node, accept-only, both
/// enforced by Core in [`crate::decide`]/[`crate::db::apply_intent_graph_proposal`].
#[derive(Debug, Clone, Deserialize)]
pub struct NodeDecision {
    pub handle: String,
    pub decision: String,
    #[serde(default)]
    pub entity_id: Option<String>,
    #[serde(default)]
    pub edited_fields: Option<serde_json::Value>,
}

/// `proposal/decide` params (ADR-0025): the user's Decision on a pending
/// Proposal. `decision` is accept|reject|edit; `edited_payload` carries edits
/// for `edit`. `decision_idempotency_key` makes a retried decide safe — a repeat
/// with the same key returns the prior result without re-applying (ADR-0014).
///
/// `decisions` is the per-node vector for `apply_intent_graph` only (ADR-0042):
/// non-graph kinds keep the scalar `decision`/`edited_payload`; the
/// graph reconciles its stored nodes against this vector (reject-cascade,
/// entity_id override, edited_fields). Absent/empty = accept everything (a
/// missing per-node entry defaults to accept).
#[derive(Debug, Deserialize)]
pub struct ProposalDecideParams {
    pub proposal_id: uuid::Uuid,
    pub decision: String,
    #[serde(default)]
    #[allow(dead_code)] // consumed by `edit`; accept ignores it
    pub edited_payload: Option<serde_json::Value>,
    #[serde(default)]
    pub decisions: Option<Vec<NodeDecision>>,
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

/// `thread/titled` Notification (ADR-0047): the one-shot titler (ADR-0046) pushes
/// the generated `title` to the connection that created `thread_id`, so its
/// sidebar updates live without a `thread/list` poll. Rides the connection's
/// `out_tx`, keyed by `method` — not a Run subscription.
#[derive(Debug, Serialize)]
pub struct ThreadTitledNotification {
    pub thread_id: String,
    pub title: String,
}

/// `provider/connected` Notification (ADR-0047 second consumer, ADR-0049): the
/// detached credential-drain task (`provider/login_start`, ADR-0023) persisted
/// the rotated OAuth credentials, so Core pushes `{provider}` to the connection
/// that started the login — the Settings → Models card flips to Connected live,
/// without waiting for the tab to regain focus. Rides the connection's `out_tx`,
/// keyed by `method` — not a Run subscription. Carries only the provider id (a
/// ping, not the connection state); the Client refetches `provider/status`.
#[derive(Debug, Serialize)]
pub struct ProviderConnectedNotification {
    pub provider: String,
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
/// `thread/list_archived` (ADR-0052) reuses this same result type for the
/// archived list (newest-archived-first).
#[derive(Debug, Serialize)]
pub struct ThreadListResult {
    pub threads: Vec<ThreadSummary>,
}

/// `thread/rename` params (ADR-0052): the Thread to rename + its new `title`.
/// Malformed `thread_id` → `invalid_params` (-32602), unknown → `unknown_thread`
/// (-32001); an empty/whitespace `title` is also `invalid_params`.
#[derive(Debug, Deserialize)]
pub struct ThreadRenameParams {
    pub thread_id: uuid::Uuid,
    pub title: String,
}

/// `thread/archive` params (ADR-0052): the Thread to archive (hide from the
/// default sidebar list). Malformed `thread_id` → `invalid_params` (-32602),
/// unknown → `unknown_thread` (-32001).
#[derive(Debug, Deserialize)]
pub struct ThreadArchiveParams {
    pub thread_id: uuid::Uuid,
}

/// `thread/unarchive` params (ADR-0052): the Thread to restore to the default
/// list. Malformed `thread_id` → `invalid_params` (-32602), unknown →
/// `unknown_thread` (-32001).
#[derive(Debug, Deserialize)]
pub struct ThreadUnarchiveParams {
    pub thread_id: uuid::Uuid,
}

/// The shared ack for the three mutating Thread verbs (`thread/rename`,
/// `thread/archive`, `thread/unarchive`, ADR-0052): the affected `thread_id`.
/// Mirrors `EntityMutateResult` but `thread_id` is NON-optional — every mutating
/// verb has a target Thread (the Web reconciles by invalidating its `["threads"]`
/// query and re-reading, so a minimal ack suffices).
#[derive(Debug, Serialize)]
pub struct ThreadMutateResult {
    pub thread_id: String,
}

/// `run/get_history` params: an optional `limit` on how many recent Runs to
/// return (Core defaults to `RUN_HISTORY_DEFAULT_LIMIT` when omitted/null).
#[derive(Debug, Default, Deserialize)]
pub struct RunGetHistoryParams {
    #[serde(default)]
    pub limit: Option<i64>,
}

/// One Run in the `run/get_history` recent-Runs feed (ADR-0028 as-built). `kind`
/// is the Run's *latest* Run Log milestone verbatim — one of the seven Run Log
/// kinds, deliberately not folded into `runs.status` (a resumed-still-working
/// Run reads `proposal_decided`, since `resume` writes no Run Log row). `title`
/// is the owning Thread's title; `at` is the milestone's ms-epoch `created_at`,
/// which is also the recency key. Hand-authored wire struct (not a `PayloadSpec`
/// kind), so it sits outside the schema-parity gate — like `ThreadSummary`.
#[derive(Debug, Serialize)]
pub struct RunHistoryItem {
    pub run_id: String,
    pub thread_id: String,
    pub title: String,
    pub kind: String,
    pub at: i64,
}

/// `run/get_history` result: recent Runs, newest-first. Object-wrapper shape
/// (`{runs: [...]}`) keeps the result forward-extensible, mirroring
/// `ThreadListResult`.
#[derive(Debug, Serialize)]
pub struct RunHistoryResult {
    pub runs: Vec<RunHistoryItem>,
}

/// `recurrence/preview` params (ADR-0039 amendment, #227): a draft Recurrence
/// Rule + the editing Todo's current `defer_at`/`due_at`. Read-only — the editor
/// sends an in-progress rule to preview when the next occurrence would land.
/// `recurrence` is the opaque rule object (validated only by the date math's
/// fail-safe `None`, never rejected here); the dates are optional because a Todo
/// may carry only one anchor. Hand-authored wire struct (Deserialize-only).
#[derive(Debug, Deserialize)]
pub struct RecurrencePreviewParams {
    pub recurrence: serde_json::Value,
    #[serde(default)]
    pub defer_at: Option<String>,
    #[serde(default)]
    pub due_at: Option<String>,
}

/// `recurrence/preview` result (ADR-0039 amendment, #227): the next occurrence's
/// dates, or `ended: true` when completing the Todo would spawn no successor
/// (end condition reached, or a malformed/partial draft rule — `next_occurrence`
/// is fail-safe). `ended: true` is a normal result, NOT a JSON-RPC error: a
/// bounded series ending is expected, and an in-flight draft must never surface
/// as an error in the editor. When `ended` is false, `defer_at`/`due_at` mirror
/// the input's anchor presence (a date absent on input stays absent).
#[derive(Debug, Serialize)]
pub struct RecurrencePreviewResult {
    pub ended: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub defer_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_at: Option<String>,
}

/// One draft observation in `observation/record` params (ADR-0053). `values` is
/// schema-specific opaque JSON; Core validates it against the observation schema
/// registry before storage.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObservationRecordDraft {
    pub schema_key: String,
    pub occurred_at: String,
    #[serde(default)]
    pub ended_at: Option<String>,
    pub values: serde_json::Value,
    #[serde(default)]
    pub note: Option<String>,
}

/// Optional evidence attached to a direct `observation/record` batch. Both
/// fields are strings at the wire layer; Core validates identifiers when the RPC
/// handler maps this shape into the observation module.
#[derive(Debug, Deserialize)]
pub struct ObservationEvidence {
    #[serde(default)]
    pub journal_entry_id: Option<String>,
    #[serde(default)]
    pub message_id: Option<String>,
}

/// `observation/record` params (ADR-0053): direct user-authored observation
/// drafts plus optional shared evidence for the batch.
#[derive(Debug, Deserialize)]
pub struct ObservationRecordParams {
    pub observations: Vec<ObservationRecordDraft>,
    #[serde(default)]
    pub evidence: Option<ObservationEvidence>,
}

/// `observation/record` result: ids of the created observations, in input order.
#[derive(Debug, Serialize)]
pub struct ObservationRecordResult {
    pub observation_ids: Vec<String>,
}

/// The mutable fact fields of an `observation/update` replacement (#256). Unlike
/// [`ObservationRecordDraft`], this carries NO `schema_key`: the schema is
/// single-sourced from the stored row, so a stray `schema_key` (or any other
/// unknown field) is hard-rejected by `deny_unknown_fields`. `values` are
/// validated against the stored row's schema by Core, not the wire payload.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObservationUpdateDraft {
    pub occurred_at: String,
    #[serde(default)]
    pub ended_at: Option<String>,
    pub values: serde_json::Value,
    #[serde(default)]
    pub note: Option<String>,
}

/// `observation/update` params: the target Observation id plus a source-free
/// replacement draft. Provenance stays immutable; corrections only change the
/// current fact fields and append `observation_revisions`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObservationUpdateParams {
    pub observation_id: uuid::Uuid,
    pub observation: ObservationUpdateDraft,
}

/// `observation/update` result: the canonical id of the updated Observation.
#[derive(Debug, Serialize)]
pub struct ObservationUpdateResult {
    pub observation_id: String,
}

/// `observation/query` params (ADR-0053): optional schema, time, evidence
/// source, related Entity, and limit filters. `related_entity_id` filters
/// schema-specific Observation relation fields such as `habit.checkin.habit_id`;
/// it is distinct from `source_entity_id`, which filters provenance evidence.
#[derive(Debug, Default, Deserialize)]
pub struct ObservationQueryParams {
    #[serde(default)]
    pub schema_keys: Option<Vec<String>>,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
    #[serde(default)]
    pub source_entity_id: Option<String>,
    #[serde(default)]
    pub source_message_id: Option<String>,
    #[serde(default)]
    pub related_entity_id: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
}

/// One observation source surfaced in `observation/query` results.
#[derive(Debug, Serialize)]
pub struct ObservationSourceView {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_entity_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_message_id: Option<String>,
    pub relation: String,
}

/// One row in an `observation/query` result. Nullable fields serialize as
/// explicit `null` so the Client can distinguish "known absent" from omitted
/// request fields.
#[derive(Debug, Serialize)]
pub struct ObservationRow {
    pub id: String,
    pub schema_key: String,
    pub schema_version: i64,
    pub occurred_at: String,
    pub ended_at: Option<String>,
    pub values: serde_json::Value,
    pub note: Option<String>,
    pub source: Option<ObservationSourceView>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// `observation/query` result: matched observations, newest-first by Core query
/// behavior once the handler is wired.
#[derive(Debug, Serialize)]
pub struct ObservationQueryResult {
    pub observations: Vec<ObservationRow>,
}

/// `observation/get_history` params (ADR-0053): the Observation whose correction
/// history to read. `observation_id` is UUID-checked by Core.
#[derive(Debug, Deserialize)]
pub struct ObservationGetHistoryParams {
    pub observation_id: String,
}

/// One revision in an `observation/get_history` result (`observation_revisions`),
/// `seq`-ordered ascending. Like `ObservationRow`, nullable fields serialize as
/// explicit `null` so the Client can distinguish known-absent from omitted.
/// `proposal_id` names the Proposal a correction came from, `null` for user edits.
#[derive(Debug, Serialize)]
pub struct ObservationRevisionView {
    pub seq: i64,
    pub schema_key: String,
    pub schema_version: i64,
    pub occurred_at: String,
    pub ended_at: Option<String>,
    pub values: serde_json::Value,
    pub note: Option<String>,
    pub proposal_id: Option<String>,
    pub created_at: i64,
}

/// `observation/get_history` result: the full revision chain `ORDER BY seq ASC`.
/// Empty for an unknown observation_id (no error).
#[derive(Debug, Serialize)]
pub struct ObservationGetHistoryResult {
    pub revisions: Vec<ObservationRevisionView>,
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
    /// The Entity's origin provenance ("Captured from", ADR-0030). Omitted for a
    /// user-authored Entity (a direct Library write records no source row).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<EntitySourceView>,
}

/// One Entity's origin provenance on an `entity/list` row (ADR-0030). A FLAT
/// optional shape, safe because Core is the sole producer and fills the fields
/// from one `entity_sources` row whose CHECK guarantees exactly one source kind:
/// a user Message source carries `thread_id` + `thread_title` (link back to the
/// Thread) plus the capturing `message_id` (so the Client can deep-link to the
/// exact message, #184); a Journal-Entry source carries `journal_entry_id` (link
/// to it in the Library). The Client reads `journal_entry_id` first, else the
/// Thread fields (`message_id` rides along with them).
#[derive(Debug, Serialize)]
pub struct EntitySourceView {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub journal_entry_id: Option<String>,
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

/// `entity/backlinks` params (ADR-0050): the Entity whose reverse relations the
/// detail Inspector wants. Only Person/Project/Todo are `entity_ref` targets, so
/// only those fire the read.
#[derive(Debug, Deserialize)]
pub struct EntityBacklinksParams {
    pub entity_id: String,
}

/// `entity/backlinks` result (ADR-0050): the two reverse sets Core resolves
/// authoritatively for the detail Inspector — `mentioned_in` (distinct Journal
/// Entries referencing this Entity, newest-occurred first) and `linked_todos`
/// (Todos linked via `project_id` / `person_refs`, newest first). Reuses
/// `EntityRow` (ADR-0032), so each section parses through the existing entity
/// codec. Both arrays are ALWAYS present (possibly empty `[]`); object-wrapper
/// shape modeled like `EntityListResult` for forward-extensibility.
#[derive(Debug, Serialize)]
pub struct EntityBacklinksResult {
    pub mentioned_in: Vec<EntityRow>,
    pub linked_todos: Vec<EntityRow>,
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

/// `journal_entry/rescan` params (ADR-0042): the Journal Entry to re-scan for
/// people/projects/tasks mentioned but not yet captured. Core resolves the JE's
/// origin Thread and starts an ordinary agent Run there.
#[derive(Debug, Deserialize)]
pub struct JournalEntryRescanParams {
    pub je_id: String,
}

/// `journal_entry/rescan` result: the spawned Run and the origin Thread it runs
/// in (so the Client can follow `run/subscribe(run_id)` and navigate to the
/// Thread). Mirror of TS `JournalEntryRescanResult`.
#[derive(Debug, Serialize)]
pub struct JournalEntryRescanResult {
    pub run_id: String,
    pub thread_id: String,
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

/// One item in an assistant turn's ordered `segments[]` timeline (ADR-0045): a
/// contiguous run of text, a tool-activity row, or the decided Proposal — replayed
/// in `run_steps` `seq` order so the reload renders the turn's pieces in the order
/// they happened. A `#[serde(tag = "kind")]` snake_case union, modeled on
/// [`RunEvent`]. The variant field shapes are exactly what each row renders — the
/// former `ToolCallView` (`name`/`status`/optional `arg`) and `MessageProposalView`
/// (`proposal_id`/`mutation_kind`/`status`) — inlined here, not wrapped, because the
/// `kind` tag IS the discriminant. The union is left OPEN for a future `reasoning`
/// kind (#202) without reshaping `MessageView`. This SUPERSEDES the read-path shapes
/// of ADR-0043 (`tool_calls`) and ADR-0044 (`proposal`): both fold into `segments`.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Segment {
    /// A contiguous run of assistant text (one `message_parts` row).
    Text { text: String },
    /// A settled tool-activity row (ADR-0043): `name`, `status` (`completed`/`error`
    /// — the read filters `pending`), and an optional display `arg`, omitted (not
    /// `null`) for argless tools. Proposal tool calls are NOT emitted here — they
    /// become a `proposal` segment.
    ToolCall {
        name: String,
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        arg: Option<String>,
    },
    /// The decided Proposal an assistant turn parked on (ADR-0044). Only
    /// `accepted`/`rejected` appear — a still-`pending` Proposal renders its
    /// interactive card (deferred), a `cancelled` one is cleared live. The Client
    /// looks the live interactive payload up by `proposal_id`; `mutation_kind` drives
    /// the decided card's copy + routing, `status` the accepted-vs-rejected branch,
    /// and `entity_id` (ADR-0044 amendment) the durable Entity the accepted change
    /// created/updated — the anchor for `apply_intent_graph` — so the card can name +
    /// deep-link it. `entity_id` is omitted (not `null`, matching the TS `S.optional`)
    /// for a `rejected` Proposal (nothing created) or when no Entity resolves.
    Proposal {
        proposal_id: String,
        mutation_kind: String,
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        entity_id: Option<String>,
    },
    /// The model's thinking trace (ADR-0045 reasoning amendment, #202): `text` is
    /// the streamed reasoning (one `message_parts.type='reasoning'` row), and
    /// `duration_ms` how long the model thought — Core-computed at read from the
    /// reasoning step's span, omitted (not `null`, matching the TS `S.optional`) when
    /// unknown. Renders default-collapsed; never replayed into the worker transcript.
    Reasoning {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        duration_ms: Option<i64>,
    },
}

/// A Message in a `thread/get` result. `run_id` lets a refreshed Client resubscribe
/// to a `streaming` Message's Run. `segments` is the assistant turn's ordered
/// timeline (ADR-0045) — `text | tool_call | proposal` items in `run_steps` order —
/// replacing the prior three independent buckets (`text`, `tool_calls`, `proposal`).
/// A user Message carries a single `text` segment. There is no denormalized flat
/// `text`: the Client derives it via one `concatText(segments)` helper, a single
/// source of truth (ADR-0045).
#[derive(Debug, Serialize)]
pub struct MessageView {
    pub id: String,
    pub role: String,
    pub status: String,
    pub run_id: String,
    pub segments: Vec<Segment>,
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
        /// The tool's display argument (ADR-0043), e.g. a `search_entities`
        /// query. Omitted for tools that expose none; carried on the live row so
        /// it matches the rehydrated `ToolCallView`.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        arg: Option<String>,
    },
    Done,
    Cancelled,
    Error {
        message: String,
    },
    /// A reasoning (thinking) delta, mirroring `TextDelta` (ADR-0045 reasoning
    /// amendment, #202): Core republishes it from `WorkerStdout::ReasoningDelta`. The
    /// segment boundary is inferred from the interleaved stream — no position field.
    ReasoningDelta {
        delta: String,
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
/// selection and global effort for the default Workflow. `model` falls back to
/// the per-provider default when the user has not picked one (`null` only when
/// the provider has no default); `effort` defaults to `off`.
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
    const UUID_B: &str = "0190d3c1-0000-7000-8000-000000000002";
    const UUID_RUN: &str = "0190d3c1-0000-7000-8000-000000000003";

    // --- Deserialize-only params: decode the canonical wire JSON. ---

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
    fn run_retry_params_decodes_run_id() {
        let wire = json!({ "run_id": UUID_A });
        let p: RunRetryParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.run_id.to_string(), UUID_A);
        // A non-UUID run_id is rejected at decode → invalid_params (ADR-0029).
        assert!(serde_json::from_value::<RunRetryParams>(json!({ "run_id": "nope" })).is_err());
    }

    #[test]
    fn run_retry_result_encodes_outcome() {
        for outcome in ["accepted", "not_errored", "unknown_run"] {
            let r = RunRetryResult {
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
            resolved_plan: None,
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
            resolved_plan: None,
            status: "pending".to_string(),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["rationale"], json!(null));
        // `resolved_plan` omitted (None) for a non-graph kind.
        assert!(v.get("resolved_plan").is_none());
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
                current_person: None,
                current_project: None,
            }),
            resolved_plan: None,
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
    fn proposal_get_result_encodes_current_person_review_context() {
        // lamplit-desk-alignment: an `update_person` proposal/get carries the
        // CURRENT stored Person as `review_context.current_person`, so the Client
        // renders Current-vs-Proposed and the user sees a field the proposed
        // full-document REPLACE drops (here `note`, present in current but absent
        // from the proposed payload — ADR-0016, ADR-0033). Identity is `entity_id`
        // to match the sibling Current structs.
        let r = ProposalGetResult {
            proposal_id: UUID_B.to_string(),
            run_id: UUID_A.to_string(),
            mutation_kind: "update_person".to_string(),
            payload: json!({ "entity_id": UUID_B, "name": "Alice Renamed" }),
            rationale: Some("the user renamed Alice".to_string()),
            review_context: Some(ProposalReviewContext {
                current_journal_entry: None,
                current_person: Some(ProposalReviewCurrentPerson {
                    entity_id: UUID_B.to_string(),
                    name: "Alice".to_string(),
                    note: Some("daycare coordinator".to_string()),
                    aliases: Some(vec!["Al".to_string()]),
                }),
                current_project: None,
            }),
            resolved_plan: None,
            status: "pending".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap()["review_context"],
            json!({
                "current_person": {
                    "entity_id": UUID_B,
                    "name": "Alice",
                    "note": "daycare coordinator",
                    "aliases": ["Al"]
                }
            }),
        );
    }

    #[test]
    fn proposal_review_current_structs_omit_absent_optionals() {
        // Each Current struct's non-identity fields are `skip_serializing_if`
        // (mirroring the TS `S.optional`): an absent optional drops from the wire,
        // so a Person with no note/aliases serializes to just `entity_id`+`name`.
        let person = serde_json::to_value(ProposalReviewCurrentPerson {
            entity_id: UUID_A.to_string(),
            name: "Bob".to_string(),
            note: None,
            aliases: None,
        })
        .unwrap();
        assert_eq!(person, json!({ "entity_id": UUID_A, "name": "Bob" }));

        let project = serde_json::to_value(ProposalReviewCurrentProject {
            entity_id: UUID_A.to_string(),
            name: "Ship API v2".to_string(),
            outcome: None,
            status: Some("active".to_string()),
            note: None,
        })
        .unwrap();
        assert_eq!(
            project,
            json!({ "entity_id": UUID_A, "name": "Ship API v2", "status": "active" }),
        );
    }

    #[test]
    fn proposal_get_result_encodes_resolved_plan() {
        // The `apply_intent_graph` resolved plan (ADR-0042): a flat per-node shape
        // keyed by disposition — `create` carries only the label; `reuse` adds
        // `entity_id`; `ambiguous` adds `candidates`. `entity_id`/`candidates` are
        // omitted on the dispositions that do not carry them.
        let r = ProposalGetResult {
            proposal_id: UUID_B.to_string(),
            run_id: UUID_A.to_string(),
            mutation_kind: "apply_intent_graph".to_string(),
            payload: json!({}),
            rationale: None,
            review_context: None,
            resolved_plan: Some(vec![
                ResolvedNode {
                    handle: "@rodeo".to_string(),
                    r#type: "todo".to_string(),
                    disposition: "create".to_string(),
                    label: "Figure out the Rodeo side".to_string(),
                    entity_id: None,
                    candidates: None,
                    // A create node MAY carry advisory near_matches (ADR-0042 amendment).
                    near_matches: Some(vec![ResolvedNodeCandidate {
                        entity_id: UUID_A.to_string(),
                        label: "Figure out Rodeo".to_string(),
                    }]),
                },
                ResolvedNode {
                    handle: "@leadads".to_string(),
                    r#type: "project".to_string(),
                    disposition: "reuse".to_string(),
                    label: "Lead Ads".to_string(),
                    entity_id: Some(UUID_A.to_string()),
                    candidates: None,
                    near_matches: None,
                },
                ResolvedNode {
                    handle: "@morris".to_string(),
                    r#type: "person".to_string(),
                    disposition: "ambiguous".to_string(),
                    label: "Morris".to_string(),
                    entity_id: None,
                    candidates: Some(vec![
                        ResolvedNodeCandidate {
                            entity_id: UUID_A.to_string(),
                            label: "Morris".to_string(),
                        },
                        ResolvedNodeCandidate {
                            entity_id: UUID_B.to_string(),
                            label: "Morris".to_string(),
                        },
                    ]),
                    near_matches: None,
                },
            ]),
            status: "pending".to_string(),
        };
        let v = serde_json::to_value(&r).unwrap();
        let plan = v["resolved_plan"].as_array().expect("resolved_plan array");
        assert_eq!(plan.len(), 3);
        // create node: label only, no entity_id / candidates keys — but its advisory
        // near_matches DO serialize (ADR-0042 amendment).
        assert_eq!(plan[0]["disposition"], "create");
        assert_eq!(plan[0]["type"], "todo");
        assert!(plan[0].get("entity_id").is_none());
        assert!(plan[0].get("candidates").is_none());
        assert_eq!(plan[0]["near_matches"].as_array().unwrap().len(), 1);
        assert_eq!(plan[0]["near_matches"][0]["entity_id"], UUID_A);
        // reuse node: carries entity_id, no candidates, no near_matches.
        assert_eq!(plan[1]["disposition"], "reuse");
        assert_eq!(plan[1]["entity_id"], UUID_A);
        assert!(plan[1].get("candidates").is_none());
        assert!(plan[1].get("near_matches").is_none());
        // ambiguous node: carries candidates, no entity_id, no near_matches.
        assert_eq!(plan[2]["disposition"], "ambiguous");
        assert!(plan[2].get("entity_id").is_none());
        assert_eq!(plan[2]["candidates"].as_array().unwrap().len(), 2);
        assert_eq!(plan[2]["candidates"][0]["entity_id"], UUID_A);
        assert!(plan[2].get("near_matches").is_none());
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
    fn proposal_decide_params_decodes_decisions_vector() {
        // The `apply_intent_graph` shape (ADR-0042): a vector of per-node
        // decisions keyed by handle, mirroring the TS `NodeDecision`. A plain
        // accept node, a reject node, an `entity_id` override, and an
        // `edited_fields` correction — the four per-node forms.
        let wire = json!({
            "proposal_id": UUID_B,
            "decision": "accept",
            "decisions": [
                { "handle": "@je", "decision": "accept" },
                { "handle": "@leadads", "decision": "reject" },
                { "handle": "@morris", "decision": "accept", "entity_id": UUID_A },
                { "handle": "@rodeo", "decision": "accept", "edited_fields": { "title": "Fixed" } }
            ],
            "decision_idempotency_key": "k-graph"
        });
        let p: ProposalDecideParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.decision, "accept");
        assert_eq!(p.decision_idempotency_key.as_deref(), Some("k-graph"));
        let decisions = p.decisions.expect("decisions vector present");
        assert_eq!(decisions.len(), 4);

        assert_eq!(decisions[0].handle, "@je");
        assert_eq!(decisions[0].decision, "accept");
        assert!(decisions[0].entity_id.is_none());
        assert!(decisions[0].edited_fields.is_none());

        assert_eq!(decisions[1].handle, "@leadads");
        assert_eq!(decisions[1].decision, "reject");

        assert_eq!(decisions[2].handle, "@morris");
        assert_eq!(decisions[2].entity_id.as_deref(), Some(UUID_A));

        assert_eq!(decisions[3].handle, "@rodeo");
        assert_eq!(
            decisions[3].edited_fields.as_ref().unwrap()["title"],
            json!("Fixed")
        );
    }

    #[test]
    fn proposal_decide_params_omits_decisions_when_absent() {
        // Non-graph proposal kinds send no `decisions` vector; absent decodes
        // to `None` (the graph cascade treats a missing vector as accept-all).
        let bare: ProposalDecideParams =
            serde_json::from_value(json!({ "proposal_id": UUID_B, "decision": "accept" })).unwrap();
        assert!(bare.decisions.is_none());
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
    fn thread_titled_notification_encodes_full_shape() {
        let n = ThreadTitledNotification {
            thread_id: UUID_A.to_string(),
            title: "Budget planning for Q3".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&n).unwrap(),
            json!({ "thread_id": UUID_A, "title": "Budget planning for Q3" }),
        );
    }

    #[test]
    fn provider_connected_notification_encodes_full_shape() {
        let n = ProviderConnectedNotification {
            provider: "openai-codex".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&n).unwrap(),
            json!({ "provider": "openai-codex" }),
        );
    }

    #[test]
    fn observation_record_params_decodes_batch_and_evidence() {
        let wire = json!({
            "observations": [
                {
                    "schema_key": "bodyweight",
                    "occurred_at": "2026-06-01T07:30:00",
                    "ended_at": "2026-06-01T07:35:00",
                    "values": { "kg": 72.4 },
                    "note": "after morning run"
                },
                {
                    "schema_key": "bodyweight",
                    "occurred_at": "2026-06-02T07:30:00",
                    "values": { "kg": 72.1 }
                }
            ],
            "evidence": {
                "journal_entry_id": UUID_A
            }
        });
        let p: ObservationRecordParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.observations.len(), 2);
        assert_eq!(
            p.observations[0].ended_at.as_deref(),
            Some("2026-06-01T07:35:00")
        );
        assert_eq!(p.observations[0].values["kg"], json!(72.4));
        assert_eq!(p.observations[0].note.as_deref(), Some("after morning run"));
        assert!(p.observations[1].ended_at.is_none());
        let evidence = p.evidence.expect("evidence present");
        assert_eq!(evidence.journal_entry_id.as_deref(), Some(UUID_A));
        assert_eq!(evidence.message_id, None);
    }

    #[test]
    fn observation_update_params_decodes_source_free_replacement() {
        let wire = json!({
            "observation_id": UUID_A,
            "observation": {
                "occurred_at": "2026-06-03T07:30:00",
                "ended_at": "2026-06-03T07:35:00",
                "values": { "kg": 71.8 },
                "note": "corrected"
            }
        });
        let p: ObservationUpdateParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.observation_id.to_string(), UUID_A);
        assert_eq!(p.observation.ended_at.as_deref(), Some("2026-06-03T07:35:00"));
        assert_eq!(p.observation.values["kg"], json!(71.8));
        assert_eq!(p.observation.note.as_deref(), Some("corrected"));
    }

    #[test]
    fn observation_update_params_rejects_malformed_observation_id() {
        let wire = json!({
            "observation_id": "not-a-uuid",
            "observation": {
                "occurred_at": "2026-06-03T07:30:00",
                "values": { "kg": 71.8 }
            }
        });
        assert!(serde_json::from_value::<ObservationUpdateParams>(wire).is_err());
    }

    #[test]
    fn observation_query_params_decodes_omitted_filters() {
        let p: ObservationQueryParams = serde_json::from_value(json!({})).unwrap();
        assert!(p.schema_keys.is_none());
        assert!(p.from.is_none());
        assert!(p.to.is_none());
        assert!(p.source_entity_id.is_none());
        assert!(p.source_message_id.is_none());
        assert!(p.related_entity_id.is_none());
        assert!(p.limit.is_none());
    }

    #[test]
    fn observation_results_encode_expected_shapes() {
        let record = ObservationRecordResult {
            observation_ids: vec![UUID_A.to_string(), UUID_B.to_string()],
        };
        assert_eq!(
            serde_json::to_value(&record).unwrap(),
            json!({ "observation_ids": [UUID_A, UUID_B] }),
        );
        let update = ObservationUpdateResult {
            observation_id: UUID_A.to_string(),
        };
        assert_eq!(
            serde_json::to_value(&update).unwrap(),
            json!({ "observation_id": UUID_A }),
        );

        let query = ObservationQueryResult {
            observations: vec![ObservationRow {
                id: UUID_A.to_string(),
                schema_key: "bodyweight".to_string(),
                schema_version: 1,
                occurred_at: "2026-06-01T07:30:00".to_string(),
                ended_at: None,
                values: json!({ "kg": 72.4 }),
                note: None,
                source: None,
                created_at: 1_700_000_000_000,
                updated_at: 1_700_000_000_000,
            }],
        };
        let row = &serde_json::to_value(&query).unwrap()["observations"][0];
        assert_eq!(row["ended_at"], json!(null));
        assert_eq!(row["note"], json!(null));
        assert_eq!(row["source"], json!(null));
    }

    #[test]
    fn thread_get_params_decodes_thread_id() {
        let wire = json!({ "thread_id": UUID_A });
        let p: ThreadGetParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.thread_id.to_string(), UUID_A);
        // A non-UUID thread_id is rejected at decode → invalid_params (ADR-0029).
        assert!(serde_json::from_value::<ThreadGetParams>(json!({ "thread_id": "nope" })).is_err());
    }

    #[test]
    fn thread_rename_params_decodes_thread_id_and_title() {
        let wire = json!({ "thread_id": UUID_A, "title": "Renamed thread" });
        let p: ThreadRenameParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.thread_id.to_string(), UUID_A);
        assert_eq!(p.title, "Renamed thread");
        // A non-UUID thread_id is rejected at decode → invalid_params (ADR-0029).
        assert!(
            serde_json::from_value::<ThreadRenameParams>(
                json!({ "thread_id": "nope", "title": "x" })
            )
            .is_err()
        );
    }

    #[test]
    fn thread_archive_params_decodes_thread_id() {
        let wire = json!({ "thread_id": UUID_A });
        let p: ThreadArchiveParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.thread_id.to_string(), UUID_A);
        assert!(
            serde_json::from_value::<ThreadArchiveParams>(json!({ "thread_id": "nope" })).is_err()
        );
    }

    #[test]
    fn thread_unarchive_params_decodes_thread_id() {
        let wire = json!({ "thread_id": UUID_A });
        let p: ThreadUnarchiveParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.thread_id.to_string(), UUID_A);
        assert!(
            serde_json::from_value::<ThreadUnarchiveParams>(json!({ "thread_id": "nope" }))
                .is_err()
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
                    arg,
                } => {
                    assert_eq!(tool_call_id, "tc_01");
                    assert_eq!(name, "read_thread");
                    assert_eq!(*got, status);
                    assert_eq!(*arg, None, "argless tool omits arg");
                }
                other => panic!("expected ToolCall, got {other:?}"),
            }
            // No `arg` key when absent (skip_serializing_if).
            assert_eq!(serde_json::to_value(&ev).unwrap(), wire);
        }
    }

    #[test]
    fn run_event_tool_call_round_trips_with_arg() {
        let wire = json!({
            "kind": "tool_call",
            "tool_call_id": "tc_02",
            "name": "search_entities",
            "status": "started",
            "arg": "Lev",
        });
        let ev: RunEvent = serde_json::from_value(wire.clone()).unwrap();
        match &ev {
            RunEvent::ToolCall { name, arg, .. } => {
                assert_eq!(name, "search_entities");
                assert_eq!(arg.as_deref(), Some("Lev"));
            }
            other => panic!("expected ToolCall, got {other:?}"),
        }
        assert_eq!(serde_json::to_value(&ev).unwrap(), wire);
    }

    // --- Tool Protocol (ADR-0018): the duplex frames mirror the TS shapes. ---

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

    // --- model/catalog (round-trip, ADR-0024): `input` is a string array. ---

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
                    "input": ["text", "image"]
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

    #[test]
    fn message_search_params_rejects_missing_and_non_string_query() {
        assert!(serde_json::from_value::<MessageSearchParams>(json!({})).is_err());
        assert!(serde_json::from_value::<MessageSearchParams>(json!({ "query": 42 })).is_err());
    }

    #[test]
    fn message_search_result_encodes_hits_wrapper_and_empty() {
        let one = MessageSearchResult {
            hits: vec![MessageHit {
                message_id: UUID_A.to_string(),
                thread_id: UUID_B.to_string(),
                run_id: UUID_RUN.to_string(),
                role: "user".to_string(),
                snippet: "hi".to_string(),
                thread_title: "T".to_string(),
                created_at: 1,
            }],
        };
        let value = serde_json::to_value(&one).unwrap();
        assert_eq!(value["hits"].as_array().unwrap().len(), 1);
        assert_eq!(value["hits"][0]["role"], json!("user"));

        let empty = MessageSearchResult { hits: vec![] };
        assert_eq!(serde_json::to_value(&empty).unwrap(), json!({ "hits": [] }));
    }
}

/// Non-payload wire-message parity fixtures (the contract-test leg ADR-0009 was
/// originally written about, finished as-built). The agent-proposable
/// *payloads* are gated by `propose_workspace_mutation.rs`'s schema-vs-schema
/// fixtures; this module gates the ~31 plain serde wire structs INSTANCE-based:
/// Core serializes one canonical instance per Serialize-capable message to a
/// committed fixture (ground truth — the exact bytes the real serde path emits),
/// and the `@inkstone/contract` TS gate decodes + re-encodes that fixture against
/// the hand-authored Effect Schema. A field added/omitted/mistyped on EITHER side
/// turns the TS gate red against the one shared artifact.
///
/// Deserialize-only params (the 13 `*Params`, `WorkerStdout`, `NodeDecision`) are
/// the OTHER half (grilling Q2): Core never serializes them in production, so
/// their fixtures are HAND-AUTHORED canonical wire JSON committed under
/// `fixtures/structs/authored/`. This module's `authored_fixtures_parse` self-lock
/// asserts each one round-trips through the Rust `Deserialize` (the producer-side
/// check); the TS gate decodes them against the Effect Schema (the consumer side).
///
/// Like the payload gate, the emitter MUST live inline in `src/` (not
/// `crates/core/tests/`): `crates/core` is binary-only, so these `pub(crate)`
/// types are unreachable from an integration-test crate. The self-lock embeds the
/// committed fixtures via `include_str!` (compile-time) to dodge a disk-read race
/// with the concurrent writer test.
#[cfg(test)]
mod parity_fixtures {
    use super::*;
    use std::path::Path;

    // Shared id constants — identical spelling to the values baked into the
    // committed fixtures, so the round-trip comparison is exact.
    const UUID_A: &str = "0190d3c1-0000-7000-8000-000000000001";
    const UUID_B: &str = "0190d3c1-0000-7000-8000-000000000002";
    const UUID_RUN: &str = "0190d3c1-0000-7000-8000-000000000003";

    /// The Serialize-capable messages Core EMITS as fixtures. Each entry is
    /// `(filename, serialized-JSON)`: the writer dumps the JSON to
    /// `fixtures/structs/emitted/<filename>`, and the self-lock re-dumps the same
    /// instance and asserts it equals the committed bytes. ONE source of truth for
    /// both halves — the writer can never drift from what the lock checks.
    ///
    /// Each instance is serialized through the REAL serde path, so the fixture is
    /// ground-truth wire bytes. A struct with optional / `skip_serializing_if`
    /// fields gets a maximal entry (every optional populated, so the gate
    /// exercises those fields) plus a `.bare`/`.omitted` companion (the None /
    /// empty branch). Leaf sub-structs (`ThreadSummary`, `EntityRow`,
    /// `MessageView`, `ModelInfo`, …) are covered TRANSITIVELY inside their
    /// wrapper result here.
    fn emitted_fixtures() -> Vec<(&'static str, String)> {
        let pretty = |v: serde_json::Value| {
            let mut s = serde_json::to_string_pretty(&v).expect("fixture serializes");
            s.push('\n');
            s
        };
        // Each entry serializes one instance through the real serde path.
        macro_rules! fx {
            ($file:literal, $val:expr) => {
                (
                    $file,
                    pretty(serde_json::to_value(&$val).expect(concat!($file, " serializes"))),
                )
            };
        }

        vec![
            // ── run/subscribe, run/cancel ──
            fx!(
                "subscribe_result.json",
                SubscribeResult {
                    run_id: UUID_RUN.to_string(),
                    status: "parked".to_string(),
                }
            ),
            fx!(
                "run_cancel_result.json",
                RunCancelResult {
                    outcome: "accepted".to_string(),
                }
            ),
            fx!(
                "run_retry_result.json",
                RunRetryResult {
                    outcome: "accepted".to_string(),
                }
            ),
            // ── proposal/* results + notifications ──
            // ProposalGetResult maximal: rationale + review_context + resolved_plan
            // all present (covers ResolvedNode create/reuse/ambiguous + near_matches,
            // ResolvedNodeCandidate, ProposalReviewContext, ProposalReviewCurrentJournalEntry,
            // JournalEntryBodyNode both variants — all transitively).
            fx!(
                "proposal_get_result.json",
                ProposalGetResult {
                    proposal_id: UUID_B.to_string(),
                    run_id: UUID_RUN.to_string(),
                    mutation_kind: "apply_intent_graph".to_string(),
                    payload: serde_json::json!({}),
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
                            ],
                        }),
                        current_person: None,
                        current_project: None,
                    }),
                    resolved_plan: Some(vec![
                        ResolvedNode {
                            handle: "@rodeo".to_string(),
                            r#type: "todo".to_string(),
                            disposition: "create".to_string(),
                            label: "Figure out the Rodeo side".to_string(),
                            entity_id: None,
                            candidates: None,
                            near_matches: Some(vec![ResolvedNodeCandidate {
                                entity_id: UUID_A.to_string(),
                                label: "Figure out Rodeo".to_string(),
                            }]),
                        },
                        ResolvedNode {
                            handle: "@leadads".to_string(),
                            r#type: "project".to_string(),
                            disposition: "reuse".to_string(),
                            label: "Lead Ads".to_string(),
                            entity_id: Some(UUID_A.to_string()),
                            candidates: None,
                            near_matches: None,
                        },
                        ResolvedNode {
                            handle: "@morris".to_string(),
                            r#type: "person".to_string(),
                            disposition: "ambiguous".to_string(),
                            label: "Morris".to_string(),
                            entity_id: None,
                            candidates: Some(vec![ResolvedNodeCandidate {
                                entity_id: UUID_B.to_string(),
                                label: "Morris".to_string(),
                            }]),
                            near_matches: None,
                        },
                    ]),
                    status: "pending".to_string(),
                }
            ),
            // ProposalGetResult bare: a single-entity kind — rationale null, no
            // review_context, no resolved_plan (omitted).
            fx!(
                "proposal_get_result.bare.json",
                ProposalGetResult {
                    proposal_id: UUID_B.to_string(),
                    run_id: UUID_RUN.to_string(),
                    mutation_kind: "create_journal_entry".to_string(),
                    payload: serde_json::json!({}),
                    rationale: None,
                    review_context: None,
                    resolved_plan: None,
                    status: "pending".to_string(),
                }
            ),
            fx!(
                "proposal_decide_result.json",
                ProposalDecideResult {
                    status: "accepted".to_string(),
                    entity_id: Some(UUID_A.to_string()),
                }
            ),
            fx!(
                "proposal_decide_result.bare.json",
                ProposalDecideResult {
                    status: "rejected".to_string(),
                    entity_id: None,
                }
            ),
            fx!(
                "proposal_pending_notification.json",
                ProposalPendingNotification {
                    run_id: UUID_RUN.to_string(),
                    proposal_id: UUID_B.to_string(),
                }
            ),
            fx!(
                "proposal_changed_notification.json",
                ProposalChangedNotification {
                    run_id: UUID_RUN.to_string(),
                    proposal_id: UUID_B.to_string(),
                    status: "accepted".to_string(),
                }
            ),
            fx!(
                "thread_titled_notification.json",
                ThreadTitledNotification {
                    thread_id: UUID_A.to_string(),
                    title: "Budget planning for Q3".to_string(),
                }
            ),
            fx!(
                "provider_connected_notification.json",
                ProviderConnectedNotification {
                    provider: "openai-codex".to_string(),
                }
            ),
            // ── run/post_message, thread/create, thread/list ──
            fx!(
                "post_message_result.json",
                PostMessageResult {
                    run_id: UUID_RUN.to_string(),
                }
            ),
            fx!(
                "thread_create_result.json",
                ThreadCreateResult {
                    thread_id: UUID_A.to_string(),
                    run_id: UUID_RUN.to_string(),
                }
            ),
            fx!(
                "thread_list_result.json",
                ThreadListResult {
                    threads: vec![ThreadSummary {
                        id: UUID_A.to_string(),
                        title: "Morning brain dump".to_string(),
                        last_activity_at: 1_700_000_000_000,
                    }],
                }
            ),
            // thread/list_archived (ADR-0052): the inverse list, reusing
            // ThreadListResult. A distinct id/title so it can't be mistaken for
            // the active fixture above.
            fx!(
                "thread_list_result.archived.json",
                ThreadListResult {
                    threads: vec![ThreadSummary {
                        id: UUID_B.to_string(),
                        title: "Archived plans".to_string(),
                        last_activity_at: 1_700_000_000_000,
                    }],
                }
            ),
            // ── thread/rename, thread/archive, thread/unarchive (ADR-0052) ──
            // The shared ack echoing the affected thread_id.
            fx!(
                "thread_mutate_result.json",
                ThreadMutateResult {
                    thread_id: UUID_A.to_string(),
                }
            ),
            // ── run/get_history ──
            fx!(
                "run_history_result.json",
                RunHistoryResult {
                    runs: vec![RunHistoryItem {
                        run_id: UUID_RUN.to_string(),
                        thread_id: UUID_A.to_string(),
                        title: "Morning brain dump".to_string(),
                        kind: "proposal_decided".to_string(),
                        at: 1_700_000_000_000,
                    }],
                }
            ),
            // ── recurrence/preview (continuing + ended companion) ──
            // Maximal: the series continues, both dates present.
            fx!(
                "recurrence_preview_result.json",
                RecurrencePreviewResult {
                    ended: false,
                    defer_at: Some("2026-07-08T00:00:00".to_string()),
                    due_at: Some("2026-07-15T00:00:00".to_string()),
                }
            ),
            // Ended: no successor — both dates omitted (skip_serializing_if None).
            fx!(
                "recurrence_preview_result.ended.json",
                RecurrencePreviewResult {
                    ended: true,
                    defer_at: None,
                    due_at: None,
                }
            ),
            // ── observation/* (ADR-0053) ──
            fx!(
                "observation_record_result.json",
                ObservationRecordResult {
                    observation_ids: vec![UUID_A.to_string(), UUID_B.to_string()],
                }
            ),
            fx!(
                "observation_update_result.json",
                ObservationUpdateResult {
                    observation_id: UUID_A.to_string(),
                }
            ),
            // Maximal row: nullable fields populated, opaque values present, and
            // an entity source using the created_from relation.
            fx!(
                "observation_query_result.json",
                ObservationQueryResult {
                    observations: vec![ObservationRow {
                        id: UUID_A.to_string(),
                        schema_key: "bodyweight".to_string(),
                        schema_version: 1,
                        occurred_at: "2026-06-01T07:30:00".to_string(),
                        ended_at: Some("2026-06-01T07:35:00".to_string()),
                        values: serde_json::json!({ "kg": 72.4 }),
                        note: Some("after morning run".to_string()),
                        source: Some(ObservationSourceView {
                            source_entity_id: Some(UUID_B.to_string()),
                            source_message_id: None,
                            relation: "created_from".to_string(),
                        }),
                        created_at: 1_700_000_000_000,
                        updated_at: 1_700_000_000_001,
                    }],
                }
            ),
            // Message-source companion: exercises source_message_id without
            // violating observation_sources' exactly-one source invariant.
            fx!(
                "observation_query_result.message_source.json",
                ObservationQueryResult {
                    observations: vec![ObservationRow {
                        id: UUID_A.to_string(),
                        schema_key: "bodyweight".to_string(),
                        schema_version: 1,
                        occurred_at: "2026-06-01T07:30:00".to_string(),
                        ended_at: Some("2026-06-01T07:35:00".to_string()),
                        values: serde_json::json!({ "kg": 72.4 }),
                        note: Some("after morning run".to_string()),
                        source: Some(ObservationSourceView {
                            source_entity_id: None,
                            source_message_id: Some(UUID_RUN.to_string()),
                            relation: "evidenced_by".to_string(),
                        }),
                        created_at: 1_700_000_000_000,
                        updated_at: 1_700_000_000_001,
                    }],
                }
            ),
            // Bare row: nullable result fields are explicit nulls, not omitted.
            fx!(
                "observation_query_result.bare.json",
                ObservationQueryResult {
                    observations: vec![ObservationRow {
                        id: UUID_B.to_string(),
                        schema_key: "bodyweight".to_string(),
                        schema_version: 1,
                        occurred_at: "2026-06-02T07:30:00".to_string(),
                        ended_at: None,
                        values: serde_json::json!({ "kg": 72.1 }),
                        note: None,
                        source: None,
                        created_at: 1_700_000_000_000,
                        updated_at: 1_700_000_000_000,
                    }],
                }
            ),
            // observation/get_history: a maximal seq-1 revision (every Option
            // populated, incl. proposal_id) plus a seq-2 user-correction revision
            // whose ended_at/note/proposal_id are explicit nulls — the null-branch
            // serialization is the risk this fixture pins.
            fx!(
                "observation_get_history_result.json",
                ObservationGetHistoryResult {
                    revisions: vec![
                        ObservationRevisionView {
                            seq: 1,
                            schema_key: "bodyweight".to_string(),
                            schema_version: 1,
                            occurred_at: "2026-06-01T07:30:00".to_string(),
                            ended_at: Some("2026-06-01T07:35:00".to_string()),
                            values: serde_json::json!({ "kg": 72.4 }),
                            note: Some("after morning run".to_string()),
                            proposal_id: Some(UUID_B.to_string()),
                            created_at: 1_700_000_000_000,
                        },
                        ObservationRevisionView {
                            seq: 2,
                            schema_key: "bodyweight".to_string(),
                            schema_version: 1,
                            occurred_at: "2026-06-02T07:35:00".to_string(),
                            ended_at: None,
                            values: serde_json::json!({ "kg": 71.8 }),
                            note: None,
                            proposal_id: None,
                            created_at: 1_700_000_000_001,
                        },
                    ],
                }
            ),
            // ── entity/list (EntityRow maximal + bare, transitively) ──
            // Maximal row: refs + person_refs + source all present (covers
            // ResolvedEntityRef with its optionals, TodoPersonRefView, EntitySourceView
            // message-source branch).
            fx!(
                "entity_list_result.json",
                EntityListResult {
                    entities: vec![EntityRow {
                        id: UUID_A.to_string(),
                        r#type: "todo".to_string(),
                        data: serde_json::json!({ "title": "Buy milk" }),
                        created_at: 1_700_000_000_000,
                        updated_at: 1_700_000_000_001,
                        refs: vec![ResolvedEntityRef {
                            id: UUID_B.to_string(),
                            source_entity_id: UUID_A.to_string(),
                            target_entity_id: UUID_RUN.to_string(),
                            target_entity_type: "project".to_string(),
                            target_title: Some("Lead Ads".to_string()),
                            label_snapshot: Some("Lead Ads".to_string()),
                        }],
                        person_refs: vec![TodoPersonRefView {
                            person_id: UUID_B.to_string(),
                            role: "waiting_on".to_string(),
                        }],
                        source: Some(EntitySourceView {
                            thread_id: Some(UUID_A.to_string()),
                            thread_title: Some("Morning brain dump".to_string()),
                            message_id: Some(UUID_RUN.to_string()),
                            journal_entry_id: None,
                        }),
                    }],
                }
            ),
            // Bare row: no refs, no person_refs, no source — all omitted
            // (skip_serializing_if Vec::is_empty / Option::is_none). The
            // EntitySourceView journal-entry branch is covered here? No — covered by
            // a dedicated entry below to exercise that exactly-one-kind branch.
            fx!(
                "entity_list_result.bare.json",
                EntityListResult {
                    entities: vec![EntityRow {
                        id: UUID_A.to_string(),
                        r#type: "media".to_string(),
                        data: serde_json::json!({ "title": "Docs", "medium": "link", "state": "backlog" }),
                        created_at: 1_700_000_000_000,
                        updated_at: 1_700_000_000_000,
                        refs: vec![],
                        person_refs: vec![],
                        source: None,
                    }],
                }
            ),
            // EntitySourceView journal-entry branch (the other exactly-one-kind arm):
            // a row whose source carries only journal_entry_id.
            fx!(
                "entity_list_result.je_source.json",
                EntityListResult {
                    entities: vec![EntityRow {
                        id: UUID_A.to_string(),
                        r#type: "todo".to_string(),
                        data: serde_json::json!({ "title": "Email Alice" }),
                        created_at: 1_700_000_000_000,
                        updated_at: 1_700_000_000_000,
                        refs: vec![],
                        person_refs: vec![],
                        source: Some(EntitySourceView {
                            thread_id: None,
                            thread_title: None,
                            message_id: None,
                            journal_entry_id: Some(UUID_B.to_string()),
                        }),
                    }],
                }
            ),
            // ── entity/backlinks (ADR-0050) ──
            // Maximal result: mentioned_in carries a journal_entry EntityRow with
            // non-empty refs (a ResolvedEntityRef incl. its optionals) + a message
            // source (EntitySourceView), mirroring the entity_list_result.json
            // maximal row so EntityRow coverage carries; linked_todos carries a todo
            // EntityRow with non-empty person_refs. Both arrays always present.
            fx!(
                "entity_backlinks_result.json",
                EntityBacklinksResult {
                    mentioned_in: vec![EntityRow {
                        id: UUID_A.to_string(),
                        r#type: "journal_entry".to_string(),
                        data: serde_json::json!({ "title": "Morning brain dump" }),
                        created_at: 1_700_000_000_000,
                        updated_at: 1_700_000_000_001,
                        refs: vec![ResolvedEntityRef {
                            id: UUID_B.to_string(),
                            source_entity_id: UUID_A.to_string(),
                            target_entity_id: UUID_RUN.to_string(),
                            target_entity_type: "project".to_string(),
                            target_title: Some("Lead Ads".to_string()),
                            label_snapshot: Some("Lead Ads".to_string()),
                        }],
                        person_refs: vec![],
                        source: Some(EntitySourceView {
                            thread_id: Some(UUID_A.to_string()),
                            thread_title: Some("Morning brain dump".to_string()),
                            message_id: Some(UUID_RUN.to_string()),
                            journal_entry_id: None,
                        }),
                    }],
                    linked_todos: vec![EntityRow {
                        id: UUID_B.to_string(),
                        r#type: "todo".to_string(),
                        data: serde_json::json!({ "title": "Buy milk" }),
                        created_at: 1_700_000_000_000,
                        updated_at: 1_700_000_000_001,
                        refs: vec![],
                        person_refs: vec![TodoPersonRefView {
                            person_id: UUID_A.to_string(),
                            role: "waiting_on".to_string(),
                        }],
                        source: None,
                    }],
                }
            ),
            // ── entity/mutate ──
            fx!(
                "entity_mutate_result.json",
                EntityMutateResult {
                    entity_id: Some(UUID_A.to_string()),
                }
            ),
            fx!(
                "entity_mutate_result.bare.json",
                EntityMutateResult { entity_id: None }
            ),
            // ── journal_entry/rescan (ADR-0042) ──
            fx!(
                "journal_entry_rescan_result.json",
                JournalEntryRescanResult {
                    run_id: UUID_RUN.to_string(),
                    thread_id: UUID_B.to_string(),
                }
            ),
            // ── message/search ──
            fx!(
                "message_search_result.json",
                MessageSearchResult {
                    hits: vec![MessageHit {
                        message_id: UUID_A.to_string(),
                        thread_id: UUID_B.to_string(),
                        run_id: UUID_RUN.to_string(),
                        role: "assistant".to_string(),
                        snippet: "…daycare schedule…".to_string(),
                        thread_title: "Planning".to_string(),
                        created_at: 1_700_000_000_000,
                    }],
                }
            ),
            // ── thread/get (MessageView maximal + bare, transitively) ──
            // Maximal: an assistant turn whose ORDERED segments are the screenshot
            // order (ADR-0045) — two tool_call segments (one with arg, one without —
            // covers Segment::ToolCall optional arg), then the decided proposal
            // segment (Segment::Proposal), then a reasoning segment (Segment::Reasoning,
            // ADR-0045 reasoning amendment), then the reply text (Segment::Text). All
            // four Segment variants are thus covered transitively here.
            fx!(
                "thread_get_result.json",
                ThreadGetResult {
                    thread_id: UUID_A.to_string(),
                    title: "Morning brain dump".to_string(),
                    messages: vec![MessageView {
                        id: UUID_B.to_string(),
                        role: "assistant".to_string(),
                        status: "complete".to_string(),
                        run_id: UUID_RUN.to_string(),
                        segments: vec![
                            Segment::ToolCall {
                                name: "search_entities".to_string(),
                                status: "completed".to_string(),
                                arg: Some("Lev".to_string()),
                            },
                            Segment::ToolCall {
                                name: "read_thread".to_string(),
                                status: "completed".to_string(),
                                arg: None,
                            },
                            Segment::Proposal {
                                proposal_id: UUID_A.to_string(),
                                mutation_kind: "apply_intent_graph".to_string(),
                                status: "accepted".to_string(),
                                // The anchor Entity the accepted apply created/updated
                                // (ADR-0044 entity_id amendment) — the decided card
                                // names + deep-links it. Omitted when absent (S.optional).
                                entity_id: Some(UUID_B.to_string()),
                            },
                            Segment::Reasoning {
                                text: "Checking the journal schema…".to_string(),
                                duration_ms: Some(1500),
                            },
                            Segment::Text {
                                text: "Logged.".to_string(),
                            },
                        ],
                    }],
                }
            ),
            // Bare: a user turn — a single text segment.
            fx!(
                "thread_get_result.bare.json",
                ThreadGetResult {
                    thread_id: UUID_A.to_string(),
                    title: "Morning brain dump".to_string(),
                    messages: vec![MessageView {
                        id: UUID_B.to_string(),
                        role: "user".to_string(),
                        status: "complete".to_string(),
                        run_id: UUID_RUN.to_string(),
                        segments: vec![Segment::Text {
                            text: "I bought milk.".to_string(),
                        }],
                    }],
                }
            ),
            // ── provider/status, provider/login_start ──
            fx!(
                "provider_status_result.json",
                ProviderStatusResult {
                    providers: vec![ProviderStatus {
                        id: "openai-codex".to_string(),
                        connected: true,
                    }],
                }
            ),
            fx!(
                "provider_login_start_result.json",
                ProviderLoginStartResult {
                    authorize_url: "https://auth.openai.com/oauth/authorize?x=1".to_string(),
                }
            ),
            // ── model/catalog ──
            fx!(
                "model_catalog_result.json",
                ModelCatalogResult {
                    providers: vec![ProviderModels {
                        id: "openai-codex".to_string(),
                        label: "OpenAI".to_string(),
                        models: vec![ModelInfo {
                            id: "gpt-5.5".to_string(),
                            name: "GPT-5.5".to_string(),
                            reasoning: true,
                            input: vec!["text".to_string(), "image".to_string()],
                        }],
                    }],
                }
            ),
            // ── settings/* (model present + null branch) ──
            fx!(
                "settings_result.json",
                SettingsResult {
                    provider: "openai-codex".to_string(),
                    model: Some("gpt-5.5".to_string()),
                    effort: "high".to_string(),
                }
            ),
            fx!(
                "settings_result.bare.json",
                SettingsResult {
                    provider: "openai-codex".to_string(),
                    model: None,
                    effort: "off".to_string(),
                }
            ),
            // ── slice 4: worker↔core protocol (the surface ADR-0009 was written
            // about). RunEvent (ser+deser) emitted per variant; the tool_call
            // variant gets one fixture per ToolCallStatus value (started carries an
            // arg, completed/error omit it) so the closed status domain is locked. ──
            fx!(
                "run_event.text_delta.json",
                RunEvent::TextDelta {
                    delta: "Bought ".to_string(),
                }
            ),
            fx!(
                "run_event.tool_call.started.json",
                RunEvent::ToolCall {
                    tool_call_id: "tc_01".to_string(),
                    name: "search_entities".to_string(),
                    status: ToolCallStatus::Started,
                    arg: Some("Lev".to_string()),
                }
            ),
            fx!(
                "run_event.tool_call.completed.json",
                RunEvent::ToolCall {
                    tool_call_id: "tc_02".to_string(),
                    name: "read_thread".to_string(),
                    status: ToolCallStatus::Completed,
                    arg: None,
                }
            ),
            fx!(
                "run_event.tool_call.error.json",
                RunEvent::ToolCall {
                    tool_call_id: "tc_03".to_string(),
                    name: "read_thread".to_string(),
                    status: ToolCallStatus::Error,
                    arg: None,
                }
            ),
            fx!("run_event.done.json", RunEvent::Done),
            fx!("run_event.cancelled.json", RunEvent::Cancelled),
            fx!(
                "run_event.error.json",
                RunEvent::Error {
                    message: "boom".to_string(),
                }
            ),
            // reasoning_delta (ADR-0045 reasoning amendment, #202): the thinking
            // delta Core republishes from WorkerStdout::ReasoningDelta.
            fx!(
                "run_event.reasoning_delta.json",
                RunEvent::ReasoningDelta {
                    delta: "Checking the journal schema…".to_string(),
                }
            ),
            // ToolResult (ser-only, Core → Worker): the ok / err arms of the
            // untagged ToolOutcome union (covers AgentToolResult + ToolTextContent +
            // ToolErrorWire transitively).
            fx!(
                "tool_result.ok.json",
                ToolResult {
                    kind: "tool_result",
                    run_id: UUID_RUN.to_string(),
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
                }
            ),
            fx!(
                "tool_result.err.json",
                ToolResult {
                    kind: "tool_result",
                    run_id: UUID_RUN.to_string(),
                    tool_call_id: "tc_01".to_string(),
                    outcome: ToolOutcome::Err {
                        err: ToolErrorWire {
                            code: "tool_not_allowed".to_string(),
                            message: "no".to_string(),
                        },
                    },
                }
            ),
            // WorkerManifest (ser-only, borrowed-lifetime <'a> — owned literals live
            // to the serialize call inside `fx!`). Maximal: resume mode, all THREE
            // ManifestMessage variants (user / assistant-with-tool_calls /
            // tool_result), access_token present, a tool descriptor (covers
            // WorkflowManifest + CoreToolDescriptor + ManifestToolCall transitively).
            fx!(
                "worker_manifest.json",
                WorkerManifest {
                    run_id: UUID_RUN.parse().expect("valid uuid"),
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
                            json_schema: serde_json::json!({ "type": "object" }),
                        }],
                    },
                    prompt: "",
                    messages: vec![
                        ManifestMessage::User { text: "earlier q" },
                        ManifestMessage::Assistant {
                            text: None,
                            tool_calls: Some(vec![ManifestToolCall {
                                id: "tc_1",
                                name: "propose_workspace_mutation",
                                arguments: serde_json::json!({ "mutation_kind": "create_journal_entry" }),
                            }]),
                        },
                        ManifestMessage::ToolResult {
                            tool_call_id: "tc_1",
                            content: "Accepted.",
                            is_error: None,
                        },
                    ],
                    mode: Some("resume"),
                    access_token: Some("tok_abc"),
                }
            ),
            // WorkerManifest bare: fresh start, empty history, no mode / token.
            fx!(
                "worker_manifest.bare.json",
                WorkerManifest {
                    run_id: UUID_RUN.parse().expect("valid uuid"),
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
                }
            ),
        ]
    }

    /// Dump every emitted fixture to `tests/contract/fixtures/structs/emitted/`.
    /// Deterministic (serde sorts object keys; pretty-print + trailing newline), so
    /// CI re-runs it and `git diff --exit-code` is the staleness gate — exactly the
    /// payload gate's contract. CI regenerates ONLY this dir; `authored/` is
    /// hand-maintained and never regenerated.
    #[test]
    fn regenerate_struct_fixtures() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("tests/contract/fixtures/structs/emitted");
        std::fs::create_dir_all(&dir).expect("create emitted fixtures dir");
        for (file, json) in emitted_fixtures() {
            let path = dir.join(file);
            std::fs::write(&path, json).unwrap_or_else(|e| panic!("write {path:?}: {e}"));
        }
    }

    /// Lift CI's `git diff --exit-code` into the test suite so `cargo test` ITSELF
    /// bites on a stale emitted fixture. The committed bytes are EMBEDDED via
    /// `include_str!` (compile-time, NOT a disk read): `regenerate_struct_fixtures`
    /// rewrites the same files and runs concurrently in this binary — a disk read
    /// would race the writer and tear. Both sides parse to `Value` before asserting
    /// (robust to trailing-newline / whitespace), naming the stale file on mismatch.
    #[test]
    fn emitted_fixtures_match_committed() {
        // (filename, committed bytes). `include_str!` resolves relative to this
        // source file (`crates/core/src/protocol.rs`): `../../../tests/contract/…`.
        macro_rules! committed {
            ($($file:literal),+ $(,)?) => {
                &[$((
                    $file,
                    include_str!(concat!(
                        "../../../tests/contract/fixtures/structs/emitted/",
                        $file
                    )),
                )),+]
            };
        }
        let committed: &[(&str, &str)] = committed![
            "subscribe_result.json",
            "run_cancel_result.json",
            "run_retry_result.json",
            "proposal_get_result.json",
            "proposal_get_result.bare.json",
            "proposal_decide_result.json",
            "proposal_decide_result.bare.json",
            "proposal_pending_notification.json",
            "proposal_changed_notification.json",
            "thread_titled_notification.json",
            "provider_connected_notification.json",
            "post_message_result.json",
            "thread_create_result.json",
            "thread_list_result.json",
            "thread_list_result.archived.json",
            "thread_mutate_result.json",
            "run_history_result.json",
            "recurrence_preview_result.json",
            "recurrence_preview_result.ended.json",
            "observation_record_result.json",
            "observation_update_result.json",
            "observation_query_result.json",
            "observation_query_result.message_source.json",
            "observation_query_result.bare.json",
            "observation_get_history_result.json",
            "entity_list_result.json",
            "entity_list_result.bare.json",
            "entity_list_result.je_source.json",
            "entity_backlinks_result.json",
            "entity_mutate_result.json",
            "entity_mutate_result.bare.json",
            "journal_entry_rescan_result.json",
            "message_search_result.json",
            "thread_get_result.json",
            "thread_get_result.bare.json",
            "provider_status_result.json",
            "provider_login_start_result.json",
            "model_catalog_result.json",
            "settings_result.json",
            "settings_result.bare.json",
            "run_event.text_delta.json",
            "run_event.tool_call.started.json",
            "run_event.tool_call.completed.json",
            "run_event.tool_call.error.json",
            "run_event.done.json",
            "run_event.cancelled.json",
            "run_event.error.json",
            "run_event.reasoning_delta.json",
            "tool_result.ok.json",
            "tool_result.err.json",
            "worker_manifest.json",
            "worker_manifest.bare.json",
        ];
        // The embedded table must cover exactly what the writer emits — neither can
        // gain or drop a fixture the other lacks.
        let emitted = emitted_fixtures();
        assert_eq!(
            committed.len(),
            emitted.len(),
            "the embedded fixture table must cover every emitted struct fixture"
        );
        for (file, fresh) in emitted {
            let raw = committed
                .iter()
                .find_map(|(f, raw)| (*f == file).then_some(*raw))
                .unwrap_or_else(|| panic!("embedded fixture table is missing {file}"));
            let committed_value: serde_json::Value = serde_json::from_str(raw)
                .unwrap_or_else(|e| panic!("parse committed fixture {file}: {e}"));
            let fresh_value: serde_json::Value =
                serde_json::from_str(&fresh).expect("fresh fixture parses");
            assert_eq!(
                committed_value, fresh_value,
                "committed emitted fixture {file} is stale; run `cargo test regenerate_struct_fixtures` and commit tests/contract/fixtures/structs/emitted/{file}"
            );
        }
    }

    /// The hand-authored params self-lock (grilling Q2): each Deserialize-only
    /// param's committed fixture must round-trip through the Rust `Deserialize` —
    /// the producer-side half of the gate (Core is the consumer of params in
    /// production, so "Core accepts this shape" is the meaningful Rust check). The
    /// TS gate independently decodes the same file against the Effect Schema. The
    /// fixtures are NEVER regenerated — they are the canonical wire JSON Web sends,
    /// authored by hand. `include_str!` embeds them (no disk read needed; no
    /// concurrent writer for this dir, but kept consistent with the emitted lock).
    #[test]
    fn authored_fixtures_parse() {
        // Each authored param fixture must deserialize through its Rust type — the
        // producer-side half of the gate. A macro keeps each line to the type +
        // file it checks; the TS gate independently decodes the same files. UUID
        // fields are real UUIDs (Rust parses them) though TS types them `S.String`.
        macro_rules! parses {
            ($ty:ty, $file:literal) => {{
                let raw = include_str!(concat!(
                    "../../../tests/contract/fixtures/structs/authored/",
                    $file
                ));
                let _parsed: $ty = serde_json::from_str(raw)
                    .unwrap_or_else(|e| panic!(concat!($file, " must deserialize: {}"), e));
            }};
        }

        parses!(SubscribeParams, "subscribe_params.json");
        parses!(PostMessageParams, "post_message_params.json");
        parses!(RunCancelParams, "run_cancel_params.json");
        parses!(RunRetryParams, "run_retry_params.json");
        parses!(ProposalGetParams, "proposal_get_params.json");
        parses!(ProposalDecideParams, "proposal_decide_params.json");
        parses!(ProposalDecideParams, "proposal_decide_params.edit.json");
        parses!(ProposalDecideParams, "proposal_decide_params.bare.json");
        parses!(ThreadCreateParams, "thread_create_params.json");
        parses!(RunGetHistoryParams, "run_get_history_params.json");
        parses!(RunGetHistoryParams, "run_get_history_params.bare.json");
        parses!(
            RecurrencePreviewParams,
            "recurrence_preview_params.json"
        );
        parses!(
            RecurrencePreviewParams,
            "recurrence_preview_params.bare.json"
        );
        parses!(ObservationRecordParams, "observation_record_params.json");
        parses!(
            ObservationRecordParams,
            "observation_record_params.bare.json"
        );
        parses!(ObservationUpdateParams, "observation_update_params.json");
        parses!(
            ObservationUpdateParams,
            "observation_update_params.bare.json"
        );
        parses!(ObservationQueryParams, "observation_query_params.json");
        parses!(
            ObservationQueryParams,
            "observation_query_params.message_source.json"
        );
        parses!(
            ObservationQueryParams,
            "observation_query_params.bare.json"
        );
        parses!(
            ObservationGetHistoryParams,
            "observation_get_history_params.json"
        );
        parses!(EntityListParams, "entity_list_params.json");
        parses!(EntityBacklinksParams, "entity_backlinks_params.json");
        parses!(EntityMutateParams, "entity_mutate_params.json");
        parses!(JournalEntryRescanParams, "journal_entry_rescan_params.json");
        parses!(MessageSearchParams, "message_search_params.json");
        parses!(ThreadGetParams, "thread_get_params.json");
        parses!(ThreadRenameParams, "thread_rename_params.json");
        parses!(ThreadArchiveParams, "thread_archive_params.json");
        parses!(ThreadUnarchiveParams, "thread_unarchive_params.json");
        parses!(ProviderLoginStartParams, "provider_login_start_params.json");
        parses!(SettingsSetParams, "settings_set_params.json");
        parses!(SettingsSetParams, "settings_set_params.bare.json");

        // WorkerStdout (deser-only): the 5 variants Core reads off the Worker's
        // stdout. Hand-authored because Core never serializes them.
        parses!(WorkerStdout, "worker_stdout.text_delta.json");
        parses!(WorkerStdout, "worker_stdout.done.json");
        parses!(WorkerStdout, "worker_stdout.error.json");
        parses!(WorkerStdout, "worker_stdout.tool_request.json");
        parses!(WorkerStdout, "worker_stdout.reasoning_delta.json");

        // Spot-check the maximal ProposalDecideParams carries every per-node form,
        // so a future fixture edit can't silently drop the rich graph shape.
        let graph: ProposalDecideParams = serde_json::from_str(include_str!(
            "../../../tests/contract/fixtures/structs/authored/proposal_decide_params.json"
        ))
        .unwrap();
        let decisions = graph.decisions.expect("maximal carries a decisions vector");
        assert_eq!(decisions.len(), 4, "all four per-node decision forms present");
    }
}
