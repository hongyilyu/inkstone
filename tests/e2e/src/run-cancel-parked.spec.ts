import path from "node:path";
import { expect, test } from "./fixtures.js";
import { FAUX_WORKER_CMD, REPO_ROOT } from "./spawnCore.js";

// Cancel a Run that is PARKED awaiting a Proposal, through the real UI. The faux
// `propose` interpreter parks the Run on a Journal Entry proposal (the same setup
// proposal-review.spec.ts uses); Stop is shown while parked because `activeRunId`
// is set from park through terminal (ADR-0014, ChatColumn). Clicking Stop drives
// run/cancel → the crate::cancel verb's PARKED branch (cancel_parked_run), which
// cancels the Run and its pending Proposal in one tier-2 transaction.
//
// This complements the two RUNNING-cancel specs: run-cancel.spec.ts (raw WebSocket)
// and run-cancel-ui.spec.ts (composer Stop mid-stream). The parked branch — which
// the verb concentrates and which has only Rust-integration coverage — had no
// browser-level test until now.
test.use({
	coreOptions: {
		workerCmd: FAUX_WORKER_CMD,
		faux: "propose",
		proposeParamsFile: path.join(
			REPO_ROOT,
			"tests/e2e/fixtures/faux-propose-journal.json",
		),
	},
});

test("clicking Stop cancels a parked run and clears its pending proposal", async ({
	chat,
}) => {
	await chat.goto();

	await chat.send("I bought milk after daycare pickup and felt relieved.");

	// The proposal card renders → the Run is PARKED awaiting a decision. Stop is
	// shown (activeRunId is set while parked), so the Stop click is not racing a
	// stream completion.
	const card = chat.proposalCard();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(card).toContainText("Bought milk after daycare pickup.");

	// Stop cancels via run/cancel → the verb's parked branch. A parked Run has no
	// live tail, so the client settles the bubble off the authoritative cancel
	// response (a synthesized `cancelled`), not a streamed terminal event.
	await chat.stop();

	// The reply settles to the calm "stopped" state — a deliberate cancel is not a
	// failure (ADR-0014), the same settle running-cancel produces in run-cancel-ui.spec.ts.
	const settled = chat.assistantStopped();
	await expect(settled).toBeVisible({ timeout: 15_000 });
	await expect(settled).toContainText("You stopped this reply");

	// The pending Proposal is cleared — the parked Run was cancelled, so there is
	// nothing left to review.
	await expect(
		chat.page.locator('[data-proposal-status="pending"]'),
	).toHaveCount(0);

	// The proposal was cancelled, NOT accepted: the interpreter never resumes, so
	// the post-decision confirmation ("added it") never appears. Stop is gone and
	// Send is back — the Run is terminal.
	await chat.expectNoAssistantText("added it");
	await expect(chat.page.getByRole("button", { name: /^stop$/i })).toHaveCount(
		0,
	);
	await expect(
		chat.page.getByRole("button", { name: /^send$/i }),
	).toBeVisible();
});
