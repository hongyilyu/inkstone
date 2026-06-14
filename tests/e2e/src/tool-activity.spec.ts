import { expect, test } from "./fixtures.js";
import { FAUX_WORKER_CMD } from "./spawnCore.js";

/**
 * Full-system ToolActivity row (ADR-0006 `tool_call` Run Event): the compact
 * per-call row that surfaces a live tool call inside an assistant turn. Driven
 * by the same real `read_thread` round-trip `tool-read-thread.spec.ts` uses
 * (faux-provider Worker in tool-call mode, ADR-0019) — but that spec asserts
 * only the resulting assistant TEXT, leaving the row's status transition,
 * humanized label, read-only access chip, and accessible announcement
 * unguarded e2e. This asserts the row itself.
 *
 * The `running` phase is fleeting (no gate in tool-call mode), so we assert the
 * settled terminal state rather than racing the transient running row.
 */
test.use({
	coreOptions: {
		workerCmd: FAUX_WORKER_CMD,
		fauxToolCall: true,
	},
});

test("a read_thread call renders a completed, read-only tool-activity row", async ({
	chat,
}) => {
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

	// The Tool activity list and its single row render for the call.
	const list = chat.page.getByRole("list", { name: /tool activity/i });
	await expect(list).toBeVisible();
	const row = chat.page.getByTestId("tool-call");

	// The row settles to completed, flips to the past-tense label, and keeps the
	// read-only access chip (read_thread is a read-only Tool, ADR-0006).
	await expect(row).toHaveAttribute("data-status", "completed", {
		timeout: 15_000,
	});
	await expect(row).toContainText("Read this thread");
	await expect(row).toContainText("read-only");

	// The row belongs to a real round-trip: B's bubble echoes A's secret.
	await chat.waitForAssistantText(/alpha-secret-123/);
});
