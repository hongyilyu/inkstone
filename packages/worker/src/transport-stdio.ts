import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
	asObject,
	asString,
	type ExternalToolAck,
	type JsonValue,
	WorkerInbound,
	WorkerManifest,
	type WorkerOutbound,
} from "@inkstone/protocol";
import { Effect, Either, Layer, ParseResult, Schema as S } from "effect";
import type { ToolCallResponse } from "./tool-proxy.js";
import { ManifestParseError, WorkerTransport } from "./transport.js";
import { logWorkerFault } from "./worker-log.js";

/** A VALUE-FREE manifest schema-failure message (review R10 #1). The manifest
 * carries secrets (`external_tools.access_token`, `access_token`), and Effect
 * Schema's TreeFormatter prints the ACTUAL value at each issue. This message flows
 * into a terminal `error` Run Event and is PERSISTED by Core as the run's
 * error_message — so it is built from issue PATHS + tags only, never values. (The
 * sibling JSON-syntax failure is value-free by construction: Node's `JSON.parse`
 * SyntaxError quotes a source snippet, so its text is a fixed string.) */
const sanitizedManifestError = (error: ParseResult.ParseError): string => {
	const issues = ParseResult.ArrayFormatter.formatErrorSync(error)
		.map(
			(issue) =>
				`${issue.path.map(String).join(".") || "<root>"}: ${issue._tag}`,
		)
		.join("; ");
	return `manifest failed WorkerManifest schema validation (${issues})`;
};

/** Best-effort run_id from a raw manifest line, for when schema decode fails but
 * the JSON parsed (#146): keeps the failure's diagnostic line joinable to
 * core.jsonl. `undefined` on a JSON syntax error or a non-string run_id. */
const rawRunId = (line: string): string | undefined => {
	try {
		return asString(asObject(JSON.parse(line))?.run_id);
	} catch {
		return undefined;
	}
};

interface RawInboundCorrelation {
	readonly kind: string | undefined;
	readonly toolCallId: string | undefined;
	readonly phase: string | undefined;
}

const rawInboundCorrelation = (value: JsonValue): RawInboundCorrelation => {
	const record = asObject(value);
	return {
		kind: asString(record?.kind),
		toolCallId: asString(record?.tool_call_id),
		phase: asString(record?.phase),
	};
};

const decodeWorkerInbound = S.decodeUnknownEither(WorkerInbound);
const EXTERNAL_ACK_REJECTED = "Core rejected an external tool lifecycle frame";
const EXTERNAL_ACK_INVALID =
	"Core sent an invalid external tool acknowledgement";
const EXTERNAL_ACK_CLOSED =
	"Core closed before acknowledging an external tool frame";
type ExternalPhase = ExternalToolAck["phase"];
const externalAckKey = (toolCallId: string, phase: ExternalPhase): string =>
	`${phase}\u0000${toolCallId}`;

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

	// Bidirectional stdio: first stdin line is the manifest; subsequent lines are
	// tool results or external lifecycle acknowledgements.
	const pendingTools = new Map<string, (resp: ToolCallResponse) => void>();
	const pendingExternal = new Map<
		string,
		{ resolve: () => void; reject: (error: Error) => void }
	>();
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
		let parsed: JsonValue;
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
		const decoded = decodeWorkerInbound(parsed);
		if (Either.isRight(decoded)) {
			const inbound = decoded.right;
			if (inbound.kind === "external_tool_ack") {
				const key = externalAckKey(inbound.tool_call_id, inbound.phase);
				const pending = pendingExternal.get(key);
				if (pending === undefined) {
					logWorkerFault("worker.external_ack_no_pending", runId, {
						tool_call_id: inbound.tool_call_id,
						phase: inbound.phase,
					});
					return;
				}
				pendingExternal.delete(key);
				if (inbound.ok) {
					pending.resolve();
				} else {
					pending.reject(new Error(EXTERNAL_ACK_REJECTED));
				}
				return;
			}

			const pending = pendingTools.get(inbound.tool_call_id);
			if (pending !== undefined) {
				pendingTools.delete(inbound.tool_call_id);
				pending(inbound.outcome);
			} else {
				// A tool_result arrived with no awaiting call — silently dropped before.
				logWorkerFault("worker.tool_result_no_pending", runId, {
					tool_call_id: inbound.tool_call_id,
				});
			}
			return;
		}

		const raw = rawInboundCorrelation(parsed);
		const toolCallId = raw.toolCallId;
		if (raw.kind === "external_tool_ack" && toolCallId !== undefined) {
			const phases: readonly ExternalPhase[] =
				raw.phase === "started" || raw.phase === "finished"
					? [raw.phase]
					: ["started", "finished"];
			const matches = phases.flatMap((phase) => {
				const key = externalAckKey(toolCallId, phase);
				const pending = pendingExternal.get(key);
				return pending === undefined ? [] : [{ key, pending }];
			});
			if (matches.length === 1) {
				const [{ key, pending }] = matches;
				pendingExternal.delete(key);
				pending.reject(new Error(EXTERNAL_ACK_INVALID));
			}
			logWorkerFault("worker.external_ack_undecodable", runId, {
				tool_call_id: toolCallId,
				phase: raw.phase,
				preview: line.slice(0, 200),
			});
			return;
		}

		// Parsed as JSON but failed the ToolResult schema. Salvage the correlation
		// id and SETTLE the awaiting call with an `err` outcome: the proxy throws on
		// `err`, so the model sees a correctly-attributed decode failure (which pi
		// feeds back as an error tool result, ADR-0018) instead of a truthiness guard
		// waving junk through. The settle is what makes it fail loud — it stops the
		// call hanging; the fault log makes it observable.
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
			tool_call_id: toolCallId,
			preview: line.slice(0, 200),
		});
	});
	rl.on("close", () => {
		if (!gotManifest) {
			gotManifest = true;
			resolveManifest(null);
		}
		for (const pending of pendingExternal.values()) {
			pending.reject(new Error(EXTERNAL_ACK_CLOSED));
		}
		pendingExternal.clear();
	});

	return {
		readManifest: Effect.gen(function* () {
			const line = yield* Effect.promise(() => manifestLine);
			if (line === null) return null;
			const json = yield* Effect.try({
				try: (): JsonValue => JSON.parse(line),
				catch: () =>
					new ManifestParseError({
						message: "manifest line is not valid JSON",
						runId: undefined,
					}),
			});
			const manifest = yield* Effect.mapError(
				S.decodeUnknown(WorkerManifest)(json),
				(error) =>
					new ManifestParseError({
						// Sanitized (review R10 #1): this string reaches the terminal
						// `error` Run Event and Core's persisted error_message — it must
						// never embed the manifest's values (the bearer token).
						message: sanitizedManifestError(error),
						// Salvage run_id from the raw JSON so a schema-skew failure (#146)
						// still logs a joinable run_id.
						runId: rawRunId(line),
					}),
			);
			runId = manifest.run_id;
			return manifest;
		}),
		emit: (event) => writeLine(event),
		syncExternalTool: (event) =>
			new Promise<void>((resolve, reject) => {
				const phase: ExternalPhase =
					event.kind === "external_tool_started" ? "started" : "finished";
				const key = externalAckKey(event.tool_call_id, phase);
				if (pendingExternal.has(key)) {
					reject(new Error(EXTERNAL_ACK_INVALID));
					return;
				}
				pendingExternal.set(key, { resolve, reject });
				writeLine(event);
			}),
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
