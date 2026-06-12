import type { RunEvent, WorkerManifest } from "@inkstone/protocol";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { fauxDepsFor } from "./faux-worker.js";
import type { ToolCallResponse } from "./tool-proxy.js";
import { runInterpreter } from "./interpreter.js";
import type { CapturedToolRequest } from "./transport-memory.js";
import { InMemoryTransport } from "./transport-memory.js";

// `fauxDepsFor` reads `INKSTONE_FAUX_*` env vars at call time; clear them after each case so modes don't bleed.
const FAUX_ENV_KEYS = [
	"INKSTONE_FAUX_RESPONSE",
	"INKSTONE_FAUX_ERROR",
	"INKSTONE_FAUX_TOOL_CALL",
	"INKSTONE_FAUX_PROPOSE",
	"INKSTONE_FAUX_ECHO_HISTORY",
] as const;
afterEach(() => {
	for (const key of FAUX_ENV_KEYS) delete process.env[key];
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

const JOURNAL_INTAKE_TOOLS: WorkerManifest["workflow"]["tools"] = [
	{
		name: "read_current_thread_journal_entries",
		description: "Read accepted Journal Entries from the current thread.",
		label: "Read current thread journal entries",
		json_schema: {
			type: "object",
			properties: {},
		},
	},
	{
		name: "propose_workspace_mutation",
		description: "Propose a Workspace mutation for approval.",
		label: "Propose Workspace mutation",
		json_schema: {
			type: "object",
			properties: {},
		},
	},
];

function journalIntakeManifest(prompt: string): WorkerManifest {
	return fauxManifest({
		prompt,
		workflow: {
			name: "default",
			version: "1.0.0",
			provider: "faux",
			model: "faux-1",
			system_prompt: "You run the journal entry intake loop.",
			thinking_level: "off",
			tools: JOURNAL_INTAKE_TOOLS,
		},
	});
}

// Drive the interpreter with the faux entry's deps through an InMemoryTransport (ADR-0027), returning captured Run Events.
// `fauxDepsFor` registers a fresh faux provider per call (unique random `api`), so cases don't contaminate each other.
function runChat(
	manifest: WorkerManifest,
	results: Record<string, ToolCallResponse> = {},
): Promise<{ events: RunEvent[]; requests: CapturedToolRequest[] }> {
	const captured: RunEvent[] = [];
	const requests: CapturedToolRequest[] = [];
	return Effect.runPromise(
		runInterpreter(manifest, fauxDepsFor(manifest)).pipe(
			Effect.provide(InMemoryTransport(captured, { results, requests })),
		),
	).then(() => ({ events: captured, requests }));
}

describe("faux-worker dep-builder (test-only entry)", () => {
	it("scripts the faux provider from INKSTONE_FAUX_RESPONSE: text_delta then done", async () => {
		process.env.INKSTONE_FAUX_RESPONSE = "scripted faux reply";

		const { events } = await runChat(fauxManifest());

		// Reassemble deltas (as faux_run.rs does); faux/streamSimple chunk boundaries aren't fixed, so per-delta asserts flake.
		const text = events
			.filter((e) => e.kind === "text_delta")
			.map((e) => (e as { delta: string }).delta)
			.join("");
		expect(text).toBe("scripted faux reply");
		expect(events.at(-1)).toEqual({ kind: "done" });
	});

	it("scripts a faux error from INKSTONE_FAUX_ERROR: terminal error, not done", async () => {
		process.env.INKSTONE_FAUX_ERROR = "scripted boom";

		const { events } = await runChat(fauxManifest());

		const terminal = events[events.length - 1];
		expect(terminal).toEqual({ kind: "error", message: "scripted boom" });
		expect(events.some((e) => e.kind === "done")).toBe(false);
	});

	it("proposes a create_journal_entry directly for a normal journal prompt", async () => {
		process.env.INKSTONE_FAUX_PROPOSE = "1";

		const { events, requests } = await runChat(
			journalIntakeManifest(
				"I bought milk after daycare pickup and felt relieved.",
			),
			{
				tc_create: {
					ok: {
						content: [
							{
								type: "text",
								text: "Accepted. Created Journal Entry.",
							},
						],
					},
				},
			},
		);

		expect(requests).toEqual([
			{
				toolCallId: "tc_create",
				name: "propose_workspace_mutation",
				params: {
					mutation_kind: "create_journal_entry",
					payload: {
						occurred_at: "2026-06-10T10:30:00",
						body: [
							{
								type: "text",
								text: "Bought milk after daycare pickup.",
							},
						],
					},
					rationale: "the user shared a journal-worthy moment",
				},
			},
		]);
		expect(events.at(-1)).toEqual({ kind: "done" });
		expect(
			events
				.filter(
					(e): e is { kind: "text_delta"; delta: string } =>
						e.kind === "text_delta",
				)
				.map((e) => e.delta)
				.join(""),
		).toContain("Done — added it.");
	});

	it("treats 'actually' alone as a fresh create_journal_entry prompt", async () => {
		process.env.INKSTONE_FAUX_PROPOSE = "1";

		const { events, requests } = await runChat(
			journalIntakeManifest("Actually, I bought bread after work."),
			{
				tc_create: {
					ok: {
						content: [
							{
								type: "text",
								text: "Accepted. Created Journal Entry.",
							},
						],
					},
				},
			},
		);

		expect(requests).toEqual([
			{
				toolCallId: "tc_create",
				name: "propose_workspace_mutation",
				params: {
					mutation_kind: "create_journal_entry",
					payload: {
						occurred_at: "2026-06-10T10:30:00",
						body: [
							{
								type: "text",
								text: "Bought milk after daycare pickup.",
							},
						],
					},
					rationale: "the user shared a journal-worthy moment",
				},
			},
		]);
		expect(events.at(-1)).toEqual({ kind: "done" });
		expect(
			events
				.filter(
					(e): e is { kind: "text_delta"; delta: string } =>
						e.kind === "text_delta",
				)
				.map((e) => e.delta)
				.join(""),
		).toContain("Done — added it.");
	});

	it("reads current-thread entries before proposing an update_journal_entry", async () => {
		process.env.INKSTONE_FAUX_PROPOSE = "1";

		const { events, requests } = await runChat(
			journalIntakeManifest("Actually, for that entry, make it oat milk."),
			{
				tc_read_current: {
					ok: {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									entries: [
										{
											entity_id: "entry-1",
											occurred_at: "2026-06-10T10:30:00",
											body: [
												{
													type: "text",
													text: "Bought milk after daycare pickup.",
												},
											],
										},
									],
								}),
							},
						],
					},
				},
				tc_update: {
					ok: {
						content: [
							{
								type: "text",
								text: "Accepted. Updated Journal Entry.",
							},
						],
					},
				},
			},
		);

		expect(requests).toEqual([
			{
				toolCallId: "tc_read_current",
				name: "read_current_thread_journal_entries",
				params: {},
			},
			{
				toolCallId: "tc_update",
				name: "propose_workspace_mutation",
				params: {
					mutation_kind: "update_journal_entry",
					payload: {
						entity_id: "entry-1",
						occurred_at: "2026-06-10T10:30:00",
						body: [
							{
								type: "text",
								text: "Bought oat milk after daycare pickup.",
							},
						],
					},
					rationale: "the user corrected a Journal Entry from this Thread",
				},
			},
		]);
		expect(events.at(-1)).toEqual({ kind: "done" });
		expect(
			events
				.filter(
					(e): e is { kind: "text_delta"; delta: string } =>
						e.kind === "text_delta",
				)
				.map((e) => e.delta)
				.join(""),
		).toContain("Done — updated it.");
	});

	it("updates the current-thread body text instead of replaying stale milk text", async () => {
		process.env.INKSTONE_FAUX_PROPOSE = "1";

		const { requests } = await runChat(
			journalIntakeManifest("Actually, for that entry, make it bread."),
			{
				tc_read_current: {
					ok: {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									entries: [
										{
											entity_id: "entry-1",
											occurred_at: "2026-06-10T10:30:00",
											body: [
												{
													type: "text",
													text: "Bought milk after daycare pickup.",
												},
											],
										},
									],
								}),
							},
						],
					},
				},
				tc_update: {
					ok: {
						content: [
							{
								type: "text",
								text: "Accepted. Updated Journal Entry.",
							},
						],
					},
				},
			},
		);

		expect(requests).toEqual([
			{
				toolCallId: "tc_read_current",
				name: "read_current_thread_journal_entries",
				params: {},
			},
			{
				toolCallId: "tc_update",
				name: "propose_workspace_mutation",
				params: {
					mutation_kind: "update_journal_entry",
					payload: {
						entity_id: "entry-1",
						occurred_at: "2026-06-10T10:30:00",
						body: [
							{
								type: "text",
								text: "Bought bread after daycare pickup.",
							},
						],
					},
					rationale: "the user corrected a Journal Entry from this Thread",
				},
			},
		]);
	});

	it("updates the occurred_at time when the prompt corrects only the time", async () => {
		process.env.INKSTONE_FAUX_PROPOSE = "1";

		const { requests } = await runChat(
			journalIntakeManifest(
				"Actually, for that entry, change the time to 11:00.",
			),
			{
				tc_read_current: {
					ok: {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									entries: [
										{
											entity_id: "entry-1",
											occurred_at: "2026-06-10T10:30:00",
											body: [
												{
													type: "text",
													text: "Bought milk after daycare pickup.",
												},
											],
										},
									],
								}),
							},
						],
					},
				},
				tc_update: {
					ok: {
						content: [
							{
								type: "text",
								text: "Accepted. Updated Journal Entry.",
							},
						],
					},
				},
			},
		);

		expect(requests).toEqual([
			{
				toolCallId: "tc_read_current",
				name: "read_current_thread_journal_entries",
				params: {},
			},
			{
				toolCallId: "tc_update",
				name: "propose_workspace_mutation",
				params: {
					mutation_kind: "update_journal_entry",
					payload: {
						entity_id: "entry-1",
						occurred_at: "2026-06-10T11:00:00",
						body: [
							{
								type: "text",
								text: "Bought milk after daycare pickup.",
							},
						],
					},
					rationale: "the user corrected a Journal Entry from this Thread",
				},
			},
		]);
	});

	it("reads current-thread entries before proposing a delete_journal_entry", async () => {
		process.env.INKSTONE_FAUX_PROPOSE = "1";

		const { events, requests } = await runChat(
			journalIntakeManifest("Actually, delete that entry."),
			{
				tc_read_current: {
					ok: {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									entries: [
										{
											entity_id: "entry-1",
											occurred_at: "2026-06-10T10:30:00",
											body: [
												{
													type: "text",
													text: "Bought milk after daycare pickup.",
												},
											],
										},
									],
								}),
							},
						],
					},
				},
				tc_delete: {
					ok: {
						content: [
							{
								type: "text",
								text: "Accepted. Deleted Journal Entry.",
							},
						],
					},
				},
			},
		);

		expect(requests).toEqual([
			{
				toolCallId: "tc_read_current",
				name: "read_current_thread_journal_entries",
				params: {},
			},
			{
				toolCallId: "tc_delete",
				name: "propose_workspace_mutation",
				params: {
					mutation_kind: "delete_journal_entry",
					payload: {
						entity_id: "entry-1",
					},
					rationale: "the user wants to remove a mistaken Journal Entry",
				},
			},
		]);
		expect(events.at(-1)).toEqual({ kind: "done" });
		expect(
			events
				.filter(
					(e): e is { kind: "text_delta"; delta: string } =>
						e.kind === "text_delta",
				)
				.map((e) => e.delta)
				.join(""),
		).toContain("Done — deleted it.");
	});
});
