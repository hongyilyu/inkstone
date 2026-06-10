import { expect, test } from "./fixtures.js";
import { PROPOSE_WORKER_CMD } from "./spawnCore.js";

/**
 * Regression for a real-model failure shape: the worker parks a Journal Entry
 * proposal with a date-only occurred_at and an empty body. The UI must not let
 * that go to Core's validator as a doomed accept; it should require edit first.
 */
test.use({
	coreOptions: {
		workerCmd: PROPOSE_WORKER_CMD,
		invalidJournalProposal: true,
	},
});

test("invalid Journal Entry proposal must be edited before applying", async ({
	chat,
}) => {
	await chat.goto();

	await chat.send("remember buying milk after daycare pickup");

	const card = chat.proposalCard();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(card).toContainText("Untitled entry");
	await expect(card).toContainText("2026-06-10");
	await expect(card).toContainText("Empty");
	await expect(card).toContainText(/edit required fields/i);

	const add = card.getByRole("button", { name: /add journal entry/i });
	await expect(add).toBeDisabled();

	const edit = card.getByRole("button", { name: /edit/i });
	await expect(edit).toBeEnabled();

	await edit.click();
	await card
		.getByRole("textbox", { name: /occurred at/i })
		.fill("2026-06-10T10:30:00");
	await card
		.getByRole("textbox", { name: /body/i })
		.fill("Bought milk after daycare pickup.");
	await card.getByRole("button", { name: /save changes/i }).click();

	await expect(card).toContainText(/added to journal/i, { timeout: 15_000 });
	await chat.waitForAssistantText(/done.*added it/i);
});
