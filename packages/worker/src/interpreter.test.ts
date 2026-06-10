import {
	fauxAssistantMessage,
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

// Drive the interpreter through an InMemoryTransport on a test runtime and
// return the Run Events the seam captured (ADR-0027).
function runChat(
	manifest: WorkerManifest,
	deps: InterpreterDeps,
): Promise<RunEvent[]> {
	const captured: RunEvent[] = [];
	return Effect.runPromise(
		runInterpreter(manifest, deps).pipe(
			Effect.provide(InMemoryTransport(captured)),
		),
	).then(() => captured);
}

describe("generic interpreter (faux provider)", () => {
	it("emits a faux completion as text_delta then done through the transport", async () => {
		const faux = registerFauxProvider({ provider: "faux" });
		registrations.push(faux);
		faux.setResponses([fauxAssistantMessage("hello")]);

		const deps: InterpreterDeps = {
			resolveModel: () => faux.getModel(),
			streamFn: streamSimple,
		};

		const events = await runChat(fauxManifest(), deps);

		// The seam captured exactly the streamed delta then the terminal done.
		expect(events).toEqual([
			{ kind: "text_delta", delta: "hello" },
			{ kind: "done" },
		]);
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

		const events = await runChat(fauxManifest(), deps);

		const terminal = events[events.length - 1];
		expect(terminal).toEqual({ kind: "error", message: "provider exploded" });
		expect(events.some((e) => e.kind === "done")).toBe(false);
	});

	it("resumes from a tool_result transcript", async () => {
		// ADR-0025: a `mode:"resume"` manifest whose typed-block transcript
		// ends in a `tool_result` drives `runAgentLoopContinue`. The seeded
		// transcript is provider-valid: the assistant `tool_call` precedes its
		// `tool_result`, ids match. The seeded tool is NOT re-executed.
		const faux = registerFauxProvider({
			provider: "faux",
			tokenSize: { min: 1, max: 2 },
		});
		registrations.push(faux);

		let sawToolResult = false;
		let sawToolCall = false;
		// Stronger than presence: the seeded `tool_result` must be paired to a
		// `tool_call` of matching id in a PRECEDING assistant message — the exact
		// ordering+id invariant a real provider enforces (an orphan/reordered
		// `toolResult` is rejected). Guards slice 3's reconstruction.
		let pairedToPrecedingToolCall = false;
		faux.setResponses([
			(context) => {
				// Read the live context the REAL transform produced, proving
				// the seeded transcript reached the model with NO orphan
				// rejection.
				const msgs = context.messages;
				const trIdx = msgs.findIndex((m) => m.role === "toolResult");
				sawToolResult = trIdx >= 0;
				sawToolCall = msgs.some(
					(m) =>
						m.role === "assistant" &&
						Array.isArray(m.content) &&
						m.content.some((c) => "type" in c && c.type === "toolCall"),
				);
				if (trIdx >= 0) {
					const resultId = (msgs[trIdx] as { toolCallId?: string }).toolCallId;
					pairedToPrecedingToolCall =
						typeof resultId === "string" &&
						resultId.length > 0 &&
						msgs
							.slice(0, trIdx)
							.some(
								(m) =>
									m.role === "assistant" &&
									Array.isArray(m.content) &&
									m.content.some(
										(c) =>
											"type" in c &&
											c.type === "toolCall" &&
											(c as { id?: string }).id === resultId,
									),
							);
				}
				return fauxAssistantMessage("Done — added it.");
			},
		]);

		const deps: InterpreterDeps = {
			resolveModel: () => faux.getModel(),
			streamFn: streamSimple,
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
						name: "propose_workspace_mutation",
						description: "Propose a Workspace mutation for approval.",
						label: "Propose Workspace mutation",
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
							name: "propose_workspace_mutation",
							arguments: {
								mutation_kind: "create_journal_entry",
								payload: {
									occurred_at: "2026-06-10T10:30:00",
									body: [{ type: "text", text: "Bought milk." }],
								},
							},
						},
					],
				},
				{
					role: "tool_result",
					tool_call_id: "tc_1",
					content: "Accepted. Created Journal Entry.",
				},
			],
		});

		// Drive through the seam directly so the test can assert no tool was
		// round-tripped: an empty scripted result table plus a `requests` log.
		const events: RunEvent[] = [];
		const requests: CapturedToolRequest[] = [];
		await Effect.runPromise(
			runInterpreter(manifest, deps).pipe(
				Effect.provide(InMemoryTransport(events, { results: {}, requests })),
			),
		);

		// Exactly one terminal `done`, no error.
		const terminal = events[events.length - 1];
		expect(terminal).toEqual({ kind: "done" });
		expect(events.some((e) => e.kind === "error")).toBe(false);
		expect(events.filter((e) => e.kind === "done")).toHaveLength(1);

		// The faux continuation streamed as text deltas.
		const text = events
			.filter(
				(e): e is { kind: "text_delta"; delta: string } =>
					e.kind === "text_delta",
			)
			.map((e) => e.delta)
			.join("");
		expect(text).toBe("Done — added it.");

		// The model saw the seeded transcript through the real transform: the
		// assistant tool_call AND its tool_result both reached it (no orphan
		// rejection), and the tool_result is paired to a PRECEDING tool_call of
		// matching id — the ordering a real provider enforces.
		expect(sawToolCall).toBe(true);
		expect(sawToolResult).toBe(true);
		expect(pairedToPrecedingToolCall).toBe(true);

		// The seeded tool was NOT re-executed on resume: the seam saw no
		// outbound tool_request.
		expect(requests).toHaveLength(0);
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

		await runChat(manifest, deps);

		expect(seenUserTexts).toContain("earlier question");
		expect(seenUserTexts).toContain("current question");
	});
});
