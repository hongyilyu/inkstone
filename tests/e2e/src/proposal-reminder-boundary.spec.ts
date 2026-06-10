import { expect, test } from "./fixtures.js";
import { PROMPT_BOUNDARY_WORKER_CMD } from "./spawnCore.js";

test.use({
	coreOptions: {
		workerCmd: PROMPT_BOUNDARY_WORKER_CMD,
	},
});

test("does not propose a Journal Entry for a reminder", async ({ chat }) => {
	await chat.goto();

	await chat.send("remember buying milk after daycare pickup");

	await chat.waitForAssistantText(/won't save it as a Journal Entry/i);
	await expect(chat.proposalCard()).toHaveCount(0);
});
