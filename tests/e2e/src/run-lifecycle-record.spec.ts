import { expect, test } from "./fixtures.js";
import { FAUX_WORKER_CMD } from "./spawnCore.js";

/**
 * The Run-lifecycle record (one keyed { status, threadId, snapshotArmed }) drives
 * the park -> decide -> resume loop through the chat UI: parked-ness, which thread,
 * and the snapshot boundary are field reads, not cross-file inference. This spec
 * exercises that loop end-to-end against a real Core + faux interpreter Worker,
 * pinning the user-visible result the record guards — a single clean resumed
 * bubble (the M1 duplicated-prefix bug surfaced as doubled text) and a Proposal
 * that transitions pending -> accepted in place.
 */
test.use({
	coreOptions: {
		workerCmd: FAUX_WORKER_CMD,
		faux: "propose",
	},
});

test("park -> decide -> resume settles one clean assistant bubble", async ({
	chat,
}) => {
	await chat.goto();

	await chat.send("I bought milk after daycare pickup and felt relieved.");

	// Parked on a pending Proposal (the record is `parked` — no live tail yet).
	const card = chat.page.locator('[data-proposal-status="pending"]').last();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(card).toContainText("Bought milk after daycare pickup.");

	await card.getByRole("button", { name: /add journal entry/i }).click();

	// Decide flips the same card in place (pending -> accepted), then the resume
	// re-subscribes through the begin verb (record back to `running`, snapshot
	// re-armed) and the tail SETs the snapshot rather than appending it.
	const accepted = chat.page
		.locator('[data-proposal-status="accepted"]')
		.last();
	await expect(accepted).toContainText(/added to journal/i, {
		timeout: 15_000,
	});

	// Exactly one resumed assistant bubble carries the resume text — the M1 bug
	// (snapshot APPENDed over the on-screen prefix) would double it.
	await chat.waitForAssistantText(/done.*added it/i);
	await expect(
		chat.assistantBubbles().filter({ hasText: /done.*added it/i }),
	).toHaveCount(1);

	// No stray second pending card lingers; the parked record settled terminal.
	await expect(
		chat.page.locator('[data-proposal-status="pending"]'),
	).toHaveCount(0);
});

test("Stop is available while parked and settles the parked Run", async ({
	chat,
}) => {
	await chat.goto();

	await chat.send("I bought milk after daycare pickup and felt relieved.");

	// Parked: the Proposal awaits a decision. Because the record reports the Run as
	// `parked` (active, no live tail), the composer's Stop control still drives
	// run/cancel — a parked Run has no stream that would otherwise clear it.
	const card = chat.proposalCard();
	await expect(card).toBeVisible({ timeout: 15_000 });

	await chat.stop();

	// The cancelled parked Run settles to the calm "stopped" bubble (ADR-0014:
	// a deliberate cancel is not a failure).
	await expect(chat.assistantStopped()).toBeVisible({ timeout: 15_000 });
});
