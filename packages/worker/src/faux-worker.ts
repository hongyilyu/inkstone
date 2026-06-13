// TEST-ONLY Worker entry — never the production worker command — see docs/design/worker.md (ADR-0019)

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
	streamSimple,
} from "@earendil-works/pi-ai";
import type { WorkerManifest } from "@inkstone/protocol";
import type { InterpreterDeps } from "./interpreter.js";
import { runWorkerMain } from "./worker-main.js";

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

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const JOURNAL_ENTRY_TEXT = "Bought milk after daycare pickup.";

type JournalIntakeAction = "create" | "update" | "delete";

interface JournalEntrySnapshot {
	entity_id: string;
	occurred_at: string;
	ended_at?: string;
	body?: Array<{ type?: string; text?: string }>;
}

function lastUserText(
	messages: readonly { role: string; content?: unknown }[],
): string {
	const lastUser = [...messages]
		.reverse()
		.find((message) => message.role === "user");
	return textOf(lastUser?.content);
}

function classifyJournalIntakePrompt(prompt: string): JournalIntakeAction {
	const lower = prompt.toLowerCase();
	const referencesCurrentEntry =
		/\bfor that entry\b/.test(lower) ||
		/\b(?:that|this|the) journal entry\b/.test(lower) ||
		/\b(?:that|this|the) entry\b/.test(lower) ||
		/\bthat one\b/.test(lower);
	if (
		referencesCurrentEntry &&
		(lower.includes("delete") ||
			lower.includes("remove") ||
			lower.includes("drop"))
	) {
		return "delete";
	}
	if (
		referencesCurrentEntry &&
		(lower.includes("correct") ||
			lower.includes("change") ||
			lower.includes("edit") ||
			lower.includes("update") ||
			lower.includes("make it"))
	) {
		return "update";
	}
	return "create";
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
	return typeof firstNode?.text === "string" && firstNode.text.length > 0
		? firstNode.text
		: JOURNAL_ENTRY_TEXT;
}

function replacementTextFromPrompt(prompt: string): string | null {
	const promptMatch = prompt.match(/\bmake it ([^.!?]+?)(?:[.!?]|$)/i);
	return promptMatch?.[1]?.trim() || null;
}

function updatedOccurredAt(prompt: string, currentOccurredAt: string): string {
	const timeMatch = prompt.match(
		/\b(?:change|set|make)\b.*\btime\b.*\bto\b\s*(\d{1,2}):(\d{2})\b/i,
	);
	if (timeMatch === null) {
		return currentOccurredAt;
	}
	const [, hours, minutes] = timeMatch;
	const hour = Number(hours);
	const minute = Number(minutes);
	if (
		Number.isNaN(hour) ||
		Number.isNaN(minute) ||
		hour < 0 ||
		hour > 23 ||
		minute < 0 ||
		minute > 59
	) {
		return currentOccurredAt;
	}
	const dateMatch = currentOccurredAt.match(/^(\d{4}-\d{2}-\d{2})T/);
	if (dateMatch === null) {
		return currentOccurredAt;
	}
	return `${dateMatch[1]}T${hours.padStart(2, "0")}:${minutes}:00`;
}

function updatedBodyText(prompt: string, currentText: string): string {
	const replacement = replacementTextFromPrompt(prompt);
	if (replacement === null) {
		return currentText;
	}
	const objectMatch = currentText.match(
		/^(\w+\s+)(.+?)(\s+(?:after|before|during|at|on|in|from|with|for|while|because|since)\b.*)$/i,
	);
	if (objectMatch !== null) {
		const [, prefix, , suffix] = objectMatch;
		return `${prefix}${replacement}${suffix}`;
	}
	if (/\bmilk\b/i.test(currentText)) {
		return currentText.replace(/\b(?:[a-z]+\s+)?milk\b/i, replacement);
	}
	return currentText;
}

function journalConfirmation(text: string): string {
	const lower = text.toLowerCase();
	if (
		lower.includes("declined") ||
		lower.includes("rejected") ||
		lower.includes("dismissed")
	) {
		return "Done — dismissed it.";
	}
	if (lower.includes("deleted journal entry")) {
		return "Done — deleted it.";
	}
	if (lower.includes("updated journal entry")) {
		return "Done — updated it.";
	}
	if (lower.includes("created journal entry")) {
		return "Done — added it.";
	}
	return "Done.";
}

function createJournalEntryProposal() {
	return {
		mutation_kind: "create_journal_entry",
		payload: {
			occurred_at: "2026-06-10T10:30:00",
			body: [
				{
					type: "text",
					text: JOURNAL_ENTRY_TEXT,
				},
			],
		},
		rationale: "the user shared a journal-worthy moment",
	};
}

function updateJournalEntryProposal(
	prompt: string,
	entry: JournalEntrySnapshot,
) {
	const payload: {
		entity_id: string;
		occurred_at: string;
		ended_at?: string;
		body: Array<{ type: "text"; text: string }>;
	} = {
		entity_id: entry.entity_id,
		occurred_at: updatedOccurredAt(prompt, entry.occurred_at),
		body: [
			{
				type: "text",
				text: updatedBodyText(prompt, firstBodyText(entry)),
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
			m.role === "tool_result" &&
			(m.content.startsWith("Accepted.") ||
				m.content === "User declined this proposal."),
	);
	const latest = decisions.at(-1);
	if (
		latest !== undefined &&
		latest.content === "User declined this proposal."
	) {
		return "dismiss";
	}

	const accepted = (substr: string) =>
		decisions.some((d) => d.content.includes(substr));
	// The Todo flow is a single create with no reference step, so an accepted
	// create_todo Decision means the flow is complete.
	if (accepted("Accepted. Created Todo")) return "done";
	if (accepted("Accepted. Referenced Entity")) return "done";
	if (
		accepted("Accepted. Created Person") ||
		accepted("Accepted. Created Project")
	)
		return "after_create_entity";
	if (accepted("Accepted. Created Journal Entry")) return "after_journal";
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
	faux: ReturnType<typeof registerFauxProvider>,
	manifest: WorkerManifest,
	todo: NonNullable<ExtractScenario["todo"]>,
): void {
	const responses: Array<
		| ReturnType<typeof fauxAssistantMessage>
		| ((context: {
				messages: AnyMessage[];
		  }) => ReturnType<typeof fauxAssistantMessage>)
	> = [
		fauxAssistantMessage(
			[
				fauxToolCall(
					"read_current_thread_journal_entries",
					{},
					{ id: "tc_extract_read" },
				),
			],
			{ stopReason: "toolUse" },
		),
	];
	if (todo.person_name !== undefined && todo.person_name.length > 0) {
		responses.push(
			fauxAssistantMessage(
				[
					fauxToolCall(
						"search_entities",
						{ type: "person", query: todo.person_name },
						{ id: "tc_extract_search_person" },
					),
				],
				{ stopReason: "toolUse" },
			),
		);
	}
	if (todo.project_name !== undefined && todo.project_name.length > 0) {
		responses.push(
			fauxAssistantMessage(
				[
					fauxToolCall(
						"search_entities",
						{ type: "project", query: todo.project_name },
						{ id: "tc_extract_search_project" },
					),
				],
				{ stopReason: "toolUse" },
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
		return fauxAssistantMessage(
			[
				fauxToolCall(
					"propose_workspace_mutation",
					createTodoProposal(todo, journalEntryId, personId, projectId),
					{ id: "tc_extract_todo" },
				),
			],
			{ stopReason: "toolUse" },
		);
	});
	responses.push(fauxAssistantMessage("Awaiting your decision."));
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

/** Script the faux provider for direct capture for THIS process. A fresh run
 * proposes once and parks; a resume after the Decision emits a confirmation. */
function setCaptureResponses(
	faux: ReturnType<typeof registerFauxProvider>,
	manifest: WorkerManifest,
): void {
	const scenario = readCaptureScenario();

	if (manifest.mode === "resume") {
		faux.setResponses([fauxAssistantMessage("Done — added it.")]);
		return;
	}

	const proposal = captureProposal(scenario);
	if (proposal === undefined) {
		// Conversation intent (or a malformed scenario): reply, propose nothing.
		faux.setResponses([
			fauxAssistantMessage(
				"Happy to talk it through — nothing to capture here.",
			),
		]);
		return;
	}

	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("propose_workspace_mutation", proposal, {
					id: "tc_capture",
				}),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Done — added it."),
	]);
}

/** Script the faux provider for the extraction state machine for THIS process. */
function setExtractResponses(
	faux: ReturnType<typeof registerFauxProvider>,
	manifest: WorkerManifest,
): void {
	const scenario = readExtractScenario();
	const target = extractTarget(scenario);
	const phase = extractionPhase(manifest);

	if (phase === "done") {
		faux.setResponses([
			fauxAssistantMessage(
				target !== undefined
					? `Done — extracted ${target.name}.`
					: "Done — added it.",
			),
		]);
		return;
	}
	if (phase === "dismiss") {
		faux.setResponses([fauxAssistantMessage("Dismissed.")]);
		return;
	}
	if (phase === "propose_journal") {
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(
						"propose_workspace_mutation",
						createJournalEntryForExtraction(scenario),
						{ id: "tc_extract_journal" },
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Journal Entry captured."),
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
		faux.setResponses([fauxAssistantMessage("Done — added it.")]);
		return;
	}

	// Both "after_journal" and "after_create_entity" end with a search → propose
	// chain. after_journal first reads the JE to learn its id; after_create_entity
	// already has the JE id in the transcript and re-searches to resolve the new id.
	const proposeFromSearch = (context: { messages: AnyMessage[] }) => {
		const journalEntryId =
			journalEntryIdFrom(context.messages) ??
			journalEntryIdFrom(manifest.messages);
		const results = latestSearchResults(context.messages) ?? [];
		if (journalEntryId === undefined) {
			return fauxAssistantMessage(
				"I couldn't find the Journal Entry to extract from.",
			);
		}
		const found = results[0];
		const proposal =
			found !== undefined
				? referenceEntityProposal(target, journalEntryId, found.id)
				: createEntityProposal(target, journalEntryId);
		const createId =
			target.kind === "project" ? "tc_extract_project" : "tc_extract_person";
		return fauxAssistantMessage(
			[
				fauxToolCall("propose_workspace_mutation", proposal, {
					id: found !== undefined ? "tc_extract_reference" : createId,
				}),
			],
			{ stopReason: "toolUse" },
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
	const searchEntity = () =>
		fauxAssistantMessage(
			[
				fauxToolCall(
					"search_entities",
					{ type: target.kind, query: target.name },
					{ id: searchToolCallId },
				),
			],
			{ stopReason: "toolUse" },
		);
	const finalConfirm = () => fauxAssistantMessage("Awaiting your decision.");

	if (phase === "after_journal") {
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(
						"read_current_thread_journal_entries",
						{},
						{ id: "tc_extract_read" },
					),
				],
				{ stopReason: "toolUse" },
			),
			searchEntity,
			proposeFromSearch,
			finalConfirm,
		]);
		return;
	}

	// phase === "after_create_entity"
	faux.setResponses([searchEntity, proposeFromSearch, finalConfirm]);
}

/** Build interpreter deps that script pi-ai's faux provider from `INKSTONE_FAUX_*` env vars — see docs/design/worker.md for the five modes. */
export function fauxDepsFor(manifest: WorkerManifest): InterpreterDeps {
	const faux = registerFauxProvider({ provider: "faux" });
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
				return fauxAssistantMessage(
					`read_thread result: ${textOf(toolResult?.content)}`,
				);
			},
		]);
	} else if (process.env.INKSTONE_FAUX_PROPOSE === "1") {
		// Propose mode (e2e): fresh turn proposes, Core parks; resume continues — see docs/design/worker.md (ADR-0025).
		if (manifest.mode === "resume") {
			const toolResult = [...manifest.messages]
				.reverse()
				.find((message) => message.role === "tool_result");
			faux.setResponses([
				fauxAssistantMessage(journalConfirmation(textOf(toolResult?.content))),
			]);
		} else {
			const prompt = manifest.prompt;
			const action = classifyJournalIntakePrompt(prompt);
			if (action === "create") {
				faux.setResponses([
					fauxAssistantMessage(
						[
							fauxToolCall(
								"propose_workspace_mutation",
								createJournalEntryProposal(),
								{ id: "tc_create" },
							),
						],
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage("Done — added it."),
				]);
			} else {
				faux.setResponses([
					fauxAssistantMessage(
						[
							fauxToolCall(
								"read_current_thread_journal_entries",
								{},
								{ id: "tc_read_current" },
							),
						],
						{ stopReason: "toolUse" },
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
							return fauxAssistantMessage(
								"I couldn't find that Journal Entry in this thread.",
							);
						}
						const proposal =
							action === "update"
								? updateJournalEntryProposal(prompt, entry)
								: deleteJournalEntryProposal(entry);
						return fauxAssistantMessage(
							[
								fauxToolCall("propose_workspace_mutation", proposal, {
									id: action === "update" ? "tc_update" : "tc_delete",
								}),
							],
							{ stopReason: "toolUse" },
						);
					},
					(context) => {
						const toolResult = [...context.messages]
							.reverse()
							.find((message) => message.role === "toolResult");
						return fauxAssistantMessage(
							journalConfirmation(textOf(toolResult?.content)),
						);
					},
				]);
			}
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
				return fauxAssistantMessage(`history:${parts.join("|")}`);
			},
		]);
	} else {
		faux.setResponses([
			fauxAssistantMessage(process.env.INKSTONE_FAUX_RESPONSE ?? "faux reply"),
		]);
	}
	return {
		resolveModel: () => faux.getModel(),
		streamFn: streamSimple,
	};
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
