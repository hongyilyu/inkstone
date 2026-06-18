import { expect, test } from "./fixtures.js";
import { FAUX_WORKER_CMD } from "./spawnCore.js";

/**
 * Full-system Skills activation (ADR-0036): the model calls the AMBIENT
 * `load_skill` tool mid-Run and the skill body round-trips, surfaced as a
 * tool-activity row in the REAL Web Client (headless Chromium over a real Core +
 * real interpreter Worker).
 *
 * This is the browser-level proof that the Core-only Skills change is reachable
 * end-to-end: `load_skill` is in NO Workflow allowlist (the faux Workflow ships
 * `tools = []`), yet Core seeds the bundled `weekly-review` skill into the
 * Workspace skills dir at boot, advertises `load_skill` ambiently, dispatches the
 * call, and the body comes back — and the UI renders the live ToolActivity row
 * for it. Driven by the faux-provider Worker in load-skill mode (ADR-0019).
 *
 * The `running` phase is fleeting (no gate in this mode), so we assert the
 * settled terminal state, mirroring tool-activity.spec.ts.
 */
test.use({
	coreOptions: {
		workerCmd: FAUX_WORKER_CMD,
		fauxLoadSkill: "weekly-review",
	},
});

test("a load_skill call renders a completed tool-activity row and the body round-trips", async ({
	chat,
}) => {
	await chat.goto();

	// Any message drives the faux turn: turn 1 calls load_skill("weekly-review"),
	// turn 2 echoes the returned body.
	await chat.send("do my weekly review");

	// The Tool activity list + its single row render for the ambient load_skill call.
	const list = chat.page.getByRole("list", { name: /tool activity/i });
	await expect(list).toBeVisible();
	const row = chat.page.getByTestId("tool-call");

	// The row settles to completed and shows the past-tense label plus the skill
	// name as its display arg (ADR-0043: load_skill → name).
	await expect(row).toHaveAttribute("data-status", "completed", {
		timeout: 15_000,
	});
	await expect(row).toContainText("Loaded skill");
	await expect(row).toContainText("weekly-review");

	// The row belongs to a real round-trip: the assistant bubble echoes the seeded
	// weekly-review SKILL.md body (frontmatter stripped → starts at the heading).
	await chat.waitForAssistantText(/load_skill result: # Weekly review/);
});
