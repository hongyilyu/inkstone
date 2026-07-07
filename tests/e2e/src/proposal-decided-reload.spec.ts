import { expect, test } from "./fixtures.js";
import { FAUX_PROPOSE_JOURNAL_FIXTURE, FAUX_WORKER_CMD } from "./spawnCore.js";

/**
 * Decided-proposal preservation (ADR-0044): a Proposal's settled outcome — the
 * decided `ProposalCard` (e.g. "Added to Journal.") — must SURVIVE a page reload.
 * Before this feature the decided card lived only in the in-memory `proposals`
 * store map (populated by the live `proposal/pending` notification + decide flow),
 * so a refresh dropped it: `thread/get` rehydration carried no proposal field.
 * Now `thread/get` surfaces the decided outcome as `MessageView.proposal`, and
 * `hydrate.rehydrateDecidedProposals` reconstructs the settled card cold.
 *
 * Sibling of `tool-activity-reload.spec.ts` (the ADR-0043 reload spec); driven by
 * the same faux-provider interpreter Worker `proposal-review.spec.ts` uses.
 */
test.use({
	coreOptions: {
		workerCmd: FAUX_WORKER_CMD,
		faux: "propose",
		proposeParamsFile: FAUX_PROPOSE_JOURNAL_FIXTURE,
	},
});

test("a decided proposal card survives a page reload and sits above the copy button", async ({
	chat,
}) => {
	await chat.goto();
	await chat.send("I bought milk after daycare pickup and felt relieved.");

	// Accept the pending proposal → the decided ("accepted") card renders.
	const card = chat.proposalCard();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await card.getByRole("button", { name: /add journal entry/i }).click();

	const accepted = chat.page.locator('[data-proposal-status="accepted"]');
	await expect(accepted).toContainText(/added to journal/i, {
		timeout: 15_000,
	});
	// Wait for the turn to finish so the assistant Message + decided Proposal are
	// durably persisted before the reload.
	await chat.waitForAssistantText(/done.*added it/i);

	// The copy button mounts only once the assistant message flips to `completed`
	// (ChatColumn gates it on `status === "completed"`), and that flip LAGS the
	// text appearing — `waitForAssistantText` matches mid-stream. Wait for the copy
	// button before the one-shot DOM-order probe below; otherwise the probe can
	// race a not-yet-mounted button and read "missing" (a pre-existing flake, seen
	// on master too). `opacity-0` (hover-reveal) still counts as visible here.
	await expect(
		chat.page.locator('button[aria-label="Copy"]').last(),
	).toBeVisible({ timeout: 15_000 });

	// The decided indicator sits ABOVE the copy button (DOCUMENT_POSITION_FOLLOWING
	// = 4 ⇒ the copy button follows the card in DOM order).
	const order = await chat.page.evaluate(() => {
		const card = document.querySelector('[data-proposal-status="accepted"]');
		const copies = Array.from(
			document.querySelectorAll('button[aria-label="Copy"]'),
		);
		const copy = copies[copies.length - 1];
		if (!card || !copy) return "missing";
		return card.compareDocumentPosition(copy) & 4 ? "card-above" : "card-below";
	});
	expect(order).toBe("card-above");

	const threadUrl = chat.pathname();
	expect(threadUrl).toMatch(/^\/thread\//);

	// Cold reload: the store reinitializes empty, so anything that survives came
	// from `thread/get`. The decided card must rehydrate.
	await chat.reload();
	expect(chat.pathname()).toBe(threadUrl);

	const reloaded = chat.page.locator('[data-proposal-status="accepted"]');
	await expect(reloaded).toBeVisible({ timeout: 15_000 });
	await expect(reloaded).toContainText(/added to journal/i);
	// No pending card resurrected — only the settled outcome rehydrates.
	await expect(
		chat.page.locator('[data-proposal-status="pending"]'),
	).toHaveCount(0);
});
