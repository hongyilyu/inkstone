import { FAUX_WORKER_CMD } from "./spawnCore.js";
import { expect, test } from "./fixtures.js";

/** Real-interpreter chat acceptance (ADR-0018): the faux-provider Worker streams a real agent-loop completion offline (ADR-0019). */
test.use({
	coreOptions: {
		workerCmd: FAUX_WORKER_CMD,
		fauxResponse: "the codex says hello",
	},
});

test("a chat message streams a real interpreter completion", async ({
	chat,
}) => {
	await chat.goto();

	await chat.send("hi there");

	await chat.waitForAssistantText("the codex says hello");
});
