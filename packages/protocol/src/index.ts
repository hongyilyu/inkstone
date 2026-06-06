import { Schema as S } from "effect";

export const PostMessageParams = S.Struct({
	thread_id: S.String,
	prompt: S.String,
});
export type PostMessageParams = S.Schema.Type<typeof PostMessageParams>;

export const PostMessageResult = S.Struct({ run_id: S.String });
export type PostMessageResult = S.Schema.Type<typeof PostMessageResult>;

export const SubscribeParams = S.Struct({ run_id: S.String });
export type SubscribeParams = S.Schema.Type<typeof SubscribeParams>;

/**
 * `run/subscribe` result: the Run's `status` at the subscribe instant
 * (ADR-0022 + ADR-0025). `running` while a live stream (hub) exists, else the
 * persisted `runs.status` — notably `parked`, which a refreshed Client must
 * distinguish from a terminal `completed`/`errored` so it does not treat the
 * stopped Run Event stream as a false `done`.
 */
export const SubscribeResult = S.Struct({
	run_id: S.String,
	status: S.String,
});
export type SubscribeResult = S.Schema.Type<typeof SubscribeResult>;

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
	// Live tool-call boundary (ADR-0006): Core synthesizes these when it
	// receives a `tool_request` from the Worker and publishes them on the Run
	// Event hub so the Client can show a tool running. `started` precedes
	// dispatch; the terminal `completed`/`error` mirrors the outcome. Ephemeral
	// (not persisted), so not replayed on a snapshot/reconnect (ADR-0022).
	S.Struct({
		kind: S.Literal("tool_call"),
		tool_call_id: S.String,
		name: S.String,
		status: S.Literal("started", "completed", "error"),
	}),
	S.Struct({ kind: S.Literal("done") }),
	S.Struct({ kind: S.Literal("error"), message: S.String }),
);
export type RunEvent = S.Schema.Type<typeof RunEvent>;

// --- proposal/* (ADR-0025): a Proposal is a Tool Request awaiting a human
// Decision. When the Worker emits a `propose_entity` tool_request, Core parks
// the Run and persists a pending Proposal. The Proposal lifecycle rides this
// `proposal/*` channel, NOT a new RunEvent variant (the wire RunEvent enum
// stays frozen at text_delta/tool_call/done/error).

/** `proposal/get` params: the parked Run whose pending Proposal to fetch. */
export const ProposalGetParams = S.Struct({ run_id: S.String });
export type ProposalGetParams = S.Schema.Type<typeof ProposalGetParams>;

/**
 * `proposal/get` result: the Run's pending Proposal. `kind` is the proposed
 * entity type (e.g. `todo`); `change_kind` is create|update|delete; `data` is
 * the opaque proposed entity payload; `rationale` is the model's reason (may
 * be null); `status` is the Proposal's lifecycle state.
 */
export const ProposalGetResult = S.Struct({
	proposal_id: S.String,
	run_id: S.String,
	kind: S.String,
	change_kind: S.String,
	data: S.Unknown,
	rationale: S.NullOr(S.String),
	status: S.String,
});
export type ProposalGetResult = S.Schema.Type<typeof ProposalGetResult>;

// --- tool protocol (ADR-0018): the Worker↔Core duplex for tool calls. The
// Worker emits `tool_request` on its outbound stream (alongside RunEvents);
// Core replies with `tool_result` on the post-manifest inbound stream.
// `params` and `json_schema` are opaque JSON forwarded verbatim (the Worker
// wraps `json_schema` in `Type.Unsafe`; Core re-validates `params`). The
// descriptor list ships in the WorkflowManifest.

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

// What the Worker writes to stdout. NOTE: the `tool_call` member of `RunEvent`
// is Core-synthesized (Core publishes it to the Client hub when it receives a
// `tool_request`); the Worker never emits it, so Core's stdout decoder ignores
// that kind. The union is widened only because it reuses `RunEvent`.
export const WorkerOutbound = S.Union(RunEvent, ToolRequest);
export type WorkerOutbound = S.Schema.Type<typeof WorkerOutbound>;

/** Core → Worker, after the manifest: a tool's outcome (ADR-0018). */
export const WorkerInbound = ToolResult;
export type WorkerInbound = S.Schema.Type<typeof WorkerInbound>;

// --- provider/* (ADR-0023, ADR-0014 amendment): LLM-provider connection.

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

// --- model/catalog (ADR-0024): the models available per provider. Static
// data hand-mirrored from pi-ai's MODELS and embedded in Core; a Worker-side
// drift test guards it. `openai-codex` is the only connectable provider today.

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

// --- settings/* (ADR-0024): the user's preferred model + global effort.

/**
 * `settings/get` / `settings/set` result: the effective model selection and
 * global effort for the default Workflow. `model` is `null` until the user
 * picks one (the resolver then falls back to the per-provider default);
 * `provider` is the Workflow's provider; `effort` is the global thinking level.
 */
export const SettingsResult = S.Struct({
	provider: S.String,
	model: S.NullOr(S.String),
	effort: S.String,
});
export type SettingsResult = S.Schema.Type<typeof SettingsResult>;

/**
 * `settings/set` params: a partial update. An absent field is left unchanged;
 * `model` must be a known catalog id and `effort` a valid thinking level, else
 * the request is rejected with `invalid_params`.
 */
export const SettingsSetParams = S.Struct({
	model: S.optional(S.String),
	effort: S.optional(S.String),
});
export type SettingsSetParams = S.Schema.Type<typeof SettingsSetParams>;

// --- Worker manifest (ADR-0018 as-built): the spawn payload Core ships to
// the generic interpreter on stdin. Carries the Workflow definition, the
// assembled conversation history, and — for OAuth providers — a short-lived
// access token (ADR-0023). `tools` is empty until the tools slice.

/** One prior message in the assembled Thread history (ADR-0018 messages[]). */
export const ManifestMessage = S.Struct({
	role: S.Literal("user", "assistant"),
	text: S.String,
});
export type ManifestMessage = S.Schema.Type<typeof ManifestMessage>;

/** The Workflow definition fields the interpreter consumes (ADR-0018). */
export const WorkflowManifest = S.Struct({
	name: S.String,
	version: S.String,
	provider: S.String,
	model: S.String,
	system_prompt: S.String,
	thinking_level: S.Literal(
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
	),
	tools: S.Array(CoreToolDescriptor),
});
export type WorkflowManifest = S.Schema.Type<typeof WorkflowManifest>;

/**
 * The full spawn manifest written to the Worker's stdin. `prompt` is the
 * current user turn; `messages` is the prior completed history (oldest
 * first, excluding the current prompt). `access_token` is present only for
 * OAuth providers (ADR-0023); absent for the `faux` test provider and any
 * env-key provider.
 */
export const WorkerManifest = S.Struct({
	workflow: WorkflowManifest,
	prompt: S.String,
	messages: S.Array(ManifestMessage),
	access_token: S.optional(S.String),
});
export type WorkerManifest = S.Schema.Type<typeof WorkerManifest>;
