import type { RunEvent } from "@inkstone/protocol";
import { Effect, Layer } from "effect";
import type { ToolCallResponse } from "./tool-proxy.js";
import { WorkerTransport } from "./transport.js";

/** One outbound Tool Request recorded by the in-memory seam so a test can assert what the model asked Core to run. */
export interface CapturedToolRequest {
	readonly toolCallId: string;
	readonly name: string;
	readonly params: unknown;
}

/** Scripted Tool Protocol channel for {@link InMemoryTransport}: the Tool Results `callTool` returns plus an array of received Tool Requests, for assertions. */
export interface InMemoryToolChannel {
	/** Tool Results to return, keyed by `tool_call_id`. */
	readonly results: Record<string, ToolCallResponse>;
	/** Each Tool Request the interpreter sent, in call order. */
	readonly requests: CapturedToolRequest[];
}

/** Test `Layer` for {@link WorkerTransport} (ADR-0027): `captured`/`tools` arrays are the assertions, no real stdio. See docs/design/worker-transport.md. */
export const InMemoryTransport = (
	captured: RunEvent[],
	tools?: InMemoryToolChannel,
): Layer.Layer<WorkerTransport> =>
	Layer.succeed(WorkerTransport, {
		readManifest: Effect.succeed(null),
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
