// TEST-ONLY Worker entry — never the production worker command — see docs/design/worker.md (ADR-0019)

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import type { WorkerManifest } from "@inkstone/protocol";
import type { InterpreterDeps } from "../interpreter.js";
import { runWorkerMain } from "../worker-main.js";
import {
	acceptedCreate,
	acceptedReference,
	acceptedVerb,
	decisionOutcome,
} from "./faux-decisions.js";
import { fauxInterpreterDeps } from "./faux-deps.js";

/** Flatten a pi message `content` (string | content blocks) to plain text. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c) =>
				c && typeof c === "object" && "text" in c
					? String((c as { text: unknown }).text)
					: "",
			)
			.join("");
	}
	return "";
}

// ── Ordered-Turn fixtures (ADR-0019) ───────────────────────────────────────
// ADR-0019 prescribes the faux script as an *ordered list of Turn responses*,
// hand-authored, and explicitly rejects the "(context) => response" programmatic
// shape. These builders express one Turn per entry declaratively: `toolCallTurn`
// for a tool-use Turn, `textTurn` for a plain assistant reply. A scenario's
// script is then a hand-readable array of Turns. The minority of Turns whose
// response genuinely depends on a PRIOR tool result (a Journal Entry id or a
// search row that is only known at run time) stay as `(context) => …` closures —
// no static fixture can name a value the run hasn't produced yet.

/** One scripted Turn: a static assistant response, or a context-dependent one
 * for the Turns that must read a prior tool result. */
type FauxContext = { messages: AnyMessage[] };
type FauxTurn =
	| ReturnType<typeof fauxAssistantMessage>
	| ((context: FauxContext) => ReturnType<typeof fauxAssistantMessage>);

/** A tool-use Turn: the assistant calls `name(args)` under tool-call id `id`. */
function toolCallTurn(
	name: string,
	args: Record<string, unknown>,
	id: string,
): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage([fauxToolCall(name, args, { id })], {
		stopReason: "toolUse",
	});
}

/** A plain-text Turn: the assistant replies with `text` and stops. */
function textTurn(text: string): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage(text);
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

interface JournalEntrySnapshot {
	entity_id: string;
	occurred_at: string;
	ended_at?: string;
	body?: Array<{ type?: string; text?: string }>;
}

function currentThreadEntriesFromToolResult(
	text: string,
): JournalEntrySnapshot[] {
	try {
		const payload = JSON.parse(text) as { entries?: JournalEntrySnapshot[] };
		return Array.isArray(payload.entries) ? payload.entries : [];
	} catch {
		return [];
	}
}

function firstBodyText(entry: JournalEntrySnapshot): string {
	const firstNode = Array.isArray(entry.body) ? entry.body[0] : undefined;
	return typeof firstNode?.text === "string" ? firstNode.text : "";
}

function journalConfirmation(text: string): string {
	if (decisionOutcome(text) === "declined") {
		return "Done — dismissed it.";
	}
	if (acceptedVerb(text, "Deleted", "Journal Entry")) {
		return "Done — deleted it.";
	}
	if (acceptedVerb(text, "Updated", "Journal Entry")) {
		return "Done — updated it.";
	}
	if (acceptedVerb(text, "Created", "Journal Entry")) {
		return "Done — added it.";
	}
	return "Done.";
}

function createJournalEntryProposal(bodyText: string, occurredAt: string) {
	return {
		mutation_kind: "create_journal_entry",
		payload: {
			occurred_at: occurredAt,
			body: [
				{
					type: "text",
					text: bodyText,
				},
			],
		},
		rationale: "the user shared a journal-worthy moment",
	};
}

function updateJournalEntryProposal(
	entry: JournalEntrySnapshot,
	bodyText: string,
	occurredAt: string,
) {
	const payload: {
		entity_id: string;
		occurred_at: string;
		ended_at?: string;
		body: Array<{ type: "text"; text: string }>;
	} = {
		entity_id: entry.entity_id,
		occurred_at: occurredAt,
		body: [
			{
				type: "text",
				text: bodyText,
			},
		],
	};
	if (typeof entry.ended_at === "string") {
		payload.ended_at = entry.ended_at;
	}
	return {
		mutation_kind: "update_journal_entry",
		payload,
		rationale: "the user corrected a Journal Entry from this Thread",
	};
}

function deleteJournalEntryProposal(entry: JournalEntrySnapshot) {
	return {
		mutation_kind: "delete_journal_entry",
		payload: {
			entity_id: entry.entity_id,
		},
		rationale: "the user wants to remove a mistaken Journal Entry",
	};
}

// ── Propose-mode scenario playback (INKSTONE_FAUX_PROPOSE_PARAMS) ──────────
// An ordered list of Turns played back by manifest position (the count of user
// messages), mirroring the EXTRACT/CAPTURE scenario-file seam — the prompt's
// prose never routes the action. Omitted update fields keep the live entry's
// values; update/delete resolve the entry via a real
// read_current_thread_journal_entries round-trip, entry[0].

/** One validated scenario Turn: create carries its full payload (both fields
 * required); update fields are optional (omitted = keep the live entry's
 * value); delete resolves everything from the live entry. */
type ProposeTurn =
	| { action: "create"; body: string; occurred_at: string }
	| { action: "update"; body?: string; occurred_at?: string }
	| { action: "delete" };

interface ProposeScenario {
	turns: ProposeTurn[];
}

function readProposeScenario(): ProposeScenario {
	const file = process.env.INKSTONE_FAUX_PROPOSE_PARAMS;
	if (file === undefined || file.length === 0) {
		throw new Error(
			"INKSTONE_FAUX_PROPOSE=1 requires INKSTONE_FAUX_PROPOSE_PARAMS to point at a scenario JSON file",
		);
	}
	// Read+parse failures (missing file, malformed JSON) must name the seam and
	// the path — a bare ENOENT/SyntaxError through catchAllDefect names neither.
	let parsed: {
		turns?: Array<{ action?: unknown; body?: string; occurred_at?: string }>;
	};
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (cause) {
		throw new Error(`INKSTONE_FAUX_PROPOSE_PARAMS ${file}: ${String(cause)}`, {
			cause,
		});
	}
	if (!Array.isArray(parsed.turns)) {
		throw new Error(
			`INKSTONE_FAUX_PROPOSE_PARAMS: file must contain a "turns" array`,
		);
	}
	// Validate the WHOLE scenario at load, not the played Turn at use: a typo'd
	// action or a partial create must fail fast — the update/delete ternary below
	// would otherwise route an unknown action to the most destructive branch.
	for (const [index, turn] of parsed.turns.entries()) {
		if (
			turn.action !== "create" &&
			turn.action !== "update" &&
			turn.action !== "delete"
		) {
			throw new Error(
				`INKSTONE_FAUX_PROPOSE_PARAMS turn ${index}: unknown action ${JSON.stringify(turn.action)} (expected create|update|delete)`,
			);
		}
		if (turn.action === "create") {
			// Empty strings are as wrong as missing fields: an empty-body create
			// parks Core-side as an invalid draft, far from the authoring mistake.
			if (turn.body === undefined || turn.body === "") {
				throw new Error(
					`INKSTONE_FAUX_PROPOSE_PARAMS turn ${index}: create requires "body"`,
				);
			}
			if (turn.occurred_at === undefined || turn.occurred_at === "") {
				throw new Error(
					`INKSTONE_FAUX_PROPOSE_PARAMS turn ${index}: create requires "occurred_at"`,
				);
			}
		}
	}
	return parsed as ProposeScenario;
}

/** Script the faux provider from the scenario Turn at the manifest position
 * (fresh mode only — resumes confirm via journalConfirmation upstream). */
function setProposePlaybackResponses(
	faux: ReturnType<typeof fauxProvider>,
	manifest: WorkerManifest,
	scenario: ProposeScenario,
): void {
	const position = manifest.messages.filter((m) => m.role === "user").length;
	const turn = scenario.turns[position];
	if (turn === undefined) {
		throw new Error(
			`INKSTONE_FAUX_PROPOSE_PARAMS scenario exhausted: position ${position} has no turn (${scenario.turns.length} scripted)`,
		);
	}

	// tool_calls.id is a GLOBAL primary key in Core's DB, so a multi-Turn scenario
	// in one thread must not reuse ids across Runs — suffix them by position.
	if (turn.action === "create") {
		faux.setResponses([
			toolCallTurn(
				"propose_workspace_mutation",
				createJournalEntryProposal(turn.body, turn.occurred_at),
				`tc_create_${position}`,
			),
			textTurn("Done — added it."),
		]);
		return;
	}

	faux.setResponses([
		toolCallTurn(
			"read_current_thread_journal_entries",
			{},
			`tc_read_current_${position}`,
		),
		(context) => {
			const toolResult = [...context.messages]
				.reverse()
				.find((message) => message.role === "toolResult");
			const entries = currentThreadEntriesFromToolResult(
				textOf(toolResult?.content),
			);
			const entry = entries[0];
			if (entry === undefined) {
				return textTurn("I couldn't find that Journal Entry in this thread.");
			}
			const proposal =
				turn.action === "update"
					? updateJournalEntryProposal(
							entry,
							turn.body ?? firstBodyText(entry),
							turn.occurred_at ?? entry.occurred_at,
						)
					: deleteJournalEntryProposal(entry);
			return toolCallTurn(
				"propose_workspace_mutation",
				proposal,
				turn.action === "update"
					? `tc_update_${position}`
					: `tc_delete_${position}`,
			);
		},
		(context) => {
			const toolResult = [...context.messages]
				.reverse()
				.find((message) => message.role === "toolResult");
			return textTurn(journalConfirmation(textOf(toolResult?.content)));
		},
	]);
}

// ── Extraction mode (INKSTONE_FAUX_EXTRACT) ────────────────────────────────
// Person extraction from an accepted Journal Entry. Each park→decide→resume
// spawns a FRESH process, so the worker reconstructs its phase from
// `manifest.messages` every invocation. See docs/design/worker.md + the slice-4
// state machine. The target name + journal text are injected via a scenario file
// (INKSTONE_FAUX_EXTRACT_PARAMS), not parsed from NL — the worker still issues
// REAL search_entities calls and branches on the REAL (empty vs non-empty) result.

// Additive scenario shape (backward-compatible with slice-4's person-only
// `{journal_text, person_name}`). Target precedence: `todo` → Todo (this
// slice — a DIRECT create whose links are resolved by search, no separate
// reference step), else `project_name` → Project, else `person_name` → Person
// (slice-4 behavior, unchanged), else NO extraction target (the "category stays
// plain text" path).
interface ExtractScenario {
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
}

type ExtractTarget = { kind: "person" | "project"; name: string };

/** Resolve the extraction target by precedence, or `undefined` for no-target. */
function extractTarget(scenario: ExtractScenario): ExtractTarget | undefined {
	if (scenario.project_name !== undefined && scenario.project_name.length > 0) {
		return { kind: "project", name: scenario.project_name };
	}
	if (scenario.person_name !== undefined && scenario.person_name.length > 0) {
		return { kind: "person", name: scenario.person_name };
	}
	return undefined;
}

function readExtractScenario(): ExtractScenario {
	const file = process.env.INKSTONE_FAUX_EXTRACT_PARAMS;
	if (file === undefined || file.length === 0) {
		throw new Error(
			"INKSTONE_FAUX_EXTRACT=1 requires INKSTONE_FAUX_EXTRACT_PARAMS to point at a scenario JSON file",
		);
	}
	const parsed = JSON.parse(readFileSync(file, "utf8")) as ExtractScenario;
	return {
		journal_text: parsed.journal_text,
		person_name: parsed.person_name,
		project_name: parsed.project_name,
		journal_entry_id_source: parsed.journal_entry_id_source,
		todo: parsed.todo,
	};
}

interface SearchResultRow {
	id: string;
	type: string;
	label: string | null;
}

/** Parse `results[]` out of a `search_entities` tool result JSON string. */
function searchResultsFromToolResult(text: string): SearchResultRow[] {
	try {
		const payload = JSON.parse(text) as { results?: SearchResultRow[] };
		return Array.isArray(payload.results) ? payload.results : [];
	} catch {
		return [];
	}
}

/** A minimal view over both the resume transcript (`tool_result`/`content`,
 * snake_case `tool_call_id`) and the in-process pi context (`toolResult`/
 * `content`, camelCase `toolCallId`). */
type AnyMessage = {
	role: string;
	content?: unknown;
	tool_call_id?: string;
	toolCallId?: string;
};

/** The tool-call id a tool_result message answers, across both transcript forms. */
function toolResultCallId(m: AnyMessage): string | undefined {
	return m.tool_call_id ?? m.toolCallId;
}

/** Unwrap a tool_result content string to the tool's own inner payload text.
 * In-process pi `toolResult`s flatten to the bare inner JSON, but a RESUME
 * transcript carries Core's serialized `AgentToolResult` envelope verbatim
 * (`{"content":[{"type":"text","text":"<inner>"}],…}` — see resume.rs
 * render_result_content). Peel that envelope so the parse helpers see the inner
 * `{entries|results …}` either way; leave already-bare text untouched. */
function unwrapToolResultText(text: string): string {
	try {
		const parsed = JSON.parse(text) as { content?: unknown };
		if (Array.isArray(parsed.content)) {
			return textOf(parsed.content);
		}
	} catch {
		// Not an envelope (already bare inner JSON) — fall through.
	}
	return text;
}

/** Newest-first scan for the latest tool_result content matching `predicate`. */
function latestToolResultText(
	messages: readonly AnyMessage[],
	predicate: (text: string) => boolean,
): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "tool_result" && m.role !== "toolResult") continue;
		const text = unwrapToolResultText(textOf(m.content));
		if (predicate(text)) return text;
	}
	return undefined;
}

/** The current-thread Journal Entry id from the latest read result, if any. */
function journalEntryIdFrom(
	messages: readonly AnyMessage[],
): string | undefined {
	const text = latestToolResultText(messages, (t) => t.includes('"entries"'));
	if (text === undefined) return undefined;
	return currentThreadEntriesFromToolResult(text)[0]?.entity_id;
}

/** The Journal Entry id Core now includes in an accepted create_journal_entry
 * Decision result. This covers the real-model path where the Worker reasons
 * from the resume transcript instead of issuing a read tool call. */
function journalEntryIdFromDecision(
	messages: readonly AnyMessage[],
): string | undefined {
	const text = latestToolResultText(messages, (t) =>
		acceptedCreate(t, "Journal Entry"),
	);
	return text?.match(/\bentity_id=([^,\s)]+)/)?.[1];
}

function journalEntryIdForExtraction(
	scenario: ExtractScenario,
	context: FauxContext,
	manifest: WorkerManifest,
): string | undefined {
	if (scenario.journal_entry_id_source === "decision_result") {
		return (
			journalEntryIdFromDecision(context.messages) ??
			journalEntryIdFromDecision(manifest.messages)
		);
	}
	return (
		journalEntryIdFrom(context.messages) ??
		journalEntryIdFrom(manifest.messages)
	);
}

/** The latest `search_entities` results, if a search result is present. */
function latestSearchResults(
	messages: readonly AnyMessage[],
): SearchResultRow[] | undefined {
	const text = latestToolResultText(messages, (t) => t.includes('"results"'));
	if (text === undefined) return undefined;
	return searchResultsFromToolResult(text);
}

/** The id of the first result row from the search issued under `searchCallId`,
 * or undefined if that specific search returned no rows. Bound to the CURRENT
 * phase's tool-call id (not a transcript-wide scan by row type) so that "empty
 * search now" reliably means "omit the link now" — an earlier same-kind search
 * from a prior step cannot bleed a stale id into this proposal. */
function searchedEntityId(
	messages: readonly AnyMessage[],
	searchCallId: string,
): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "tool_result" && m.role !== "toolResult") continue;
		if (toolResultCallId(m) !== searchCallId) continue;
		const text = unwrapToolResultText(textOf(m.content));
		if (!text.includes('"results"')) continue;
		return searchResultsFromToolResult(text)[0]?.id;
	}
	return undefined;
}

type ExtractionPhase =
	| "propose_journal"
	| "after_journal"
	| "after_create_entity"
	| "done"
	| "dismiss";

/** Reconstruct which extraction step to run from the manifest transcript.
 * Pure over the message list + mode so it is unit-testable. */
export function extractionPhase(manifest: WorkerManifest): ExtractionPhase {
	if (manifest.mode !== "resume") return "propose_journal";

	const decisions = manifest.messages.filter(
		(m): m is Extract<typeof m, { role: "tool_result" }> =>
			m.role === "tool_result" && decisionOutcome(m.content) !== undefined,
	);
	const latest = decisions.at(-1);
	if (latest !== undefined && decisionOutcome(latest.content) === "declined") {
		return "dismiss";
	}

	const acceptedCreateOf = (kind: string) =>
		decisions.some((d) => acceptedCreate(d.content, kind));
	// The Todo flow is a single create with no reference step, so an accepted
	// create_todo Decision means the flow is complete.
	if (acceptedCreateOf("Todo")) return "done";
	if (decisions.some((d) => acceptedReference(d.content))) return "done";
	if (acceptedCreateOf("Person") || acceptedCreateOf("Project"))
		return "after_create_entity";
	if (acceptedCreateOf("Journal Entry")) return "after_journal";
	// No relevant accepted Decision yet — confirm and stop rather than loop.
	return "done";
}

function createJournalEntryForExtraction(scenario: ExtractScenario) {
	return {
		mutation_kind: "create_journal_entry",
		payload: {
			occurred_at: "2026-06-10T10:30:00",
			body: [{ type: "text", text: scenario.journal_text }],
		},
		rationale: "the user shared a journal-worthy moment",
	};
}

// Per-kind labels keep the person path's prose byte-identical while letting the
// project path reuse the same machine.
const KIND_LABEL: Record<ExtractTarget["kind"], string> = {
	person: "Person",
	project: "Project",
};

function createEntityProposal(target: ExtractTarget, journalEntryId: string) {
	return {
		mutation_kind:
			target.kind === "project" ? "create_project" : "create_person",
		payload: {
			name: target.name,
			source_journal_entry_id: journalEntryId,
		},
		rationale: `the Journal Entry mentions a ${KIND_LABEL[target.kind]} not yet in the Workspace`,
	};
}

function referenceEntityProposal(
	target: ExtractTarget,
	journalEntryId: string,
	entityId: string,
) {
	return {
		mutation_kind: "reference_existing_entity_from_journal_entry",
		payload: {
			source_entity_id: journalEntryId,
			target_entity_id: entityId,
			body: [
				{ type: "text", text: "Met " },
				{ type: "entity_ref" },
				{ type: "text", text: "." },
			],
		},
		rationale: `link the accepted ${KIND_LABEL[target.kind]} from this Journal Entry`,
	};
}

/** Build the `create_todo` envelope, linking the Todo to a found Person/Project.
 * Links are OMITTED (not nulled) when search returned no match so the envelope
 * stays a valid plain-text Todo — Core's payload uses `deny_unknown_fields`. */
function createTodoProposal(
	todo: NonNullable<ExtractScenario["todo"]>,
	journalEntryId: string,
	personId: string | undefined,
	projectId: string | undefined,
) {
	return {
		mutation_kind: "create_todo",
		payload: {
			todo: {
				title: todo.title,
				...(projectId !== undefined ? { project_id: projectId } : {}),
			},
			...(personId !== undefined
				? {
						person_refs: [
							{ person_id: personId, role: todo.person_role ?? "related" },
						],
					}
				: {}),
			source_journal_entry_id: journalEntryId,
		},
		rationale: "the Journal Entry records an obligation to track as a Todo",
	};
}

/** Script the Todo flow (after_journal phase): read the JE id, then search for
 * the named Person/Project (each search a distinct step), then propose ONE
 * create_todo with whatever links resolved. No reference step. */
function setExtractTodoResponses(
	faux: ReturnType<typeof fauxProvider>,
	manifest: WorkerManifest,
	todo: NonNullable<ExtractScenario["todo"]>,
): void {
	const responses: FauxTurn[] = [
		toolCallTurn("read_current_thread_journal_entries", {}, "tc_extract_read"),
	];
	if (todo.person_name !== undefined && todo.person_name.length > 0) {
		responses.push(
			toolCallTurn(
				"search_entities",
				{ type: "person", query: todo.person_name },
				"tc_extract_search_person",
			),
		);
	}
	if (todo.project_name !== undefined && todo.project_name.length > 0) {
		responses.push(
			toolCallTurn(
				"search_entities",
				{ type: "project", query: todo.project_name },
				"tc_extract_search_project",
			),
		);
	}
	responses.push((context) => {
		const journalEntryId =
			journalEntryIdFrom(context.messages) ??
			journalEntryIdFrom(manifest.messages);
		if (journalEntryId === undefined) {
			return fauxAssistantMessage(
				"I couldn't find the Journal Entry to extract from.",
			);
		}
		const personId =
			todo.person_name !== undefined && todo.person_name.length > 0
				? searchedEntityId(context.messages, "tc_extract_search_person")
				: undefined;
		const projectId =
			todo.project_name !== undefined && todo.project_name.length > 0
				? searchedEntityId(context.messages, "tc_extract_search_project")
				: undefined;
		return toolCallTurn(
			"propose_workspace_mutation",
			createTodoProposal(todo, journalEntryId, personId, projectId),
			"tc_extract_todo",
		);
	});
	responses.push(textTurn("Awaiting your decision."));
	faux.setResponses(responses);
}

// ── Direct capture mode (INKSTONE_FAUX_CAPTURE) ────────────────────────────
// A user types task/project/person-shaped input directly into chat and gets ONE
// create_* proposal sourced from the user Message — no Journal Entry (ADR-0030
// allows direct non-journal capture; Core auto-sources from the triggering
// Message when source_journal_entry_id is omitted). The intent + entity fields
// are injected via a scenario file (INKSTONE_FAUX_CAPTURE_PARAMS), mirroring the
// EXTRACT mode, rather than parsed from NL.

interface CaptureScenario {
	intent: "todo" | "project" | "person" | "conversation";
	todo?: { title: string; note?: string; due_at?: string; defer_at?: string };
	project?: { name: string; outcome?: string };
	person?: { name: string; note?: string; aliases?: string[] };
	// After a direct Todo is accepted, enrich it with existing accepted
	// People/Projects (slice 3) — one update_todo proposal per resume cycle,
	// Project before Person (ADR-0031 sequencing).
	enrich?: {
		person_name?: string;
		person_role?: "waiting_on" | "related";
		project_name?: string;
	};
}

// One enrichment step: link the named existing entity onto the Todo. `kind`
// selects the search type + update_todo shape; ordered project-before-person.
type EnrichStep = { kind: "project" | "person"; name: string };

/** The ordered enrichment steps a scenario asks for (project first), filtered to
 * those naming an entity. Empty when the scenario has no `enrich`. */
function enrichSteps(scenario: CaptureScenario): EnrichStep[] {
	const enrich = scenario.enrich;
	if (enrich === undefined) return [];
	const steps: EnrichStep[] = [];
	if (enrich.project_name !== undefined && enrich.project_name.length > 0) {
		steps.push({ kind: "project", name: enrich.project_name });
	}
	if (enrich.person_name !== undefined && enrich.person_name.length > 0) {
		steps.push({ kind: "person", name: enrich.person_name });
	}
	return steps;
}

function readCaptureScenario(): CaptureScenario {
	const file = process.env.INKSTONE_FAUX_CAPTURE_PARAMS;
	if (file === undefined || file.length === 0) {
		throw new Error(
			"INKSTONE_FAUX_CAPTURE=1 requires INKSTONE_FAUX_CAPTURE_PARAMS to point at a scenario JSON file",
		);
	}
	return JSON.parse(readFileSync(file, "utf8")) as CaptureScenario;
}

/** Build the direct-capture create_* proposal for a scenario, or `undefined`
 * for the conversation intent (nothing to propose). Links/status/provenance are
 * OMITTED (never nulled): a direct capture carries no source_journal_entry_id
 * (Core sources it from the user Message) and lets Core default Todo status. */
function captureProposal(scenario: CaptureScenario) {
	if (scenario.intent === "todo" && scenario.todo !== undefined) {
		const { title, note, due_at, defer_at } = scenario.todo;
		return {
			mutation_kind: "create_todo",
			payload: {
				todo: {
					title,
					...(note !== undefined ? { note } : {}),
					...(due_at !== undefined ? { due_at } : {}),
					...(defer_at !== undefined ? { defer_at } : {}),
				},
			},
			rationale: "the user asked to track a direct Todo",
		};
	}
	if (scenario.intent === "project" && scenario.project !== undefined) {
		const { name, outcome } = scenario.project;
		return {
			mutation_kind: "create_project",
			payload: {
				name,
				...(outcome !== undefined ? { outcome } : {}),
			},
			rationale: "the user asked to start a Project outcome",
		};
	}
	if (scenario.intent === "person" && scenario.person !== undefined) {
		const { name, note, aliases } = scenario.person;
		return {
			mutation_kind: "create_person",
			payload: {
				name,
				...(note !== undefined ? { note } : {}),
				...(aliases !== undefined ? { aliases } : {}),
			},
			rationale: "the user asked to remember a Person",
		};
	}
	return undefined;
}

/** The recovered Todo id for enrichment: the first result of the todo-recovery
 * search (bound to its call id), if that search is already in the transcript. */
function capturedTodoId(messages: readonly AnyMessage[]): string | undefined {
	return searchedEntityId(messages, "tc_cap_todo");
}

// Per-step tool-call ids. Each enrichment step does up to four tool calls across
// resumes — search existing, (if missing) create, re-search the created entity,
// update_todo link — and `tool_calls.id` is a GLOBAL primary key, so the ids must
// be distinct per kind AND per role (initial search vs post-create re-search).
const STEP_IDS: Record<
	EnrichStep["kind"],
	{ search: string; create: string; research: string; update: string }
> = {
	project: {
		search: "tc_cap_search_project",
		create: "tc_cap_create_project",
		research: "tc_cap_research_project",
		update: "tc_cap_update_project",
	},
	person: {
		search: "tc_cap_search_person",
		create: "tc_cap_create_person",
		research: "tc_cap_research_person",
		update: "tc_cap_update_person",
	},
};

/** Whether a Decision for a proposal under `callId` is present in the transcript,
 * and if so whether it was accepted. */
function decisionFor(
	messages: readonly AnyMessage[],
	callId: string,
): "accepted" | "declined" | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "tool_result" && m.role !== "toolResult") continue;
		if (toolResultCallId(m) !== callId) continue;
		return decisionOutcome(textOf(m.content));
	}
	return undefined;
}

/** A step is RESOLVED once a Decision for its link has landed (the user accepted
 * OR declined the update_todo — either way that link is settled and the Todo
 * stays valid), or its missing-entity create was declined (link abandoned).
 * Otherwise it still needs work. */
function stepResolved(
	messages: readonly AnyMessage[],
	step: EnrichStep,
): boolean {
	const ids = STEP_IDS[step.kind];
	return (
		decisionFor(messages, ids.update) !== undefined ||
		decisionFor(messages, ids.create) === "declined"
	);
}

/** Build the update_todo link proposal for an enrichment step + resolved id. */
function enrichLinkProposal(
	step: EnrichStep,
	todoId: string,
	entityId: string,
	personRole: "waiting_on" | "related",
) {
	if (step.kind === "project") {
		return {
			mutation_kind: "update_todo",
			payload: { todo_id: todoId, todo: { project_id: entityId } },
			rationale: "link the accepted Project to the Todo",
		};
	}
	return {
		mutation_kind: "update_todo",
		payload: {
			todo_id: todoId,
			add_person_refs: [{ person_id: entityId, role: personRole }],
		},
		rationale: "link the accepted Person to the Todo",
	};
}

/** Build the missing-entity create proposal, sourced from the user Message (no
 * source_journal_entry_id — Core auto-sources from the triggering Message). */
function enrichCreateProposal(step: EnrichStep) {
	if (step.kind === "project") {
		return {
			mutation_kind: "create_project",
			payload: { name: step.name },
			rationale: "the Todo references a Project not yet in the Workspace",
		};
	}
	return {
		mutation_kind: "create_person",
		payload: { name: step.name },
		rationale: "the Todo references a Person not yet in the Workspace",
	};
}

/** Script the enrichment leg for the FIRST unresolved step. Each resume advances
 * one step (link an existing entity, or create-then-link a missing one), one
 * proposal at a time. Steps already linked or abandoned (declined create) are
 * skipped; when none remain, confirm and stop. */
function setCaptureEnrichResponses(
	faux: ReturnType<typeof fauxProvider>,
	manifest: WorkerManifest,
	scenario: CaptureScenario,
): void {
	const steps = enrichSteps(scenario);
	const step = steps.find((s) => !stepResolved(manifest.messages, s));
	if (step === undefined || scenario.todo === undefined) {
		// No (more) enrichment to do: confirm and stop.
		faux.setResponses([fauxAssistantMessage("Done — added it.")]);
		return;
	}
	const personRole = scenario.enrich?.person_role ?? "related";
	const ids = STEP_IDS[step.kind];

	// If this step's missing-entity create was already ACCEPTED, the entity now
	// exists: re-search (distinct id) and propose the update_todo link.
	if (decisionFor(manifest.messages, ids.create) === "accepted") {
		faux.setResponses([
			toolCallTurn(
				"search_entities",
				{ type: step.kind, query: step.name },
				ids.research,
			),
			(context) => {
				const todoId =
					capturedTodoId(context.messages) ?? capturedTodoId(manifest.messages);
				const entityId = searchedEntityId(context.messages, ids.research);
				if (todoId === undefined || entityId === undefined) {
					return textTurn("Done — added it.");
				}
				return toolCallTurn(
					"propose_workspace_mutation",
					enrichLinkProposal(step, todoId, entityId, personRole),
					ids.update,
				);
			},
			textTurn("Awaiting your decision."),
		]);
		return;
	}

	const responses: FauxTurn[] = [];

	// Recover the Todo id by title search unless a prior cycle already did
	// (its result is in the resume transcript).
	const haveTodoId = capturedTodoId(manifest.messages) !== undefined;
	if (!haveTodoId) {
		responses.push(
			toolCallTurn(
				"search_entities",
				{ type: "todo", query: scenario.todo.title },
				"tc_cap_todo",
			),
		);
	}
	// Search the step's entity (existing-vs-missing branch resolves on the result).
	responses.push(
		toolCallTurn(
			"search_entities",
			{ type: step.kind, query: step.name },
			ids.search,
		),
	);
	// FOUND -> propose update_todo link; MISSING -> propose create_* first.
	responses.push((context) => {
		const todoId =
			capturedTodoId(context.messages) ?? capturedTodoId(manifest.messages);
		const entityId = searchedEntityId(context.messages, ids.search);
		if (todoId === undefined) {
			return textTurn("Done — added it.");
		}
		if (entityId === undefined) {
			// Missing: create the entity first, Message-sourced. The link follows
			// on the next resume once this create is accepted.
			return toolCallTurn(
				"propose_workspace_mutation",
				enrichCreateProposal(step),
				ids.create,
			);
		}
		return toolCallTurn(
			"propose_workspace_mutation",
			enrichLinkProposal(step, todoId, entityId, personRole),
			ids.update,
		);
	});
	responses.push(textTurn("Awaiting your decision."));
	faux.setResponses(responses);
}

/** Script the faux provider for direct capture for THIS process. A fresh run
 * proposes the create_* once and parks; resumes drive Todo enrichment. */
function setCaptureResponses(
	faux: ReturnType<typeof fauxProvider>,
	manifest: WorkerManifest,
): void {
	const scenario = readCaptureScenario();

	// Resume: drive enrichment as long as the Todo was created. The step-walk
	// (stepResolved) decides what remains, so we don't need to distinguish
	// after_create vs after_link — both resume into the enrichment leg.
	if (manifest.mode === "resume") {
		const todoCreated = manifest.messages.some(
			(m) => m.role === "tool_result" && acceptedCreate(m.content, "Todo"),
		);
		if (todoCreated) {
			setCaptureEnrichResponses(faux, manifest, scenario);
		} else {
			// The Todo create itself was declined (or no Todo) — nothing to enrich.
			faux.setResponses([textTurn("Done — added it.")]);
		}
		return;
	}

	// Fresh run.
	const proposal = captureProposal(scenario);
	if (proposal === undefined) {
		// Conversation intent (or a malformed scenario): reply, propose nothing.
		faux.setResponses([
			textTurn("Happy to talk it through — nothing to capture here."),
		]);
		return;
	}

	faux.setResponses([
		toolCallTurn("propose_workspace_mutation", proposal, "tc_capture"),
		textTurn("Done — added it."),
	]);
}

/** Script the faux provider for the extraction state machine for THIS process. */
function setExtractResponses(
	faux: ReturnType<typeof fauxProvider>,
	manifest: WorkerManifest,
): void {
	const scenario = readExtractScenario();
	const target = extractTarget(scenario);
	const phase = extractionPhase(manifest);

	if (phase === "done") {
		faux.setResponses([
			textTurn(
				target !== undefined
					? `Done — extracted ${target.name}.`
					: "Done — added it.",
			),
		]);
		return;
	}
	if (phase === "dismiss") {
		faux.setResponses([textTurn("Dismissed.")]);
		return;
	}
	if (phase === "propose_journal") {
		faux.setResponses([
			toolCallTurn(
				"propose_workspace_mutation",
				createJournalEntryForExtraction(scenario),
				"tc_extract_journal",
			),
			textTurn("Journal Entry captured."),
		]);
		return;
	}

	// Todo target (precedence over person/project): a Todo is created DIRECTLY in
	// the after_journal phase, with its Person/Project links resolved by search —
	// no separate reference step. (propose_journal/done/dismiss are handled above,
	// target-agnostic.)
	if (scenario.todo !== undefined && phase === "after_journal") {
		setExtractTodoResponses(faux, manifest, scenario.todo);
		return;
	}

	// No-target / category case: the JE is accepted but the scenario names no
	// entity to extract, so confirm and propose NOTHING (category stays plain text).
	if (target === undefined) {
		faux.setResponses([textTurn("Done — added it.")]);
		return;
	}

	// Both "after_journal" and "after_create_entity" end with a search → propose
	// chain. after_journal first reads the JE to learn its id; after_create_entity
	// already has the JE id in the transcript and re-searches to resolve the new id.
	const proposeFromSearch = (context: FauxContext) => {
		const journalEntryId = journalEntryIdForExtraction(
			scenario,
			context,
			manifest,
		);
		const results = latestSearchResults(context.messages) ?? [];
		if (journalEntryId === undefined) {
			return textTurn("I couldn't find the Journal Entry to extract from.");
		}
		const found = results[0];
		const proposal =
			found !== undefined
				? referenceEntityProposal(target, journalEntryId, found.id)
				: createEntityProposal(target, journalEntryId);
		const createId =
			target.kind === "project" ? "tc_extract_project" : "tc_extract_person";
		return toolCallTurn(
			"propose_workspace_mutation",
			proposal,
			found !== undefined ? "tc_extract_reference" : createId,
		);
	};
	// `tool_calls.id` is a global PRIMARY KEY, so the two searches in the
	// missing→create→reference Run must carry DISTINCT ids. Key the id off the
	// phase: the after_journal search and the after_create_entity re-search never
	// share a Run-step, so phase-distinct constants stay unique and deterministic.
	const searchToolCallId =
		phase === "after_create_entity"
			? "tc_extract_search_recheck"
			: "tc_extract_search_initial";
	const searchEntity = toolCallTurn(
		"search_entities",
		{ type: target.kind, query: target.name },
		searchToolCallId,
	);
	const finalConfirm = textTurn("Awaiting your decision.");

	if (phase === "after_journal") {
		faux.setResponses(
			scenario.journal_entry_id_source === "decision_result"
				? [searchEntity, proposeFromSearch, finalConfirm]
				: [
						toolCallTurn(
							"read_current_thread_journal_entries",
							{},
							"tc_extract_read",
						),
						searchEntity,
						proposeFromSearch,
						finalConfirm,
					],
		);
		return;
	}

	// phase === "after_create_entity"
	faux.setResponses([searchEntity, proposeFromSearch, finalConfirm]);
}

/** Build interpreter deps that script pi-ai's faux provider from `INKSTONE_FAUX_*` env vars — see docs/design/worker.md for the five modes. */
export function fauxDepsFor(manifest: WorkerManifest): InterpreterDeps {
	const faux = fauxProvider({ provider: "faux" });
	const errorMessage = process.env.INKSTONE_FAUX_ERROR;
	if (errorMessage !== undefined && errorMessage.length > 0) {
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage }),
		]);
	} else if (process.env.INKSTONE_FAUX_TOOL_CALL === "1") {
		// Tool-call mode (e2e): turn 1 read_thread on the pasted id, turn 2 echoes the result.
		faux.setResponses([
			(context) => {
				const lastUser = [...context.messages]
					.reverse()
					.find((m) => m.role === "user");
				const match = textOf(lastUser?.content).match(UUID_RE);
				const threadId = match ? match[0] : "missing";
				return fauxAssistantMessage(
					[fauxToolCall("read_thread", { thread_id: threadId })],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				const toolResult = [...context.messages]
					.reverse()
					.find((m) => m.role === "toolResult");
				return textTurn(`read_thread result: ${textOf(toolResult?.content)}`);
			},
		]);
	} else if (process.env.INKSTONE_FAUX_LOAD_SKILL !== undefined) {
		// Load-skill mode (e2e, ADR-0036): turn 1 calls the AMBIENT load_skill tool
		// by name (the name rides in INKSTONE_FAUX_LOAD_SKILL), turn 2 echoes the
		// returned skill body. Proves the Skills activation round-trip surfaces a
		// tool-call row in the real UI even though no Workflow allowlists load_skill.
		const skillName = process.env.INKSTONE_FAUX_LOAD_SKILL;
		faux.setResponses([
			toolCallTurn("load_skill", { name: skillName }, "tc_load_skill"),
			(context) => {
				const toolResult = [...context.messages]
					.reverse()
					.find((m) => m.role === "toolResult");
				return textTurn(`load_skill result: ${textOf(toolResult?.content)}`);
			},
		]);
	} else if (process.env.INKSTONE_FAUX_PROPOSE === "1") {
		// Propose mode (e2e): scenario-driven ordered Turns via
		// INKSTONE_FAUX_PROPOSE_PARAMS (required, fresh AND resume — same
		// fail-fast shape as EXTRACT/CAPTURE); the prompt's prose never routes.
		// Fresh turn proposes, Core parks; resume continues — see
		// docs/design/worker.md (ADR-0025).
		const scenario = readProposeScenario();
		if (manifest.mode === "resume") {
			// The scenario is loaded/validated above but its turns aren't consumed
			// on resume — confirm from the awaited Decision tool_result.
			const toolResult = [...manifest.messages]
				.reverse()
				.find((message) => message.role === "tool_result");
			faux.setResponses([
				textTurn(journalConfirmation(textOf(toolResult?.content))),
			]);
		} else {
			setProposePlaybackResponses(faux, manifest, scenario);
		}
	} else if (process.env.INKSTONE_FAUX_EXTRACT === "1") {
		// Extraction mode (e2e): after an accepted Journal Entry mentioning a Person,
		// chain read -> search -> propose (create_person | reference) across resumes
		// — see the slice-4 state machine + docs/design/worker.md (ADR-0030/0031).
		setExtractResponses(faux, manifest);
	} else if (process.env.INKSTONE_FAUX_CAPTURE === "1") {
		// Direct capture mode (e2e): task/project/person-shaped input proposes ONE
		// create_* sourced from the user Message — no Journal Entry (ADR-0030/0031).
		setCaptureResponses(faux, manifest);
	} else if (process.env.INKSTONE_FAUX_ECHO_HISTORY === "1") {
		// History-echo mode (multi-turn test): echo prior turns' roles+text — see docs/design/worker.md.
		faux.setResponses([
			(context) => {
				// All prior turns except the current prompt (the last user message).
				const prior = context.messages.slice(0, -1);
				const parts = prior.map((m) => `${m.role}=${textOf(m.content)}`);
				return textTurn(`history:${parts.join("|")}`);
			},
		]);
	} else if (process.env.INKSTONE_FAUX_THINKING !== undefined) {
		// Thinking mode (e2e, ADR-0045 reasoning amendment): one turn emitting a
		// reasoning block then the reply, so the Client renders a collapsed reasoning
		// segment that survives reload. The thinking text rides in the env var; the
		// reply is fixed.
		const thinking = process.env.INKSTONE_FAUX_THINKING;
		faux.setResponses([
			fauxAssistantMessage([
				fauxThinking(thinking),
				fauxText("Here is the answer."),
			]),
		]);
	} else {
		faux.setResponses([
			textTurn(process.env.INKSTONE_FAUX_RESPONSE ?? "faux reply"),
		]);
	}
	return fauxInterpreterDeps(faux);
}

// Run only when this file is the process entry, not when imported — see docs/design/worker.md.
// realpathSync both sides so the macOS /var→/private/var symlink doesn't defeat the comparison.
const entryPath = process.argv[1];
if (
	entryPath !== undefined &&
	realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url))
) {
	runWorkerMain(fauxDepsFor);
}
