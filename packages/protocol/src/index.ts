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
	S.Struct({ kind: S.Literal("done") }),
	S.Struct({ kind: S.Literal("error"), message: S.String }),
);
export type RunEvent = S.Schema.Type<typeof RunEvent>;

export const WorkerOutbound = RunEvent;
export type WorkerOutbound = S.Schema.Type<typeof WorkerOutbound>;

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
	tools: S.Array(S.String),
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
