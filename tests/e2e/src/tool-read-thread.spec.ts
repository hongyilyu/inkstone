import { INTERPRETER_WORKER_CMD } from "./spawnCore.js";
import { expect, test } from "./fixtures.js";

/**
 * Tool Protocol capstone (ADR-0018): the full cross-thread read, end-to-end
 * through the real stack — real Core, the real generic interpreter Worker
 * (packages/worker/src/cli.ts), and the real built Web Client in the browser.
 *
 * Offline via the faux provider in tool-call mode (ADR-0019): the Workflow
 * allowlists `read_thread`; the faux "model" extracts a thread id from the
 * user's message, calls `read_thread`, and echoes the result. The user hands
 * over Thread A's id with the sidebar copy button (slice 5), exercising the
 * whole feature as a real user would.
 */
test.use({
	coreOptions: {
		workerCmd: INTERPRETER_WORKER_CMD,
		fauxToolCall: true,
	},
});

test("the assistant reads another thread's messages via read_thread", async ({
	chat,
	page,
}) => {
	await page
		.context()
		.grantPermissions(["clipboard-read", "clipboard-write"]);

	await chat.goto();

	// Thread A carries a distinctive secret in its first user message.
	await chat.send("alpha-secret-123");
	await chat.waitForAssistantText(/read_thread result/);

	// Copy A's id from its sidebar row (slice 5) and read it off the clipboard.
	await chat.copyThreadId("alpha-secret-123");
	const threadAId = await chat.clipboardText();
	expect(threadAId).toMatch(
		/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
	);

	// New thread B: ask the assistant to read A by pasting its id. The faux
	// model calls read_thread(threadAId); Core returns A's messages; the reply
	// echoes them — so B's assistant bubble contains A's secret.
	await chat.newChat();
	await chat.send(`read thread ${threadAId}`);

	await chat.waitForAssistantText(/alpha-secret-123/);
});
