import { expect, test } from "@playwright/test";
import { hasReminderBoundary } from "../../../crates/core/tests/fixtures/prompt-boundary-worker.js";

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
