import { expect, test } from "./fixtures.js";
import { FAUX_WORKER_CMD } from "./spawnCore.js";

/**
 * Tool-activity preservation (ADR-0043): a tool-activity row that surfaces live
 * inside an assistant turn (the ephemeral `tool_call` Run Event, ADR-0006) must
 * SURVIVE a page reload. Before this feature, the row was built only from the
 * live stream and `thread/get` rehydration carried no tool calls, so a refresh
 * dropped it. Now `thread/get` folds the persisted `tool_calls` into
 * `MessageView.tool_calls`, and `hydrate.toMessage` rebuilds the row cold.
 *
 * Driven by the same real `read_thread` round-trip `tool-activity.spec.ts` uses
 * (faux-provider Worker in tool-call mode, ADR-0019); this spec adds the reload.
 */
test.use({
	coreOptions: {
		workerCmd: FAUX_WORKER_CMD,
		fauxToolCall: true,
	},
});

test("a tool-activity row survives a page reload", async ({ chat }) => {
	await chat.page
		.context()
		.grantPermissions(["clipboard-read", "clipboard-write"]);

	await chat.goto();

	// Thread A carries a distinctive secret; copy its id from the sidebar row.
	await chat.send("alpha-secret-123");
	await chat.waitForAssistantText(/read_thread result/);
	await chat.copyThreadId("alpha-secret-123");
	const threadAId = await chat.clipboardText();

	// New Thread B asks the model to read A by id → a real read_thread call.
	await chat.newChat();
	await chat.send(`read thread ${threadAId}`);

	// The row renders live and settles to completed.
	const list = chat.page.getByRole("list", { name: /tool activity/i });
	await expect(list).toBeVisible();
	const row = chat.page.getByTestId("tool-call");
	await expect(row).toHaveAttribute("data-status", "completed", {
		timeout: 15_000,
	});
	await expect(row).toContainText("Read this thread");

	// Wait for the turn to finish so the assistant Message + its tool call are
	// durably persisted before the reload.
	await chat.waitForAssistantText(/alpha-secret-123/);
	const threadUrl = chat.pathname();
	expect(threadUrl).toMatch(/^\/thread\//);

	// Cold reload: the store reinitializes empty, so anything that survives came
	// from `thread/get`. The tool-activity row must rehydrate.
	await chat.reload();
	expect(chat.pathname()).toBe(threadUrl);

	const reloadedRow = chat.page.getByTestId("tool-call");
	await expect(reloadedRow).toHaveCount(1, { timeout: 15_000 });
	await expect(reloadedRow).toHaveAttribute("data-status", "completed");
	await expect(reloadedRow).toContainText("Read this thread");
});
