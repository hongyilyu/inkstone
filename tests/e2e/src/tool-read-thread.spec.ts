import { expect, test } from "./fixtures.js";
import { FAUX_WORKER_CMD } from "./spawnCore.js";

/** Tool Protocol capstone (ADR-0018): cross-thread `read_thread` end-to-end via the faux-provider Worker in tool-call mode (ADR-0019). */
test.use({
	coreOptions: {
		workerCmd: FAUX_WORKER_CMD,
		fauxToolCall: true,
	},
});

test("the assistant reads another thread's messages via read_thread", async ({
	chat,
	page,
}) => {
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

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

	// New thread B reads A by id: faux model calls read_thread(threadAId), so B's bubble echoes A's secret.
	await chat.newChat();
	await chat.send(`read thread ${threadAId}`);

	await chat.waitForAssistantText(/alpha-secret-123/);
});
