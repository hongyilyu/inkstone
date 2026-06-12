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

	await chat.send("I bought milk after daycare pickup and felt relieved.");

	const card = chat.proposalCard();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(card).toContainText("Bought milk after daycare pickup.");

	await card.getByRole("button", { name: /add journal entry/i }).click();

	await expect(card).toContainText(/added to journal/i, { timeout: 15_000 });
	await chat.waitForAssistantText(/done.*added it/i);
});

test("edit changes the Journal Entry then resumes", async ({ chat }) => {
	await chat.goto();

	await chat.send("I bought milk after daycare pickup and felt relieved.");

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

	await chat.send("I bought milk after daycare pickup and felt relieved.");

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

	await chat.send("I bought milk after daycare pickup and felt relieved.");

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

test("create then update stays in-thread and resumes with an update confirmation", async ({
	chat,
	core,
	page,
}) => {
	await chat.goto();

	await chat.send("I bought milk after daycare pickup and felt relieved.");

	let card = chat.proposalCard();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await card.getByRole("button", { name: /add journal entry/i }).click();
	await expect(card).toContainText(/added to journal/i, { timeout: 15_000 });
	await chat.waitForAssistantText(/done.*added it/i);

	await chat.send("Actually, for that entry, make it oat milk.");

	card = chat.page.locator('[data-proposal-status="pending"]').last();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(card).toContainText("Bought milk after daycare pickup.");
	await expect(card).toContainText("Bought oat milk after daycare pickup.");
	await card.getByRole("button", { name: /update journal entry/i }).click();

	const acceptedCard = chat.page.locator('[data-proposal-status="accepted"]').last();
	await expect(acceptedCard).toContainText(/updated in journal/i, {
		timeout: 15_000,
	});
	await chat.waitForAssistantText(/done.*updated it/i);
	await expect(chat.page.locator('[data-proposal-status="pending"]')).toHaveCount(0);

	await page.goto(`${core.url}/library/journal`);
	await expect(
		page
			.getByRole("region", { name: /journal/i })
			.getByText("Bought oat milk after daycare pickup."),
	).toBeVisible({ timeout: 15_000 });
	await expect(
		page
			.getByRole("region", { name: /journal/i })
			.getByText("Bought milk after daycare pickup."),
	).toHaveCount(0);
});

test("rejecting an update keeps the current Journal Entry", async ({
	chat,
	core,
	page,
}) => {
	await chat.goto();

	await chat.send("I bought milk after daycare pickup and felt relieved.");

	let card = chat.proposalCard();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await card.getByRole("button", { name: /add journal entry/i }).click();
	await expect(card).toContainText(/added to journal/i, { timeout: 15_000 });
	await chat.waitForAssistantText(/done.*added it/i);

	await chat.send("Actually, for that entry, make it oat milk.");

	card = chat.page.locator('[data-proposal-status="pending"]').last();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(card).toContainText("Bought milk after daycare pickup.");
	await expect(card).toContainText("Bought oat milk after daycare pickup.");
	await card.getByRole("button", { name: /keep current entry/i }).click();

	const rejectedCard = chat.page.locator('[data-proposal-status="rejected"]').last();
	await expect(rejectedCard).toContainText(/kept current journal entry/i, {
		timeout: 15_000,
	});
	await chat.waitForAssistantText(/done.*dismissed it/i);
	await expect(chat.page.locator('[data-proposal-status="pending"]')).toHaveCount(0);

	await page.goto(`${core.url}/library/journal`);
	await expect(
		page
			.getByRole("region", { name: /journal/i })
			.getByText("Bought milk after daycare pickup."),
	).toBeVisible({ timeout: 15_000 });
	await expect(
		page
			.getByRole("region", { name: /journal/i })
			.getByText("Bought oat milk after daycare pickup."),
	).toHaveCount(0);
});

test("create then delete stays in-thread and resumes with a delete confirmation", async ({
	chat,
	core,
	page,
}) => {
	await chat.goto();

	await chat.send("I bought milk after daycare pickup and felt relieved.");

	let card = chat.proposalCard();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await card.getByRole("button", { name: /add journal entry/i }).click();
	await expect(card).toContainText(/added to journal/i, { timeout: 15_000 });
	await chat.waitForAssistantText(/done.*added it/i);

	await chat.send("Actually, delete that entry.");

	card = chat.page.locator('[data-proposal-status="pending"]').last();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(card).toContainText("Bought milk after daycare pickup.");
	await card.getByRole("button", { name: /delete journal entry/i }).click();

	const acceptedCard = chat.page.locator('[data-proposal-status="accepted"]').last();
	await expect(acceptedCard).toContainText(/deleted from journal/i, {
		timeout: 15_000,
	});
	await chat.waitForAssistantText(/done.*deleted it/i);
	await expect(chat.page.locator('[data-proposal-status="pending"]')).toHaveCount(0);

	await page.goto(`${core.url}/library/journal`);
	await expect(
		page
			.getByRole("region", { name: /journal/i })
			.getByText("Bought milk after daycare pickup."),
	).toHaveCount(0);
});
