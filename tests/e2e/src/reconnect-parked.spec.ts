import { expect, test } from "./fixtures.js";
import { FAUX_PROPOSE_JOURNAL_FIXTURE, FAUX_WORKER_CMD } from "./spawnCore.js";

/**
 * Reconnect-to-a-parked-Run rehydration: real Core + faux-provider interpreter
 * Worker + built Web Client.
 *
 * Exercises the Run-status READ seam (ADR-0025, ADR-0028 read side). A parked Run
 * has no live Worker and no hub, so a fresh subscribe falls to the no-hub branch,
 * reads the persisted status, and — only because that status is `parked` — pushes
 * `proposal/pending` instead of synthesizing a terminal `done`. After the seam was
 * typed (`db::run_status` → `Option<RunStatus>`, classified by `is_parked()`), this
 * is the highest-value black-box check that the typed read path still drives the
 * no-false-done rehydration correctly: reload drops the socket, Core keeps the Run
 * parked, and reopening the thread must bring the review card back without a manual
 * `proposal/get` poll. Accepting then proves parked → running → completed still
 * resumes across the reconnect.
 */
test.use({
	coreOptions: {
		workerCmd: FAUX_WORKER_CMD,
		faux: "propose",
		proposeParamsFile: FAUX_PROPOSE_JOURNAL_FIXTURE,
	},
});

test("reopening a parked Run after reload rehydrates the pending proposal and accept resumes", async ({
	chat,
}) => {
	await chat.goto();

	await chat.send("I bought milk after daycare pickup and felt relieved.");

	// The Run parks on a pending Journal Entry proposal: the review card shows.
	const card = chat.proposalCard();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(card).toHaveAttribute("data-proposal-status", "pending");
	await expect(card).toContainText("Bought milk after daycare pickup.");

	// Reload: the socket drops, but the Run stays parked in Core (no live Worker,
	// no hub) — the page forgets focus.
	await chat.reload();
	await chat.openThread(/bought milk/i);

	// Reconnect rehydration: the no-hub subscribe reads `parked` from the typed
	// seam and re-pushes `proposal/pending`, so the SAME pending card reappears
	// with no terminal `done` and no manual poll.
	const rehydrated = chat.proposalCard();
	await expect(rehydrated).toBeVisible({ timeout: 15_000 });
	await expect(rehydrated).toHaveAttribute("data-proposal-status", "pending");
	await expect(rehydrated).toContainText("Bought milk after daycare pickup.");

	// Accepting after the reconnect resumes the parked Run to completion.
	await rehydrated.getByRole("button", { name: /add journal entry/i }).click();
	await expect(rehydrated).toContainText(/added to journal/i, {
		timeout: 15_000,
	});
	await chat.waitForAssistantText(/done.*added it/i);
});
