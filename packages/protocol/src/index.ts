import { Schema as S } from "effect";

export * from "./payloads.js";

export const PostMessageParams = S.Struct({
	thread_id: S.String,
	prompt: S.String,
});
export type PostMessageParams = S.Schema.Type<typeof PostMessageParams>;

export const PostMessageResult = S.Struct({ run_id: S.String });
export type PostMessageResult = S.Schema.Type<typeof PostMessageResult>;

export const SubscribeParams = S.Struct({ run_id: S.String });
export type SubscribeParams = S.Schema.Type<typeof SubscribeParams>;

/** `run/subscribe` result: the Run's `status` at the subscribe instant (ADR-0022 + ADR-0025). */
export const SubscribeResult = S.Struct({
	run_id: S.String,
	status: S.String,
});
export type SubscribeResult = S.Schema.Type<typeof SubscribeResult>;

/** `run/cancel` params: the Run to cancel (ADR-0014). */
export const RunCancelParams = S.Struct({ run_id: S.String });
export type RunCancelParams = S.Schema.Type<typeof RunCancelParams>;

/** `run/cancel` result (ADR-0014): whether Core accepted the cancel command. */
export const RunCancelResult = S.Struct({
	outcome: S.Literal("accepted", "already_terminal", "unknown_run"),
});
export type RunCancelResult = S.Schema.Type<typeof RunCancelResult>;

export const ThreadCreateParams = S.Struct({ prompt: S.String });
export type ThreadCreateParams = S.Schema.Type<typeof ThreadCreateParams>;

export const ThreadCreateResult = S.Struct({
	thread_id: S.String,
	run_id: S.String,
});
export type ThreadCreateResult = S.Schema.Type<typeof ThreadCreateResult>;

export const ThreadSummary = S.Struct({
	id: S.String,
	title: S.String,
	last_activity_at: S.Number,
});
export type ThreadSummary = S.Schema.Type<typeof ThreadSummary>;

export const ThreadListResult = S.Struct({ threads: S.Array(ThreadSummary) });
export type ThreadListResult = S.Schema.Type<typeof ThreadListResult>;

export const ThreadGetParams = S.Struct({ thread_id: S.String });
export type ThreadGetParams = S.Schema.Type<typeof ThreadGetParams>;

export const MessageView = S.Struct({
	id: S.String,
	role: S.String,
	status: S.String,
	run_id: S.String,
	text: S.String,
});
export type MessageView = S.Schema.Type<typeof MessageView>;

export const ThreadGetResult = S.Struct({
	thread_id: S.String,
	title: S.String,
	messages: S.Array(MessageView),
});
export type ThreadGetResult = S.Schema.Type<typeof ThreadGetResult>;

export const RunEvent = S.Union(
	S.Struct({ kind: S.Literal("text_delta"), delta: S.String }),
	// Core-synthesized, ephemeral tool-call boundary (ADR-0006) — see docs/design/protocol.md
	S.Struct({
		kind: S.Literal("tool_call"),
		tool_call_id: S.String,
		name: S.String,
		status: S.Literal("started", "completed", "error"),
	}),
	S.Struct({ kind: S.Literal("done") }),
	S.Struct({ kind: S.Literal("cancelled") }),
	S.Struct({ kind: S.Literal("error"), message: S.String }),
);
export type RunEvent = S.Schema.Type<typeof RunEvent>;

// proposal/* (ADR-0025): a Proposal is a Tool Request awaiting a human Decision — see docs/design/protocol.md

/** `proposal/get` params: the parked Run whose pending Proposal to fetch. */
export const ProposalGetParams = S.Struct({ run_id: S.String });
export type ProposalGetParams = S.Schema.Type<typeof ProposalGetParams>;

export const JournalEntryBodyTextNode = S.Struct({
	type: S.Literal("text"),
	text: S.String,
});
export type JournalEntryBodyTextNode = S.Schema.Type<
	typeof JournalEntryBodyTextNode
>;

export const JournalEntryBodyEntityRefNode = S.Struct({
	type: S.Literal("entity_ref"),
	ref_id: S.String,
});
export type JournalEntryBodyEntityRefNode = S.Schema.Type<
	typeof JournalEntryBodyEntityRefNode
>;

export const JournalEntryBodyNode = S.Union(
	JournalEntryBodyTextNode,
	JournalEntryBodyEntityRefNode,
);
export type JournalEntryBodyNode = S.Schema.Type<typeof JournalEntryBodyNode>;

export const ProposalReviewCurrentJournalEntry = S.Struct({
	entity_id: S.String,
	occurred_at: S.String,
	ended_at: S.optional(S.String),
	body: S.Array(JournalEntryBodyNode),
});
export type ProposalReviewCurrentJournalEntry = S.Schema.Type<
	typeof ProposalReviewCurrentJournalEntry
>;

export const ProposalReviewContext = S.Struct({
	current_journal_entry: S.optional(ProposalReviewCurrentJournalEntry),
});
export type ProposalReviewContext = S.Schema.Type<typeof ProposalReviewContext>;

/** `proposal/get` result: the Run's pending Proposal. */
export const ProposalGetResult = S.Struct({
	proposal_id: S.String,
	run_id: S.String,
	mutation_kind: S.String,
	payload: S.Unknown,
	rationale: S.NullOr(S.String),
	review_context: S.optional(ProposalReviewContext),
	status: S.String,
});
export type ProposalGetResult = S.Schema.Type<typeof ProposalGetResult>;

/** `proposal/decide` params: the user's Decision on a pending Proposal. */
export const ProposalDecideParams = S.Struct({
	proposal_id: S.String,
	decision: S.Literal("accept", "reject", "edit"),
	edited_payload: S.optional(S.Unknown),
	decision_idempotency_key: S.optional(S.String),
});
export type ProposalDecideParams = S.Schema.Type<typeof ProposalDecideParams>;

/** `proposal/decide` result: the Proposal's post-decision `status` and any created `entity_id`. */
export const ProposalDecideResult = S.Struct({
	status: S.Literal("accepted", "rejected"),
	entity_id: S.optional(S.String),
});
export type ProposalDecideResult = S.Schema.Type<typeof ProposalDecideResult>;

/** `proposal/pending` Notification: pushed to a Run's subscribers the moment the Run parks (ADR-0025). */
export const ProposalPendingNotification = S.Struct({
	run_id: S.String,
	proposal_id: S.String,
});
export type ProposalPendingNotification = S.Schema.Type<
	typeof ProposalPendingNotification
>;

/** `proposal/changed` Notification: pushed when a pending Proposal is decided (ADR-0025). */
export const ProposalChangedNotification = S.Struct({
	run_id: S.String,
	proposal_id: S.String,
	status: S.Literal("accepted", "rejected"),
});
export type ProposalChangedNotification = S.Schema.Type<
	typeof ProposalChangedNotification
>;

// entity/* (ADR-0004): the accepted Entities the Library reads; `entity/list` is type-parameterized (one type per call).

/** `entity/list` params: the Entity type to list (one type per call). */
export const EntityListParams = S.Struct({ type: S.String });
export type EntityListParams = S.Schema.Type<typeof EntityListParams>;

export const ResolvedEntityRef = S.Struct({
	id: S.String,
	source_entity_id: S.String,
	target_entity_id: S.String,
	target_entity_type: S.Literal("person", "project", "todo"),
	target_title: S.optional(S.String),
	label_snapshot: S.optional(S.String),
});
export type ResolvedEntityRef = S.Schema.Type<typeof ResolvedEntityRef>;

/**
 * One Todo Person Reference on a Todo `entity/list` row (ADR-0031, ADR-0032):
 * the task-relationship analogue of `refs`. `role` carries the GTD semantics
 * (`waiting_on` ⊇ `related`). Clients derive Project↔Person↔Todo from these.
 */
export const TodoPersonRefView = S.Struct({
	person_id: S.String,
	role: S.Literal("waiting_on", "related"),
});
export type TodoPersonRefView = S.Schema.Type<typeof TodoPersonRefView>;

/** One Entity row in an `entity/list` result: the raw tier-2 `entities` columns (ADR-0004). */
export const EntityRow = S.Struct({
	id: S.String,
	type: S.String,
	data: S.Unknown,
	created_at: S.Number,
	updated_at: S.Number,
	refs: S.optional(S.Array(ResolvedEntityRef)),
	/** Present on Todo rows: the Todo's Person References (ADR-0032). */
	person_refs: S.optional(S.Array(TodoPersonRefView)),
});
export type EntityRow = S.Schema.Type<typeof EntityRow>;

/** `entity/list` result: the accepted Entities of the requested type, newest-first. */
export const EntityListResult = S.Struct({ entities: S.Array(EntityRow) });
export type EntityListResult = S.Schema.Type<typeof EntityListResult>;

/**
 * `entity/mutate` params (ADR-0033): a user-initiated CRUD request. `payload` is the
 * same discriminated `{mutation_kind, payload}` envelope the Worker's
 * `propose_workspace_mutation` tool uses (minus rationale), so it stays opaque at the
 * wire boundary — Core validates it per `mutation_kind`.
 */
export const EntityMutateParams = S.Struct({
	mutation_kind: S.String,
	payload: S.Unknown,
});
export type EntityMutateParams = S.Schema.Type<typeof EntityMutateParams>;

/** `entity/mutate` result: the affected Entity id — present on create/update, absent on delete. */
export const EntityMutateResult = S.Struct({
	entity_id: S.optional(S.String),
});
export type EntityMutateResult = S.Schema.Type<typeof EntityMutateResult>;

// message/* (ADR-0035): full-text search over completed Message text, surfaced in ⌘K.

/** One message-search hit (ADR-0035): a completed Message matching the substring query, with a SQL-rendered snippet and its Thread title for navigation. */
export const MessageHit = S.Struct({
	message_id: S.String,
	thread_id: S.String,
	run_id: S.String,
	role: S.Literal("user", "assistant"),
	snippet: S.String,
	thread_title: S.String,
	created_at: S.Number, // ms-epoch
});
export type MessageHit = S.Schema.Type<typeof MessageHit>;

/** `message/search` params (ADR-0035): a substring query over completed message text. */
export const MessageSearchParams = S.Struct({ query: S.String });
export type MessageSearchParams = S.Schema.Type<typeof MessageSearchParams>;

/** `message/search` result: matching hits, newest-first. */
export const MessageSearchResult = S.Struct({ hits: S.Array(MessageHit) });
export type MessageSearchResult = S.Schema.Type<typeof MessageSearchResult>;

// tool protocol (ADR-0018): the Worker<->Core duplex for tool calls — see docs/design/protocol.md

/** The only `content` modality Core produces today (image is out of scope). */
export const ToolTextContent = S.Struct({
	type: S.Literal("text"),
	text: S.String,
});
export type ToolTextContent = S.Schema.Type<typeof ToolTextContent>;

/** Hand-mirror of pi-agent-core's `AgentToolResult` (ADR-0018:201; no `isError`). */
export const AgentToolResult = S.Struct({
	content: S.Array(ToolTextContent),
	details: S.optional(S.Unknown),
	terminate: S.optional(S.Boolean),
});
export type AgentToolResult = S.Schema.Type<typeof AgentToolResult>;

/** Worker → Core: a request to run a named tool with opaque params. */
export const ToolRequest = S.Struct({
	kind: S.Literal("tool_request"),
	run_id: S.String,
	tool_call_id: S.String,
	name: S.String,
	params: S.Unknown,
});
export type ToolRequest = S.Schema.Type<typeof ToolRequest>;

/** Core → Worker: the outcome of a tool call (success or error). */
export const ToolResult = S.Struct({
	kind: S.Literal("tool_result"),
	run_id: S.String,
	tool_call_id: S.String,
	outcome: S.Union(
		S.Struct({ ok: AgentToolResult }),
		S.Struct({ err: S.Struct({ code: S.String, message: S.String }) }),
	),
});
export type ToolResult = S.Schema.Type<typeof ToolResult>;

/** One tool the Workflow exposes; shipped in the WorkflowManifest. */
export const CoreToolDescriptor = S.Struct({
	name: S.String,
	description: S.String,
	label: S.String,
	json_schema: S.Unknown,
});
export type CoreToolDescriptor = S.Schema.Type<typeof CoreToolDescriptor>;

// What the Worker writes to stdout; reuses `RunEvent`, so its `tool_call`/`cancelled` kinds are never emitted here — see docs/design/protocol.md
export const WorkerOutbound = S.Union(RunEvent, ToolRequest);
export type WorkerOutbound = S.Schema.Type<typeof WorkerOutbound>;

/** Core → Worker, after the manifest: a tool's outcome (ADR-0018). */
export const WorkerInbound = ToolResult;
export type WorkerInbound = S.Schema.Type<typeof WorkerInbound>;

// provider/* (ADR-0023, ADR-0014 amendment): LLM-provider connection.

/** One provider's connection state in `provider/status`. */
export const ProviderStatus = S.Struct({
	id: S.String,
	connected: S.Boolean,
});
export type ProviderStatus = S.Schema.Type<typeof ProviderStatus>;

/** `provider/status` result: connection state of each known provider. */
export const ProviderStatusResult = S.Struct({
	providers: S.Array(ProviderStatus),
});
export type ProviderStatusResult = S.Schema.Type<typeof ProviderStatusResult>;

/** `provider/login_start` params: which provider to begin an OAuth login for. */
export const ProviderLoginStartParams = S.Struct({ provider: S.String });
export type ProviderLoginStartParams = S.Schema.Type<
	typeof ProviderLoginStartParams
>;

/** `provider/login_start` result: the authorize URL to open in a new tab. */
export const ProviderLoginStartResult = S.Struct({ authorize_url: S.String });
export type ProviderLoginStartResult = S.Schema.Type<
	typeof ProviderLoginStartResult
>;

// model/catalog (ADR-0024): the models available per provider, hand-mirrored from pi-ai's MODELS and guarded by a Worker-side drift test.

/** One model in `model/catalog`. `input` is the modality list (`text`/`image`). */
export const ModelInfo = S.Struct({
	id: S.String,
	name: S.String,
	reasoning: S.Boolean,
	input: S.Array(S.String),
	cost_input: S.Number,
	cost_output: S.Number,
});
export type ModelInfo = S.Schema.Type<typeof ModelInfo>;

/** One provider's model group in `model/catalog`. */
export const ProviderModels = S.Struct({
	id: S.String,
	label: S.String,
	models: S.Array(ModelInfo),
});
export type ProviderModels = S.Schema.Type<typeof ProviderModels>;

/** `model/catalog` result: the models available per provider. */
export const ModelCatalogResult = S.Struct({
	providers: S.Array(ProviderModels),
});
export type ModelCatalogResult = S.Schema.Type<typeof ModelCatalogResult>;

// settings/* (ADR-0024): the user's preferred model + global effort.

/** `settings/get` / `settings/set` result: the effective model selection and global effort for the default Workflow. */
export const SettingsResult = S.Struct({
	provider: S.String,
	model: S.NullOr(S.String),
	effort: S.String,
});
export type SettingsResult = S.Schema.Type<typeof SettingsResult>;

/** `settings/set` params: a partial update; an absent field is left unchanged. */
export const SettingsSetParams = S.Struct({
	model: S.optional(S.String),
	effort: S.optional(S.String),
});
export type SettingsSetParams = S.Schema.Type<typeof SettingsSetParams>;

// Worker manifest (ADR-0018 as-built): the spawn payload Core ships to the generic interpreter on stdin — see docs/design/protocol.md

/** One tool call inside an assistant manifest message (ADR-0025 resume). */
export const ManifestToolCall = S.Struct({
	id: S.String,
	name: S.String,
	arguments: S.Unknown,
});
export type ManifestToolCall = S.Schema.Type<typeof ManifestToolCall>;

/** One prior message in the assembled Thread history, a tagged union (ADR-0018 messages[], ADR-0025) — see docs/design/protocol.md */
export const ManifestMessage = S.Union(
	S.Struct({ role: S.Literal("user"), text: S.String }),
	S.Struct({
		role: S.Literal("assistant"),
		text: S.optional(S.String),
		tool_calls: S.optional(S.Array(ManifestToolCall)),
	}),
	S.Struct({
		role: S.Literal("tool_result"),
		tool_call_id: S.String,
		content: S.String,
		is_error: S.optional(S.Boolean),
	}),
);
export type ManifestMessage = S.Schema.Type<typeof ManifestMessage>;

/** The Workflow definition fields the interpreter consumes (ADR-0018). */
export const WorkflowManifest = S.Struct({
	name: S.String,
	version: S.String,
	provider: S.String,
	model: S.String,
	system_prompt: S.String,
	thinking_level: S.Literal("off", "minimal", "low", "medium", "high", "xhigh"),
	tools: S.Array(CoreToolDescriptor),
});
export type WorkflowManifest = S.Schema.Type<typeof WorkflowManifest>;

/** The full spawn manifest written to the Worker's stdin (ADR-0018, ADR-0023, ADR-0025) — see docs/design/protocol.md. `run_id` carries the Run's id in-band so the Worker can stamp its Diagnostic Log (ADR-0038, #146). */
export const WorkerManifest = S.Struct({
	run_id: S.String,
	workflow: WorkflowManifest,
	prompt: S.String,
	messages: S.Array(ManifestMessage),
	mode: S.optional(S.Literal("fresh", "resume")),
	access_token: S.optional(S.String),
});
export type WorkerManifest = S.Schema.Type<typeof WorkerManifest>;
