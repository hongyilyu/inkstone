import {
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
	streamSimple,
} from "@earendil-works/pi-ai";
import type { RunEvent, WorkerManifest } from "@inkstone/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CallTool,
	type Emit,
	type InterpreterDeps,
	runInterpreter,
} from "./interpreter.js";

// Each test registers a fresh faux provider and tears it down after.
const registrations: Array<{ unregister: () => void }> = [];
afterEach(() => {
	for (const r of registrations.splice(0)) r.unregister();
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

describe("tool proxy round-trip (faux provider)", () => {
	it("routes a model tool call through callTool and feeds the result back to the loop", async () => {
		const faux = registerFauxProvider({ provider: "faux" });
		registrations.push(faux);
		// Turn 1: the model calls read_thread. Turn 2 (after the tool result):
		// a final text answer.
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("read_thread", { thread_id: "T-1" }, { id: "tc_01" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("here is the thread"),
		]);

		const calls: Array<{ toolCallId: string; name: string; params: unknown }> = [];
		const callTool: CallTool = async (toolCallId, name, params) => {
			calls.push({ toolCallId, name, params });
			return {
				ok: {
					content: [
						{ type: "text", text: '{"messages":[{"role":"user","text":"hi from T-1"}]}' },
					],
				},
			};
		};

		const deps: InterpreterDeps = {
			resolveModel: () => faux.getModel(),
			streamFn: streamSimple,
			callTool,
		};

		const events: RunEvent[] = [];
		const emit: Emit = (e) => events.push(e);
		await runInterpreter(manifestWithReadThread(), emit, deps);

		// The proxy round-tripped exactly the model's tool call.
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			toolCallId: "tc_01",
			name: "read_thread",
			params: { thread_id: "T-1" },
		});

		// The loop fed the result back and produced the follow-up answer + done.
		const text = events
			.filter((e): e is { kind: "text_delta"; delta: string } => e.kind === "text_delta")
			.map((e) => e.delta)
			.join("");
		expect(text).toContain("here is the thread");
		expect(events[events.length - 1]).toEqual({ kind: "done" });
	});

	it("a callTool error throws into the loop without crashing the run", async () => {
		const faux = registerFauxProvider({ provider: "faux" });
		registrations.push(faux);
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("read_thread", { thread_id: "nope" }, { id: "tc_02" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("could not read it"),
		]);

		const callTool: CallTool = async () => ({
			err: { code: "not_found", message: "no such thread" },
		});

		const deps: InterpreterDeps = {
			resolveModel: () => faux.getModel(),
			streamFn: streamSimple,
			callTool,
		};

		const events: RunEvent[] = [];
		const emit: Emit = (e) => events.push(e);
		await runInterpreter(manifestWithReadThread(), emit, deps);

		// The Run reaches a terminal event (the thrown tool error became a
		// tool result the model recovered from); it did not crash.
		const terminal = events[events.length - 1];
		expect(terminal.kind === "done" || terminal.kind === "error").toBe(true);
	});
});
