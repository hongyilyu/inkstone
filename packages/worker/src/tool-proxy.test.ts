import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
	streamSimple,
} from "@earendil-works/pi-ai";
import type { RunEvent, WorkerManifest } from "@inkstone/protocol";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { type InterpreterDeps, runInterpreter } from "./interpreter.js";
import {
	type CapturedToolRequest,
	InMemoryTransport,
} from "./transport-memory.js";

// Each test registers a fresh faux provider and tears it down after.
const registrations: Array<{ unregister: () => void }> = [];
afterEach(() => {
	for (const r of registrations.splice(0)) r.unregister();
	delete process.env.INKSTONE_WORKER_TOOL_CALL_LOG;
});

function manifestWithReadThread(): WorkerManifest {
	return {
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
		const faux = registerFauxProvider({ provider: "faux" });
		registrations.push(faux);
		// Turn 1: the model calls read_thread. Turn 2 (after the tool result):
		// a final text answer that reflects the scripted result.
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("read_thread", { thread_id: "T-1" }, { id: "tc1" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("here is the thread"),
		]);

		const deps: InterpreterDeps = {
			resolveModel: () => faux.getModel(),
			streamFn: streamSimple,
		};

		// The seam supplies the Tool Result (scripted, keyed by tool_call_id) and
		// records the outbound tool_request — no loose `deps.callTool` (ADR-0027).
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

		// (a) The transport captured exactly the model's outbound tool_request.
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

		// (b) The loop fed the scripted result back; the follow-up answer reflects it.
		const text = events
			.filter(
				(e): e is { kind: "text_delta"; delta: string } =>
					e.kind === "text_delta",
			)
			.map((e) => e.delta)
			.join("");
		expect(text).toContain("here is the thread");

		// (c) The terminal event is done.
		expect(events[events.length - 1]).toEqual({ kind: "done" });
	});

	it("a callTool error throws into the loop without crashing the run", async () => {
		const faux = registerFauxProvider({ provider: "faux" });
		registrations.push(faux);
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("read_thread", { thread_id: "nope" }, { id: "tc_err" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("could not read it"),
		]);

		const deps: InterpreterDeps = {
			resolveModel: () => faux.getModel(),
			streamFn: streamSimple,
		};

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

		// The proxy round-tripped the request; the `err` outcome made the proxy
		// throw, which pi converts into an error tool result the model recovered
		// from — the Run still reaches a terminal event without crashing.
		expect(requests).toHaveLength(1);
		const terminal = events[events.length - 1];
		expect(terminal.kind === "done" || terminal.kind === "error").toBe(true);
	});
});
