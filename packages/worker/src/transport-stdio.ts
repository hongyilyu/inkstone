import { WorkerManifest } from "@inkstone/protocol";
import { Effect, Layer, Schema as S } from "effect";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { ToolCallResponse } from "./tool-proxy.js";
import { ManifestParseError, WorkerTransport } from "./transport.js";

/**
 * Production transport (ADR-0027): the Worker's stdio behind the
 * {@link WorkerTransport} seam. This is the sole module in the Worker's
 * interpreter transport that touches `process.stdin`/`process.stdout` — the
 * Provider Helper (`provider.ts`, ADR-0023) is a separate binary with its own
 * stdio and is out of scope here. Mirrors Core's `ChildWorker` as the sole
 * `Command::spawn` site for the Worker (ADR-0026). It owns the single readline
 * over stdin, the first-line manifest read (ADR-0013), the `tool_call_id` →
 * resolver correlation map for the bidirectional Tool Protocol (ADR-0006), and
 * the stdout NDJSON writer.
 *
 * Built over injected `Readable`/`Writable` streams so the adapter is testable
 * with fakes; {@link StdioTransportLive} binds it to the real process streams.
 */
const makeStdioService = (
	input: Readable,
	output: Writable,
): WorkerTransport["Type"] => {
	const writeLine = (frame: unknown): void => {
		output.write(`${JSON.stringify(frame)}\n`);
	};

	// Bidirectional stdio (ADR-0013): a single readline over stdin. The FIRST
	// line is the manifest; every subsequent line is a `tool_result` Core writes
	// back, dispatched to the pending tool call keyed by `tool_call_id`.
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
				}
			}
		} catch {
			// Non-JSON / unknown inbound line: ignore.
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
export const StdioTransportLive: Layer.Layer<WorkerTransport> = makeStdioTransport(
	process.stdin,
	process.stdout,
);
