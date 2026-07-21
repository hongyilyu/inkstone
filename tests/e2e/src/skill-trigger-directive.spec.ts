import { test } from "./fixtures.js";
import { FAUX_WORKER_CMD } from "./spawnCore.js";

/**
 * Deterministic skill triggers (ADR-0063): a prompt with a seeded trigger phrase
 * ("weekly review") makes Core inject the directive into the manifest
 * `system_prompt`; a control prompt does not. The faux provider reports what it
 * received. Scope: proves the directive REACHED the model's context, not that a
 * live model obeys it (that's a separate manual smoke).
 */

test.describe("trigger matched → directive injected", () => {
	test.use({
		coreOptions: {
			workerCmd: FAUX_WORKER_CMD,
			fauxLoadSkill: "weekly-review",
			fauxExpectDirective: "weekly-review",
		},
	});

	test("a prompt containing a seeded trigger phrase injects the directive", async ({
		chat,
	}) => {
		await chat.goto();
		// "weekly review" is a bundled trigger phrase → deterministic match.
		await chat.send("let's do my weekly review");
		await chat.waitForAssistantText("trigger directive present: true");
	});
});

test.describe("no trigger match → no directive", () => {
	test.use({
		coreOptions: {
			workerCmd: FAUX_WORKER_CMD,
			fauxLoadSkill: "weekly-review",
			fauxExpectDirective: "weekly-review",
		},
	});

	test("an unrelated prompt injects no directive", async ({ chat }) => {
		await chat.goto();
		// No seeded trigger phrase occurs → no match, no directive.
		await chat.send("tell me a joke about penguins");
		await chat.waitForAssistantText("trigger directive present: false");
	});
});
