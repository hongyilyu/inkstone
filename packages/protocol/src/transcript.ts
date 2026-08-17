// The transcript result currency (external-task-views A4): shared by the
// Worker frame union (worker.ts), the Run Event stream (run.ts), and the
// thread/get Segment timeline (thread.ts). Its own module so those three can
// import it without a cycle.

import { Schema as S } from "effect";

/** The only `content` modality Core produces today (image is out of scope). */
export const ToolTextContent = S.Struct({
	type: S.Literal("text"),
	text: S.String,
});

export type ToolTextContent = S.Schema.Type<typeof ToolTextContent>;

/** The single transcript result type for ALL tools (external-task-views A4):
 * the model-visible content blocks plus the ONE error flag. Carried by the
 * `external_tool_finished` frame, persisted in `tool_calls.result_payload` for
 * external (`ticktick_*`) calls, served on terminal `tool_call` Run Events and
 * `Segment.tool_call`, and replayed in the resume manifest's `tool_result`
 * blocks — Core tool results, Proposal Decisions, the not-executed placeholder,
 * and MCP results all reduce to this shape. Deliberately no runtime
 * `details`/`terminate`: those are Worker-runtime control flow, never durable. */
export const TranscriptToolResult = S.Struct({
	content: S.Array(ToolTextContent),
	is_error: S.Boolean,
});

export type TranscriptToolResult = S.Schema.Type<typeof TranscriptToolResult>;

/** The reserved name prefix of EXTERNAL tools — Worker-executed MCP tools the
 * model sees as `ticktick_*` (external-task-views A3/A4). The Core registry
 * reserves it (crates/core/src/tools/mod.rs `EXTERNAL_TOOL_PREFIX`), so the
 * prefix alone marks a call external at every consumer: the Worker's frame
 * emission and the Web's no-grouping rule both key off it. */
export const EXTERNAL_TOOL_PREFIX = "ticktick_";

/** Whether `name` is an external (Worker-executed MCP) tool. */
export function isExternalToolName(name: string): boolean {
	return name.startsWith(EXTERNAL_TOOL_PREFIX);
}
