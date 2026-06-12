import { expect, test } from "./fixtures.js";

// Gated 2-chunk fixture: `echo: hello` arrives as "echo: " then (after the gate trips) "hello" — holds a Run mid-stream.
test.use({ coreOptions: { chunks: 2 } });

/** Slice 7: reloading mid-stream rehydrates the partial and resumes to completion — Run owned by Core, not the socket; see docs/design/e2e-tests.md */
test("reload mid-stream rehydrates the partial and resumes to completion", async ({
	chat,
	core,
}) => {
	await chat.goto();

	await chat.send("hello");

	// Chunk 1 streamed: the partial is visible, the gated tail is not.
	await chat.waitForAssistantText(/echo:/);
	await chat.expectNoAssistantText("echo: hello");

	// Reload mid-stream: the Run keeps running in Core; the page forgets focus.
	await chat.reload();

	await chat.openThread("hello");
	await chat.waitForAssistantText(/echo:/);
	await chat.expectNoAssistantText("echo: hello");

	core.tripGate();

	await chat.waitForAssistantText("echo: hello");

	await expect(chat.assistantBubbles()).toHaveCount(1);
	await expect(chat.userBubbles().filter({ hasText: "hello" })).toHaveCount(1);
});
