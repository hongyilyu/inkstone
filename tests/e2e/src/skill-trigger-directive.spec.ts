import { expect, test } from "./fixtures.js";
import { FAUX_WORKER_CMD } from "./spawnCore.js";

/**
 * Deterministic skill triggers (ADR-0063): a natural prompt containing a skill's
 * declared trigger phrase makes Core append a Core-authored directive naming that
 * skill to the Run's effective `system_prompt` — the model then loads it via the
 * existing `load_skill` tool ("deterministic matching, model-mediated loading").
 *
 * The bundled `weekly-review` seed ships `triggers: ["weekly review", ...]`, so a
 * prompt containing "weekly review" must match at fresh dispatch. We prove this
 * through the REAL Core + real interpreter Worker: the faux provider, in
 * load-skill + expect-directive mode, inspects the manifest `system_prompt` it
 * received and replies `trigger directive present: <bool>`. A control run with a
 * non-triggering prompt must report `false`.
 *
 * SCOPE (honest): this proves the directive REACHED the model's context
 * deterministically from a trigger phrase — NOT that a live model then obeys it.
 * Live-model compliance rests on the directive's wording and is covered by a
 * manual live smoke, not this hermetic faux-worker spec.
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
