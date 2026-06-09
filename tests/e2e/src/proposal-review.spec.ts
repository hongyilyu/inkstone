import { FAUX_WORKER_CMD } from "./spawnCore.js";
import { expect, test } from "./fixtures.js";

/**
 * Interactive proposal review (slice 9, ADR-0016/0025) end-to-end through the
 * real stack — real Core, the real generic interpreter Worker, the real built
 * Web Client in the browser.
 *
 * Offline via the faux provider in propose mode (ADR-0019): turn 1 the faux
 * "model" calls `propose_entity` with a Todo (`buy milk`), so Core parks the
 * Run and pushes a `proposal/pending` notification. The chat surface renders
 * the review card. Deciding (accept/reject) calls `proposal/decide`; Core
 * resumes the Run, which streams to a final completion.
 */
test.use({
	coreOptions: {
		workerCmd: FAUX_WORKER_CMD,
		faux: "propose",
	},
});

test("renders a pending proposal and accept resumes the run", async ({
	chat,
}) => {
	await chat.goto();

	await chat.send("remember to buy milk");

	// The review card surfaces with the proposed Todo.
	const card = chat.proposalCard();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(card).toContainText("buy milk");

	// Accept: Add to Todos.
	await card.getByRole("button", { name: /add to todos/i }).click();

	// Card transitions to its accepted state and the Run resumes to completion.
	await expect(card).toContainText(/added to todos/i, { timeout: 15_000 });
	await chat.waitForAssistantText(/done — added it/i);
});

test("edit changes the todo then resumes", async ({ chat }) => {
	await chat.goto();

	await chat.send("remember to buy milk");

	const card = chat.proposalCard();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(card).toContainText("buy milk");

	// Edit: open the inline form, retype the title, save.
	await card.getByRole("button", { name: /edit/i }).click();
	const title = card.getByRole("textbox", { name: /title/i });
	await title.fill("buy oat milk");
	await card.getByRole("button", { name: /save changes/i }).click();

	// The edit decides AND accepts in one step (ADR-0025); the card reaches
	// accepted and the Run resumes to completion.
	await expect(card).toContainText(/added to todos/i, { timeout: 15_000 });
	await chat.waitForAssistantText(/done — added it/i);
});

test("dismiss rejects and resumes", async ({ chat }) => {
	await chat.goto();

	await chat.send("remember to buy milk");

	const card = chat.proposalCard();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(card).toContainText("buy milk");

	await card.getByRole("button", { name: /dismiss/i }).click();

	await expect(card).toContainText(/dismissed/i, { timeout: 15_000 });
	await chat.waitForAssistantText(/done — added it/i);
});

test("accepted todo appears in the library", async ({ chat, core, page }) => {
	await chat.goto();

	await chat.send("remember to buy milk");

	const card = chat.proposalCard();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(card).toContainText("buy milk");

	// Accept: the Todo is created in Core.
	await card.getByRole("button", { name: /add to todos/i }).click();
	await expect(card).toContainText(/added to todos/i, { timeout: 15_000 });

	// The Library's Todos collection reads live from Core via entity/list_todos
	// (slice 11): the accepted "buy milk" Todo is listed there.
	await page.goto(`${core.url}/library/todos`);
	await expect(
		page.getByRole("region", { name: /todos/i }).getByText("buy milk"),
	).toBeVisible({ timeout: 15_000 });
});
