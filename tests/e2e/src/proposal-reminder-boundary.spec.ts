import { expect, test } from "./fixtures.js";
import { PROMPT_BOUNDARY_WORKER_CMD } from "./spawnCore.js";

// The reminder boundary, end-to-end through the REAL shipped prompt (the
// fixture reads it out of the manifest and only takes the TickTick path when
// the boundary holds — see crates/core/tests/fixtures/prompt-boundary-worker.ts).
//
// It MOVED at the ticktick-writes cutover (ADR-0065 amending ADR-0064): a
// reminder still never becomes a Journal Entry, but it is no longer a dead-end
// redirect — it parks ONE `create_ticktick_task` Proposal. That also proves the
// shipped default Workflow allowlists `propose_ticktick_task` (without it the
// dispatch gate would reject the call and nothing would park).

test.use({
	coreOptions: {
		workerCmd: PROMPT_BOUNDARY_WORKER_CMD,
		// Setting the API URL also seeds the TickTick credential, which the
		// PRE-PARK gate requires: a propose on a disconnected TickTick refuses as
		// a normal tool error and parks nothing (ticktick-writes W-A2 — covered by
		// the Core unit tests). Nothing dials this URL: the card only parks.
		ticktickApiUrl: "http://127.0.0.1:1",
	},
});

test("a reminder parks a TickTick task proposal, never a Journal Entry", async ({
	chat,
}) => {
	await chat.goto();

	await chat.send("remember buying milk after daycare pickup");

	const card = chat.page.locator('[data-proposal-status="pending"]').last();
	await expect(card).toBeVisible({ timeout: 20_000 });
	await expect(card).toContainText(
		"Inkstone wants to create a task in TickTick.",
	);
	await expect(card).toContainText("buy milk");
	// The Journal Entry path stays closed: no journal card, no journal accept.
	await expect(card).not.toContainText(/journal entry/i);
	await expect(
		chat.page.getByRole("button", { name: /add journal entry/i }),
	).toHaveCount(0);
});
