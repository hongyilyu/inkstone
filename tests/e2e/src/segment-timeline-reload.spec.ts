import path from "node:path";
import { expect, test } from "./fixtures.js";
import { FAUX_WORKER_CMD, REPO_ROOT } from "./spawnCore.js";

/**
 * Segment-timeline order survives reload (ADR-0045). An assistant turn that parks
 * on a Proposal and then replies after the decision renders its pieces in
 * chronological order — the decided "Applied." pill BEFORE the reply text, because
 * the Proposal was created before the reply. Live already does this (slice 2); the
 * defect was reload: `thread/get` carried three independent buckets (`text`,
 * `tool_calls`, `proposal`) with no cross-bucket order, so the rehydrated proposal
 * segment was appended LAST and the pill fell BELOW the reply. This slice carries
 * an ordered `segments[]` on the wire and the reload now matches the live order.
 *
 * Sibling of `proposal-decided-reload.spec.ts` (ADR-0044) and
 * `tool-activity-reload.spec.ts` (ADR-0043), driven by the same faux `propose`
 * interpreter Worker. Those assert the pieces SURVIVE; this asserts their ORDER.
 */
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

/** Within the assistant turn, is the decided proposal pill positioned ABOVE the
 * reply text? `DOCUMENT_POSITION_FOLLOWING` (4) ⇒ the reply follows the pill in DOM
 * order (pill first = correct chronological order). */
async function pillAboveReply(
	page: import("@playwright/test").Page,
): Promise<"pill-above" | "pill-below" | "missing"> {
	return page.evaluate(() => {
		const pill = document.querySelector('[data-proposal-status="accepted"]');
		// The reply text renders as a prose group inside the same assistant bubble.
		const bubble = pill?.closest('[data-role="assistant"]');
		const reply = Array.from(bubble?.querySelectorAll(".prose") ?? []).find(
			(el) => /done.*added it/i.test(el.textContent ?? ""),
		);
		if (!pill || !reply) return "missing";
		return pill.compareDocumentPosition(reply) & 4
			? "pill-above"
			: "pill-below";
	});
}

test("a parked-then-reply turn keeps its timeline order (pill above reply) across reload", async ({
	chat,
}) => {
	await chat.goto();
	await chat.send("I bought milk after daycare pickup and felt relieved.");

	// Accept the pending proposal → the decided ("accepted") card renders, and the
	// resume reply ("Done — added it.") streams after it.
	const card = chat.proposalCard();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await card.getByRole("button", { name: /add journal entry/i }).click();

	const accepted = chat.page.locator('[data-proposal-status="accepted"]');
	await expect(accepted).toContainText(/added to journal/i, {
		timeout: 15_000,
	});
	// Wait for the resume reply so both timeline pieces are present + persisted.
	await chat.waitForAssistantText(/done.*added it/i);

	// LIVE: the decided pill sits ABOVE the reply text (it happened first).
	expect(await pillAboveReply(chat.page)).toBe("pill-above");

	const threadUrl = chat.pathname();
	expect(threadUrl).toMatch(/^\/thread\//);

	// Cold reload: the store reinitializes empty, so the rendered order comes
	// entirely from `thread/get`'s `segments[]`. The order must be identical.
	await chat.reload();
	expect(chat.pathname()).toBe(threadUrl);

	const reloaded = chat.page.locator('[data-proposal-status="accepted"]');
	await expect(reloaded).toBeVisible({ timeout: 15_000 });
	await chat.waitForAssistantText(/done.*added it/i);

	// RELOAD: same chronological order — pill still ABOVE the reply (the assertion
	// that REDs on the legacy three-bucket wire, where the proposal was appended last).
	expect(await pillAboveReply(chat.page)).toBe("pill-above");
});
