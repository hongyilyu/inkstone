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
import type { JsonObject, JsonValue, WorkerManifest } from "@inkstone/protocol";
import { asArray, asObject, asString, decodeJson } from "@inkstone/protocol";
import { Option } from "effect";
import type { InterpreterDeps } from "../interpreter.js";
import { runWorkerMain } from "../worker-main.js";
import {
	acceptedCreate,
	acceptedReference,
	acceptedVerb,
	decisionOutcome,
	tickTickWriteOutcome,
} from "./faux-decisions.js";
import { fauxInterpreterDeps } from "./faux-deps.js";

/** Flatten a message `content` (a string, or content blocks) to plain text. */
function textOf(content: JsonValue | undefined): string {
	const text = asString(content);
	if (text !== undefined) return text;
	return asArray(content)
		.map((block) => {
			const record = asObject(block);
			return record !== null && "text" in record ? String(record.text) : "";
		})
		.join("");
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
/** A tool-use Turn: the assistant calls `name(args)` under tool-call id `id`. */
function toolCallTurn(
	name: string,
	args: JsonObject,
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
		// `text` is the JSON result of the
		// `read_current_thread_journal_entries` tool this harness scripts; `entries`
		// is re-checked for an array below.
		const payload = JSON.parse(text) as { entries?: JournalEntrySnapshot[] };
		return Array.isArray(payload.entries) ? payload.entries : [];
	} catch {
		return [];
	}
}

/** The `update_journal_entry` payload the correction Turn proposes. */
type JournalEntryUpdatePayload = {
	entity_id: string;
	occurred_at: string;
	ended_at?: string;
	body: Array<{ type: "text"; text: string }>;
};

function firstBodyText(entry: JournalEntrySnapshot): string {
	const firstNode = Array.isArray(entry.body) ? entry.body[0] : undefined;
	return firstNode?.text ?? "";
}

function journalConfirmation(text: string): string {
	if (decisionOutcome(text) === "declined") {
		return "Done — dismissed it.";
	}
	// The TickTick write's three outcomes (ticktick-writes W-A3): the model
	// RELAYS the outcome — a failed/unknown write is never reported as done.
	const write = tickTickWriteOutcome(text);
	if (write === "created") {
		return "Done — it's in TickTick.";
	}
	if (write === "failed") {
		return "TickTick didn't take it — the task was not created.";
	}
	if (write === "unknown") {
		return "I'm not sure that reached TickTick — check it before re-asking.";
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
	const payload: JournalEntryUpdatePayload = {
		entity_id: entry.entity_id,
		occurred_at: occurredAt,
		body: [
			{
				type: "text",
				text: bodyText,
			},
		],
	};
	if (entry.ended_at !== undefined) {
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
	| { action: "delete" }
	// The TickTick write family (ticktick-writes W4): one task Proposal, the
	// ONE remote write. `title` required; `due`/`note` optional, passed
	// through verbatim so a scenario can exercise the card's due rendering.
	| {
			action: "ticktick_task";
			title: string;
			note?: string;
			due?: { date: string; is_all_day?: boolean; time_zone?: string };
	  };

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
		turns?: Array<{
			action?: unknown;
			body?: string;
			occurred_at?: string;
			title?: unknown;
			note?: unknown;
			due?: unknown;
		}>;
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
			turn.action !== "delete" &&
			turn.action !== "ticktick_task"
		) {
			throw new Error(
				`INKSTONE_FAUX_PROPOSE_PARAMS turn ${index}: unknown action ${JSON.stringify(turn.action)} (expected create|update|delete|ticktick_task)`,
			);
		}
		if (turn.action === "ticktick_task") {
			// Fail fast on the WHOLE turn (the module's stated contract): a
			// non-string title or a `due: null` would otherwise surface as a
			// throw deep in playback, or as an invalid proposal payload Core
			// rejects far from the authoring mistake.
			if (typeof turn.title !== "string" || turn.title === "") {
				throw new Error(
					`INKSTONE_FAUX_PROPOSE_PARAMS turn ${index}: ticktick_task requires a non-empty string "title"`,
				);
			}
			if (turn.note !== undefined && typeof turn.note !== "string") {
				throw new Error(
					`INKSTONE_FAUX_PROPOSE_PARAMS turn ${index}: ticktick_task "note" must be a string`,
				);
			}
			if (turn.due !== undefined) {
				const due = turn.due;
				if (
					typeof due !== "object" ||
					due === null ||
					Array.isArray(due) ||
					typeof (due as { date?: unknown }).date !== "string" ||
					(due as { date: string }).date === ""
				) {
					throw new Error(
						`INKSTONE_FAUX_PROPOSE_PARAMS turn ${index}: ticktick_task "due" must be an object with a non-empty string "date"`,
					);
				}
			}
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
	// every field the harness reads is checked above.
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

	// The TickTick write: its OWN proposal tool, no mutation_kind (the stored
	// kind derives from the tool name). One task per proposal.
	if (turn.action === "ticktick_task") {
		// The `propose_ticktick_task` wire payload (ticktick-writes W-A2:
		// `{title, note?, due?}` — Inbox-only, no list/tags/priority). Built by
		// statement so an omitted field is absent, not `undefined`.
		const payload: JsonObject = { title: turn.title };
		if (turn.note !== undefined) {
			payload.note = turn.note;
		}
		if (turn.due !== undefined) {
			const due: JsonObject = { date: turn.due.date };
			if (turn.due.is_all_day !== undefined) {
				due.is_all_day = turn.due.is_all_day;
			}
			if (turn.due.time_zone !== undefined) {
				due.time_zone = turn.due.time_zone;
			}
			payload.due = due;
		}
		faux.setResponses([
			toolCallTurn(
				"propose_ticktick_task",
				{ payload, rationale: "the user asked to be reminded" },
				`tc_ticktick_${position}`,
			),
			textTurn("Done — it's in TickTick."),
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
			const entries = currentThreadEntriesFromToolResult(
				latestToolResultText(context.messages) ?? "",
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
		(context) =>
			textTurn(
				journalConfirmation(latestToolResultText(context.messages) ?? ""),
			),
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
// `{journal_text, person_name}`). Target precedence: `project_name` → Project,
// else `person_name` → Person (slice-4 behavior, unchanged), else NO extraction
// target (the "category stays plain text" path).
interface ExtractScenario {
	journal_text: string;
	person_name?: string;
	project_name?: string;
	journal_entry_id_source?: "read_tool" | "decision_result";
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
	// the file is the scenario the e2e spec wrote for this run.
	const parsed = JSON.parse(readFileSync(file, "utf8")) as ExtractScenario;
	return {
		journal_text: parsed.journal_text,
		person_name: parsed.person_name,
		project_name: parsed.project_name,
		journal_entry_id_source: parsed.journal_entry_id_source,
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
		// `text` is the JSON result of the `search_entities` tool this
		// harness scripts; `results` is re-checked for an array below.
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
	/** Wire `tool_result` blocks carry the ONE transcript result type
	 * (external-task-views A4); pi runtime `toolResult`s keep flat `content`. */
	result?: { content?: unknown };
	tool_call_id?: string;
	toolCallId?: string;
};

/** The flattened text of a tool result, across both transcript forms: the wire
 * `tool_result`'s `result.content` blocks, or the pi `toolResult`'s `content`. */
function toolResultText(m: AnyMessage): string {
	// pi's in-process content crosses as its own open type; decode it to JSON here.
	return textOf(Option.getOrNull(decodeJson(m.result?.content ?? m.content)));
}

/** Newest-first scan for the latest tool_result content, matching `predicate` when
 * one is given (a context-dependent Turn just wants the newest one). */
function latestToolResultText(
	messages: readonly AnyMessage[],
	predicate: (text: string) => boolean = () => true,
): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "tool_result" && m.role !== "toolResult") continue;
		const text = toolResultText(m);
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
			m.role === "tool_result" &&
			decisionOutcome(textOf(m.result.content)) !== undefined,
	);
	const latest = decisions.at(-1);
	if (
		latest !== undefined &&
		decisionOutcome(textOf(latest.result.content)) === "declined"
	) {
		return "dismiss";
	}

	const acceptedCreateOf = (kind: string) =>
		decisions.some((d) => acceptedCreate(textOf(d.result.content), kind));
	if (decisions.some((d) => acceptedReference(textOf(d.result.content))))
		return "done";
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
const KIND_LABEL = {
	person: "Person",
	project: "Project",
} satisfies Record<ExtractTarget["kind"], string>;

function createEntityProposal(
	target: ExtractTarget,
	journalEntryId: string,
): JsonObject {
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
): JsonObject {
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

// ── Direct capture mode (INKSTONE_FAUX_CAPTURE) ────────────────────────────
// A user types project/person-shaped input directly into chat and gets ONE
// create_* proposal sourced from the user Message — no Journal Entry (ADR-0030
// allows direct non-journal capture; Core auto-sources from the triggering
// Message when source_journal_entry_id is omitted). The intent + entity fields
// are injected via a scenario file (INKSTONE_FAUX_CAPTURE_PARAMS), mirroring the
// EXTRACT mode, rather than parsed from NL.

interface CaptureScenario {
	intent: "project" | "person" | "conversation";
	project?: { name: string; outcome?: string };
	person?: { name: string; note?: string; aliases?: string[] };
}

function readCaptureScenario(): CaptureScenario {
	const file = process.env.INKSTONE_FAUX_CAPTURE_PARAMS;
	if (file === undefined || file.length === 0) {
		throw new Error(
			"INKSTONE_FAUX_CAPTURE=1 requires INKSTONE_FAUX_CAPTURE_PARAMS to point at a scenario JSON file",
		);
	}
	// the file is the scenario the e2e spec wrote for this run.
	return JSON.parse(readFileSync(file, "utf8")) as CaptureScenario;
}

/** Build the direct-capture create_* proposal for a scenario, or `undefined`
 * for the conversation intent (nothing to propose). Fields/provenance are
 * OMITTED (never nulled): a direct capture carries no source_journal_entry_id
 * (Core sources it from the user Message). */
function captureProposal(scenario: CaptureScenario) {
	if (scenario.intent === "project" && scenario.project !== undefined) {
		const { name, outcome } = scenario.project;
		const payload: JsonObject = {};
		payload.name = name;
		if (outcome !== undefined) payload.outcome = outcome;
		return {
			mutation_kind: "create_project",
			payload,
			rationale: "the user asked to start a Project outcome",
		};
	}
	if (scenario.intent === "person" && scenario.person !== undefined) {
		const { name, note, aliases } = scenario.person;
		const payload: JsonObject = {};
		payload.name = name;
		if (note !== undefined) payload.note = note;
		if (aliases !== undefined) payload.aliases = aliases;
		return {
			mutation_kind: "create_person",
			payload,
			rationale: "the user asked to remember a Person",
		};
	}
	return undefined;
}

/** Script the faux provider for direct capture for THIS process. A fresh run
 * proposes the create_* once and parks; a resume confirms and stops. */
function setCaptureResponses(
	faux: ReturnType<typeof fauxProvider>,
	manifest: WorkerManifest,
): void {
	const scenario = readCaptureScenario();

	// Resume: the Decision landed (accepted or declined) — confirm and stop.
	if (manifest.mode === "resume") {
		faux.setResponses([textTurn("Done — added it.")]);
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
	} else if (process.env.INKSTONE_FAUX_EXTERNAL !== undefined) {
		// External tool-call mode (e2e, external-task-views A3/A4): one
		// `ticktick_filter_tasks` call per comma-separated entry ("error" sends
		// empty args so the fake MCP server fails the call), then a final turn
		// echoing the LAST tool result — proving the model received the content.
		const entries = process.env.INKSTONE_FAUX_EXTERNAL.split(",");
		faux.setResponses([
			...entries.map((entry, index) =>
				toolCallTurn(
					"ticktick_filter_tasks",
					entry === "error" ? {} : { filter: { status: [0] }, call: index + 1 },
					`tc_ext_${index + 1}`,
				),
			),
			(context) =>
				textTurn(
					`external result: ${latestToolResultText(context.messages) ?? ""}`,
				),
		]);
	} else if (process.env.INKSTONE_FAUX_TOOL_CALL === "1") {
		// Tool-call mode (e2e): turn 1 read_thread on the pasted id, turn 2 echoes the result.
		faux.setResponses([
			(context) => {
				const lastUser = [...context.messages]
					.reverse()
					.find((m) => m.role === "user");
				const match = textOf(
					Option.getOrNull(decodeJson(lastUser?.content)),
				).match(UUID_RE);
				const threadId = match ? match[0] : "missing";
				return fauxAssistantMessage(
					[fauxToolCall("read_thread", { thread_id: threadId })],
					{ stopReason: "toolUse" },
				);
			},
			(context) =>
				textTurn(
					`read_thread result: ${latestToolResultText(context.messages) ?? ""}`,
				),
		]);
	} else if (process.env.INKSTONE_FAUX_LOAD_SKILL !== undefined) {
		// Load-skill mode (e2e, ADR-0036): turn 1 calls the ambient load_skill by
		// INKSTONE_FAUX_LOAD_SKILL name, turn 2 echoes the body. With
		// INKSTONE_FAUX_EXPECT_DIRECTIVE set, turn 1 instead reports whether that
		// name's ADR-0063 trigger directive reached the manifest system_prompt.
		const skillName = process.env.INKSTONE_FAUX_LOAD_SKILL;
		const expectDirective = process.env.INKSTONE_FAUX_EXPECT_DIRECTIVE;
		if (expectDirective !== undefined) {
			const present = manifest.workflow.system_prompt.includes(
				`Call load_skill("${expectDirective}")`,
			);
			faux.setResponses([textTurn(`trigger directive present: ${present}`)]);
		} else {
			faux.setResponses([
				toolCallTurn("load_skill", { name: skillName }, "tc_load_skill"),
				(context) =>
					textTurn(
						`load_skill result: ${latestToolResultText(context.messages) ?? ""}`,
					),
			]);
		}
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
				textTurn(
					journalConfirmation(
						toolResult === undefined ? "" : textOf(toolResult.result.content),
					),
				),
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
				const parts = prior.map(
					(m) => `${m.role}=${textOf(Option.getOrNull(decodeJson(m.content)))}`,
				);
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
