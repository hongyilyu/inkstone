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
import { fauxDepsFor } from "../../src/faux/faux-worker.js";
import { runInterpreter } from "../../src/interpreter.js";
import type { ToolCallResponse } from "../../src/tool-proxy.js";
import type { CapturedToolRequest } from "../../src/transport-memory.js";
import { InMemoryTransport } from "../../src/transport-memory.js";

// `fauxDepsFor` reads `INKSTONE_FAUX_*` env vars at call time; clear them after each case so modes don't bleed.
const FAUX_ENV_KEYS = [
	"INKSTONE_FAUX_RESPONSE",
	"INKSTONE_FAUX_ERROR",
	"INKSTONE_FAUX_TOOL_CALL",
	"INKSTONE_FAUX_PROPOSE",
	"INKSTONE_FAUX_PROPOSE_PARAMS",
	"INKSTONE_FAUX_ECHO_HISTORY",
	"INKSTONE_FAUX_EXTRACT",
	"INKSTONE_FAUX_EXTRACT_PARAMS",
	"INKSTONE_FAUX_CAPTURE",
	"INKSTONE_FAUX_CAPTURE_PARAMS",
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
	journal_entry_id_source?: "read_tool" | "decision_result";
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

// Direct-capture scenario (INKSTONE_FAUX_CAPTURE): a single intent that routes to
// one create_* proposal sourced from the user Message — no Journal Entry. Mirrors
// withExtractScenario's tempfile+env shape.
function withCaptureScenario(scenario: {
	intent: "todo" | "project" | "person" | "conversation";
	todo?: { title: string; note?: string; due_at?: string; defer_at?: string };
	project?: { name: string; outcome?: string };
	person?: { name: string; note?: string; aliases?: string[] };
	enrich?: {
		person_name?: string;
		person_role?: "waiting_on" | "related";
		project_name?: string;
	};
}): void {
	const dir = mkdtempSync(path.join(tmpdir(), "faux-capture-"));
	const file = path.join(dir, "scenario.json");
	writeFileSync(file, JSON.stringify(scenario));
	process.env.INKSTONE_FAUX_CAPTURE = "1";
	process.env.INKSTONE_FAUX_CAPTURE_PARAMS = file;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));
}

// Propose-mode scenario (INKSTONE_FAUX_PROPOSE + INKSTONE_FAUX_PROPOSE_PARAMS):
// an ordered list of Turns played back by manifest position — no prompt NLU.
// Mirrors withExtractScenario's tempfile+env shape.
function withProposeScenario(scenario: {
	turns: Array<{
		action: "create" | "update" | "delete";
		body?: string;
		occurred_at?: string;
	}>;
}): void {
	const dir = mkdtempSync(path.join(tmpdir(), "faux-propose-"));
	const file = path.join(dir, "scenario.json");
	writeFileSync(file, JSON.stringify(scenario));
	process.env.INKSTONE_FAUX_PROPOSE = "1";
	process.env.INKSTONE_FAUX_PROPOSE_PARAMS = file;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));
}

// Raw variant for malformed-scenario tests: writes `content` verbatim (invalid
// JSON, wrong top-level keys) that withProposeScenario's type would reject.
function withRawProposeParams(content: string): string {
	const dir = mkdtempSync(path.join(tmpdir(), "faux-propose-"));
	const file = path.join(dir, "scenario.json");
	writeFileSync(file, content);
	process.env.INKSTONE_FAUX_PROPOSE = "1";
	process.env.INKSTONE_FAUX_PROPOSE_PARAMS = file;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));
	return file;
}

// A manifest with the direct-capture tool allowlist (search_entities is present
// for the enrichment slices; slice 2 only proposes a single create_*).
function captureManifest(
	overrides: Partial<WorkerManifest> = {},
): WorkerManifest {
	return fauxManifest({
		prompt: "Remind me to buy milk.",
		workflow: {
			name: "default",
			version: "1.0.0",
			provider: "faux",
			model: "faux-1",
			system_prompt: "You run the direct capture loop.",
			thinking_level: "off",
			tools: EXTRACT_TOOLS,
		},
		...overrides,
	});
}

// A resume capture manifest carrying the prior turn's transcript (mode="resume",
// empty prompt) — the Decision arrives as the awaited proposal's tool_result.
function resumeCaptureManifest(messages: ManifestMessage[]): WorkerManifest {
	return captureManifest({ prompt: "", mode: "resume", messages });
}

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

function journalIntakeManifest(
	prompt: string,
	overrides: Partial<WorkerManifest> = {},
): WorkerManifest {
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
		...overrides,
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

// Live (in-process) tool results for runChat's `results` map — the bare inner
// content the InMemoryTransport returns for a call id (NOT the resume-transcript
// Core envelope resumeToolResult builds above; never merge the two shapes).
const okText = (text: string): ToolCallResponse => ({
	ok: { content: [{ type: "text", text }] },
});

const okJson = (payload: unknown): ToolCallResponse =>
	okText(JSON.stringify(payload));

// A live search_entities tool result: the bare inner `{results}` JSON.
const searchResultResponse = (
	results: Array<{ id: string; type: string; label: string }>,
): ToolCallResponse => okJson({ results });

const readEntriesResult = (
	tool_call_id: string,
	entries: Array<{
		entity_id: string;
		occurred_at: string;
		body?: Array<{ type: string; text: string }>;
	}>,
): ManifestMessage => resumeToolResult(tool_call_id, { entries });

// A single-text-body journal entry as read_current_thread_journal_entries
// returns it (multi-element bodies stay inline at their call sites).
const jeEntry = (id: string, occurredAt: string, text: string) => ({
	entity_id: id,
	occurred_at: occurredAt,
	body: [{ type: "text", text }],
});

// Reassemble text_delta events (as faux_run.rs does); faux/streamSimple chunk
// boundaries aren't fixed, so per-delta asserts flake.
const deltaText = (events: RunEvent[]): string =>
	events
		.filter(
			(e): e is { kind: "text_delta"; delta: string } =>
				e.kind === "text_delta",
		)
		.map((e) => e.delta)
		.join("");

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

		expect(deltaText(events)).toBe("scripted faux reply");
		expect(events.at(-1)).toEqual({ kind: "done" });
	});

	it("scripts a faux error from INKSTONE_FAUX_ERROR: terminal error, not done", async () => {
		process.env.INKSTONE_FAUX_ERROR = "scripted boom";

		const { events } = await runChat(fauxManifest());

		const terminal = events[events.length - 1];
		expect(terminal).toEqual({ kind: "error", message: "scripted boom" });
		expect(events.some((e) => e.kind === "done")).toBe(false);
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

describe("faux-worker propose mode — scenario playback (INKSTONE_FAUX_PROPOSE_PARAMS)", () => {
	it("throws on a fresh manifest when INKSTONE_FAUX_PROPOSE_PARAMS is unset — no prose fallback", () => {
		process.env.INKSTONE_FAUX_PROPOSE = "1";

		expect(() =>
			fauxDepsFor(journalIntakeManifest("I bought milk after daycare pickup.")),
		).toThrow(/INKSTONE_FAUX_PROPOSE_PARAMS/);
	});

	it("throws on a resume manifest when INKSTONE_FAUX_PROPOSE_PARAMS is unset — params required uniformly", () => {
		process.env.INKSTONE_FAUX_PROPOSE = "1";

		expect(() =>
			fauxDepsFor(
				journalIntakeManifest("", {
					mode: "resume",
					messages: [
						{ role: "user", text: "I bought milk after daycare pickup." },
						assistantCall("tc_create_0", "propose_workspace_mutation"),
						decisionResult(
							"tc_create_0",
							"Accepted. Created Journal Entry (entity_id=entry-1).",
						),
					],
				}),
			),
		).toThrow(/INKSTONE_FAUX_PROPOSE_PARAMS/);
	});

	it("plays an update Turn from the scenario even when the prompt is gibberish", async () => {
		withProposeScenario({
			turns: [
				{ action: "update", body: "Bought oat milk after daycare pickup." },
			],
		});

		const { events, requests } = await runChat(
			journalIntakeManifest("complete gibberish zzz"),
			{
				tc_read_current_0: okJson({
					entries: [
						jeEntry(
							"entry-1",
							"2026-06-10T10:30:00",
							"Bought milk after daycare pickup.",
						),
					],
				}),
				tc_update_0: okText("Accepted. Updated Journal Entry."),
			},
		);

		// The scenario Turn — not the prompt — routes the action: read then update.
		expect(requests).toEqual([
			{
				toolCallId: "tc_read_current_0",
				name: "read_current_thread_journal_entries",
				params: {},
			},
			{
				toolCallId: "tc_update_0",
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
		expect(deltaText(events)).toContain("Done — updated it.");
	});

	it("plays a create Turn from the scenario: one proposal built from the Turn, no read", async () => {
		// Values distinct from the deleted prompt-NLU's hard-coded defaults so a
		// reintroduced silent fallback can't pass this test.
		withProposeScenario({
			turns: [
				{
					action: "create",
					body: "Walked the dog before sunrise.",
					occurred_at: "2026-06-11T07:15:00",
				},
			],
		});

		const { events, requests } = await runChat(
			journalIntakeManifest("complete gibberish zzz"),
			{
				tc_create_0: okText("Accepted. Created Journal Entry."),
			},
		);

		expect(requests).toEqual([
			{
				toolCallId: "tc_create_0",
				name: "propose_workspace_mutation",
				params: {
					mutation_kind: "create_journal_entry",
					payload: {
						occurred_at: "2026-06-11T07:15:00",
						body: [
							{
								type: "text",
								text: "Walked the dog before sunrise.",
							},
						],
					},
					rationale: "the user shared a journal-worthy moment",
				},
			},
		]);
		expect(events.at(-1)).toEqual({ kind: "done" });
		expect(deltaText(events)).toContain("Done — added it.");
	});

	it("plays a delete Turn from the scenario: read then delete_journal_entry from the live entry", async () => {
		withProposeScenario({ turns: [{ action: "delete" }] });

		const { events, requests } = await runChat(
			journalIntakeManifest("complete gibberish zzz"),
			{
				tc_read_current_0: okJson({
					entries: [
						jeEntry(
							"entry-1",
							"2026-06-10T10:30:00",
							"Bought milk after daycare pickup.",
						),
					],
				}),
				tc_delete_0: okText("Accepted. Deleted Journal Entry."),
			},
		);

		expect(requests).toEqual([
			{
				toolCallId: "tc_read_current_0",
				name: "read_current_thread_journal_entries",
				params: {},
			},
			{
				toolCallId: "tc_delete_0",
				name: "propose_workspace_mutation",
				params: {
					mutation_kind: "delete_journal_entry",
					payload: { entity_id: "entry-1" },
					rationale: "the user wants to remove a mistaken Journal Entry",
				},
			},
		]);
		expect(events.at(-1)).toEqual({ kind: "done" });
		expect(deltaText(events)).toContain("Done — deleted it.");
	});

	it("plays the Turn at the manifest position: one prior user message selects turns[1]", async () => {
		withProposeScenario({
			turns: [
				{
					action: "create",
					body: "Bought milk after daycare pickup.",
					occurred_at: "2026-06-10T10:30:00",
				},
				{ action: "delete" },
			],
		});

		const { requests } = await runChat(
			journalIntakeManifest("complete gibberish zzz", {
				messages: [
					{ role: "user", text: "Bought milk." },
					{ role: "assistant", text: "Done — added it." },
				],
			}),
			{
				tc_read_current_1: okJson({
					entries: [
						jeEntry(
							"entry-1",
							"2026-06-10T10:30:00",
							"Bought milk after daycare pickup.",
						),
					],
				}),
				tc_delete_1: okText("Accepted. Deleted Journal Entry."),
			},
		);

		// turns[1] (delete) plays — not turns[0] (create).
		expect(requests.map((r) => r.name)).toEqual([
			"read_current_thread_journal_entries",
			"propose_workspace_mutation",
		]);
		expect(proposalsIn(requests)).toEqual([
			{
				mutation_kind: "delete_journal_entry",
				payload: { entity_id: "entry-1" },
			},
		]);
		// tool_calls.id is a GLOBAL primary key in Core's DB: position 1 must not
		// reuse position 0's ids or the second Run corrupts the first Run's rows.
		expect(requests.map((r) => r.toolCallId)).toEqual([
			"tc_read_current_1",
			"tc_delete_1",
		]);
	});

	it("throws when the scenario is exhausted — never a silent default", () => {
		withProposeScenario({
			turns: [
				{
					action: "create",
					body: "Bought milk after daycare pickup.",
					occurred_at: "2026-06-10T10:30:00",
				},
			],
		});

		// Position 1 (one prior user message) has no scripted turn. `fauxDepsFor`
		// scripts the provider at call time, so the exhaustion throws synchronously.
		expect(() =>
			fauxDepsFor(
				fauxManifest({
					prompt: "complete gibberish zzz",
					messages: [
						{ role: "user", text: "Bought milk." },
						{ role: "assistant", text: "Done — added it." },
					],
				}),
			),
		).toThrow(/scenario exhausted/);
	});

	it("throws at load on an unknown action, naming the value and its turn index", () => {
		// Raw write: a typo'd action withProposeScenario's type would reject —
		// the silent-misroute case.
		withRawProposeParams(
			JSON.stringify({
				turns: [
					{
						action: "create",
						body: "Walked the dog before sunrise.",
						occurred_at: "2026-06-11T07:15:00",
					},
					{ action: "updte", body: "Bought oat milk after daycare pickup." },
				],
			}),
		);

		// The bad turn is at index 1, but load-time validation covers the whole
		// scenario — it throws even though position 0 would play the valid create.
		expect(() =>
			fauxDepsFor(journalIntakeManifest("complete gibberish zzz")),
		).toThrow('turn 1: unknown action "updte"');
	});

	it("throws at load when a create Turn omits body", () => {
		withProposeScenario({
			turns: [{ action: "create", occurred_at: "2026-06-11T07:15:00" }],
		});

		expect(() =>
			fauxDepsFor(journalIntakeManifest("complete gibberish zzz")),
		).toThrow('turn 0: create requires "body"');
	});

	it("throws at load when a create Turn omits occurred_at", () => {
		withProposeScenario({
			turns: [{ action: "create", body: "Walked the dog before sunrise." }],
		});

		expect(() =>
			fauxDepsFor(journalIntakeManifest("complete gibberish zzz")),
		).toThrow('turn 0: create requires "occurred_at"');
	});

	it("throws at load when a create Turn's body is an empty string", () => {
		withProposeScenario({
			turns: [
				{ action: "create", body: "", occurred_at: "2026-06-11T07:15:00" },
			],
		});

		expect(() =>
			fauxDepsFor(journalIntakeManifest("complete gibberish zzz")),
		).toThrow('turn 0: create requires "body"');
	});

	it("throws at load when the file has no turns array", () => {
		withRawProposeParams(JSON.stringify({ turn: [] }));

		expect(() =>
			fauxDepsFor(journalIntakeManifest("complete gibberish zzz")),
		).toThrow(/must contain a "turns" array/);
	});

	it("names the seam and path when the scenario file is malformed or missing", () => {
		const file = withRawProposeParams("{not json");

		// Malformed JSON: the raw SyntaxError is wrapped with the env var + path.
		expect(() =>
			fauxDepsFor(journalIntakeManifest("complete gibberish zzz")),
		).toThrow(new RegExp(`INKSTONE_FAUX_PROPOSE_PARAMS ${file}`));

		// Missing file: same wrapping (ENOENT would otherwise name neither).
		rmSync(file);
		expect(() =>
			fauxDepsFor(journalIntakeManifest("complete gibberish zzz")),
		).toThrow(new RegExp(`INKSTONE_FAUX_PROPOSE_PARAMS ${file}`));
	});

	it("update Turn with occurred_at only: keeps the live body, replaces the time", async () => {
		withProposeScenario({
			turns: [{ action: "update", occurred_at: "2026-06-10T11:00:00" }],
		});

		const { requests } = await runChat(
			journalIntakeManifest("complete gibberish zzz"),
			{
				tc_read_current_0: okJson({
					entries: [
						jeEntry(
							"entry-1",
							"2026-06-10T10:30:00",
							"Bought milk after daycare pickup.",
						),
					],
				}),
				tc_update_0: okText("Accepted. Updated Journal Entry."),
			},
		);

		expect(proposalsIn(requests)).toEqual([
			{
				mutation_kind: "update_journal_entry",
				payload: {
					entity_id: "entry-1",
					occurred_at: "2026-06-10T11:00:00",
					body: [{ type: "text", text: "Bought milk after daycare pickup." }],
				},
			},
		]);
	});

	it("update Turn with body only: keeps the live occurred_at, replaces the body", async () => {
		withProposeScenario({
			turns: [{ action: "update", body: "Bought bread after daycare pickup." }],
		});

		const { requests } = await runChat(
			journalIntakeManifest("complete gibberish zzz"),
			{
				tc_read_current_0: okJson({
					entries: [
						jeEntry(
							"entry-1",
							"2026-06-10T10:30:00",
							"Bought milk after daycare pickup.",
						),
					],
				}),
				tc_update_0: okText("Accepted. Updated Journal Entry."),
			},
		);

		expect(proposalsIn(requests)).toEqual([
			{
				mutation_kind: "update_journal_entry",
				payload: {
					entity_id: "entry-1",
					occurred_at: "2026-06-10T10:30:00",
					body: [{ type: "text", text: "Bought bread after daycare pickup." }],
				},
			},
		]);
	});

	it("update Turn on an empty thread: 'couldn't find' text, no proposal", async () => {
		withProposeScenario({
			turns: [{ action: "update", body: "Bought bread after daycare pickup." }],
		});

		const { events, requests } = await runChat(
			journalIntakeManifest("complete gibberish zzz"),
			{
				tc_read_current_0: okJson({ entries: [] }),
			},
		);

		expect(requests.map((r) => r.name)).toEqual([
			"read_current_thread_journal_entries",
		]);
		expect(deltaText(events)).toContain(
			"I couldn't find that Journal Entry in this thread.",
		);
		expect(events.at(-1)).toEqual({ kind: "done" });
	});

	it("resume: confirms from the Decision result without consuming scenario turns", async () => {
		withProposeScenario({
			turns: [
				{
					action: "create",
					body: "Bought milk after daycare pickup.",
					occurred_at: "2026-06-10T10:30:00",
				},
			],
		});

		const { events, requests } = await runChat(
			journalIntakeManifest("", {
				mode: "resume",
				messages: [
					{ role: "user", text: "complete gibberish zzz" },
					assistantCall("tc_update_0", "propose_workspace_mutation"),
					decisionResult(
						"tc_update_0",
						"Accepted. Updated Journal Entry (entity_id=entry-1).",
					),
				],
			}),
		);

		// The resume branch confirms — the scenario's create turn is NOT played.
		expect(requests).toEqual([]);
		expect(deltaText(events)).toContain("Done — updated it.");
		expect(events.at(-1)).toEqual({ kind: "done" });
	});
});

describe("faux-worker extraction mode (INKSTONE_FAUX_EXTRACT)", () => {
	it("fresh: proposes a create_journal_entry whose body mentions the person", async () => {
		withExtractScenario({
			journal_text: "I had coffee with Alice this morning.",
			person_name: "Alice",
		});

		const { requests } = await runChat(extractManifest(), {
			tc_extract_journal: okText("Accepted. Created Journal Entry."),
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
				tc_extract_read: okJson({
					entries: [
						jeEntry(
							"je-1",
							"2026-06-10T10:30:00",
							"I had coffee with Alice this morning.",
						),
					],
				}),
				tc_extract_search_initial: searchResultResponse([]),
				tc_extract_person: okText("Accepted. Created Person (name=Alice)."),
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

	it("resume after JE accepted can source create_person from the Decision result entity id", async () => {
		withExtractScenario({
			journal_text: "I had coffee with Alice this morning.",
			person_name: "Alice",
			journal_entry_id_source: "decision_result",
		});

		const { requests } = await runChat(
			resumeExtractManifest([
				{ role: "user", text: "I had coffee with Alice." },
				assistantCall("tc_extract_journal", "propose_workspace_mutation"),
				decisionResult(
					"tc_extract_journal",
					"Accepted. Created Journal Entry (entity_id=je-1, occurred_at=2026-06-10T10:30:00, body=I had coffee with Alice this morning.).",
				),
			]),
			{
				tc_extract_search_initial: searchResultResponse([]),
				tc_extract_person: okText("Accepted. Created Person (name=Alice)."),
			},
		);

		expect(requests.map((r) => r.name)).toEqual([
			"search_entities",
			"propose_workspace_mutation",
		]);
		expect(proposalsIn(requests)).toEqual([
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
				tc_extract_read: okJson({
					entries: [
						jeEntry(
							"je-1",
							"2026-06-10T10:30:00",
							"I had coffee with Alice this morning.",
						),
					],
				}),
				tc_extract_search_initial: searchResultResponse([
					{ id: "alice-1", type: "person", label: "Alice" },
				]),
				tc_extract_reference: okText(
					"Accepted. Referenced Entity (source_entity_id=je-1, target_entity_id=alice-1, body=Met .).",
				),
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
				tc_extract_search_recheck: searchResultResponse([
					{ id: "alice-new", type: "person", label: "Alice" },
				]),
				tc_extract_reference: okText(
					"Accepted. Referenced Entity (source_entity_id=je-1, target_entity_id=alice-new, body=Met .).",
				),
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
		expect(deltaText(events)).toContain("Done — extracted Alice.");
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
		expect(deltaText(events)).toContain("Dismissed.");
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
				tc_extract_read: okJson({
					entries: [
						jeEntry(
							"je-1",
							"2026-06-10T10:30:00",
							"I had coffee with Alice this morning.",
						),
					],
				}),
				tc_extract_search_initial: searchResultResponse([]),
				tc_extract_person: okText("Accepted. Created Person (name=Alice)."),
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
				tc_extract_search_recheck: searchResultResponse([
					{ id: "alice-new", type: "person", label: "Alice" },
				]),
				tc_extract_reference: okText(
					"Accepted. Referenced Entity (source_entity_id=je-1, target_entity_id=alice-new, body=Met .).",
				),
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
			tc_extract_journal: okText("Accepted. Created Journal Entry."),
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
				tc_extract_read: okJson({
					entries: [
						jeEntry(
							"je-1",
							"2026-06-10T10:30:00",
							"Kicked off the API v2 migration today.",
						),
					],
				}),
				tc_extract_search_initial: searchResultResponse([]),
				tc_extract_project: okText(
					"Accepted. Created Project (name=Ship API v2 migration).",
				),
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
				tc_extract_read: okJson({
					entries: [
						jeEntry(
							"je-1",
							"2026-06-10T10:30:00",
							"Kicked off the API v2 migration today.",
						),
					],
				}),
				tc_extract_search_initial: searchResultResponse([
					{
						id: "proj-1",
						type: "project",
						label: "Ship API v2 migration",
					},
				]),
				tc_extract_reference: okText(
					"Accepted. Referenced Entity (source_entity_id=je-1, target_entity_id=proj-1, body=Met .).",
				),
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
				tc_extract_search_recheck: searchResultResponse([
					{
						id: "proj-new",
						type: "project",
						label: "Ship API v2 migration",
					},
				]),
				tc_extract_reference: okText(
					"Accepted. Referenced Entity (source_entity_id=je-1, target_entity_id=proj-new, body=Met .).",
				),
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
		expect(deltaText(events)).toContain("Done — added it.");
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
			tc_extract_journal: okText("Accepted. Created Journal Entry."),
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
				tc_extract_read: okJson({
					entries: [
						jeEntry(
							"je-1",
							"2026-06-10T10:30:00",
							"I need to email Alice about Project Y.",
						),
					],
				}),
				tc_extract_search_person: searchResultResponse([
					{ id: "alice-1", type: "person", label: "Alice" },
				]),
				tc_extract_search_project: searchResultResponse([
					{ id: "proj-1", type: "project", label: "Project Y" },
				]),
				tc_extract_todo: okText("Accepted. Created Todo (title=…)."),
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
				tc_extract_read: okJson({
					entries: [
						jeEntry(
							"je-1",
							"2026-06-10T10:30:00",
							"I need to email Alice about Project Y.",
						),
					],
				}),
				tc_extract_search_person: searchResultResponse([]),
				tc_extract_search_project: searchResultResponse([
					{ id: "proj-1", type: "project", label: "Project Y" },
				]),
				tc_extract_todo: okText("Accepted. Created Todo (title=…)."),
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
				tc_extract_read: okJson({
					entries: [
						jeEntry(
							"je-1",
							"2026-06-10T10:30:00",
							"I need to email Alice about Project Y.",
						),
					],
				}),
				tc_extract_search_person: searchResultResponse([
					{ id: "alice-1", type: "person", label: "Alice" },
				]),
				tc_extract_search_project: searchResultResponse([]),
				tc_extract_todo: okText("Accepted. Created Todo (title=…)."),
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
				tc_extract_read: okJson({
					entries: [
						jeEntry("je-1", "2026-06-10T10:30:00", "Wait for Bob to send Z."),
					],
				}),
				tc_extract_search_person: searchResultResponse([
					{ id: "bob-1", type: "person", label: "Bob" },
				]),
				tc_extract_todo: okText("Accepted. Created Todo (title=…)."),
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

describe("faux-worker direct capture mode (INKSTONE_FAUX_CAPTURE)", () => {
	it("intent=todo: proposes ONE create_todo sourced from the Message (no JE, no status, no links)", async () => {
		withCaptureScenario({
			intent: "todo",
			todo: { title: "Buy milk" },
		});

		const { events, requests } = await runChat(
			captureManifest({ prompt: "Remind me to buy milk." }),
			{
				tc_capture: okText("Accepted. Created Todo (title=Buy milk)."),
			},
		);

		// A direct Todo capture proposes exactly once and never touches the
		// journal/extraction tools.
		expect(requests.map((r) => r.name)).toEqual(["propose_workspace_mutation"]);
		const proposals = proposalsIn(requests);
		expect(proposals).toEqual([
			{
				mutation_kind: "create_todo",
				payload: { todo: { title: "Buy milk" } },
			},
		]);
		// Provenance is the user Message: source_journal_entry_id must be ABSENT.
		expect(JSON.stringify(proposals[0].payload)).not.toContain(
			"source_journal_entry_id",
		);
		// Core defaults a new Todo to active, so status is omitted.
		expect(JSON.stringify(proposals[0].payload)).not.toContain("status");
		expect(events.at(-1)).toEqual({ kind: "done" });
	});

	it("intent=todo: carries note + due_at + defer_at when the scenario supplies them", async () => {
		withCaptureScenario({
			intent: "todo",
			todo: {
				title: "Renew passport",
				note: "expires next month",
				due_at: "2026-07-15T09:00:00",
				defer_at: "2026-06-20T09:00:00",
			},
		});

		const { requests } = await runChat(
			captureManifest({ prompt: "Todo: renew passport, due 2026-07-15." }),
			{
				tc_capture: okText("Accepted. Created Todo."),
			},
		);

		expect(proposalsIn(requests)).toEqual([
			{
				mutation_kind: "create_todo",
				payload: {
					todo: {
						title: "Renew passport",
						note: "expires next month",
						due_at: "2026-07-15T09:00:00",
						defer_at: "2026-06-20T09:00:00",
					},
				},
			},
		]);
	});

	it("intent=project: proposes ONE create_project (with outcome) sourced from the Message", async () => {
		withCaptureScenario({
			intent: "project",
			project: {
				name: "Ship API v2 migration",
				outcome: "API v2 fully migrated and old endpoints retired",
			},
		});

		const { requests } = await runChat(
			captureManifest({ prompt: "Start a project for API v2 migration." }),
			{
				tc_capture: okText("Accepted. Created Project."),
			},
		);

		expect(requests.map((r) => r.name)).toEqual(["propose_workspace_mutation"]);
		const proposals = proposalsIn(requests);
		expect(proposals).toEqual([
			{
				mutation_kind: "create_project",
				payload: {
					name: "Ship API v2 migration",
					outcome: "API v2 fully migrated and old endpoints retired",
				},
			},
		]);
		expect(JSON.stringify(proposals[0].payload)).not.toContain(
			"source_journal_entry_id",
		);
	});

	it("intent=person: proposes ONE create_person with descriptive note", async () => {
		withCaptureScenario({
			intent: "person",
			person: { name: "Alice", note: "daycare coordinator" },
		});

		const { requests } = await runChat(
			captureManifest({ prompt: "Remember Alice is the daycare coordinator." }),
			{
				tc_capture: okText("Accepted. Created Person."),
			},
		);

		expect(requests.map((r) => r.name)).toEqual(["propose_workspace_mutation"]);
		const proposals = proposalsIn(requests);
		expect(proposals).toEqual([
			{
				mutation_kind: "create_person",
				payload: { name: "Alice", note: "daycare coordinator" },
			},
		]);
		expect(JSON.stringify(proposals[0].payload)).not.toContain(
			"source_journal_entry_id",
		);
	});

	it("intent=person: carries aliases when the scenario supplies them", async () => {
		withCaptureScenario({
			intent: "person",
			person: { name: "Priya", aliases: ["P", "Priyanka"] },
		});

		const { requests } = await runChat(
			captureManifest({ prompt: "Add Priya (aka P, Priyanka)." }),
			{
				tc_capture: okText("Accepted. Created Person."),
			},
		);

		expect(proposalsIn(requests)).toEqual([
			{
				mutation_kind: "create_person",
				payload: { name: "Priya", aliases: ["P", "Priyanka"] },
			},
		]);
	});

	it("intent=conversation: replies and proposes nothing", async () => {
		withCaptureScenario({ intent: "conversation" });

		const { events, requests } = await runChat(
			captureManifest({ prompt: "What should I focus on today?" }),
		);

		// A plain reply: NO tool calls at all — not just no proposal. A regression
		// that issued search_entities would still be "no capture" yet wrong.
		expect(requests).toEqual([]);
		expect(events.at(-1)).toEqual({ kind: "done" });
	});

	it("resume after the create_todo Decision: confirms with no tool call", async () => {
		withCaptureScenario({ intent: "todo", todo: { title: "Buy milk" } });

		const { events, requests } = await runChat(
			resumeCaptureManifest([
				{ role: "user", text: "Remind me to buy milk." },
				assistantCall("tc_capture", "propose_workspace_mutation"),
				decisionResult(
					"tc_capture",
					"Accepted. Created Todo (title=Buy milk, status=active).",
				),
			]),
		);

		// The park→decide→resume cycle ends in a plain confirmation: no further
		// proposal, run completes.
		expect(requests).toEqual([]);
		expect(deltaText(events)).toContain("Done");
		expect(events.at(-1)).toEqual({ kind: "done" });
	});
});

// A resume transcript where the direct create_todo was already accepted. The
// user-text prefix never routes (capture mode keys on the scenario file and
// tool_result decisions, not prose), so one shape serves every enrichment case.
const todoAcceptedTranscript = (title: string): ManifestMessage[] => [
	{ role: "user", text: `Remind me to ${title}.` },
	assistantCall("tc_capture", "propose_workspace_mutation"),
	decisionResult(
		"tc_capture",
		`Accepted. Created Todo (title=${title}, status=active).`,
	),
];

describe("faux-worker direct capture enrichment — existing entities (INKSTONE_FAUX_CAPTURE)", () => {
	// After a direct create_todo is accepted, the worker recovers the new Todo's
	// id by search (Core's create_todo Decision carries title+status, not the id —
	// crates/core/src/entities.rs:155), then links an EXISTING accepted
	// Person/Project via one update_todo per resume cycle.

	it("existing Project found: recovers todo id then proposes ONE update_todo with project_id", async () => {
		withCaptureScenario({
			intent: "todo",
			todo: { title: "email Alice about Project Y" },
			enrich: { project_name: "Project Y" },
		});

		const { requests } = await runChat(
			resumeCaptureManifest(
				todoAcceptedTranscript("email Alice about Project Y"),
			),
			{
				tc_cap_todo: searchResultResponse([
					{ id: "todo-1", type: "todo", label: "email Alice about Project Y" },
				]),
				tc_cap_search_project: searchResultResponse([
					{ id: "proj-1", type: "project", label: "Project Y" },
				]),
				tc_cap_update_project: okText(
					"Accepted. Updated Todo (todo_id=todo-1).",
				),
			},
		);

		// recover todo id -> search project -> ONE update_todo link.
		expect(requests.map((r) => r.name)).toEqual([
			"search_entities",
			"search_entities",
			"propose_workspace_mutation",
		]);
		expect(proposalsIn(requests)).toEqual([
			{
				mutation_kind: "update_todo",
				payload: { todo_id: "todo-1", todo: { project_id: "proj-1" } },
			},
		]);
	});

	it("existing Person found (related): proposes ONE update_todo with add_person_refs", async () => {
		withCaptureScenario({
			intent: "todo",
			todo: { title: "email Alice" },
			enrich: { person_name: "Alice", person_role: "related" },
		});

		const { requests } = await runChat(
			resumeCaptureManifest(todoAcceptedTranscript("email Alice")),
			{
				tc_cap_todo: searchResultResponse([
					{ id: "todo-1", type: "todo", label: "email Alice" },
				]),
				tc_cap_search_person: searchResultResponse([
					{ id: "alice-1", type: "person", label: "Alice" },
				]),
				tc_cap_update_person: okText(
					"Accepted. Updated Todo (todo_id=todo-1).",
				),
			},
		);

		expect(requests.map((r) => r.name)).toEqual([
			"search_entities",
			"search_entities",
			"propose_workspace_mutation",
		]);
		expect(proposalsIn(requests)).toEqual([
			{
				mutation_kind: "update_todo",
				payload: {
					todo_id: "todo-1",
					add_person_refs: [{ person_id: "alice-1", role: "related" }],
				},
			},
		]);
	});

	it("'wait for X' uses waiting_on role on the person ref", async () => {
		withCaptureScenario({
			intent: "todo",
			todo: { title: "wait for Bob to send the schedule" },
			enrich: { person_name: "Bob", person_role: "waiting_on" },
		});

		const { requests } = await runChat(
			resumeCaptureManifest(
				todoAcceptedTranscript("wait for Bob to send the schedule"),
			),
			{
				tc_cap_todo: searchResultResponse([
					{
						id: "todo-1",
						type: "todo",
						label: "wait for Bob to send the schedule",
					},
				]),
				tc_cap_search_person: searchResultResponse([
					{ id: "bob-1", type: "person", label: "Bob" },
				]),
				tc_cap_update_person: okText(
					"Accepted. Updated Todo (todo_id=todo-1).",
				),
			},
		);

		expect(proposalsIn(requests)).toEqual([
			{
				mutation_kind: "update_todo",
				payload: {
					todo_id: "todo-1",
					add_person_refs: [{ person_id: "bob-1", role: "waiting_on" }],
				},
			},
		]);
	});

	it("rejected enrichment: confirms and proposes nothing further (Todo stays unlinked)", async () => {
		withCaptureScenario({
			intent: "todo",
			todo: { title: "email Alice" },
			enrich: { person_name: "Alice", person_role: "related" },
		});

		const { events, requests } = await runChat(
			resumeCaptureManifest([
				...todoAcceptedTranscript("email Alice"),
				assistantCall("tc_cap_todo", "search_entities"),
				searchResult("tc_cap_todo", [
					{ id: "todo-1", type: "todo", label: "email Alice" },
				]),
				assistantCall("tc_cap_search_person", "search_entities"),
				searchResult("tc_cap_search_person", [
					{ id: "alice-1", type: "person", label: "Alice" },
				]),
				assistantCall("tc_cap_update_person", "propose_workspace_mutation"),
				decisionResult("tc_cap_update_person", "User declined this proposal."),
			]),
		);

		// A declined enrichment ends the flow: no further proposal, Todo unchanged.
		expect(requests.some((r) => r.name === "propose_workspace_mutation")).toBe(
			false,
		);
		expect(events.at(-1)).toEqual({ kind: "done" });
	});

	it("project then person: after the project link is accepted, the next resume links the person (one at a time)", async () => {
		withCaptureScenario({
			intent: "todo",
			todo: { title: "email Alice about Project Y" },
			enrich: {
				person_name: "Alice",
				person_role: "related",
				project_name: "Project Y",
			},
		});

		const { requests } = await runChat(
			resumeCaptureManifest([
				...todoAcceptedTranscript("email Alice about Project Y"),
				// cycle 1 (project) already happened and was accepted:
				assistantCall("tc_cap_todo", "search_entities"),
				searchResult("tc_cap_todo", [
					{ id: "todo-1", type: "todo", label: "email Alice about Project Y" },
				]),
				assistantCall("tc_cap_search_project", "search_entities"),
				searchResult("tc_cap_search_project", [
					{ id: "proj-1", type: "project", label: "Project Y" },
				]),
				assistantCall("tc_cap_update_project", "propose_workspace_mutation"),
				decisionResult(
					"tc_cap_update_project",
					"Accepted. Updated Todo (todo_id=todo-1).",
				),
			]),
			{
				tc_cap_search_person: searchResultResponse([
					{ id: "alice-1", type: "person", label: "Alice" },
				]),
				tc_cap_update_person: okText(
					"Accepted. Updated Todo (todo_id=todo-1).",
				),
			},
		);

		// Todo id reused from the transcript's prior search (no re-search); straight
		// to person search -> ONE update_todo for the person.
		expect(requests.map((r) => r.name)).toEqual([
			"search_entities",
			"propose_workspace_mutation",
		]);
		expect(proposalsIn(requests)).toEqual([
			{
				mutation_kind: "update_todo",
				payload: {
					todo_id: "todo-1",
					add_person_refs: [{ person_id: "alice-1", role: "related" }],
				},
			},
		]);
	});
});

describe("faux-worker direct capture enrichment — missing entities (INKSTONE_FAUX_CAPTURE)", () => {
	it("missing Person: empty search -> proposes create_person sourced from the Message (no JE)", async () => {
		withCaptureScenario({
			intent: "todo",
			todo: { title: "follow up with NewPerson" },
			enrich: { person_name: "NewPerson", person_role: "related" },
		});

		const { requests } = await runChat(
			resumeCaptureManifest(todoAcceptedTranscript("follow up with NewPerson")),
			{
				tc_cap_todo: searchResultResponse([
					{ id: "todo-1", type: "todo", label: "follow up with NewPerson" },
				]),
				// The person does NOT exist yet.
				tc_cap_search_person: searchResultResponse([]),
				tc_cap_create_person: okText(
					"Accepted. Created Person (name=NewPerson).",
				),
			},
		);

		// recover todo id -> search (empty) -> propose create_person.
		expect(requests.map((r) => r.name)).toEqual([
			"search_entities",
			"search_entities",
			"propose_workspace_mutation",
		]);
		const proposals = proposalsIn(requests);
		expect(proposals).toEqual([
			{
				mutation_kind: "create_person",
				payload: { name: "NewPerson" },
			},
		]);
		// Missing-entity create is Message-sourced: no JE provenance.
		expect(JSON.stringify(proposals[0].payload)).not.toContain(
			"source_journal_entry_id",
		);
	});

	it("after the missing Person is accepted: re-searches then proposes update_todo to link it", async () => {
		withCaptureScenario({
			intent: "todo",
			todo: { title: "follow up with NewPerson" },
			enrich: { person_name: "NewPerson", person_role: "related" },
		});

		const { requests } = await runChat(
			resumeCaptureManifest([
				...todoAcceptedTranscript("follow up with NewPerson"),
				assistantCall("tc_cap_todo", "search_entities"),
				searchResult("tc_cap_todo", [
					{ id: "todo-1", type: "todo", label: "follow up with NewPerson" },
				]),
				assistantCall("tc_cap_search_person", "search_entities"),
				searchResult("tc_cap_search_person", []),
				assistantCall("tc_cap_create_person", "propose_workspace_mutation"),
				decisionResult(
					"tc_cap_create_person",
					"Accepted. Created Person (name=NewPerson).",
				),
			]),
			{
				// The re-search now finds the just-created Person (distinct call id).
				tc_cap_research_person: searchResultResponse([
					{ id: "newperson-1", type: "person", label: "NewPerson" },
				]),
				tc_cap_update_person: okText(
					"Accepted. Updated Todo (todo_id=todo-1).",
				),
			},
		);

		// re-search (distinct id) -> ONE update_todo linking the new Person.
		expect(requests.map((r) => r.name)).toEqual([
			"search_entities",
			"propose_workspace_mutation",
		]);
		expect(proposalsIn(requests)).toEqual([
			{
				mutation_kind: "update_todo",
				payload: {
					todo_id: "todo-1",
					add_person_refs: [{ person_id: "newperson-1", role: "related" }],
				},
			},
		]);
	});

	it("rejected missing Person: no update_todo link follows (Todo stays unlinked)", async () => {
		withCaptureScenario({
			intent: "todo",
			todo: { title: "follow up with NewPerson" },
			enrich: { person_name: "NewPerson", person_role: "related" },
		});

		const { events, requests } = await runChat(
			resumeCaptureManifest([
				...todoAcceptedTranscript("follow up with NewPerson"),
				assistantCall("tc_cap_todo", "search_entities"),
				searchResult("tc_cap_todo", [
					{ id: "todo-1", type: "todo", label: "follow up with NewPerson" },
				]),
				assistantCall("tc_cap_search_person", "search_entities"),
				searchResult("tc_cap_search_person", []),
				assistantCall("tc_cap_create_person", "propose_workspace_mutation"),
				decisionResult("tc_cap_create_person", "User declined this proposal."),
			]),
		);

		// Declined missing-entity create: no link proposal, run completes.
		expect(requests.some((r) => r.name === "propose_workspace_mutation")).toBe(
			false,
		);
		expect(events.at(-1)).toEqual({ kind: "done" });
	});

	it("missing Project: empty search -> proposes create_project sourced from the Message", async () => {
		withCaptureScenario({
			intent: "todo",
			todo: { title: "kick off Lisbon trip planning" },
			enrich: { project_name: "Plan Lisbon trip" },
		});

		const { requests } = await runChat(
			resumeCaptureManifest(
				todoAcceptedTranscript("kick off Lisbon trip planning"),
			),
			{
				tc_cap_todo: searchResultResponse([
					{
						id: "todo-1",
						type: "todo",
						label: "kick off Lisbon trip planning",
					},
				]),
				tc_cap_search_project: searchResultResponse([]),
				tc_cap_create_project: okText(
					"Accepted. Created Project (name=Plan Lisbon trip, status=active).",
				),
			},
		);

		expect(requests.map((r) => r.name)).toEqual([
			"search_entities",
			"search_entities",
			"propose_workspace_mutation",
		]);
		const proposals = proposalsIn(requests);
		expect(proposals).toEqual([
			{
				mutation_kind: "create_project",
				payload: { name: "Plan Lisbon trip" },
			},
		]);
		expect(JSON.stringify(proposals[0].payload)).not.toContain(
			"source_journal_entry_id",
		);
	});

	it("after the missing Project is accepted: re-searches then proposes update_todo with project_id", async () => {
		withCaptureScenario({
			intent: "todo",
			todo: { title: "kick off Lisbon trip planning" },
			enrich: { project_name: "Plan Lisbon trip" },
		});

		const { requests } = await runChat(
			resumeCaptureManifest([
				...todoAcceptedTranscript("kick off Lisbon trip planning"),
				assistantCall("tc_cap_todo", "search_entities"),
				searchResult("tc_cap_todo", [
					{
						id: "todo-1",
						type: "todo",
						label: "kick off Lisbon trip planning",
					},
				]),
				assistantCall("tc_cap_search_project", "search_entities"),
				searchResult("tc_cap_search_project", []),
				assistantCall("tc_cap_create_project", "propose_workspace_mutation"),
				decisionResult(
					"tc_cap_create_project",
					"Accepted. Created Project (name=Plan Lisbon trip, status=active).",
				),
			]),
			{
				// The re-search (distinct id) finds the just-created Project.
				tc_cap_research_project: searchResultResponse([
					{ id: "lisbon-1", type: "project", label: "Plan Lisbon trip" },
				]),
				tc_cap_update_project: okText(
					"Accepted. Updated Todo (todo_id=todo-1).",
				),
			},
		);

		// re-search (distinct id) -> ONE update_todo linking the new Project via project_id.
		expect(requests.map((r) => r.name)).toEqual([
			"search_entities",
			"propose_workspace_mutation",
		]);
		expect(proposalsIn(requests)).toEqual([
			{
				mutation_kind: "update_todo",
				payload: { todo_id: "todo-1", todo: { project_id: "lisbon-1" } },
			},
		]);
	});

	it("rejected missing Project: no update_todo link follows (Todo stays unlinked)", async () => {
		withCaptureScenario({
			intent: "todo",
			todo: { title: "kick off Lisbon trip planning" },
			enrich: { project_name: "Plan Lisbon trip" },
		});

		const { events, requests } = await runChat(
			resumeCaptureManifest([
				...todoAcceptedTranscript("kick off Lisbon trip planning"),
				assistantCall("tc_cap_todo", "search_entities"),
				searchResult("tc_cap_todo", [
					{
						id: "todo-1",
						type: "todo",
						label: "kick off Lisbon trip planning",
					},
				]),
				assistantCall("tc_cap_search_project", "search_entities"),
				searchResult("tc_cap_search_project", []),
				assistantCall("tc_cap_create_project", "propose_workspace_mutation"),
				decisionResult("tc_cap_create_project", "User declined this proposal."),
			]),
		);

		// Declined missing-Project create: no link proposal, run completes.
		expect(requests.some((r) => r.name === "propose_workspace_mutation")).toBe(
			false,
		);
		expect(events.at(-1)).toEqual({ kind: "done" });
	});

	it("declined initial create_todo: no enrichment runs (no search against a non-existent Todo)", async () => {
		// The Todo itself is rejected — even though the scenario names enrichment,
		// there is no Todo to enrich (and no recoverable id). The flow must stop:
		// no search_entities, no update_todo. Exercises the todoCreated===false
		// resume branch, which every other resume test skips (they accept the Todo).
		withCaptureScenario({
			intent: "todo",
			todo: { title: "follow up with NewPerson" },
			enrich: { person_name: "NewPerson", person_role: "related" },
		});

		const { events, requests } = await runChat(
			resumeCaptureManifest([
				{ role: "user", text: "Follow up with NewPerson." },
				assistantCall("tc_capture", "propose_workspace_mutation"),
				decisionResult("tc_capture", "User declined this proposal."),
			]),
		);

		// No tool calls at all — not even a recovery search.
		expect(requests).toEqual([]);
		expect(events.at(-1)).toEqual({ kind: "done" });
	});
});
