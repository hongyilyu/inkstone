import path from "node:path";
import { expect, test } from "./fixtures.js";
import { PROPOSE_WORKER_CMD, REPO_ROOT } from "./spawnCore.js";

/**
 * Replays a real captured `propose_workspace_mutation` tool call from the model.
 * The capture came from Playwright driving the real app with
 * INKSTONE_WORKER_TOOL_CALL_LOG set.
 */
test.use({
	coreOptions: {
		workerCmd: PROPOSE_WORKER_CMD,
		proposalParamsFile: path.join(
			REPO_ROOT,
			"tests/e2e/fixtures/captured-real-journal-proposal.json",
		),
	},
});

test("captured real Journal Entry proposal applies cleanly", async ({
	chat,
}) => {
	await chat.goto();

	await chat.send("remember buying milk after daycare pickup");

	const card = chat.proposalCard();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(card).toContainText(
		"Remember to buy milk after daycare pickup.",
	);
	await expect(card).toContainText("2026-06-10T00:00:00");
	await expect(card).toContainText(
		"Save the user's reminder as a journal entry.",
	);

	const add = card.getByRole("button", { name: /add journal entry/i });
	await expect(add).toBeEnabled();
	await add.click();

	await expect(card).toContainText(/added to journal/i, { timeout: 15_000 });
	await chat.waitForAssistantText(/done.*added it/i);
});
