import { appendFileSync } from "node:fs";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { CoreToolDescriptor } from "@inkstone/protocol";

// Worker-side tool proxies: thin AgentTool wrappers round-tripping to Core over stdio — see docs/design/worker.md (ADR-0018)

/** The `ok` outcome Core sends in a `tool_result`; mirrors the Rust `AgentToolResult` wire shape. */
export interface ToolResultOk {
	content: TextContent[];
	details?: unknown;
	terminate?: boolean;
}

/** Core's reply to a tool call. */
export type ToolCallResponse =
	| { ok: ToolResultOk }
	| { err: { code: string; message: string } };

/** Round-trip one tool call to Core (stdout `tool_request` / stdin `tool_result`); tests stub it. */
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

/** Build `AgentTool` proxies from Core's tool descriptors; `execute` delegates to `callTool` and throws on `err` (pi's tool-error signal). */
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
