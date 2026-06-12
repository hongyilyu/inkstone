// =============================================================================
// TEST-ONLY Worker entry — never the production worker command.
//
// This file fakes the LLM provider so Core/e2e integration tests can drive the
// REAL generic interpreter offline and deterministically. It is selected by
// tests via `INKSTONE_WORKER_CMD` (they spawn `tsx .../faux-worker.ts`); it is
// never wired into a shipped build. Production uses `cli.ts`. Reading the
// `INKSTONE_FAUX_*` env vars below is legitimate — this is test code (ADR-0019
// as-built: faux scripting lives at a dedicated test-only entry, off the
// production path).
// =============================================================================

import { realpathSync } from "node:fs";
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

function lastUserText(messages: readonly { role: string; content?: unknown }[]): string {
	const lastUser = [...messages].reverse().find((message) => message.role === "user");
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

function currentThreadEntriesFromToolResult(text: string): JournalEntrySnapshot[] {
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
	const timeMatch = prompt.match(/\b(?:change|set|make)\b.*\btime\b.*\bto\b\s*(\d{1,2}):(\d{2})\b/i);
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

/**
 * Build interpreter deps that script pi-ai's faux provider from the
 * `INKSTONE_FAUX_*` env vars, so Core/e2e tests drive the real interpreter
 * offline. This entry is ALWAYS faux (no `provider` guard — `cli.ts` is the
 * production path): every manifest gets a faux provider whose queued
 * response(s) are env-scripted.
 *
 * The five modes (first match wins):
 * - `INKSTONE_FAUX_ERROR` (non-empty)   → a single error message.
 * - `INKSTONE_FAUX_TOOL_CALL === "1"`   → turn 1 `read_thread` on the pasted
 *   thread id, turn 2 echoes the tool result.
 * - `INKSTONE_FAUX_PROPOSE === "1"`     → `propose_workspace_mutation` (fresh) / short
 *   completion (resume), the ADR-0025 park/resume dance.
 * - `INKSTONE_FAUX_ECHO_HISTORY === "1"`→ echo the prior turns' roles+text.
 * - else                                → `INKSTONE_FAUX_RESPONSE` (or a
 *   default) as a plain assistant reply.
 */
export function fauxDepsFor(manifest: WorkerManifest): InterpreterDeps {
	const faux = registerFauxProvider({ provider: "faux" });
	const errorMessage = process.env.INKSTONE_FAUX_ERROR;
	if (errorMessage !== undefined && errorMessage.length > 0) {
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage }),
		]);
	} else if (process.env.INKSTONE_FAUX_TOOL_CALL === "1") {
		// Tool-call mode (e2e): turn 1 extracts a thread id from the latest
		// user prompt and calls read_thread; turn 2 echoes the tool result so
		// the assistant's reply reflects the read thread's content. Uses
		// response factories so it reads the live context (the pasted id, then
		// the tool result the proxy round-tripped back).
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
		// Propose mode (e2e, ADR-0025): the fresh turn calls
		// the Journal Entry intake tools, which Core round-trips, persists as a
		// pending Proposal, and PARKS (tearing this Worker down).
		// On resume (`mode:"resume"`) Core re-spawns with the reconstructed
		// transcript ending in the Decision tool_result; the loop continues with
		// a short completion. The faux provider state is per-process, so the
		// resume spawn freshly applies the resume response (mirrors
		// propose-worker.ts at the protocol level).
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
	} else if (process.env.INKSTONE_FAUX_ECHO_HISTORY === "1") {
		// History-echo mode (multi-turn test): reply with the prior messages
		// the loop passed in its context — both roles — so the test can prove
		// Core assembled BOTH the prior user prompt AND the prior assistant
		// reply into the manifest history (the assistant turn is the
		// slice-9 race that this exercises). Uses a response factory so it
		// reads the live context rather than a canned string.
		faux.setResponses([
			(context) => {
				// All prior turns except the current prompt (the last user
				// message). Tag each with its role so the test can assert the
				// assistant turn specifically.
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

// Run only when this file is the process entry (Core/e2e spawn it as
// `tsx .../faux-worker.ts`), NOT when imported — `faux-worker.test.ts` imports
// `fauxDepsFor` to unit-test the dep-builder and must not boot a Worker (which
// would read stdin and `process.exit`). `realpathSync` both sides so the
// macOS `/var`→`/private/var` symlink doesn't defeat the comparison.
const entryPath = process.argv[1];
if (
	entryPath !== undefined &&
	realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url))
) {
	runWorkerMain(fauxDepsFor);
}
