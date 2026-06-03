import { INTERPRETER_WORKER_CMD } from "./spawnCore.js";
import { expect, test } from "./fixtures.js";

/**
 * Real-interpreter chat acceptance flow (real-worker-codex slices 2/4/5,
 * ADR-0018): Core spawns the GENERIC pi-agent-core interpreter
 * (packages/worker/src/cli.ts), not the echo fixture, and a user's message
 * streams a real agent-loop completion back into the chat.
 *
 * Runs fully offline via the faux provider (ADR-0019 as-built): the Workflow
 * declares `provider="faux"` and the canned completion rides
 * INKSTONE_FAUX_RESPONSE — so this exercises the real manifest → runAgentLoop
 * → text_delta → done path without contacting any provider.
 */
test.use({
	coreOptions: {
		workerCmd: INTERPRETER_WORKER_CMD,
		fauxResponse: "the codex says hello",
	},
});

test("a chat message streams a real interpreter completion", async ({
	chat,
}) => {
	await chat.goto();

	await chat.send("hi there");

	// The faux provider streams "the codex says hello" through the real
	// interpreter; it lands in an assistant bubble.
	await chat.waitForAssistantText("the codex says hello");
});
