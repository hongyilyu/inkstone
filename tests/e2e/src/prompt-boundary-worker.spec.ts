import { expect, test } from "@playwright/test";
import {
	hasReminderBoundary,
	readShippedSystemPrompt,
	teachesIntentGraph,
} from "../../../crates/core/tests/fixtures/prompt-boundary-worker.js";

test("prompt boundary fixture recognizes the canonical reminder boundary", () => {
	expect(
		hasReminderBoundary(`
			Do not propose a Journal Entry for reminders, tasks, todos, instructions,
			future obligations, or requests to remember to do something. These are not
			journal-worthy events. Instead, capture them directly, sourced from the
			user Message — do not create a Journal Entry first: a reminder, task, or
			obligation → propose create_todo.
		`),
	).toBe(true);
});

test("prompt boundary fixture rejects a softened boundary that drops the Todo redirect", () => {
	// The OLD "reply conversationally without implying the reminder was saved"
	// wording dropped the capture entirely; the boundary now MUST redirect to a
	// create_todo, so this softened phrasing no longer counts.
	expect(
		hasReminderBoundary(`
			Do not propose a Journal Entry for reminders, tasks, todos, or future
			obligations. For those, reply conversationally without implying the
			reminder was saved.
		`),
	).toBe(false);
});

// ADR-0042 slice 7: the REAL shipped prompt must teach the intent-graph contract
// (one apply_intent_graph proposal over entities + links, Todo→Project as a link,
// existing_id hints from search_entities) while STILL holding the reminder→Todo
// boundary. Reads the same default.toml Core loads — a fast, browser-less guard.
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
			After a Journal Entry is accepted, you may extract People, Projects, and
			Todos from that accepted Journal Entry. Propose ONE mutation at a time;
			never batch. If the Entity is missing, propose create_todo sourced from
			the Journal Entry; once that create is accepted, propose a separate
			reference_existing_entity_from_journal_entry in a follow-up step.
		`),
	).toBe(false);
});
