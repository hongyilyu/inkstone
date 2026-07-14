import { expect, type Page } from "@playwright/test";
import type { ChatPage } from "./page-objects/ChatPage.js";

/**
 * Shared proposal-card locators and the accept-the-anchor-Journal-Entry flow
 * used across the extraction/capture specs (person/project/todo extraction,
 * direct capture). Selectors pin on `data-proposal-status`, the stable review
 * card contract.
 */

/** The newest pending proposal card — used for each follow-up after the first. */
export function pendingCard(chat: { page: Page }) {
	return chat.page.locator('[data-proposal-status="pending"]').last();
}

/** The newest accepted proposal card — a card's status flips off "pending" once decided. */
export function acceptedCard(chat: { page: Page }) {
	return chat.page.locator('[data-proposal-status="accepted"]').last();
}

/** The newest rejected proposal card. */
export function rejectedCard(chat: { page: Page }) {
	return chat.page.locator('[data-proposal-status="rejected"]').last();
}

/** Accept the anchor create_journal_entry proposal (matched by `bodyText`) and
 * wait for its accepted state. The accepted card renders only its status copy
 * (no body text), so pin to the stable `data-proposal` run id captured while
 * the card is still pending — that id survives the pending → accepted
 * transition unambiguously. */
export async function acceptJournalEntry(
	chat: ChatPage,
	bodyText: string,
): Promise<void> {
	const jeCard = chat.page
		.locator('[data-proposal-status="pending"]')
		.filter({ hasText: bodyText });
	await expect(jeCard).toBeVisible({ timeout: 15_000 });
	const runId = await jeCard.getAttribute("data-proposal");
	expect(runId).not.toBeNull();
	await jeCard.getByRole("button", { name: /add journal entry/i }).click();
	await expect(chat.page.locator(`[data-proposal="${runId}"]`)).toContainText(
		/added to journal/i,
		{ timeout: 15_000 },
	);
}
