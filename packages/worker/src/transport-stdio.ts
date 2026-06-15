import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { WorkerManifest } from "@inkstone/protocol";
import { Effect, Layer, Schema as S } from "effect";
import type { ToolCallResponse } from "./tool-proxy.js";
import { ManifestParseError, WorkerTransport } from "./transport.js";
import { logWorkerFault } from "./worker-log.js";

/** Production transport (ADR-0027): the Worker's stdio behind the {@link WorkerTransport} seam, over injected streams for testability. See docs/design/worker-transport.md. */
const makeStdioService = (
	input: Readable,
	output: Writable,
): WorkerTransport["Type"] => {
	const writeLine = (frame: unknown): void => {
		output.write(`${JSON.stringify(frame)}\n`);
	};

	// Bidirectional stdio: first stdin line is the manifest, rest are tool_result frames — see docs/design/worker-transport.md.
	const pendingTools = new Map<string, (resp: ToolCallResponse) => void>();
	let resolveManifest!: (line: string | null) => void;
	const manifestLine = new Promise<string | null>((resolve) => {
		resolveManifest = resolve;
	});
	let gotManifest = false;

	const rl = createInterface({ input });
	rl.on("line", (line: string) => {
		if (!gotManifest) {
			gotManifest = true;
			resolveManifest(line);
			return;
		}
		try {
			const msg = JSON.parse(line) as {
				kind?: string;
				tool_call_id?: string;
				outcome?: ToolCallResponse;
			};
			if (
				msg.kind === "tool_result" &&
				typeof msg.tool_call_id === "string" &&
				msg.outcome
			) {
				const pending = pendingTools.get(msg.tool_call_id);
				if (pending) {
					pendingTools.delete(msg.tool_call_id);
					pending(msg.outcome);
				} else {
					// A tool_result arrived with no awaiting call — silently dropped before.
					logWorkerFault("worker.tool_result_no_pending", {
						tool_call_id: msg.tool_call_id,
					});
				}
			}
		} catch {
			// Non-JSON / unknown inbound line: dropped, but now observable. Bound the
			// preview so a huge bad line never bloats the Diagnostic Log.
			logWorkerFault("worker.inbound_line_unparsed", {
				preview: line.slice(0, 200),
			});
		}
	});
	rl.on("close", () => {
		if (!gotManifest) {
			gotManifest = true;
			resolveManifest(null);
		}
	});

	return {
		readManifest: Effect.gen(function* () {
			const line = yield* Effect.promise(() => manifestLine);
			if (line === null) return null;
			return yield* Effect.try({
				try: () => S.decodeUnknownSync(WorkerManifest)(JSON.parse(line)),
				catch: (e) =>
					new ManifestParseError({
						message: `worker could not parse manifest: ${
							e instanceof Error ? e.message : String(e)
						}`,
					}),
			});
		}),
		emit: (event) => writeLine(event),
		callTool: (toolCallId, name, params) =>
			new Promise<ToolCallResponse>((resolve) => {
				pendingTools.set(toolCallId, resolve);
				writeLine({
					kind: "tool_request",
					run_id: "",
					tool_call_id: toolCallId,
					name,
					params,
				});
			}),
	};
};

/** {@link WorkerTransport} over injected streams (production + tests over fakes). */
export const makeStdioTransport = (
	input: Readable,
	output: Writable,
): Layer.Layer<WorkerTransport> =>
	Layer.sync(WorkerTransport, () => makeStdioService(input, output));

/** Production transport over the real process streams. */
export const StdioTransportLive: Layer.Layer<WorkerTransport> =
	makeStdioTransport(process.stdin, process.stdout);
