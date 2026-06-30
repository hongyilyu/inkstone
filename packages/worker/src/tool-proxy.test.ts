import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import type { RunEvent, WorkerManifest } from "@inkstone/protocol";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { type InterpreterDeps, runInterpreter } from "./interpreter.js";
import {
	type CapturedToolRequest,
	InMemoryTransport,
} from "./transport-memory.js";

afterEach(() => {
	delete process.env.INKSTONE_WORKER_TOOL_CALL_LOG;
});

// Each test builds a fresh faux provider on its own `Models` collection (pi-ai
// 0.80.2's `fauxProvider` is instance-scoped — no process-global registry to
// tear down between tests).
function fauxDeps(faux: ReturnType<typeof fauxProvider>): InterpreterDeps {
	const models = createModels();
	models.setProvider(faux.provider);
	return {
		resolveModel: () => faux.getModel(),
		streamFn: (model, context, options) =>
			models.streamSimple(model, context, options),
	};
}

function manifestWithReadThread(): WorkerManifest {
	return {
		run_id: "01900000-0000-7000-8000-000000000abc",
		workflow: {
			name: "default",
			version: "1.0.0",
			provider: "faux",
			model: "faux-1",
			system_prompt: "You can read threads.",
			thinking_level: "off",
			tools: [
				{
					name: "read_thread",
					description: "Read a thread by id",
					label: "Read thread",
					json_schema: {
						type: "object",
						properties: { thread_id: { type: "string" } },
						required: ["thread_id"],
					},
				},
			],
		},
		prompt: "read thread T-1",
		messages: [],
	};
}

describe("tool proxy round-trip via WorkerTransport (faux provider)", () => {
	it("round-trips a model tool call through the transport's callTool and feeds the scripted result back to the loop", async () => {
		const tmp = mkdtempSync(path.join(tmpdir(), "inkstone-tool-log-"));
		process.env.INKSTONE_WORKER_TOOL_CALL_LOG = path.join(
			tmp,
			"tool-calls.jsonl",
		);
		const faux = fauxProvider({ provider: "faux" });
		// Turn 1: model calls read_thread. Turn 2: final text answer reflecting the scripted result.
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("read_thread", { thread_id: "T-1" }, { id: "tc1" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("here is the thread"),
		]);

		const deps = fauxDeps(faux);

		// The seam supplies the scripted Tool Result (keyed by tool_call_id) and records the outbound tool_request (ADR-0027).
		const events: RunEvent[] = [];
		const requests: CapturedToolRequest[] = [];
		await Effect.runPromise(
			runInterpreter(manifestWithReadThread(), deps).pipe(
				Effect.provide(
					InMemoryTransport(events, {
						results: {
							tc1: {
								ok: {
									content: [
										{
											type: "text",
											text: '{"messages":[{"role":"user","text":"hi from T-1"}]}',
										},
									],
								},
							},
						},
						requests,
					}),
				),
			),
		);

		expect(requests).toEqual([
			{ toolCallId: "tc1", name: "read_thread", params: { thread_id: "T-1" } },
		]);
		const logged = readFileSync(
			process.env.INKSTONE_WORKER_TOOL_CALL_LOG,
			"utf8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(logged).toEqual([
			{
				tool_call_id: "tc1",
				name: "read_thread",
				params: { thread_id: "T-1" },
			},
		]);
		rmSync(tmp, { recursive: true, force: true });

		const text = events
			.filter(
				(e): e is { kind: "text_delta"; delta: string } =>
					e.kind === "text_delta",
			)
			.map((e) => e.delta)
			.join("");
		expect(text).toContain("here is the thread");

		expect(events[events.length - 1]).toEqual({ kind: "done" });
	});

	it("a callTool error throws into the loop without crashing the run", async () => {
		const faux = fauxProvider({ provider: "faux" });
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("read_thread", { thread_id: "nope" }, { id: "tc_err" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("could not read it"),
		]);

		const deps = fauxDeps(faux);

		const events: RunEvent[] = [];
		const requests: CapturedToolRequest[] = [];
		await Effect.runPromise(
			runInterpreter(manifestWithReadThread(), deps).pipe(
				Effect.provide(
					InMemoryTransport(events, {
						results: {
							tc_err: { err: { code: "not_found", message: "no such thread" } },
						},
						requests,
					}),
				),
			),
		);

		// The `err` outcome makes the proxy throw; pi converts it to an error tool result the model recovers from, so the Run still terminates.
		expect(requests).toHaveLength(1);
		const terminal = events[events.length - 1];
		expect(terminal.kind === "done" || terminal.kind === "error").toBe(true);
	});
});
