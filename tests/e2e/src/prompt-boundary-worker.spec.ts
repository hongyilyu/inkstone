import { expect, test } from "@playwright/test";
import { hasReminderBoundary } from "../../../crates/core/tests/fixtures/prompt-boundary-worker.js";

test("prompt boundary fixture recognizes the canonical reminder exclusions", () => {
	expect(
		hasReminderBoundary(`
			Do not propose a Journal Entry for reminders, tasks, todos, instructions,
			future obligations, or requests to remember to do something. For those,
			reply conversationally without implying the reminder was saved.
		`),
	).toBe(true);
});

test("prompt boundary fixture rejects softened reminder exclusions", () => {
	expect(
		hasReminderBoundary(`
			Do not propose a Journal Entry for reminder items or future commitments.
		`),
	).toBe(false);
});
