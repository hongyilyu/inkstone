import { expect, test } from "./fixtures.js";
import { FAUX_WORKER_CMD } from "./spawnCore.js";

/**
 * Journal Entry Proposal review end-to-end through the real stack: Core, the
 * generic interpreter Worker with faux provider, and the built Web Client.
 */
test.use({
	coreOptions: {
		workerCmd: FAUX_WORKER_CMD,
		faux: "propose",
	},
});

test("renders a pending Journal Entry proposal and accept resumes the run", async ({
	chat,
}) => {
	await chat.goto();

	await chat.send("remember buying milk after daycare pickup");

	const card = chat.proposalCard();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(card).toContainText("Bought milk after daycare pickup.");

	await card.getByRole("button", { name: /add journal entry/i }).click();

	await expect(card).toContainText(/added to journal/i, { timeout: 15_000 });
	await chat.waitForAssistantText(/done.*added it/i);
});

test("edit changes the Journal Entry then resumes", async ({ chat }) => {
	await chat.goto();

	await chat.send("remember buying milk after daycare pickup");

	const card = chat.proposalCard();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(card).toContainText("Bought milk after daycare pickup.");

	await card.getByRole("button", { name: /edit/i }).click();
	const body = card.getByRole("textbox", { name: /body/i });
	await body.fill("Bought oat milk after daycare pickup.");
	await card.getByRole("button", { name: /save changes/i }).click();

	await expect(card).toContainText(/added to journal/i, { timeout: 15_000 });
	await chat.waitForAssistantText(/done.*added it/i);
});

test("dismiss rejects and resumes", async ({ chat }) => {
	await chat.goto();

	await chat.send("remember buying milk after daycare pickup");

	const card = chat.proposalCard();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(card).toContainText("Bought milk after daycare pickup.");

	await card.getByRole("button", { name: /dismiss/i }).click();

	await expect(card).toContainText(/dismissed/i, { timeout: 15_000 });
	await chat.waitForAssistantText(/done.*dismissed it/i);
});

test("accepted Journal Entry appears in the library", async ({
	chat,
	core,
	page,
}) => {
	await chat.goto();

	await chat.send("remember buying milk after daycare pickup");

	const card = chat.proposalCard();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(card).toContainText("Bought milk after daycare pickup.");

	await card.getByRole("button", { name: /add journal entry/i }).click();
	await expect(card).toContainText(/added to journal/i, { timeout: 15_000 });

	await page.goto(`${core.url}/library/journal`);
	await expect(
		page
			.getByRole("region", { name: /journal/i })
			.getByText("Bought milk after daycare pickup."),
	).toBeVisible({ timeout: 15_000 });
});
