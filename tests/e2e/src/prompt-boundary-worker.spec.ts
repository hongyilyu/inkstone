import { expect, test } from "@playwright/test";
import {
	hasReminderBoundary,
	readShippedSystemPrompt,
	teachesIntentGraph,
} from "../../../crates/core/tests/fixtures/prompt-boundary-worker.js";

test("prompt boundary fixture recognizes the canonical reminder boundary", () => {
	// The boundary MOVED at the ticktick-writes cutover (ADR-0065): a reminder
	// still never becomes a Journal Entry, but it now becomes exactly ONE
	// propose_ticktick_task Proposal, with the capability limits stated.
	expect(
		hasReminderBoundary(`
			Do not propose a Journal Entry for reminders, tasks, instructions, or
			future obligations. These are not journal-worthy events — tasks do not
			live in Inkstone at all. TickTick is the user's task system: propose ONE
			TickTick task via propose_ticktick_task — never a Journal Entry, and
			never any other Workspace mutation for it. Every task lands in
			TickTick's Inbox. You still cannot complete, edit, or delete a task.
		`),
	).toBe(true);
});

test("prompt boundary fixture rejects a softened boundary that drops the TickTick redirect", () => {
	// The OLD "reply conversationally without implying the reminder was saved"
	// wording dropped the redirect entirely; the boundary now MUST route the
	// reminder into a TickTick task Proposal, so this softened phrasing fails.
	expect(
		hasReminderBoundary(`
			Do not propose a Journal Entry for reminders, tasks, or future
			obligations. For those, reply conversationally without implying the
			reminder was saved.
		`),
	).toBe(false);
});

// The RETIRED dead end (ADR-0064's redirect) must no longer pass: it names
// TickTick but proposes nothing — exactly the capability ADR-0065 restores. A
// prompt stuck on it is a failed cutover, not a valid boundary.
test("prompt boundary fixture rejects the retired add-it-yourself dead end", () => {
	expect(
		hasReminderBoundary(`
			Do not propose a Journal Entry for reminders, tasks, instructions, or
			future obligations. TickTick is the user's task system: tell them plainly
			to add it in TickTick — do not propose any Workspace mutation for it. You
			cannot create or edit tasks from here.
		`),
	).toBe(false);
});

// A boundary that names the tool but drops the capability limits also fails:
// the model would offer completes/edits it cannot perform.
test("prompt boundary fixture rejects a boundary missing the capability limits", () => {
	expect(
		hasReminderBoundary(`
			Do not propose a Journal Entry for reminders, tasks, or future
			obligations. TickTick is the user's task system: propose ONE TickTick
			task via propose_ticktick_task — never a Journal Entry, and never any
			other Workspace mutation for it. Every task lands in TickTick's Inbox.
		`),
	).toBe(false);
});

// Each required constraint is load-bearing on its own: dropping ANY of them
// must red the predicate, or the e2e boundary test would pass for a prompt that
// (say) permits a second Workspace mutation alongside the task. The phrases are
// matched as whitespace-flexible regexes because the shipped prompt wraps them.
test("prompt boundary fixture rejects a prompt missing any single constraint", () => {
	const full = `
		Do not propose a Journal Entry for reminders, tasks, instructions, or
		future obligations. TickTick is the user's task system: propose ONE
		TickTick task via propose_ticktick_task — never a Journal Entry, and never
		any other Workspace mutation for it. Every task lands in TickTick's Inbox.
		You still cannot complete, edit, or delete a task.
	`;
	expect(hasReminderBoundary(full)).toBe(true);

	const required: ReadonlyArray<readonly [string, RegExp]> = [
		[
			"the tool call",
			/propose\s+ONE\s+TickTick\s+task\s+via\s+propose_ticktick_task/,
		],
		["never a Journal Entry", /never\s+a\s+Journal\s+Entry/],
		["no other mutation", /never\s+any\s+other\s+Workspace\s+mutation/],
		["Inbox-only", /Inbox/],
		["no complete/edit/delete", /cannot\s+complete,\s+edit,\s+or\s+delete/],
	];
	for (const [name, pattern] of required) {
		const without = full.replace(pattern, "");
		expect(without, `the phrase must exist to be removed: ${name}`).not.toBe(
			full,
		);
		expect(hasReminderBoundary(without), `without ${name}`).toBe(false);
	}
});

// ADR-0042 (narrowed by ADR-0064): the REAL shipped prompt must teach the
// intent-graph contract (one apply_intent_graph proposal over Person/Project
// entities + journal_ref links, existing_id hints from search_entities) while
// STILL holding the reminder→TickTick boundary. Reads the same default.toml Core
// loads — a fast, browser-less guard.
test("shipped prompt teaches the intent-graph contract and keeps the reminder boundary", () => {
	const prompt = readShippedSystemPrompt();
	expect(teachesIntentGraph(prompt)).toBe(true);
	expect(hasReminderBoundary(prompt)).toBe(true);
});

test("teachesIntentGraph rejects the old per-entity create-then-reference flow", () => {
	// The pre-rewrite extraction wording: one mutation at a time, gated on an
	// accepted Journal Entry, two-step create-then-reference. It teaches none of
	// the graph contract, so the guard must reject it.
	expect(
		teachesIntentGraph(`
			After a Journal Entry is accepted, you may extract People and Projects
			from that accepted Journal Entry. Propose ONE mutation at a time;
			never batch. If the Entity is missing, propose create_person sourced from
			the Journal Entry; once that create is accepted, propose a separate
			reference_existing_entity_from_journal_entry in a follow-up step.
		`),
	).toBe(false);
});
