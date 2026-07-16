// Worker<->Core wire schemas: the outbound frame union, the Tool Protocol
// duplex (ADR-0018), and the spawn manifest shapes (ADR-0009 hand-mirror).

import { Schema as S } from "effect";

import { WorkerRunEvent } from "./run.js";

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

/** What the Worker writes to stdout (mirrors Rust's `WorkerStdout` in crates/core/src/protocol/worker.rs). */
export const WorkerOutbound = S.Union(WorkerRunEvent, ToolRequest);

export type WorkerOutbound = S.Schema.Type<typeof WorkerOutbound>;

/** One NDJSON line of the Provider Helper's stdout (ADR-0023): the authorize
 * URL (login mode), the rotated credentials, or a sanitized error. Consumed by
 * Core (`HelperLine` in crates/core/src/protocol/worker.rs); produced by
 * packages/provider-helper. */
export const ProviderHelperLine = S.Union(
	S.Struct({ kind: S.Literal("authorize_url"), url: S.String }),
	S.Struct({
		kind: S.Literal("credentials"),
		access: S.String,
		refresh: S.String,
		expires: S.Number,
		account_id: S.String,
	}),
	S.Struct({ kind: S.Literal("error"), message: S.String }),
);
export type ProviderHelperLine = S.Schema.Type<typeof ProviderHelperLine>;

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
	/** The current Turn's image attachments: raw base64 (NO `data:` URL prefix —
	 * providers build their own). Forwarded fresh-mode only (a parked-resume Run
	 * does not replay images); absent = text-only turn. */
	attachments: S.optional(
		S.Array(S.Struct({ mime: S.String, data_base64: S.String })),
	),
});

export type WorkerManifest = S.Schema.Type<typeof WorkerManifest>;
