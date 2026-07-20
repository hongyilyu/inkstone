import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
	ToolResult,
	WorkerManifest,
	type WorkerOutbound,
} from "@inkstone/protocol";
import { Effect, Either, Layer, Schema as S } from "effect";
import type { ToolCallResponse } from "./tool-proxy.js";
import { ManifestParseError, WorkerTransport } from "./transport.js";
import { logWorkerFault } from "./worker-log.js";

/** Best-effort run_id from a raw manifest line, for when schema decode fails but
 * the JSON parsed (#146): keeps the failure's diagnostic line joinable to
 * core.jsonl. `undefined` on a JSON syntax error or a non-string run_id. */
const rawRunId = (line: string): string | undefined => {
	try {
		const runId = (JSON.parse(line) as { run_id?: unknown }).run_id;
		return typeof runId === "string" ? runId : undefined;
	} catch {
		return undefined;
	}
};

/** Best-effort tool_call_id from a raw inbound line, for when a `tool_result`
 * parsed as JSON but failed the {@link ToolResult} schema: lets the seam settle
 * the awaiting call LOUD (mirrors {@link rawRunId}). `undefined` on a JSON syntax
 * error or a non-string tool_call_id. */
const rawToolCallId = (line: string): string | undefined => {
	try {
		const id = (JSON.parse(line) as { tool_call_id?: unknown }).tool_call_id;
		return typeof id === "string" ? id : undefined;
	} catch {
		return undefined;
	}
};

const decodeToolResult = S.decodeUnknownEither(ToolResult);

/** Production transport (ADR-0027): the Worker's stdio behind the {@link WorkerTransport} seam, over injected streams for testability. See docs/design/worker-transport.md. */
const makeStdioService = (
	input: Readable,
	output: Writable,
): WorkerTransport["Type"] => {
	// Typed with the outbound union so the tool_request frame and every emitted
	// Run Event are compile-checked against the protocol schema (mirrors Rust's
	// WorkerStdout) — no inline frame literal can drift.
	const writeLine = (frame: WorkerOutbound): void => {
		output.write(`${JSON.stringify(frame)}\n`);
	};

	// Bidirectional stdio: first stdin line is the manifest, rest are tool_result frames — see docs/design/worker-transport.md.
	const pendingTools = new Map<string, (resp: ToolCallResponse) => void>();
	let resolveManifest!: (line: string | null) => void;
	const manifestLine = new Promise<string | null>((resolve) => {
		resolveManifest = resolve;
	});
	let gotManifest = false;
	let runId = "";

	const rl = createInterface({ input });
	rl.on("line", (line: string) => {
		if (!gotManifest) {
			gotManifest = true;
			resolveManifest(line);
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			// Non-JSON inbound line: dropped, but observable. Bound the preview so a
			// huge bad line never bloats the Diagnostic Log.
			logWorkerFault("worker.inbound_line_unparsed", runId, {
				preview: line.slice(0, 200),
			});
			return;
		}
		// Strict decode against the single-source ToolResult schema: a skewed frame
		// (e.g. outcome:{}) no longer slips past a truthiness guard to resolve the
		// call with junk that later throws inside the proxy and reads as a
		// misattributed tool error — it fails loud here, at the seam.
		const decoded = decodeToolResult(parsed);
		if (Either.isRight(decoded)) {
			const result = decoded.right;
			const pending = pendingTools.get(result.tool_call_id);
			if (pending) {
				pendingTools.delete(result.tool_call_id);
				pending(result.outcome);
			} else {
				// A tool_result arrived with no awaiting call — silently dropped before.
				logWorkerFault("worker.tool_result_no_pending", runId, {
					tool_call_id: result.tool_call_id,
				});
			}
			return;
		}
		// Parsed as JSON but failed the ToolResult schema. Salvage the correlation
		// id and SETTLE the awaiting call with an `err` outcome: the proxy throws on
		// `err`, so the model sees a correctly-attributed decode failure (which pi
		// feeds back as an error tool result, ADR-0018) instead of a truthiness guard
		// waving junk through. The settle is what makes it fail loud — it stops the
		// call hanging; the fault log makes it observable.
		const toolCallId = rawToolCallId(line);
		const pending =
			toolCallId === undefined ? undefined : pendingTools.get(toolCallId);
		if (toolCallId !== undefined && pending) {
			pendingTools.delete(toolCallId);
			pending({
				err: {
					code: "tool_result_decode_error",
					// Bound the message: it flows through the proxy throw into the
					// model-visible tool error, and an Effect ParseError tree can be long.
					message: decoded.left.message.slice(0, 500),
				},
			});
			logWorkerFault("worker.tool_result_decode_error", runId, {
				tool_call_id: toolCallId,
				preview: line.slice(0, 200),
			});
			return;
		}
		// Undecodable and no pending call to settle: record and drop. This is safe
		// only under the typed-Core contract — Core's `tool_call_id` is a required
		// String (crates/core/src/protocol/worker.rs) written by one sequential
		// flushed writer, so a decode-failing line can't carry the live id of a
		// waiting call. If that contract ever broke (a non-string id on a line whose
		// real target is pending), that call would not be settled here — hence the
		// salvaged id is logged when present, to make such a case diagnosable.
		logWorkerFault("worker.tool_result_undecodable", runId, {
			...(toolCallId === undefined ? {} : { tool_call_id: toolCallId }),
			preview: line.slice(0, 200),
		});
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
			const manifest = yield* Effect.try({
				try: () => S.decodeUnknownSync(WorkerManifest)(JSON.parse(line)),
				catch: (e) =>
					new ManifestParseError({
						message: `worker could not parse manifest: ${
							e instanceof Error ? e.message : String(e)
						}`,
						// Salvage run_id from the raw JSON so a schema-skew failure (#146)
						// still logs a joinable run_id — undefined only on a JSON syntax error.
						runId: rawRunId(line),
					}),
			});
			runId = manifest.run_id;
			return manifest;
		}),
		emit: (event) => writeLine(event),
		callTool: (toolCallId, name, params) =>
			new Promise<ToolCallResponse>((resolve) => {
				pendingTools.set(toolCallId, resolve);
				writeLine({
					kind: "tool_request",
					run_id: runId,
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
