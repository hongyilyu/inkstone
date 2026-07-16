// The non-payload struct-parity registry. Unlike the proposable-payload `schemas`
// registry (which the Web codec consumes at RUNTIME and lives in
// `@inkstone/protocol`), this one is TEST-ONLY: it maps each committed fixture to
// the hand-authored Effect Schema both languages must satisfy, and lives here in
// the contract test package.
//
// Two fixture sources, by serde direction (the grilling Q2 decision):
//   - "emitted"  — Core serializes a canonical instance through its real serde
//     path (ground truth). Machine-generated; CI regenerates + `git diff`s them.
//   - "authored" — a Deserialize-only param Core never serializes in production.
//     The fixture is hand-authored canonical wire JSON (the exact shape Web
//     sends); Rust `from_str` is the producer-side check, TS decode the consumer.
//
// One fixture = one wire-message PERMUTATION. A tagged union contributes one
// fixture per variant (all decoding against the one union schema). A struct with
// optional fields contributes a maximal fixture (every optional populated) plus a
// `.bare`/`.omitted` companion (the None branch) — see the Q3 maximal-instance
// convention. Leaf sub-structs are covered TRANSITIVELY inside their parent's
// fixture; they never appear here standalone (they never cross the wire alone).

import {
	EntityBacklinksParams,
	EntityBacklinksResult,
	EntityListParams,
	EntityListResult,
	EntityMutateParams,
	EntityMutateResult,
	JournalEntryRescanParams,
	JournalEntryRescanResult,
	MediaUploadParams,
	MediaUploadResult,
	MessageSearchParams,
	MessageSearchResult,
	ModelCatalogResult,
	ObservationGetHistoryParams,
	ObservationGetHistoryResult,
	ObservationQueryParams,
	ObservationQueryResult,
	ObservationRecordParams,
	ObservationRecordResult,
	ObservationUpdateParams,
	ObservationUpdateResult,
	PostMessageParams,
	PostMessageResult,
	ProposalChangedNotification,
	ProposalDecideParams,
	ProposalDecideResult,
	ProposalGetParams,
	ProposalGetResult,
	ProposalPendingNotification,
	ProviderConfigureParams,
	ProviderConnectedNotification,
	ProviderHelperLine,
	ProviderLoginStartParams,
	ProviderLoginStartResult,
	ProviderStatusResult,
	ProviderTestParams,
	ProviderTestResult,
	RecurrencePreviewParams,
	RecurrencePreviewResult,
	RunCancelParams,
	RunCancelResult,
	RunEvent,
	RunGetHistoryParams,
	RunHistoryResult,
	RunRetryParams,
	RunRetryResult,
	SettingsResult,
	SettingsSetParams,
	SubscribeParams,
	SubscribeResult,
	ThreadArchiveParams,
	ThreadCreateParams,
	ThreadCreateResult,
	ThreadGetParams,
	ThreadGetResult,
	ThreadListResult,
	ThreadMutateResult,
	ThreadRenameParams,
	ThreadTitledNotification,
	ThreadUnarchiveParams,
	ToolResult,
	WorkerManifest,
	WorkerOutbound,
} from "@inkstone/protocol";
import { Schema as S } from "effect";

export type FixtureDir = "emitted" | "authored";

/** The Decision-prose contract (finding F12). NOT a runtime wire type — the
 * human-readable tool_result prose Core writes on a decided Proposal, which the
 * faux worker's matchers (`packages/worker/src/faux/faux-decisions.ts`)
 * machine-parse to reconstruct phase across resumes. Test-only, so the schema
 * lives here (not `@inkstone/protocol`). The worker-side pin
 * (`packages/worker/test/faux/faux-decisions.test.ts`) asserts the matcher
 * literals classify every sample in the fixture. */
const DecisionProse = S.Struct({
	declined_text: S.String,
	accepted_prefix: S.String,
	accepted_examples: S.Array(
		S.Struct({ verb: S.String, kind: S.String, sample: S.String }),
	),
});

export interface FixtureEntry {
	/** The wire message this fixture exercises — the unit the completeness lock
	 * counts. Multiple fixtures (union variants, maximal/bare pairs) share one
	 * message name. */
	readonly message: string;
	/** Filename within the `<dir>` directory (e.g. `post_message_result.json`). */
	readonly file: string;
	/** The Effect Schema both sides must agree on; the fixture decodes against it
	 * and (for round-trip) re-encodes back to itself. `AnyNoContext` =
	 * `Schema<any, any, never>` — the no-requirements form `decodeUnknownSync` /
	 * `encodeUnknownSync` accept (a context-bearing schema can't be run sync). All
	 * protocol schemas are context-free, so this is exact, not a widening. */
	readonly schema: S.Schema.AnyNoContext;
	/** Which `fixtures/structs/<dir>/` the file lives in. */
	readonly dir: FixtureDir;
}

/** Every committed non-payload fixture, paired with its schema + source dir.
 * Grows one slice at a time until all 37 wire messages are covered (14 params +
 * 19 results/notifications + 4 worker↔core protocol). */
export const fixtures: readonly FixtureEntry[] = [
	// ── slice 1: one per source-direction, to exercise the harness end-to-end ──
	{
		message: "PostMessageResult",
		file: "post_message_result.json",
		schema: PostMessageResult,
		dir: "emitted",
	},
	{
		message: "SubscribeParams",
		file: "subscribe_params.json",
		schema: SubscribeParams,
		dir: "authored",
	},

	// ── slice 2: the 13 Deserialize-only params (hand-authored wire JSON) ──
	// Params Core never serializes in production, so the fixture is the exact
	// shape Web sends. Rust `from_str` is the producer-side check (Core accepts
	// it); TS decode is the consumer side. UUID-typed Rust fields require valid
	// UUID strings even though TS types them `S.String`. Optional-bearing params
	// get a `.bare` companion exercising the omitted branch.
	// PostMessageParams: maximal (attachment_ids present, chat-image-attachments
	// slice 2) + bare (omitted).
	{
		message: "PostMessageParams",
		file: "post_message_params.json",
		schema: PostMessageParams,
		dir: "authored",
	},
	{
		message: "PostMessageParams",
		file: "post_message_params.bare.json",
		schema: PostMessageParams,
		dir: "authored",
	},
	{
		message: "RunCancelParams",
		file: "run_cancel_params.json",
		schema: RunCancelParams,
		dir: "authored",
	},
	{
		message: "RunRetryParams",
		file: "run_retry_params.json",
		schema: RunRetryParams,
		dir: "authored",
	},
	{
		message: "ProposalGetParams",
		file: "proposal_get_params.json",
		schema: ProposalGetParams,
		dir: "authored",
	},
	// ProposalDecideParams: maximal (graph accept, all 4 per-node decision forms),
	// the scalar `edit` path, and the bare single-entity accept.
	{
		message: "ProposalDecideParams",
		file: "proposal_decide_params.json",
		schema: ProposalDecideParams,
		dir: "authored",
	},
	{
		message: "ProposalDecideParams",
		file: "proposal_decide_params.edit.json",
		schema: ProposalDecideParams,
		dir: "authored",
	},
	{
		message: "ProposalDecideParams",
		file: "proposal_decide_params.bare.json",
		schema: ProposalDecideParams,
		dir: "authored",
	},
	// ThreadCreateParams: maximal (attachment_ids present, chat-image-attachments
	// slice 2) + bare (omitted).
	{
		message: "ThreadCreateParams",
		file: "thread_create_params.json",
		schema: ThreadCreateParams,
		dir: "authored",
	},
	{
		message: "ThreadCreateParams",
		file: "thread_create_params.bare.json",
		schema: ThreadCreateParams,
		dir: "authored",
	},
	// RunGetHistoryParams: maximal (limit present) + bare (omitted).
	{
		message: "RunGetHistoryParams",
		file: "run_get_history_params.json",
		schema: RunGetHistoryParams,
		dir: "authored",
	},
	{
		message: "RunGetHistoryParams",
		file: "run_get_history_params.bare.json",
		schema: RunGetHistoryParams,
		dir: "authored",
	},
	// RecurrencePreviewParams (#227): maximal (both anchors + end) + bare (one
	// anchor, no end). `recurrence` is opaque (S.Unknown) — the rule's own shape
	// is gated by the payload schemas, not this read param.
	{
		message: "RecurrencePreviewParams",
		file: "recurrence_preview_params.json",
		schema: RecurrencePreviewParams,
		dir: "authored",
	},
	{
		message: "RecurrencePreviewParams",
		file: "recurrence_preview_params.bare.json",
		schema: RecurrencePreviewParams,
		dir: "authored",
	},
	// ObservationRecordParams: maximal batched draft + evidence, and bare
	// omitted optionals. ObservationQueryParams: entity-source + related-entity
	// maximal, a message-source companion, and bare `{}`.
	{
		message: "ObservationRecordParams",
		file: "observation_record_params.json",
		schema: ObservationRecordParams,
		dir: "authored",
	},
	{
		message: "ObservationRecordParams",
		file: "observation_record_params.bare.json",
		schema: ObservationRecordParams,
		dir: "authored",
	},
	{
		message: "ObservationUpdateParams",
		file: "observation_update_params.json",
		schema: ObservationUpdateParams,
		dir: "authored",
	},
	{
		message: "ObservationUpdateParams",
		file: "observation_update_params.bare.json",
		schema: ObservationUpdateParams,
		dir: "authored",
	},
	{
		message: "ObservationQueryParams",
		file: "observation_query_params.json",
		schema: ObservationQueryParams,
		dir: "authored",
	},
	{
		message: "ObservationQueryParams",
		file: "observation_query_params.message_source.json",
		schema: ObservationQueryParams,
		dir: "authored",
	},
	{
		message: "ObservationQueryParams",
		file: "observation_query_params.bare.json",
		schema: ObservationQueryParams,
		dir: "authored",
	},
	{
		message: "ObservationGetHistoryParams",
		file: "observation_get_history_params.json",
		schema: ObservationGetHistoryParams,
		dir: "authored",
	},
	{
		message: "EntityListParams",
		file: "entity_list_params.json",
		schema: EntityListParams,
		dir: "authored",
	},
	{
		message: "EntityBacklinksParams",
		file: "entity_backlinks_params.json",
		schema: EntityBacklinksParams,
		dir: "authored",
	},
	{
		message: "EntityMutateParams",
		file: "entity_mutate_params.json",
		schema: EntityMutateParams,
		dir: "authored",
	},
	{
		message: "JournalEntryRescanParams",
		file: "journal_entry_rescan_params.json",
		schema: JournalEntryRescanParams,
		dir: "authored",
	},
	// MediaUploadParams: maximal (width+height present) + bare (omitted).
	{
		message: "MediaUploadParams",
		file: "media_upload_params.json",
		schema: MediaUploadParams,
		dir: "authored",
	},
	{
		message: "MediaUploadParams",
		file: "media_upload_params.bare.json",
		schema: MediaUploadParams,
		dir: "authored",
	},
	{
		message: "MessageSearchParams",
		file: "message_search_params.json",
		schema: MessageSearchParams,
		dir: "authored",
	},
	{
		message: "ThreadGetParams",
		file: "thread_get_params.json",
		schema: ThreadGetParams,
		dir: "authored",
	},
	// thread/rename, thread/archive, thread/unarchive params (ADR-0052): the
	// shapes Web sends. thread_id is a bare string TS-side (Core UUID-checks).
	{
		message: "ThreadRenameParams",
		file: "thread_rename_params.json",
		schema: ThreadRenameParams,
		dir: "authored",
	},
	{
		message: "ThreadArchiveParams",
		file: "thread_archive_params.json",
		schema: ThreadArchiveParams,
		dir: "authored",
	},
	{
		message: "ThreadUnarchiveParams",
		file: "thread_unarchive_params.json",
		schema: ThreadUnarchiveParams,
		dir: "authored",
	},
	{
		message: "ProviderLoginStartParams",
		file: "provider_login_start_params.json",
		schema: ProviderLoginStartParams,
		dir: "authored",
	},
	// provider/configure params (ADR-0062): the {provider, api_key} shape Web
	// sends to store a static key. Result reuses ProviderStatusResult.
	{
		message: "ProviderConfigureParams",
		file: "provider_configure_params.json",
		schema: ProviderConfigureParams,
		dir: "authored",
	},
	// provider/test params (ADR-0062): the {provider, model} shape Web sends to
	// probe a provider's liveness.
	{
		message: "ProviderTestParams",
		file: "provider_test_params.json",
		schema: ProviderTestParams,
		dir: "authored",
	},
	// SettingsSetParams: maximal (both fields) + bare (both omitted).
	{
		message: "SettingsSetParams",
		file: "settings_set_params.json",
		schema: SettingsSetParams,
		dir: "authored",
	},
	{
		message: "SettingsSetParams",
		file: "settings_set_params.bare.json",
		schema: SettingsSetParams,
		dir: "authored",
	},

	// ── slice 3: the 18 Serialize-capable results + notifications (Core-emitted) ──
	// Core serializes a canonical instance through its real serde path. Maximal
	// fixtures populate every optional (so the gate exercises those fields); a
	// `.bare`/`.je_source` companion covers the omitted / alternate branch. Leaf
	// sub-structs are covered transitively inside their wrapper result.
	{
		message: "SubscribeResult",
		file: "subscribe_result.json",
		schema: SubscribeResult,
		dir: "emitted",
	},
	{
		message: "RunCancelResult",
		file: "run_cancel_result.json",
		schema: RunCancelResult,
		dir: "emitted",
	},
	{
		message: "RunRetryResult",
		file: "run_retry_result.json",
		schema: RunRetryResult,
		dir: "emitted",
	},
	// ProposalGetResult: maximal (rationale + review_context + resolved_plan —
	// covers ResolvedNode/ResolvedNodeCandidate/ProposalReviewContext/JournalEntryBodyNode
	// transitively) + bare (single-entity kind, all optionals omitted).
	{
		message: "ProposalGetResult",
		file: "proposal_get_result.json",
		schema: ProposalGetResult,
		dir: "emitted",
	},
	{
		message: "ProposalGetResult",
		file: "proposal_get_result.bare.json",
		schema: ProposalGetResult,
		dir: "emitted",
	},
	{
		message: "ProposalDecideResult",
		file: "proposal_decide_result.json",
		schema: ProposalDecideResult,
		dir: "emitted",
	},
	{
		message: "ProposalDecideResult",
		file: "proposal_decide_result.bare.json",
		schema: ProposalDecideResult,
		dir: "emitted",
	},
	{
		message: "ProposalPendingNotification",
		file: "proposal_pending_notification.json",
		schema: ProposalPendingNotification,
		dir: "emitted",
	},
	{
		message: "ProposalChangedNotification",
		file: "proposal_changed_notification.json",
		schema: ProposalChangedNotification,
		dir: "emitted",
	},
	{
		message: "ThreadTitledNotification",
		file: "thread_titled_notification.json",
		schema: ThreadTitledNotification,
		dir: "emitted",
	},
	{
		message: "ProviderConnectedNotification",
		file: "provider_connected_notification.json",
		schema: ProviderConnectedNotification,
		dir: "emitted",
	},
	{
		message: "ThreadCreateResult",
		file: "thread_create_result.json",
		schema: ThreadCreateResult,
		dir: "emitted",
	},
	{
		message: "ThreadListResult",
		file: "thread_list_result.json",
		schema: ThreadListResult,
		dir: "emitted",
	},
	// thread/list_archived (ADR-0052) reuses ThreadListResult — a second fixture
	// under the same message key (precedent: RecurrencePreviewResult's two).
	{
		message: "ThreadListResult",
		file: "thread_list_result.archived.json",
		schema: ThreadListResult,
		dir: "emitted",
	},
	{
		message: "RunHistoryResult",
		file: "run_history_result.json",
		schema: RunHistoryResult,
		dir: "emitted",
	},
	// RecurrencePreviewResult (#227): continuing (ended:false, both dates) + ended
	// (ended:true, dates omitted — the skip_serializing_if None branch).
	{
		message: "RecurrencePreviewResult",
		file: "recurrence_preview_result.json",
		schema: RecurrencePreviewResult,
		dir: "emitted",
	},
	{
		message: "RecurrencePreviewResult",
		file: "recurrence_preview_result.ended.json",
		schema: RecurrencePreviewResult,
		dir: "emitted",
	},
	{
		message: "ObservationRecordResult",
		file: "observation_record_result.json",
		schema: ObservationRecordResult,
		dir: "emitted",
	},
	{
		message: "ObservationUpdateResult",
		file: "observation_update_result.json",
		schema: ObservationUpdateResult,
		dir: "emitted",
	},
	// ObservationQueryResult: entity-source row + message-source row + bare null
	// ended_at/note/source.
	{
		message: "ObservationQueryResult",
		file: "observation_query_result.json",
		schema: ObservationQueryResult,
		dir: "emitted",
	},
	{
		message: "ObservationQueryResult",
		file: "observation_query_result.message_source.json",
		schema: ObservationQueryResult,
		dir: "emitted",
	},
	{
		message: "ObservationQueryResult",
		file: "observation_query_result.bare.json",
		schema: ObservationQueryResult,
		dir: "emitted",
	},
	// ObservationGetHistoryResult: a seq-1 revision with every Option populated
	// (incl. proposal_id) + a seq-2 revision exercising the null branches.
	// ObservationRevisionView rides transitively (no standalone fixture).
	{
		message: "ObservationGetHistoryResult",
		file: "observation_get_history_result.json",
		schema: ObservationGetHistoryResult,
		dir: "emitted",
	},
	// EntityListResult: maximal row (refs + person_refs + message-source) + bare
	// row (all omitted) + je_source row (the journal-entry source branch — the
	// other exactly-one-kind arm of EntitySourceView).
	{
		message: "EntityListResult",
		file: "entity_list_result.json",
		schema: EntityListResult,
		dir: "emitted",
	},
	{
		message: "EntityListResult",
		file: "entity_list_result.bare.json",
		schema: EntityListResult,
		dir: "emitted",
	},
	{
		message: "EntityListResult",
		file: "entity_list_result.je_source.json",
		schema: EntityListResult,
		dir: "emitted",
	},
	// EntityBacklinksResult (ADR-0050): maximal — mentioned_in carries a JE row
	// (refs + message-source), linked_todos a Todo row (person_refs). Both arrays
	// always present. EntityRow coverage carries from the entity_list maximal row.
	{
		message: "EntityBacklinksResult",
		file: "entity_backlinks_result.json",
		schema: EntityBacklinksResult,
		dir: "emitted",
	},
	{
		message: "EntityMutateResult",
		file: "entity_mutate_result.json",
		schema: EntityMutateResult,
		dir: "emitted",
	},
	{
		message: "EntityMutateResult",
		file: "entity_mutate_result.bare.json",
		schema: EntityMutateResult,
		dir: "emitted",
	},
	// The shared ack for thread/rename, thread/archive, thread/unarchive (ADR-0052).
	{
		message: "ThreadMutateResult",
		file: "thread_mutate_result.json",
		schema: ThreadMutateResult,
		dir: "emitted",
	},
	{
		message: "JournalEntryRescanResult",
		file: "journal_entry_rescan_result.json",
		schema: JournalEntryRescanResult,
		dir: "emitted",
	},
	{
		message: "MediaUploadResult",
		file: "media_upload_result.json",
		schema: MediaUploadResult,
		dir: "emitted",
	},
	{
		message: "MessageSearchResult",
		file: "message_search_result.json",
		schema: MessageSearchResult,
		dir: "emitted",
	},
	// ThreadGetResult: maximal (a user turn carrying an attachment segment plus an
	// assistant turn whose ordered segments[] cover the remaining Segment variants
	// — tool_call with + without arg, proposal, reasoning, text; all FIVE covered)
	// + bare (user turn, a single text segment). ADR-0045 / ADR-0058.
	{
		message: "ThreadGetResult",
		file: "thread_get_result.json",
		schema: ThreadGetResult,
		dir: "emitted",
	},
	{
		message: "ThreadGetResult",
		file: "thread_get_result.bare.json",
		schema: ThreadGetResult,
		dir: "emitted",
	},
	{
		message: "ProviderStatusResult",
		file: "provider_status_result.json",
		schema: ProviderStatusResult,
		dir: "emitted",
	},
	{
		message: "ProviderLoginStartResult",
		file: "provider_login_start_result.json",
		schema: ProviderLoginStartResult,
		dir: "emitted",
	},
	{
		message: "ModelCatalogResult",
		file: "model_catalog_result.json",
		schema: ModelCatalogResult,
		dir: "emitted",
	},
	// SettingsResult: maximal (model present) + bare (model null — NullOr, so
	// null is valid here, unlike the S.optional params).
	{
		message: "SettingsResult",
		file: "settings_result.json",
		schema: SettingsResult,
		dir: "emitted",
	},
	{
		message: "SettingsResult",
		file: "settings_result.bare.json",
		schema: SettingsResult,
		dir: "emitted",
	},
	// provider/test result (ADR-0062): alive (message omitted, S.optional) + dead
	// (message present).
	{
		message: "ProviderTestResult",
		file: "provider_test_result.json",
		schema: ProviderTestResult,
		dir: "emitted",
	},
	{
		message: "ProviderTestResult",
		file: "provider_test_result.dead.json",
		schema: ProviderTestResult,
		dir: "emitted",
	},

	// ── slice 4: worker↔core protocol — the surface ADR-0009 was written about ──
	// RunEvent (6 variants; tool_call gets one fixture per ToolCallStatus value so
	// the closed status domain is locked, plus reasoning_delta — ADR-0045 reasoning
	// segment, #202), ToolResult (ToolOutcome ok/err arms), WorkerManifest
	// (ManifestMessage 3 variants transitively), WorkerStdout (5 variants,
	// hand-authored — decoded against the TS WorkerOutbound =
	// WorkerRunEvent | ToolRequest union, its exact mirror).
	{
		message: "RunEvent",
		file: "run_event.text_delta.json",
		schema: RunEvent,
		dir: "emitted",
	},
	{
		message: "RunEvent",
		file: "run_event.tool_call.started.json",
		schema: RunEvent,
		dir: "emitted",
	},
	{
		message: "RunEvent",
		file: "run_event.tool_call.completed.json",
		schema: RunEvent,
		dir: "emitted",
	},
	{
		message: "RunEvent",
		file: "run_event.tool_call.error.json",
		schema: RunEvent,
		dir: "emitted",
	},
	{
		message: "RunEvent",
		file: "run_event.done.json",
		schema: RunEvent,
		dir: "emitted",
	},
	{
		message: "RunEvent",
		file: "run_event.cancelled.json",
		schema: RunEvent,
		dir: "emitted",
	},
	{
		message: "RunEvent",
		file: "run_event.error.json",
		schema: RunEvent,
		dir: "emitted",
	},
	{
		message: "RunEvent",
		file: "run_event.reasoning_delta.json",
		schema: RunEvent,
		dir: "emitted",
	},
	{
		message: "ToolResult",
		file: "tool_result.ok.json",
		schema: ToolResult,
		dir: "emitted",
	},
	{
		message: "ToolResult",
		file: "tool_result.err.json",
		schema: ToolResult,
		dir: "emitted",
	},
	{
		message: "WorkerManifest",
		file: "worker_manifest.json",
		schema: WorkerManifest,
		dir: "emitted",
	},
	{
		message: "WorkerManifest",
		file: "worker_manifest.bare.json",
		schema: WorkerManifest,
		dir: "emitted",
	},
	// WorkerStdout: Rust deser-only (5 variants); decoded against the TS
	// WorkerOutbound = WorkerRunEvent | ToolRequest union, its exact 1:1 mirror
	// (RunEvent's Core-synthesized cancelled/tool_call kinds are excluded from
	// WorkerRunEvent). text_delta/reasoning_delta/done/error decode as
	// WorkerRunEvent members; tool_request as the ToolRequest member.
	{
		message: "WorkerStdout",
		file: "worker_stdout.text_delta.json",
		schema: WorkerOutbound,
		dir: "authored",
	},
	{
		message: "WorkerStdout",
		file: "worker_stdout.done.json",
		schema: WorkerOutbound,
		dir: "authored",
	},
	{
		message: "WorkerStdout",
		file: "worker_stdout.error.json",
		schema: WorkerOutbound,
		dir: "authored",
	},
	{
		message: "WorkerStdout",
		file: "worker_stdout.tool_request.json",
		schema: WorkerOutbound,
		dir: "authored",
	},
	{
		message: "WorkerStdout",
		file: "worker_stdout.reasoning_delta.json",
		schema: WorkerOutbound,
		dir: "authored",
	},
	// ProviderHelperLine: Rust deser-only (3 variants) — one NDJSON line of the
	// Provider Helper's stdout (ADR-0023). Hand-authored because Core only ever
	// deserializes them (the WorkerStdout situation); the same files are parsed
	// by the Rust self-lock in crates/core/src/protocol.rs.
	{
		message: "ProviderHelperLine",
		file: "provider_helper_line.authorize_url.json",
		schema: ProviderHelperLine,
		dir: "authored",
	},
	{
		message: "ProviderHelperLine",
		file: "provider_helper_line.credentials.json",
		schema: ProviderHelperLine,
		dir: "authored",
	},
	{
		message: "ProviderHelperLine",
		file: "provider_helper_line.error.json",
		schema: ProviderHelperLine,
		dir: "authored",
	},

	// ── Decision prose (finding F12): the machine-parsed tool_result prose
	// contract between Core's accept/reject renderers and the faux worker's
	// matchers. Emitted through the real renderers, so a Rust copy edit reds
	// both the Rust stale-fixture lock and the worker's matcher pin. ──
	{
		message: "DecisionProse",
		file: "decision_prose.json",
		schema: DecisionProse,
		dir: "emitted",
	},
];

/** The hand-maintained canonical set of in-scope wire messages (41 at
 * completion; grows per slice). The completeness lock pins this equal to the
 * distinct `message` values in {@link fixtures}, so a message can't be covered
 * without being declared, nor declared without a fixture. */
export const CANONICAL_MESSAGES: readonly string[] = [
	// slice 1
	"PostMessageResult",
	"SubscribeParams",
	// slice 2 — the 13 params (12 new + SubscribeParams above = 13 total)
	// + RunRetryParams (run-retry, ADR-0028 amendment, #230) = 14 params.
	"PostMessageParams",
	"RunCancelParams",
	"RunRetryParams",
	"ProposalGetParams",
	"ProposalDecideParams",
	"ThreadCreateParams",
	"RunGetHistoryParams",
	"RecurrencePreviewParams",
	"ObservationRecordParams",
	"ObservationUpdateParams",
	"ObservationQueryParams",
	"ObservationGetHistoryParams",
	"EntityListParams",
	"EntityBacklinksParams",
	"EntityMutateParams",
	"JournalEntryRescanParams",
	"MessageSearchParams",
	"ThreadGetParams",
	"ThreadRenameParams",
	"ThreadArchiveParams",
	"ThreadUnarchiveParams",
	"ProviderLoginStartParams",
	"ProviderConfigureParams",
	"ProviderTestParams",
	"SettingsSetParams",
	// slice 3 — the 18 results + notifications
	// + RunRetryResult (run-retry, ADR-0028 amendment, #230) = 19 results.
	"SubscribeResult",
	"RunCancelResult",
	"RunRetryResult",
	"ProposalGetResult",
	"ProposalDecideResult",
	"ProposalPendingNotification",
	"ProposalChangedNotification",
	"ThreadTitledNotification",
	"ProviderConnectedNotification",
	"ThreadCreateResult",
	"ThreadListResult",
	"RunHistoryResult",
	"RecurrencePreviewResult",
	"ObservationRecordResult",
	"ObservationUpdateResult",
	"ObservationQueryResult",
	"ObservationGetHistoryResult",
	"EntityListResult",
	"EntityBacklinksResult",
	"EntityMutateResult",
	"ThreadMutateResult",
	"JournalEntryRescanResult",
	"MessageSearchResult",
	"ThreadGetResult",
	"ProviderStatusResult",
	"ProviderLoginStartResult",
	"ModelCatalogResult",
	"SettingsResult",
	"ProviderTestResult",
	// slice 4 — worker↔core protocol (4 messages)
	"RunEvent",
	"ToolResult",
	"WorkerManifest",
	"WorkerStdout",
	// provider-helper stdout protocol (ADR-0023)
	"ProviderHelperLine",
	// Decision prose (finding F12) — not a wire type; see its registry entry.
	"DecisionProse",
	// chat-image-attachments slice 1 — media/upload (ADR-0058)
	"MediaUploadParams",
	"MediaUploadResult",
];

/** Expected fixture count per tagged-union message (grilling Q10). A union must
 * contribute exactly one fixture per wire variant; a dropped variant fixture reds
 * the completeness lock. Populated as unions are added (slices 3–4). */
export const UNION_VARIANTS: Readonly<Record<string, number>> = {
	// A tagged union must contribute a fixture for EVERY wire variant. The count
	// is fixtures-per-message, so a variant carrying multiple fixtures (RunEvent's
	// tool_call spans 3 ToolCallStatus values) raises the total. A dropped variant
	// fixture drops the count and reds the lock.
	//
	// RunEvent (6 variants): text_delta, tool_call ×3 statuses, done, cancelled,
	//   error, reasoning_delta = 8 fixtures.
	RunEvent: 8,
	// ToolResult carries the ToolOutcome union (ok / err) = 2 fixtures.
	ToolResult: 2,
	// WorkerStdout (5 variants): text_delta, done, error, tool_request,
	//   reasoning_delta = 5.
	WorkerStdout: 5,
	// WorkerManifest: maximal (all 3 ManifestMessage variants in one fixture) +
	// bare = 2 fixtures; the per-ManifestMessage-variant coverage is asserted
	// structurally in the Rust self-lock, not by fixture count.
	WorkerManifest: 2,
	// ProviderHelperLine (3 variants): authorize_url, credentials, error = 3.
	ProviderHelperLine: 3,
};
