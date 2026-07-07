import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures.js";
import { FAUX_WORKER_CMD } from "./spawnCore.js";

/** Journal Entry Proposal review end-to-end: real Core + faux-provider interpreter Worker + built Web Client. */

// Scenario-file lifecycle HAZARD under `fullyParallel`: Playwright splits this
// file's tests into small test GROUPS, and the file-level afterAll fires at the
// end of EVERY group — not once per worker process. A worker is then REUSED for
// the next group WITHOUT re-importing this module (Node module cache), so that
// group inherits an already-rmSync'd scenarioDir, and a bare writeFileSync
// would throw ENOENT. writeScenario therefore re-creates the dir defensively
// before every write; the afterAll stays for cleanup.
const scenarioDir = mkdtempSync(
	path.join(tmpdir(), "inkstone-propose-review-"),
);
const proposeParamsFile = path.join(scenarioDir, "scenario.json");

test.use({
	coreOptions: {
		workerCmd: FAUX_WORKER_CMD,
		faux: "propose",
		proposeParamsFile,
	},
});

test.afterAll(() => {
	rmSync(scenarioDir, { recursive: true, force: true });
});

/** One ordered scenario Turn the faux propose Worker plays back by manifest
 * position (packages/worker/src/faux/faux-worker.ts): create carries its full
 * payload; omitted update fields keep the live entry's values. */
type ProposeTurn =
	| { action: "create"; body: string; occurred_at: string }
	| { action: "update"; body?: string; occurred_at?: string }
	| { action: "delete" };

const CREATE_TURN: ProposeTurn = {
	action: "create",
	body: "Bought milk after daycare pickup.",
	occurred_at: "2026-06-10T10:30:00",
};

/** Write the scenario the propose Worker reads (per test, before goto).
 * Re-creates scenarioDir first: a prior test-group's afterAll may already have
 * removed it (see the lifecycle hazard note above). */
function writeScenario(turns: ProposeTurn[]): void {
	mkdirSync(scenarioDir, { recursive: true });
	writeFileSync(proposeParamsFile, JSON.stringify({ turns }));
}

test("renders a pending Journal Entry proposal and accept resumes the run", async ({
	chat,
}) => {
	writeScenario([CREATE_TURN]);
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
	writeScenario([CREATE_TURN]);
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
	writeScenario([CREATE_TURN]);
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
	writeScenario([CREATE_TURN]);
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
	writeScenario([
		CREATE_TURN,
		{ action: "update", body: "Bought oat milk after daycare pickup." },
	]);
	await chat.goto();

	await chat.send("I bought milk after daycare pickup and felt relieved.");

	let card = chat.proposalCard();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await card.getByRole("button", { name: /add journal entry/i }).click();
	await expect(card).toContainText(/added to journal/i, { timeout: 15_000 });
	await chat.waitForAssistantText(/done.*added it/i);

	// Keyword-free prose: the scenario file (turns[1] = update), not the
	// sentence, routes the action.
	await chat.send("Oat, not dairy — swap that in.");

	card = chat.page.locator('[data-proposal-status="pending"]').last();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(card).toContainText("Bought milk after daycare pickup.");
	await expect(card).toContainText("Bought oat milk after daycare pickup.");
	await card.getByRole("button", { name: /update journal entry/i }).click();

	const acceptedCard = chat.page
		.locator('[data-proposal-status="accepted"]')
		.last();
	await expect(acceptedCard).toContainText(/updated in journal/i, {
		timeout: 15_000,
	});
	await chat.waitForAssistantText(/done.*updated it/i);
	await expect(
		chat.page.locator('[data-proposal-status="pending"]'),
	).toHaveCount(0);

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
	writeScenario([
		CREATE_TURN,
		{ action: "update", body: "Bought oat milk after daycare pickup." },
	]);
	await chat.goto();

	await chat.send("I bought milk after daycare pickup and felt relieved.");

	let card = chat.proposalCard();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await card.getByRole("button", { name: /add journal entry/i }).click();
	await expect(card).toContainText(/added to journal/i, { timeout: 15_000 });
	await chat.waitForAssistantText(/done.*added it/i);

	// Keyword-free prose: the scenario file (turns[1] = update), not the
	// sentence, routes the action.
	await chat.send("Oat, not dairy — swap that in.");

	card = chat.page.locator('[data-proposal-status="pending"]').last();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(card).toContainText("Bought milk after daycare pickup.");
	await expect(card).toContainText("Bought oat milk after daycare pickup.");
	await card.getByRole("button", { name: /keep current entry/i }).click();

	const rejectedCard = chat.page
		.locator('[data-proposal-status="rejected"]')
		.last();
	await expect(rejectedCard).toContainText(/kept current journal entry/i, {
		timeout: 15_000,
	});
	await chat.waitForAssistantText(/done.*dismissed it/i);
	await expect(
		chat.page.locator('[data-proposal-status="pending"]'),
	).toHaveCount(0);

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
	writeScenario([CREATE_TURN, { action: "delete" }]);
	await chat.goto();

	await chat.send("I bought milk after daycare pickup and felt relieved.");

	let card = chat.proposalCard();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await card.getByRole("button", { name: /add journal entry/i }).click();
	await expect(card).toContainText(/added to journal/i, { timeout: 15_000 });
	await chat.waitForAssistantText(/done.*added it/i);

	// Keyword-free prose: the scenario file (turns[1] = delete), not the
	// sentence, routes the action.
	await chat.send("That was a mistake — get rid of it.");

	card = chat.page.locator('[data-proposal-status="pending"]').last();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(card).toContainText("Bought milk after daycare pickup.");
	await card.getByRole("button", { name: /delete journal entry/i }).click();

	const acceptedCard = chat.page
		.locator('[data-proposal-status="accepted"]')
		.last();
	await expect(acceptedCard).toContainText(/deleted from journal/i, {
		timeout: 15_000,
	});
	await chat.waitForAssistantText(/done.*deleted it/i);
	await expect(
		chat.page.locator('[data-proposal-status="pending"]'),
	).toHaveCount(0);

	await page.goto(`${core.url}/library/journal`);
	await expect(
		page
			.getByRole("region", { name: /journal/i })
			.getByText("Bought milk after daycare pickup."),
	).toHaveCount(0);
});
