import type { RunEvent } from "@inkstone/protocol";
import { Effect } from "effect";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { makeStdioTransport } from "./transport-stdio.js";
import { ManifestParseError, WorkerTransport } from "./transport.js";

// A Writable that records everything written to it, so the test can assert the
// exact NDJSON frames the transport emitted.
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

const manifestJson = JSON.stringify({
	workflow: {
		name: "default",
		version: "1.0.0",
		provider: "faux",
		model: "faux-1",
		system_prompt: "You are a test assistant.",
		thinking_level: "off",
		tools: [],
	},
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

			// readManifest decodes the first line via Schema.
			const manifest = yield* t.readManifest;

			// emit writes a one-way Run Event as NDJSON to stdout.
			t.emit({ kind: "text_delta", delta: "hi" } satisfies RunEvent);

			// callTool writes a tool_request, then resolves when the matching
			// tool_result line arrives on stdin (bidirectional, ADR-0006).
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

		// readManifest decoded the manifest.
		expect(manifest?.workflow.provider).toBe("faux");
		expect(manifest?.prompt).toBe("hello");

		// emit wrote the Run Event frame; callTool wrote the tool_request frame.
		const frames = written()
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(frames).toContainEqual({ kind: "text_delta", delta: "hi" });
		expect(frames).toContainEqual({
			kind: "tool_request",
			run_id: "",
			tool_call_id: "tc1",
			name: "read_thread",
			params: { thread_id: "x" },
		});

		// callTool resolved with the scripted Tool Result from the stdin line.
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
});
