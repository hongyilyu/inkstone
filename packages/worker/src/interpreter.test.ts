import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
} from "@earendil-works/pi-ai";
import type { RunEvent, WorkerManifest } from "@inkstone/protocol";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { fauxInterpreterDeps } from "./faux/faux-deps.js";
import { type InterpreterDeps, runInterpreter } from "./interpreter.js";
import {
	type CapturedToolRequest,
	InMemoryTransport,
} from "./transport-memory.js";

// Each test builds a fresh faux provider on its own `Models` collection (pi-ai
// 0.80.2's `fauxProvider` is instance-scoped — no process-global registry — so
// there is nothing to unregister between tests). See `faux/faux-deps.ts`.
const fauxDeps = fauxInterpreterDeps;

function fauxManifest(overrides: Partial<WorkerManifest> = {}): WorkerManifest {
	return {
		run_id: "01900000-0000-7000-8000-000000000abc",
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

// Drive the interpreter through an InMemoryTransport and return the Run Events the seam captured (ADR-0027).
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
		const faux = fauxProvider({ provider: "faux" });
		faux.setResponses([fauxAssistantMessage("hello")]);

		const deps = fauxDeps(faux);

		const events = await runChat(fauxManifest(), deps);

		expect(events).toEqual([
			{ kind: "text_delta", delta: "hello" },
			{ kind: "done" },
		]);
	});

	it("surfaces a faux error as the error event, not done", async () => {
		const faux = fauxProvider({ provider: "faux" });
		faux.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "provider exploded",
			}),
		]);

		const deps = fauxDeps(faux);

		const events = await runChat(fauxManifest(), deps);

		const terminal = events[events.length - 1];
		expect(terminal).toEqual({ kind: "error", message: "provider exploded" });
		expect(events.some((e) => e.kind === "done")).toBe(false);
	});

	it("resumes from a tool_result transcript", async () => {
		// resume-transcript invariant — see docs/design/worker-tests.md
		const faux = fauxProvider({
			provider: "faux",
			tokenSize: { min: 1, max: 2 },
		});

		let sawToolResult = false;
		let sawToolCall = false;
		// tool_result must be paired to a PRECEDING tool_call of matching id — see docs/design/worker-tests.md
		let pairedToPrecedingToolCall = false;
		faux.setResponses([
			(context) => {
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

		const deps = fauxDeps(faux);

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
				{
					role: "user",
					text: "I bought milk after daycare pickup and felt relieved.",
				},
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

		// Drive through the seam directly to assert no tool round-tripped: empty result table plus a `requests` log.
		const events: RunEvent[] = [];
		const requests: CapturedToolRequest[] = [];
		await Effect.runPromise(
			runInterpreter(manifest, deps).pipe(
				Effect.provide(InMemoryTransport(events, { results: {}, requests })),
			),
		);

		const terminal = events[events.length - 1];
		expect(terminal).toEqual({ kind: "done" });
		expect(events.some((e) => e.kind === "error")).toBe(false);
		expect(events.filter((e) => e.kind === "done")).toHaveLength(1);

		const text = events
			.filter(
				(e): e is { kind: "text_delta"; delta: string } =>
					e.kind === "text_delta",
			)
			.map((e) => e.delta)
			.join("");
		expect(text).toBe("Done — added it.");

		// tool_call + tool_result both reached the model, paired by preceding id — see docs/design/worker-tests.md
		expect(sawToolCall).toBe(true);
		expect(sawToolResult).toBe(true);
		expect(pairedToPrecedingToolCall).toBe(true);

		// Seeded tool NOT re-executed on resume: no outbound tool_request.
		expect(requests).toHaveLength(0);
	});

	it("passes prior history into the loop context", async () => {
		// The faux response factory inspects its context, proving the manifest's assembled history reached the provider.
		const faux = fauxProvider({ provider: "faux" });
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

		const deps = fauxDeps(faux);

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

	it("emits thinking as reasoning_delta, distinct from text", async () => {
		// Faux chunks deltas (tokenSize) like the resume test — join reasoning_delta deltas to compare.
		const faux = fauxProvider({
			provider: "faux",
			tokenSize: { min: 1, max: 2 },
		});
		faux.setResponses([
			fauxAssistantMessage([
				fauxThinking("Let me check the schema."),
				fauxText("Done."),
			]),
		]);

		const deps = fauxDeps(faux);

		const events = await runChat(fauxManifest(), deps);

		const reasoning = events
			.filter(
				(e): e is { kind: "reasoning_delta"; delta: string } =>
					e.kind === "reasoning_delta",
			)
			.map((e) => e.delta)
			.join("");
		expect(reasoning).toBe("Let me check the schema.");

		const text = events
			.filter(
				(e): e is { kind: "text_delta"; delta: string } =>
					e.kind === "text_delta",
			)
			.map((e) => e.delta)
			.join("");
		expect(text).toBe("Done.");

		expect(events[events.length - 1]).toEqual({ kind: "done" });
	});

	it("emits no reasoning_delta when there is no thinking block", async () => {
		const faux = fauxProvider({ provider: "faux" });
		faux.setResponses([fauxAssistantMessage("hi")]);

		const deps = fauxDeps(faux);

		const events = await runChat(fauxManifest(), deps);

		expect(events.some((e) => e.kind === "reasoning_delta")).toBe(false);
	});

	it("drops redacted reasoning but keeps the reply text", async () => {
		// Anthropic delivers the "[Reasoning redacted]" placeholder as one block, not
		// character-streamed — a large tokenSize makes faux emit it as a single delta so
		// the per-delta guard sees the whole sentinel (faux's default chunking is a test
		// artifact that would split it across deltas).
		const faux = fauxProvider({
			provider: "faux",
			tokenSize: { min: 100, max: 100 },
		});
		faux.setResponses([
			fauxAssistantMessage([
				fauxThinking("[Reasoning redacted]"),
				fauxText("ok"),
			]),
		]);

		const deps = fauxDeps(faux);

		const events = await runChat(fauxManifest(), deps);

		expect(events.some((e) => e.kind === "reasoning_delta")).toBe(false);

		const text = events
			.filter(
				(e): e is { kind: "text_delta"; delta: string } =>
					e.kind === "text_delta",
			)
			.map((e) => e.delta)
			.join("");
		expect(text).toBe("ok");
		expect(events[events.length - 1]).toEqual({ kind: "done" });
	});
});
