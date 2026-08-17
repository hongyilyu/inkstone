// Worker<->Core wire schemas: the outbound frame union, the Tool Protocol
// duplex (ADR-0018), and the spawn manifest shapes (ADR-0009 hand-mirror).

import { Schema as S } from "effect";

import { WorkerRunEvent } from "./run.js";
import { ToolTextContent, TranscriptToolResult } from "./transcript.js";

// tool protocol (ADR-0018): the Worker<->Core duplex for tool calls — see docs/design/protocol.md
// (transcript.ts's own schemas reach the barrel via index.ts, not this file.)

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

/** Core → Worker: durable acceptance or rejection of one external lifecycle
 * frame. No failure detail crosses this boundary; Core logs the cause. */
export const ExternalToolAck = S.Struct({
	kind: S.Literal("external_tool_ack"),
	tool_call_id: S.String,
	phase: S.Literal("started", "finished"),
	ok: S.Boolean,
});

export type ExternalToolAck = S.Schema.Type<typeof ExternalToolAck>;

/** Every post-manifest frame Core can write to the Worker. */
export const WorkerInbound = S.Union(ToolResult, ExternalToolAck);
export type WorkerInbound = S.Schema.Type<typeof WorkerInbound>;

/** One tool the Workflow exposes; shipped in the WorkflowManifest. */
export const CoreToolDescriptor = S.Struct({
	name: S.String,
	description: S.String,
	label: S.String,
	json_schema: S.Unknown,
});

export type CoreToolDescriptor = S.Schema.Type<typeof CoreToolDescriptor>;

/** Worker → Core: an EXTERNAL (Worker-executed MCP, `ticktick_*`) tool call
 * began (external-task-views A4). Sourced from pi's `tool_execution_start`
 * event — never hand-assembled state. `name` is the namespaced model-facing
 * name; `arguments` the validated call args. */
export const ExternalToolStarted = S.Struct({
	kind: S.Literal("external_tool_started"),
	tool_call_id: S.String,
	name: S.String,
	arguments: S.Unknown,
});

export type ExternalToolStarted = S.Schema.Type<typeof ExternalToolStarted>;

/** Worker → Core: an external call's ONE terminal frame, from pi's finalized
 * `tool_execution_end` event. No outer error flag — `result.is_error` is the
 * single source of truth; `tool_calls.status` derives from it. */
export const ExternalToolFinished = S.Struct({
	kind: S.Literal("external_tool_finished"),
	tool_call_id: S.String,
	result: TranscriptToolResult,
});

export type ExternalToolFinished = S.Schema.Type<typeof ExternalToolFinished>;

/** What the Worker writes to stdout (mirrors Rust's `WorkerStdout` in crates/core/src/protocol/worker.rs). */
export const WorkerOutbound = S.Union(
	WorkerRunEvent,
	ToolRequest,
	ExternalToolStarted,
	ExternalToolFinished,
);

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
	// The paired result for a prior tool_call (ADR-0025), carried as the ONE
	// transcript result type (external-task-views A4): Core tool results,
	// Proposal Decisions, the not-executed placeholder, and MCP results all
	// arrive through this same shape.
	S.Struct({
		role: S.Literal("tool_result"),
		tool_call_id: S.String,
		result: TranscriptToolResult,
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
	/** External (Worker-executed MCP) tool config (external-task-views A3/A5):
	 * the TickTick MCP endpoint + auth Core hands the Worker at spawn from its
	 * boot-read credential state. Absent = no external tools this Run. */
	external_tools: S.optional(
		S.Struct({
			endpoint: S.String,
			access_token: S.String,
			timeout_ms: S.Number.pipe(
				S.int({ description: undefined }),
				S.greaterThanOrEqualTo(1, { description: undefined }),
			),
		}),
	),
});

export type WorkerManifest = S.Schema.Type<typeof WorkerManifest>;
