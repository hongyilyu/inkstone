import { expect, test } from "./fixtures.js";

// Gated 2-chunk fixture so the Run can be held mid-stream while we navigate away.
test.use({ coreOptions: { chunks: 2 } });

/** Slice 8: a background Run keeps streaming while another thread is focused — stream fiber keyed by run id survives the focus change; see docs/design/e2e-tests.md */
test("a background Run keeps streaming while another thread is focused", async ({
	chat,
	core,
}) => {
	await chat.goto();

	await chat.send("hello");
	await chat.waitForAssistantText(/echo:/);
	await chat.expectNoAssistantText("echo: hello");

	// Navigate away: New Chat clears focus, so A's messages leave the viewport.
	await chat.newChat();
	await expect(chat.assistantBubbles()).toHaveCount(0);

	// Release the gate while A is OFF-screen — its Run advances in the background.
	core.tripGate();

	// Reopening A shows the FULL echo, proving the Run kept streaming while off-screen.
	await chat.openThread("hello");
	await chat.waitForAssistantText("echo: hello");
	await expect(chat.assistantBubbles()).toHaveCount(1);
});
