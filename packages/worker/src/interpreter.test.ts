import {
	fauxAssistantMessage,
	registerFauxProvider,
	streamSimple,
} from "@earendil-works/pi-ai";
import type { WorkerManifest } from "@inkstone/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type Emit, type InterpreterDeps, runInterpreter } from "./interpreter.js";

// Each test registers a fresh faux provider and tears it down after, so the
// pi-ai global api-registry never leaks a provider across tests.
const registrations: Array<{ unregister: () => void }> = [];
afterEach(() => {
	for (const r of registrations.splice(0)) r.unregister();
});

function fauxManifest(overrides: Partial<WorkerManifest> = {}): WorkerManifest {
	return {
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
		...overrides,
	};
}

function collect(): { emit: Emit; events: import("@inkstone/protocol").RunEvent[] } {
	const events: import("@inkstone/protocol").RunEvent[] = [];
	return { emit: (e) => events.push(e), events };
}

describe("generic interpreter (faux provider)", () => {
	it("streams a faux completion as text deltas then done", async () => {
		const faux = registerFauxProvider({ provider: "faux", tokenSize: { min: 1, max: 2 } });
		registrations.push(faux);
		faux.setResponses([fauxAssistantMessage("hello world")]);

		const deps: InterpreterDeps = {
			resolveModel: () => faux.getModel(),
			streamFn: streamSimple,
		};

		const { emit, events } = collect();
		await runInterpreter(fauxManifest(), emit, deps);

		const terminal = events[events.length - 1];
		expect(terminal).toEqual({ kind: "done" });

		const text = events
			.filter((e): e is { kind: "text_delta"; delta: string } => e.kind === "text_delta")
			.map((e) => e.delta)
			.join("");
		expect(text).toBe("hello world");

		// No error event on the happy path.
		expect(events.some((e) => e.kind === "error")).toBe(false);
	});

	it("surfaces a faux error as the error event, not done", async () => {
		const faux = registerFauxProvider({ provider: "faux" });
		registrations.push(faux);
		faux.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "provider exploded",
			}),
		]);

		const deps: InterpreterDeps = {
			resolveModel: () => faux.getModel(),
			streamFn: streamSimple,
		};

		const { emit, events } = collect();
		await runInterpreter(fauxManifest(), emit, deps);

		const terminal = events[events.length - 1];
		expect(terminal).toEqual({ kind: "error", message: "provider exploded" });
		expect(events.some((e) => e.kind === "done")).toBe(false);
	});

	it("resumes from a tool_result transcript", async () => {
		// ADR-0025: a `mode:"resume"` manifest whose typed-block transcript
		// ends in a `tool_result` drives `runAgentLoopContinue`. The seeded
		// transcript is provider-valid: the assistant `tool_call` precedes its
		// `tool_result`, ids match. The seeded tool is NOT re-executed.
		const faux = registerFauxProvider({ provider: "faux", tokenSize: { min: 1, max: 2 } });
		registrations.push(faux);

		let sawToolResult = false;
		let sawToolCall = false;
		faux.setResponses([
			(context) => {
				// Read the live context the REAL transform produced, proving
				// the seeded transcript reached the model with NO orphan
				// rejection.
				sawToolResult = context.messages.some((m) => m.role === "toolResult");
				sawToolCall = context.messages.some(
					(m) =>
						m.role === "assistant" &&
						Array.isArray(m.content) &&
						m.content.some((c) => "type" in c && c.type === "toolCall"),
				);
				return fauxAssistantMessage("Done — added it.");
			},
		]);

		// If the seeded tool were re-executed, this callTool would fire; the
		// resume path must NOT invoke it.
		let callToolInvoked = false;
		const deps: InterpreterDeps = {
			resolveModel: () => faux.getModel(),
			streamFn: streamSimple,
			callTool: async () => {
				callToolInvoked = true;
				return { ok: { content: [{ type: "text", text: "unexpected" }] } };
			},
		};

		const manifest = fauxManifest({
			mode: "resume",
			prompt: "",
			workflow: {
				name: "default",
				version: "1.0.0",
				provider: "faux",
				model: "faux-1",
				system_prompt: "You are a test assistant.",
				thinking_level: "off",
				tools: [
					{
						name: "propose_entity",
						description: "Propose an entity for approval.",
						label: "Propose entity",
						json_schema: { type: "object", properties: {} },
					},
				],
			},
			messages: [
				{ role: "user", text: "remember to buy milk" },
				{
					role: "assistant",
					tool_calls: [
						{
							id: "tc_1",
							name: "propose_entity",
							arguments: { type: "todo", data: { title: "buy milk" } },
						},
					],
				},
				{
					role: "tool_result",
					tool_call_id: "tc_1",
					content: 'Accepted. Created Todo "buy milk".',
				},
			],
		});

		const { emit, events } = collect();
		await runInterpreter(manifest, emit, deps);

		// Exactly one terminal `done`, no error.
		const terminal = events[events.length - 1];
		expect(terminal).toEqual({ kind: "done" });
		expect(events.some((e) => e.kind === "error")).toBe(false);
		expect(events.filter((e) => e.kind === "done")).toHaveLength(1);

		// The faux continuation streamed as text deltas.
		const text = events
			.filter((e): e is { kind: "text_delta"; delta: string } => e.kind === "text_delta")
			.map((e) => e.delta)
			.join("");
		expect(text).toBe("Done — added it.");

		// The model saw the seeded transcript through the real transform: the
		// assistant tool_call AND its tool_result both reached it (no orphan
		// rejection).
		expect(sawToolCall).toBe(true);
		expect(sawToolResult).toBe(true);

		// The seeded tool was NOT re-executed on resume.
		expect(callToolInvoked).toBe(false);
	});

	it("passes prior history into the loop context", async () => {
		// The faux response factory can inspect the context it received,
		// proving the manifest's assembled history reached the provider.
		const faux = registerFauxProvider({ provider: "faux" });
		registrations.push(faux);
		let seenUserTexts: string[] = [];
		faux.setResponses([
			(context) => {
				seenUserTexts = context.messages
					.filter((m) => m.role === "user")
					.map((m) =>
						typeof m.content === "string"
							? m.content
							: m.content.map((c) => ("text" in c ? c.text : "")).join(""),
					);
				return fauxAssistantMessage("ack");
			},
		]);

		const deps: InterpreterDeps = {
			resolveModel: () => faux.getModel(),
			streamFn: streamSimple,
		};

		const manifest = fauxManifest({
			prompt: "current question",
			messages: [
				{ role: "user", text: "earlier question" },
				{ role: "assistant", text: "earlier answer" },
			],
		});

		const { emit } = collect();
		await runInterpreter(manifest, emit, deps);

		expect(seenUserTexts).toContain("earlier question");
		expect(seenUserTexts).toContain("current question");
	});
});
