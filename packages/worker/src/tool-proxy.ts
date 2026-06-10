import { appendFileSync } from "node:fs";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { CoreToolDescriptor } from "@inkstone/protocol";

/**
 * Worker-side tool proxies (ADR-0018). Tools are implemented once in Rust
 * (Core); the Worker builds thin `pi-agent-core` `AgentTool` proxies whose
 * `execute` round-trips a `tool_request`/`tool_result` to Core over stdio.
 * There is zero per-tool code here — the factory is generic over the
 * descriptors Core ships in the manifest.
 */

/**
 * The `ok` outcome Core sends in a `tool_result`. Mirrors the Rust
 * `AgentToolResult` wire shape: `content` is required; `details`/`terminate`
 * are omitted when absent (Rust `skip_serializing_if`). Distinct from
 * `pi-agent-core`'s `AgentToolResult<T>`, which requires `details`.
 */
export interface ToolResultOk {
	content: TextContent[];
	details?: unknown;
	terminate?: boolean;
}

/** Core's reply to a tool call. */
export type ToolCallResponse =
	| { ok: ToolResultOk }
	| { err: { code: string; message: string } };

/**
 * Round-trip one tool call to Core. Production (cli.ts) writes a `tool_request`
 * to stdout and awaits the matching `tool_result` on stdin; tests stub it.
 */
export type CallTool = (
	toolCallId: string,
	name: string,
	params: unknown,
	signal?: AbortSignal,
) => Promise<ToolCallResponse>;

function captureToolCall(
	toolCallId: string,
	name: string,
	params: unknown,
): void {
	const path = process.env.INKSTONE_WORKER_TOOL_CALL_LOG;
	if (path === undefined || path.length === 0) return;
	appendFileSync(
		path,
		`${JSON.stringify({
			tool_call_id: toolCallId,
			name,
			params,
		})}\n`,
	);
}

/**
 * Build `AgentTool` proxies from Core's tool descriptors. Each proxy carries
 * the descriptor's metadata and a `json_schema` (TypeBox's `TSchema` is
 * structurally a JSON Schema with a TS-only brand, ADR-0018:102, so the
 * Core-supplied schema satisfies it at runtime). `execute` delegates to
 * `callTool`; on an `err` outcome it THROWS — `pi-agent-core` signals a tool
 * error by `execute` throwing and converts it into an error tool result.
 */
export function makeProxyTools(
	descriptors: readonly CoreToolDescriptor[],
	callTool: CallTool,
): AgentTool[] {
	return descriptors.map(
		(desc): AgentTool =>
			({
				name: desc.name,
				description: desc.description,
				label: desc.label,
				parameters: desc.json_schema as AgentTool["parameters"],
				execute: async (
					toolCallId: string,
					params: unknown,
					signal?: AbortSignal,
				): Promise<AgentToolResult<unknown>> => {
					captureToolCall(toolCallId, desc.name, params);
					const resp = await callTool(toolCallId, desc.name, params, signal);
					if ("err" in resp) {
						throw new Error(resp.err.message);
					}
					return {
						content: resp.ok.content,
						details: resp.ok.details,
						terminate: resp.ok.terminate,
					};
				},
			}) as AgentTool,
	);
}
