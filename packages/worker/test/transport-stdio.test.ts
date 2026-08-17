import { PassThrough, Writable } from "node:stream";
import type { WorkerRunEvent } from "@inkstone/protocol";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ManifestParseError, WorkerTransport } from "../src/transport.js";
import { makeStdioTransport } from "../src/transport-stdio.js";

// A Writable that records everything written, so the test can assert the exact NDJSON frames the transport emitted.
function capturingWritable(): { output: Writable; written: () => string } {
	const chunks: string[] = [];
	const output = new Writable({
		write(chunk, _enc, cb) {
			chunks.push(chunk.toString());
			cb();
		},
	});
	return { output, written: () => chunks.join("") };
}

const validWorkflow = {
	name: "default",
	version: "1.0.0",
	provider: "faux",
	model: "faux-1",
	system_prompt: "You are a test assistant.",
	thinking_level: "off",
	tools: [],
};

const manifestJson = JSON.stringify({
	run_id: "01900000-0000-7000-8000-000000000abc",
	workflow: validWorkflow,
	prompt: "hello",
	messages: [],
});

describe("StdioTransportLive (over injected streams)", () => {
	it("reads+decodes the manifest, emits NDJSON, and round-trips a tool call", async () => {
		const input = new PassThrough();
		const { output, written } = capturingWritable();
		// The manifest is the FIRST line on stdin (ADR-0013).
		input.write(`${manifestJson}\n`);

		const program = Effect.gen(function* () {
			const t = yield* WorkerTransport;

			const manifest = yield* t.readManifest;

			t.emit({ kind: "text_delta", delta: "hi" } satisfies WorkerRunEvent);

			// callTool writes a tool_request, then resolves when the matching tool_result line arrives on stdin (bidirectional, ADR-0006).
			const respPromise = t.callTool("tc1", "read_thread", {
				thread_id: "x",
			});
			input.write(
				`${JSON.stringify({
					kind: "tool_result",
					run_id: "01900000-0000-7000-8000-000000000abc",
					tool_call_id: "tc1",
					outcome: { ok: { content: [{ type: "text", text: "ok" }] } },
				})}\n`,
			);
			const resp = yield* Effect.promise(() => respPromise);

			return { manifest, resp };
		});

		const { manifest, resp } = await Effect.runPromise(
			program.pipe(Effect.provide(makeStdioTransport(input, output))),
		);

		expect(manifest?.workflow.provider).toBe("faux");
		expect(manifest?.prompt).toBe("hello");

		const frames = written()
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(frames).toContainEqual({ kind: "text_delta", delta: "hi" });
		expect(frames).toContainEqual({
			kind: "tool_request",
			run_id: "01900000-0000-7000-8000-000000000abc",
			tool_call_id: "tc1",
			name: "read_thread",
			params: { thread_id: "x" },
		});

		expect(resp).toEqual({ ok: { content: [{ type: "text", text: "ok" }] } });
	});

	it("round-trips external lifecycle ACKs and rejects a NACK without Core detail", async () => {
		const input = new PassThrough();
		const { output, written } = capturingWritable();
		input.write(`${manifestJson}\n`);

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const t = yield* WorkerTransport;
				yield* t.readManifest;

				const started = t.syncExternalTool({
					kind: "external_tool_started",
					tool_call_id: "tc-ext",
					name: "ticktick_filter_tasks",
					arguments: { filter: { status: [0] } },
				});
				input.write(
					`${JSON.stringify({
						kind: "external_tool_ack",
						tool_call_id: "tc-ext",
						phase: "started",
						ok: true,
					})}\n`,
				);
				yield* Effect.promise(() => started);

				const finished = t.syncExternalTool({
					kind: "external_tool_finished",
					tool_call_id: "tc-ext",
					result: {
						content: [{ type: "text", text: "one task" }],
						is_error: false,
					},
				});
				input.write(
					`${JSON.stringify({
						kind: "external_tool_ack",
						tool_call_id: "tc-ext",
						phase: "finished",
						ok: false,
					})}\n`,
				);
				return yield* Effect.promise(() =>
					finished.then(
						() => ({ rejected: false, message: "" }),
						(error: unknown) => ({
							rejected: true,
							message: error instanceof Error ? error.message : String(error),
						}),
					),
				);
			}).pipe(Effect.provide(makeStdioTransport(input, output))),
		);

		expect(result).toEqual({
			rejected: true,
			message: "Core rejected an external tool lifecycle frame",
		});
		const frames = written()
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(frames.map((frame) => frame.kind)).toEqual([
			"external_tool_started",
			"external_tool_finished",
		]);
	});

	it("settles the pending call LOUD when an inbound tool_result fails schema decode", async () => {
		const input = new PassThrough();
		const { output } = capturingWritable();
		input.write(`${manifestJson}\n`);

		const program = Effect.gen(function* () {
			const t = yield* WorkerTransport;
			yield* t.readManifest;

			const respPromise = t.callTool("tc1", "read_thread", { thread_id: "x" });
			// A frame that parses as JSON and carries the correlation id, but whose
			// outcome is neither a valid `ok` nor `err` — the skew a truthiness guard
			// would wave through, resolving the call with junk that later throws and
			// gets misattributed. The strict seam must instead settle it loud.
			input.write(
				`${JSON.stringify({
					kind: "tool_result",
					run_id: "01900000-0000-7000-8000-000000000abc",
					tool_call_id: "tc1",
					outcome: {},
				})}\n`,
			);
			return yield* Effect.promise(() => respPromise);
		});

		const resp = await Effect.runPromise(
			program.pipe(Effect.provide(makeStdioTransport(input, output))),
		);

		expect(resp).toMatchObject({ err: { code: "tool_result_decode_error" } });
	});

	it("readManifest returns null on empty stdin (closed with no line)", async () => {
		const input = new PassThrough();
		const { output } = capturingWritable();
		input.end(); // stdin closes before any line — the empty-stdin path.

		const manifest = await Effect.runPromise(
			Effect.gen(function* () {
				const t = yield* WorkerTransport;
				return yield* t.readManifest;
			}).pipe(Effect.provide(makeStdioTransport(input, output))),
		);

		expect(manifest).toBeNull();
	});

	it("readManifest fails with ManifestParseError on a malformed manifest line", async () => {
		const input = new PassThrough();
		const { output } = capturingWritable();
		// Valid JSON, but not a WorkerManifest (Schema decode fails).
		input.write(`${JSON.stringify({ not: "a manifest" })}\n`);

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const t = yield* WorkerTransport;
				return yield* Effect.either(t.readManifest);
			}).pipe(Effect.provide(makeStdioTransport(input, output))),
		);

		expect(result._tag).toBe("Left");
		if (result._tag === "Left") {
			expect(result.left).toBeInstanceOf(ManifestParseError);
		}
	});

	it("never leaks manifest secrets into a schema-failure message (review R10 #1)", async () => {
		const input = new PassThrough();
		const { output } = capturingWritable();
		// A REAL token beside a malformed field: Effect Schema's default tree
		// formatter would print the actual `external_tools` object — token
		// included — and this message becomes the persisted run error_message.
		const token = "tok_SECRET_do_not_leak";
		input.write(
			`${JSON.stringify({
				run_id: "01900000-0000-7000-8000-0000000000aa",
				external_tools: { endpoint: 123, access_token: token },
			})}\n`,
		);

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const t = yield* WorkerTransport;
				return yield* Effect.either(t.readManifest);
			}).pipe(Effect.provide(makeStdioTransport(input, output))),
		);

		expect(result._tag).toBe("Left");
		if (result._tag === "Left") {
			expect(result.left.message).not.toContain(token);
			expect(result.left.message).not.toContain("tok_");
			// Still diagnosable: the failing paths are named (values are not).
			expect(result.left.message).toContain("schema validation");
		}
	});

	it("never leaks the raw line into a JSON-syntax failure message (review R10 #1)", async () => {
		const input = new PassThrough();
		const { output } = capturingWritable();
		// Node's JSON.parse SyntaxError quotes a snippet of its input — which
		// here contains the token — so the message must be fully static.
		const token = "tok_SECRET_do_not_leak";
		input.write(`{"access_token": "${token}", not json\n`);

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const t = yield* WorkerTransport;
				return yield* Effect.either(t.readManifest);
			}).pipe(Effect.provide(makeStdioTransport(input, output))),
		);

		expect(result._tag).toBe("Left");
		if (result._tag === "Left") {
			expect(result.left.message).not.toContain(token);
			expect(result.left.message).toBe("manifest line is not valid JSON");
		}
	});

	it("salvages run_id onto ManifestParseError when the JSON parses but fails schema (#146)", async () => {
		const input = new PassThrough();
		const { output } = capturingWritable();
		const runId = "01900000-0000-7000-8000-00000000beef";
		// Valid JSON carrying run_id, but schema decode fails on another field
		// (thinking_level) — the mirror-skew case whose diagnostic line must still join.
		input.write(
			`${JSON.stringify({
				run_id: runId,
				workflow: { ...validWorkflow, thinking_level: "turbo" },
				prompt: "hi",
				messages: [],
			})}\n`,
		);

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const t = yield* WorkerTransport;
				return yield* Effect.either(t.readManifest);
			}).pipe(Effect.provide(makeStdioTransport(input, output))),
		);

		expect(result._tag).toBe("Left");
		if (result._tag === "Left") {
			expect(result.left).toBeInstanceOf(ManifestParseError);
			expect((result.left as ManifestParseError).runId).toBe(runId);
		}
	});

	it("leaves run_id undefined on ManifestParseError when the line is not valid JSON", async () => {
		const input = new PassThrough();
		const { output } = capturingWritable();
		input.write("this is not json\n");

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const t = yield* WorkerTransport;
				return yield* Effect.either(t.readManifest);
			}).pipe(Effect.provide(makeStdioTransport(input, output))),
		);

		expect(result._tag).toBe("Left");
		if (result._tag === "Left") {
			expect((result.left as ManifestParseError).runId).toBeUndefined();
		}
	});
});
