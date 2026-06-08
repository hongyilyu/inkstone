import type { RunEvent } from "@inkstone/protocol";
import { Layer } from "effect";
import type { ToolCallResponse } from "./tool-proxy.js";
import { WorkerTransport } from "./transport.js";

/**
 * One outbound Tool Request the interpreter pushed through the seam, recorded
 * so a test can assert on what the model asked Core to run.
 */
export interface CapturedToolRequest {
	readonly toolCallId: string;
	readonly name: string;
	readonly params: unknown;
}

/**
 * The scripted Tool Protocol channel for {@link InMemoryTransport}: the test
 * supplies the Tool Results `callTool` returns (keyed by `tool_call_id`) and an
 * array the transport appends each received Tool Request to (for assertions).
 */
export interface InMemoryToolChannel {
	/** Tool Results to return, keyed by `tool_call_id`. */
	readonly results: Record<string, ToolCallResponse>;
	/** Each Tool Request the interpreter sent, in call order. */
	readonly requests: CapturedToolRequest[];
}

/**
 * Test `Layer` for {@link WorkerTransport} (ADR-0027). `emit` pushes each Run
 * Event into the caller's `captured` array; `callTool` records the Tool Request
 * into `tools.requests` and returns the scripted Tool Result from
 * `tools.results` (the bidirectional Tool Protocol channel, ADR-0006). Both
 * arrays plus the scripted table ARE the assertions — no process, no readline,
 * no stdout capture.
 *
 * A chat-only run passes no `tools`; its manifest has no tool descriptors, so
 * `callTool` is never invoked. If it ever is (a missing scripted result), the
 * returned `Promise` rejects so the test fails loudly rather than hanging.
 *
 * Slice 3 grows this with a preset manifest (for `readManifest`).
 */
export const InMemoryTransport = (
	captured: RunEvent[],
	tools?: InMemoryToolChannel,
): Layer.Layer<WorkerTransport> =>
	Layer.succeed(WorkerTransport, {
		emit: (event) => {
			captured.push(event);
		},
		callTool: (toolCallId, name, params) => {
			tools?.requests.push({ toolCallId, name, params });
			const result = tools?.results[toolCallId];
			if (result === undefined) {
				return Promise.reject(
					new Error(
						`InMemoryTransport: no scripted tool result for tool_call_id ${toolCallId}`,
					),
				);
			}
			return Promise.resolve(result);
		},
	});
