import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
	ManifestMessage,
	RunEvent,
	WorkerManifest,
} from "@inkstone/protocol";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { fauxDepsFor } from "./faux-worker.js";
import { runInterpreter } from "./interpreter.js";
import type { ToolCallResponse } from "./tool-proxy.js";
import type { CapturedToolRequest } from "./transport-memory.js";
import { InMemoryTransport } from "./transport-memory.js";

// `fauxDepsFor` reads `INKSTONE_FAUX_*` env vars at call time; clear them after each case so modes don't bleed.
const FAUX_ENV_KEYS = [
	"INKSTONE_FAUX_RESPONSE",
	"INKSTONE_FAUX_ERROR",
	"INKSTONE_FAUX_TOOL_CALL",
	"INKSTONE_FAUX_PROPOSE",
	"INKSTONE_FAUX_ECHO_HISTORY",
	"INKSTONE_FAUX_EXTRACT",
	"INKSTONE_FAUX_EXTRACT_PARAMS",
] as const;
afterEach(() => {
	for (const key of FAUX_ENV_KEYS) delete process.env[key];
});

// Write a `{ journal_text, person_name?, project_name?, todo? }` scenario JSON to
// a tempfile and point INKSTONE_FAUX_EXTRACT_PARAMS at it; remove the dir after
// the case.
function withExtractScenario(scenario: {
	journal_text: string;
	person_name?: string;
	project_name?: string;
	todo?: {
		title: string;
		person_name?: string;
		person_role?: "waiting_on" | "related";
		project_name?: string;
	};
}): void {
	const dir = mkdtempSync(path.join(tmpdir(), "faux-extract-"));
	const file = path.join(dir, "scenario.json");
	writeFileSync(file, JSON.stringify(scenario));
	process.env.INKSTONE_FAUX_EXTRACT = "1";
	process.env.INKSTONE_FAUX_EXTRACT_PARAMS = file;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));
}

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

const EXTRACT_TOOLS: WorkerManifest["workflow"]["tools"] = [
	{
		name: "read_current_thread_journal_entries",
		description: "Read accepted Journal Entries from the current thread.",
		label: "Read current thread journal entries",
		json_schema: { type: "object", properties: {} },
	},
	{
		name: "search_entities",
		description: "Search accepted People, Projects, and Todos.",
		label: "Search entities",
		json_schema: { type: "object", properties: {} },
	},
	{
		name: "propose_workspace_mutation",
		description: "Propose a Workspace mutation for approval.",
		label: "Propose Workspace mutation",
		json_schema: { type: "object", properties: {} },
	},
];

function extractManifest(
	overrides: Partial<WorkerManifest> = {},
): WorkerManifest {
	return fauxManifest({
		prompt: "I had coffee with Alice.",
		workflow: {
			name: "default",
			version: "1.0.0",
			provider: "faux",
			model: "faux-1",
			system_prompt: "You run the journal extraction loop.",
			thinking_level: "off",
			tools: EXTRACT_TOOLS,
		},
		...overrides,
	});
}

// A resume manifest carrying the prior turns' transcript (mode="resume", empty prompt).
function resumeExtractManifest(messages: ManifestMessage[]): WorkerManifest {
	return extractManifest({ prompt: "", mode: "resume", messages });
}

// An assistant transcript message recording one prior tool call (args elided).
const assistantCall = (id: string, name: string): ManifestMessage => ({
	role: "assistant",
	tool_calls: [{ id, name, arguments: {} }],
});

const decisionResult = (
	tool_call_id: string,
	content: string,
): ManifestMessage => ({
	role: "tool_result",
	tool_call_id,
	content,
});

// Core serializes a tool's AgentToolResult into the transcript verbatim, so a
// RESUME tool_result's `content` is the envelope `{content:[{text:"<inner>"}],…}`
// (see resume.rs render_result_content), NOT the bare inner JSON. Fixtures must
// match that shape so the worker's unwrap path is exercised as in production.
const resumeToolResult = (
	tool_call_id: string,
	inner: unknown,
): ManifestMessage => ({
	role: "tool_result",
	tool_call_id,
	content: JSON.stringify({
		content: [{ type: "text", text: JSON.stringify(inner) }],
		details: null,
		terminate: null,
	}),
});

const searchResult = (
	tool_call_id: string,
	results: Array<{ id: string; type: string; label: string }>,
): ManifestMessage => resumeToolResult(tool_call_id, { results });

const readEntriesResult = (
	tool_call_id: string,
	entries: Array<{
		entity_id: string;
		occurred_at: string;
		body?: Array<{ type: string; text: string }>;
	}>,
): ManifestMessage => resumeToolResult(tool_call_id, { entries });

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

// Helper: collect the captured propose_workspace_mutation requests, projecting
// just mutation_kind + payload (rationale is prose, not asserted here).
function proposalsIn(requests: CapturedToolRequest[]) {
	return requests
		.filter((r) => r.name === "propose_workspace_mutation")
		.map((r) => {
			const params = r.params as {
				mutation_kind: string;
				payload: unknown;
			};
			return { mutation_kind: params.mutation_kind, payload: params.payload };
		});
}

describe("faux-worker extraction mode (INKSTONE_FAUX_EXTRACT)", () => {
	it("fresh: proposes a create_journal_entry whose body mentions the person", async () => {
		withExtractScenario({
			journal_text: "I had coffee with Alice this morning.",
			person_name: "Alice",
		});

		const { requests } = await runChat(extractManifest(), {
			tc_extract_journal: {
				ok: {
					content: [{ type: "text", text: "Accepted. Created Journal Entry." }],
				},
			},
		});

		const proposals = proposalsIn(requests);
		expect(proposals).toHaveLength(1);
		expect(proposals[0].mutation_kind).toBe("create_journal_entry");
		expect(JSON.stringify(proposals[0].payload)).toContain("Alice");
	});

	it("resume after JE accepted, search empty: reads then proposes create_person sourced from the JE", async () => {
		withExtractScenario({
			journal_text: "I had coffee with Alice this morning.",
			person_name: "Alice",
		});

		const { requests } = await runChat(
			resumeExtractManifest([
				{ role: "user", text: "I had coffee with Alice." },
				assistantCall("tc_extract_journal", "propose_workspace_mutation"),
				decisionResult(
					"tc_extract_journal",
					"Accepted. Created Journal Entry (occurred_at=2026-06-10T10:30:00, body=I had coffee with Alice this morning.).",
				),
			]),
			{
				tc_extract_read: {
					ok: {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									entries: [
										{
											entity_id: "je-1",
											occurred_at: "2026-06-10T10:30:00",
											body: [
												{
													type: "text",
													text: "I had coffee with Alice this morning.",
												},
											],
										},
									],
								}),
							},
						],
					},
				},
				tc_extract_search_initial: {
					ok: {
						content: [{ type: "text", text: JSON.stringify({ results: [] }) }],
					},
				},
				tc_extract_person: {
					ok: {
						content: [
							{ type: "text", text: "Accepted. Created Person (name=Alice)." },
						],
					},
				},
			},
		);

		// read -> search -> propose, in order.
		expect(requests.map((r) => r.name)).toEqual([
			"read_current_thread_journal_entries",
			"search_entities",
			"propose_workspace_mutation",
		]);
		const proposals = proposalsIn(requests);
		expect(proposals).toEqual([
			{
				mutation_kind: "create_person",
				payload: {
					name: "Alice",
					source_journal_entry_id: "je-1",
				},
			},
		]);
	});

	it("resume after JE accepted, search finds the person: proposes a reference to it", async () => {
		withExtractScenario({
			journal_text: "I had coffee with Alice this morning.",
			person_name: "Alice",
		});

		const { requests } = await runChat(
			resumeExtractManifest([
				{ role: "user", text: "I had coffee with Alice." },
				assistantCall("tc_extract_journal", "propose_workspace_mutation"),
				decisionResult(
					"tc_extract_journal",
					"Accepted. Created Journal Entry (occurred_at=2026-06-10T10:30:00, body=I had coffee with Alice this morning.).",
				),
			]),
			{
				tc_extract_read: {
					ok: {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									entries: [
										{
											entity_id: "je-1",
											occurred_at: "2026-06-10T10:30:00",
											body: [
												{
													type: "text",
													text: "I had coffee with Alice this morning.",
												},
											],
										},
									],
								}),
							},
						],
					},
				},
				tc_extract_search_initial: {
					ok: {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									results: [{ id: "alice-1", type: "person", label: "Alice" }],
								}),
							},
						],
					},
				},
				tc_extract_reference: {
					ok: {
						content: [
							{
								type: "text",
								text: "Accepted. Referenced Entity (source_entity_id=je-1, target_entity_id=alice-1, body=Met .).",
							},
						],
					},
				},
			},
		);

		expect(requests.map((r) => r.name)).toEqual([
			"read_current_thread_journal_entries",
			"search_entities",
			"propose_workspace_mutation",
		]);
		const proposals = proposalsIn(requests);
		expect(proposals).toHaveLength(1);
		expect(proposals[0].mutation_kind).toBe(
			"reference_existing_entity_from_journal_entry",
		);
		expect(proposals[0].payload).toMatchObject({
			source_entity_id: "je-1",
			target_entity_id: "alice-1",
		});
	});

	it("resume after create_person accepted: re-searches, then proposes a reference using the JE id from the transcript", async () => {
		withExtractScenario({
			journal_text: "I had coffee with Alice this morning.",
			person_name: "Alice",
		});

		const { requests } = await runChat(
			resumeExtractManifest([
				{ role: "user", text: "I had coffee with Alice." },
				assistantCall("tc_extract_journal", "propose_workspace_mutation"),
				decisionResult(
					"tc_extract_journal",
					"Accepted. Created Journal Entry (occurred_at=2026-06-10T10:30:00, body=I had coffee with Alice this morning.).",
				),
				// The earlier read result is in the transcript; this process must reuse the JE id from it.
				assistantCall("tc_extract_read", "read_current_thread_journal_entries"),
				readEntriesResult("tc_extract_read", [
					{
						entity_id: "je-1",
						occurred_at: "2026-06-10T10:30:00",
						body: [
							{ type: "text", text: "I had coffee with Alice this morning." },
						],
					},
				]),
				assistantCall("tc_extract_search_initial", "search_entities"),
				searchResult("tc_extract_search_initial", []),
				assistantCall("tc_extract_person", "propose_workspace_mutation"),
				decisionResult(
					"tc_extract_person",
					"Accepted. Created Person (name=Alice).",
				),
			]),
			{
				tc_extract_search_recheck: {
					ok: {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									results: [
										{ id: "alice-new", type: "person", label: "Alice" },
									],
								}),
							},
						],
					},
				},
				tc_extract_reference: {
					ok: {
						content: [
							{
								type: "text",
								text: "Accepted. Referenced Entity (source_entity_id=je-1, target_entity_id=alice-new, body=Met .).",
							},
						],
					},
				},
			},
		);

		// No fresh read this round — straight to search then propose.
		expect(requests.map((r) => r.name)).toEqual([
			"search_entities",
			"propose_workspace_mutation",
		]);
		const proposals = proposalsIn(requests);
		expect(proposals).toHaveLength(1);
		expect(proposals[0].mutation_kind).toBe(
			"reference_existing_entity_from_journal_entry",
		);
		expect(proposals[0].payload).toMatchObject({
			source_entity_id: "je-1",
			target_entity_id: "alice-new",
		});
	});

	it("resume after a reference accepted: emits a final confirmation, no tool call", async () => {
		withExtractScenario({
			journal_text: "I had coffee with Alice this morning.",
			person_name: "Alice",
		});

		const { events, requests } = await runChat(
			resumeExtractManifest([
				{ role: "user", text: "I had coffee with Alice." },
				assistantCall("tc_extract_journal", "propose_workspace_mutation"),
				decisionResult(
					"tc_extract_journal",
					"Accepted. Created Journal Entry (occurred_at=2026-06-10T10:30:00, body=I had coffee with Alice this morning.).",
				),
				assistantCall("tc_extract_reference", "propose_workspace_mutation"),
				decisionResult(
					"tc_extract_reference",
					"Accepted. Referenced Entity (source_entity_id=je-1, target_entity_id=alice-1, body=Met .).",
				),
			]),
		);

		expect(requests).toEqual([]);
		const text = events
			.filter(
				(e): e is { kind: "text_delta"; delta: string } =>
					e.kind === "text_delta",
			)
			.map((e) => e.delta)
			.join("");
		expect(text).toContain("Done — extracted Alice.");
		expect(events.at(-1)).toEqual({ kind: "done" });
	});

	it("resume after a proposal was rejected: confirms dismissal, no tool call", async () => {
		withExtractScenario({
			journal_text: "I had coffee with Alice this morning.",
			person_name: "Alice",
		});

		const { events, requests } = await runChat(
			resumeExtractManifest([
				{ role: "user", text: "I had coffee with Alice." },
				assistantCall("tc_extract_journal", "propose_workspace_mutation"),
				decisionResult(
					"tc_extract_journal",
					"Accepted. Created Journal Entry (occurred_at=2026-06-10T10:30:00, body=I had coffee with Alice this morning.).",
				),
				assistantCall("tc_extract_person", "propose_workspace_mutation"),
				decisionResult("tc_extract_person", "User declined this proposal."),
			]),
		);

		expect(requests).toEqual([]);
		const text = events
			.filter(
				(e): e is { kind: "text_delta"; delta: string } =>
					e.kind === "text_delta",
			)
			.map((e) => e.delta)
			.join("");
		expect(text).toContain("Dismissed.");
		expect(events.at(-1)).toEqual({ kind: "done" });
	});

	// Regression: `tool_calls.id` is a global PRIMARY KEY, so the two searches in
	// the missing→create→reference Run must carry DISTINCT ids — otherwise the
	// second search collides on insert and the reference proposal never appears.
	it("emits a DISTINCT search tool-call id in after_create_person vs after_journal", async () => {
		withExtractScenario({
			journal_text: "I had coffee with Alice this morning.",
			person_name: "Alice",
		});

		// Phase 1: after_journal resume → first search.
		const afterJournal = await runChat(
			resumeExtractManifest([
				{ role: "user", text: "I had coffee with Alice." },
				assistantCall("tc_extract_journal", "propose_workspace_mutation"),
				decisionResult(
					"tc_extract_journal",
					"Accepted. Created Journal Entry (occurred_at=2026-06-10T10:30:00, body=I had coffee with Alice this morning.).",
				),
			]),
			{
				tc_extract_read: {
					ok: {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									entries: [
										{
											entity_id: "je-1",
											occurred_at: "2026-06-10T10:30:00",
											body: [
												{
													type: "text",
													text: "I had coffee with Alice this morning.",
												},
											],
										},
									],
								}),
							},
						],
					},
				},
				tc_extract_search_initial: {
					ok: {
						content: [{ type: "text", text: JSON.stringify({ results: [] }) }],
					},
				},
				tc_extract_person: {
					ok: {
						content: [
							{ type: "text", text: "Accepted. Created Person (name=Alice)." },
						],
					},
				},
			},
		);
		const firstSearchId = afterJournal.requests.find(
			(r) => r.name === "search_entities",
		)?.toolCallId;

		// Phase 2: after_create_person resume → second (re-check) search.
		const afterCreate = await runChat(
			resumeExtractManifest([
				{ role: "user", text: "I had coffee with Alice." },
				assistantCall("tc_extract_journal", "propose_workspace_mutation"),
				decisionResult(
					"tc_extract_journal",
					"Accepted. Created Journal Entry (occurred_at=2026-06-10T10:30:00, body=I had coffee with Alice this morning.).",
				),
				assistantCall("tc_extract_read", "read_current_thread_journal_entries"),
				readEntriesResult("tc_extract_read", [
					{
						entity_id: "je-1",
						occurred_at: "2026-06-10T10:30:00",
						body: [
							{ type: "text", text: "I had coffee with Alice this morning." },
						],
					},
				]),
				assistantCall("tc_extract_search_initial", "search_entities"),
				searchResult("tc_extract_search_initial", []),
				assistantCall("tc_extract_person", "propose_workspace_mutation"),
				decisionResult(
					"tc_extract_person",
					"Accepted. Created Person (name=Alice).",
				),
			]),
			{
				tc_extract_search_recheck: {
					ok: {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									results: [
										{ id: "alice-new", type: "person", label: "Alice" },
									],
								}),
							},
						],
					},
				},
				tc_extract_reference: {
					ok: {
						content: [
							{
								type: "text",
								text: "Accepted. Referenced Entity (source_entity_id=je-1, target_entity_id=alice-new, body=Met .).",
							},
						],
					},
				},
			},
		);
		const secondSearchId = afterCreate.requests.find(
			(r) => r.name === "search_entities",
		)?.toolCallId;

		expect(firstSearchId).toBe("tc_extract_search_initial");
		expect(secondSearchId).toBe("tc_extract_search_recheck");
		expect(secondSearchId).not.toBe(firstSearchId);

		// And the re-check search still resolves the JE id and proposes the reference.
		expect(proposalsIn(afterCreate.requests)).toEqual([
			{
				mutation_kind: "reference_existing_entity_from_journal_entry",
				payload: {
					source_entity_id: "je-1",
					target_entity_id: "alice-new",
					body: [
						{ type: "text", text: "Met " },
						{ type: "entity_ref" },
						{ type: "text", text: "." },
					],
				},
			},
		]);
	});
});

describe("faux-worker extraction mode — Project target", () => {
	it("fresh: proposes a create_journal_entry whose body mentions the project", async () => {
		withExtractScenario({
			journal_text: "Kicked off the API v2 migration today.",
			project_name: "Ship API v2 migration",
		});

		const { requests } = await runChat(extractManifest(), {
			tc_extract_journal: {
				ok: {
					content: [{ type: "text", text: "Accepted. Created Journal Entry." }],
				},
			},
		});

		const proposals = proposalsIn(requests);
		expect(proposals).toHaveLength(1);
		expect(proposals[0].mutation_kind).toBe("create_journal_entry");
		expect(JSON.stringify(proposals[0].payload)).toContain("API v2 migration");
	});

	it("resume after JE accepted, search empty: reads then proposes create_project sourced from the JE", async () => {
		withExtractScenario({
			journal_text: "Kicked off the API v2 migration today.",
			project_name: "Ship API v2 migration",
		});

		const { requests } = await runChat(
			resumeExtractManifest([
				{ role: "user", text: "Kicked off the API v2 migration." },
				assistantCall("tc_extract_journal", "propose_workspace_mutation"),
				decisionResult(
					"tc_extract_journal",
					"Accepted. Created Journal Entry (occurred_at=2026-06-10T10:30:00, body=Kicked off the API v2 migration today.).",
				),
			]),
			{
				tc_extract_read: {
					ok: {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									entries: [
										{
											entity_id: "je-1",
											occurred_at: "2026-06-10T10:30:00",
											body: [
												{
													type: "text",
													text: "Kicked off the API v2 migration today.",
												},
											],
										},
									],
								}),
							},
						],
					},
				},
				tc_extract_search_initial: {
					ok: {
						content: [{ type: "text", text: JSON.stringify({ results: [] }) }],
					},
				},
				tc_extract_project: {
					ok: {
						content: [
							{
								type: "text",
								text: "Accepted. Created Project (name=Ship API v2 migration).",
							},
						],
					},
				},
			},
		);

		// read -> search -> propose, in order; the search targets projects.
		expect(requests.map((r) => r.name)).toEqual([
			"read_current_thread_journal_entries",
			"search_entities",
			"propose_workspace_mutation",
		]);
		expect(
			requests.find((r) => r.name === "search_entities")?.params,
		).toMatchObject({ type: "project", query: "Ship API v2 migration" });
		const proposals = proposalsIn(requests);
		expect(proposals).toEqual([
			{
				mutation_kind: "create_project",
				payload: {
					name: "Ship API v2 migration",
					source_journal_entry_id: "je-1",
				},
			},
		]);
	});

	it("resume after JE accepted, search finds the project: proposes a reference to it", async () => {
		withExtractScenario({
			journal_text: "Kicked off the API v2 migration today.",
			project_name: "Ship API v2 migration",
		});

		const { requests } = await runChat(
			resumeExtractManifest([
				{ role: "user", text: "Kicked off the API v2 migration." },
				assistantCall("tc_extract_journal", "propose_workspace_mutation"),
				decisionResult(
					"tc_extract_journal",
					"Accepted. Created Journal Entry (occurred_at=2026-06-10T10:30:00, body=Kicked off the API v2 migration today.).",
				),
			]),
			{
				tc_extract_read: {
					ok: {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									entries: [
										{
											entity_id: "je-1",
											occurred_at: "2026-06-10T10:30:00",
											body: [
												{
													type: "text",
													text: "Kicked off the API v2 migration today.",
												},
											],
										},
									],
								}),
							},
						],
					},
				},
				tc_extract_search_initial: {
					ok: {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									results: [
										{
											id: "proj-1",
											type: "project",
											label: "Ship API v2 migration",
										},
									],
								}),
							},
						],
					},
				},
				tc_extract_reference: {
					ok: {
						content: [
							{
								type: "text",
								text: "Accepted. Referenced Entity (source_entity_id=je-1, target_entity_id=proj-1, body=Met .).",
							},
						],
					},
				},
			},
		);

		expect(requests.map((r) => r.name)).toEqual([
			"read_current_thread_journal_entries",
			"search_entities",
			"propose_workspace_mutation",
		]);
		expect(
			requests.find((r) => r.name === "search_entities")?.params,
		).toMatchObject({ type: "project", query: "Ship API v2 migration" });
		const proposals = proposalsIn(requests);
		expect(proposals).toHaveLength(1);
		expect(proposals[0].mutation_kind).toBe(
			"reference_existing_entity_from_journal_entry",
		);
		expect(proposals[0].payload).toMatchObject({
			source_entity_id: "je-1",
			target_entity_id: "proj-1",
		});
	});

	it("resume after create_project accepted: re-searches with a distinct id, then proposes a reference using the JE id from the transcript", async () => {
		withExtractScenario({
			journal_text: "Kicked off the API v2 migration today.",
			project_name: "Ship API v2 migration",
		});

		const { requests } = await runChat(
			resumeExtractManifest([
				{ role: "user", text: "Kicked off the API v2 migration." },
				assistantCall("tc_extract_journal", "propose_workspace_mutation"),
				decisionResult(
					"tc_extract_journal",
					"Accepted. Created Journal Entry (occurred_at=2026-06-10T10:30:00, body=Kicked off the API v2 migration today.).",
				),
				assistantCall("tc_extract_read", "read_current_thread_journal_entries"),
				readEntriesResult("tc_extract_read", [
					{
						entity_id: "je-1",
						occurred_at: "2026-06-10T10:30:00",
						body: [
							{ type: "text", text: "Kicked off the API v2 migration today." },
						],
					},
				]),
				assistantCall("tc_extract_search_initial", "search_entities"),
				searchResult("tc_extract_search_initial", []),
				assistantCall("tc_extract_project", "propose_workspace_mutation"),
				decisionResult(
					"tc_extract_project",
					"Accepted. Created Project (name=Ship API v2 migration).",
				),
			]),
			{
				tc_extract_search_recheck: {
					ok: {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									results: [
										{
											id: "proj-new",
											type: "project",
											label: "Ship API v2 migration",
										},
									],
								}),
							},
						],
					},
				},
				tc_extract_reference: {
					ok: {
						content: [
							{
								type: "text",
								text: "Accepted. Referenced Entity (source_entity_id=je-1, target_entity_id=proj-new, body=Met .).",
							},
						],
					},
				},
			},
		);

		// No fresh read this round — straight to search then propose.
		expect(requests.map((r) => r.name)).toEqual([
			"search_entities",
			"propose_workspace_mutation",
		]);
		expect(requests.find((r) => r.name === "search_entities")?.toolCallId).toBe(
			"tc_extract_search_recheck",
		);
		const proposals = proposalsIn(requests);
		expect(proposals).toEqual([
			{
				mutation_kind: "reference_existing_entity_from_journal_entry",
				payload: {
					source_entity_id: "je-1",
					target_entity_id: "proj-new",
					body: [
						{ type: "text", text: "Met " },
						{ type: "entity_ref" },
						{ type: "text", text: "." },
					],
				},
			},
		]);
	});

	it("resume after JE accepted with NO extraction target: confirms, proposes nothing (category stays plain text)", async () => {
		withExtractScenario({
			journal_text: "Spent the morning on Work.",
		});

		const { events, requests } = await runChat(
			resumeExtractManifest([
				{ role: "user", text: "Spent the morning on Work." },
				assistantCall("tc_extract_journal", "propose_workspace_mutation"),
				decisionResult(
					"tc_extract_journal",
					"Accepted. Created Journal Entry (occurred_at=2026-06-10T10:30:00, body=Spent the morning on Work.).",
				),
			]),
		);

		expect(requests).toEqual([]);
		const text = events
			.filter(
				(e): e is { kind: "text_delta"; delta: string } =>
					e.kind === "text_delta",
			)
			.map((e) => e.delta)
			.join("");
		expect(text).toContain("Done — added it.");
		expect(events.at(-1)).toEqual({ kind: "done" });
	});
});

describe("faux-worker extraction mode — Todo target", () => {
	it("fresh: proposes a create_journal_entry whose body mentions the obligation", async () => {
		withExtractScenario({
			journal_text: "I need to email Alice about Project Y.",
			todo: {
				title: "Email Alice about Project Y",
				person_name: "Alice",
				project_name: "Project Y",
			},
		});

		const { requests } = await runChat(extractManifest(), {
			tc_extract_journal: {
				ok: {
					content: [{ type: "text", text: "Accepted. Created Journal Entry." }],
				},
			},
		});

		const proposals = proposalsIn(requests);
		expect(proposals).toHaveLength(1);
		expect(proposals[0].mutation_kind).toBe("create_journal_entry");
		expect(JSON.stringify(proposals[0].payload)).toContain(
			"email Alice about Project Y",
		);
	});

	it("resume after JE accepted (person+project found): read → search person → search project → ONE create_todo linked to both, sourced from the JE", async () => {
		withExtractScenario({
			journal_text: "I need to email Alice about Project Y.",
			todo: {
				title: "Email Alice about Project Y",
				person_name: "Alice",
				project_name: "Project Y",
			},
		});

		const { requests } = await runChat(
			resumeExtractManifest([
				{ role: "user", text: "I need to email Alice about Project Y." },
				assistantCall("tc_extract_journal", "propose_workspace_mutation"),
				decisionResult(
					"tc_extract_journal",
					"Accepted. Created Journal Entry (occurred_at=2026-06-10T10:30:00, body=I need to email Alice about Project Y.).",
				),
			]),
			{
				tc_extract_read: {
					ok: {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									entries: [
										{
											entity_id: "je-1",
											occurred_at: "2026-06-10T10:30:00",
											body: [
												{
													type: "text",
													text: "I need to email Alice about Project Y.",
												},
											],
										},
									],
								}),
							},
						],
					},
				},
				tc_extract_search_person: {
					ok: {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									results: [{ id: "alice-1", type: "person", label: "Alice" }],
								}),
							},
						],
					},
				},
				tc_extract_search_project: {
					ok: {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									results: [
										{ id: "proj-1", type: "project", label: "Project Y" },
									],
								}),
							},
						],
					},
				},
				tc_extract_todo: {
					ok: {
						content: [
							{ type: "text", text: "Accepted. Created Todo (title=…)." },
						],
					},
				},
			},
		);

		// read → search(person) → search(project) → propose, in order.
		expect(requests.map((r) => r.name)).toEqual([
			"read_current_thread_journal_entries",
			"search_entities",
			"search_entities",
			"propose_workspace_mutation",
		]);
		const searches = requests.filter((r) => r.name === "search_entities");
		expect(searches[0].params).toMatchObject({
			type: "person",
			query: "Alice",
		});
		expect(searches[1].params).toMatchObject({
			type: "project",
			query: "Project Y",
		});
		const proposals = proposalsIn(requests);
		expect(proposals).toEqual([
			{
				mutation_kind: "create_todo",
				payload: {
					todo: {
						title: "Email Alice about Project Y",
						project_id: "proj-1",
					},
					person_refs: [{ person_id: "alice-1", role: "related" }],
					source_journal_entry_id: "je-1",
				},
			},
		]);
	});

	it("resume after JE accepted, person search EMPTY: create_todo OMITS person_refs but keeps the found project link", async () => {
		withExtractScenario({
			journal_text: "I need to email Alice about Project Y.",
			todo: {
				title: "Email Alice about Project Y",
				person_name: "Alice",
				project_name: "Project Y",
			},
		});

		const { requests } = await runChat(
			resumeExtractManifest([
				{ role: "user", text: "I need to email Alice about Project Y." },
				assistantCall("tc_extract_journal", "propose_workspace_mutation"),
				decisionResult(
					"tc_extract_journal",
					"Accepted. Created Journal Entry (occurred_at=2026-06-10T10:30:00, body=I need to email Alice about Project Y.).",
				),
			]),
			{
				tc_extract_read: {
					ok: {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									entries: [
										{
											entity_id: "je-1",
											occurred_at: "2026-06-10T10:30:00",
											body: [
												{
													type: "text",
													text: "I need to email Alice about Project Y.",
												},
											],
										},
									],
								}),
							},
						],
					},
				},
				tc_extract_search_person: {
					ok: {
						content: [{ type: "text", text: JSON.stringify({ results: [] }) }],
					},
				},
				tc_extract_search_project: {
					ok: {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									results: [
										{ id: "proj-1", type: "project", label: "Project Y" },
									],
								}),
							},
						],
					},
				},
				tc_extract_todo: {
					ok: {
						content: [
							{ type: "text", text: "Accepted. Created Todo (title=…)." },
						],
					},
				},
			},
		);

		const proposals = proposalsIn(requests);
		expect(proposals).toEqual([
			{
				mutation_kind: "create_todo",
				payload: {
					todo: {
						title: "Email Alice about Project Y",
						project_id: "proj-1",
					},
					source_journal_entry_id: "je-1",
				},
			},
		]);
		expect(proposals[0].payload).not.toHaveProperty("person_refs");
	});

	it("resume after JE accepted, project search EMPTY: create_todo OMITS project_id but keeps the found person link", async () => {
		withExtractScenario({
			journal_text: "I need to email Alice about Project Y.",
			todo: {
				title: "Email Alice about Project Y",
				person_name: "Alice",
				project_name: "Project Y",
			},
		});

		const { requests } = await runChat(
			resumeExtractManifest([
				{ role: "user", text: "I need to email Alice about Project Y." },
				assistantCall("tc_extract_journal", "propose_workspace_mutation"),
				decisionResult(
					"tc_extract_journal",
					"Accepted. Created Journal Entry (occurred_at=2026-06-10T10:30:00, body=I need to email Alice about Project Y.).",
				),
			]),
			{
				tc_extract_read: {
					ok: {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									entries: [
										{
											entity_id: "je-1",
											occurred_at: "2026-06-10T10:30:00",
											body: [
												{
													type: "text",
													text: "I need to email Alice about Project Y.",
												},
											],
										},
									],
								}),
							},
						],
					},
				},
				tc_extract_search_person: {
					ok: {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									results: [{ id: "alice-1", type: "person", label: "Alice" }],
								}),
							},
						],
					},
				},
				tc_extract_search_project: {
					ok: {
						content: [{ type: "text", text: JSON.stringify({ results: [] }) }],
					},
				},
				tc_extract_todo: {
					ok: {
						content: [
							{ type: "text", text: "Accepted. Created Todo (title=…)." },
						],
					},
				},
			},
		);

		const proposals = proposalsIn(requests);
		expect(proposals).toEqual([
			{
				mutation_kind: "create_todo",
				payload: {
					todo: { title: "Email Alice about Project Y" },
					person_refs: [{ person_id: "alice-1", role: "related" }],
					source_journal_entry_id: "je-1",
				},
			},
		]);
		expect(
			(proposals[0].payload as { todo: Record<string, unknown> }).todo,
		).not.toHaveProperty("project_id");
	});

	it("resume after JE accepted, role waiting_on: person_refs role is waiting_on; project-less when no project named", async () => {
		withExtractScenario({
			journal_text: "Wait for Bob to send Z.",
			todo: {
				title: "Wait for Bob to send Z",
				person_name: "Bob",
				person_role: "waiting_on",
			},
		});

		const { requests } = await runChat(
			resumeExtractManifest([
				{ role: "user", text: "Wait for Bob to send Z." },
				assistantCall("tc_extract_journal", "propose_workspace_mutation"),
				decisionResult(
					"tc_extract_journal",
					"Accepted. Created Journal Entry (occurred_at=2026-06-10T10:30:00, body=Wait for Bob to send Z.).",
				),
			]),
			{
				tc_extract_read: {
					ok: {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									entries: [
										{
											entity_id: "je-1",
											occurred_at: "2026-06-10T10:30:00",
											body: [{ type: "text", text: "Wait for Bob to send Z." }],
										},
									],
								}),
							},
						],
					},
				},
				tc_extract_search_person: {
					ok: {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									results: [{ id: "bob-1", type: "person", label: "Bob" }],
								}),
							},
						],
					},
				},
				tc_extract_todo: {
					ok: {
						content: [
							{ type: "text", text: "Accepted. Created Todo (title=…)." },
						],
					},
				},
			},
		);

		// No project named → no project search; read → search(person) → propose.
		expect(requests.map((r) => r.name)).toEqual([
			"read_current_thread_journal_entries",
			"search_entities",
			"propose_workspace_mutation",
		]);
		const proposals = proposalsIn(requests);
		expect(proposals).toEqual([
			{
				mutation_kind: "create_todo",
				payload: {
					todo: { title: "Wait for Bob to send Z" },
					person_refs: [{ person_id: "bob-1", role: "waiting_on" }],
					source_journal_entry_id: "je-1",
				},
			},
		]);
	});
});
