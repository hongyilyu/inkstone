import { expect, test } from "./fixtures.js";

// A WS drop mid-stream settles the bubble with the synthetic "lost connection"
// error + Try again, not an eternal typing state. The ui-sdk injects a terminal
// error event into active run queues on disconnect (failPending); without that,
// runQueues survived the drop and the bridge fiber blocked forever.
// Gated 2-chunk fixture holds the run mid-stream; killing Core drops the socket.
test.use({ coreOptions: { chunks: 2 } });
test.setTimeout(120_000);

test("killing Core mid-stream settles the bubble with the lost-connection error", async ({
	chat,
	core,
	page,
}) => {
	await chat.goto();
	await chat.send("hold me open");

	await chat.waitForAssistantText(/echo:/);
	await chat.expectNoAssistantText("echo: hold me open");

	// Drop the transport: SIGTERM Core while the run streams. The SPA (already
	// loaded in the browser) sees the WS close mid-stream.
	await core.shutdown();

	// Give the SDK's full reconnect ramp (5 attempts ~1.5s) plus several steady
	// 5s retries a generous window to surface the failure to the store.
	const error = page.getByTestId("assistant-error");
	await expect(error).toBeVisible({ timeout: 60_000 });
	await expect(error).toContainText(
		"Lost the connection before this reply finished",
	);
	await expect(error.getByRole("button", { name: /try again/i })).toBeVisible();

	// Stop is gone — the run is settled from the client's perspective.
	await expect(page.getByRole("button", { name: /^stop$/i })).toHaveCount(0);
});
