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
