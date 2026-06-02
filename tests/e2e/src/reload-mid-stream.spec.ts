import { expect, test } from "./fixtures.js";

// Gated 2-chunk fixture: `echo: hello` arrives as "echo: " then (after the
// gate is tripped) "hello". Lets us hold a Run mid-stream deterministically.
test.use({ coreOptions: { chunks: 2 } });

/**
 * Slice 7 — headline acceptance (the wire-web-client criterion left
 * manual-smoke only): a Run is owned by Core, not by the socket that started
 * it, so reloading the page mid-stream and reopening the thread rehydrates the
 * partial assistant text and resumes the live stream to completion.
 *
 *   send "hello"            → assistant bubble shows the partial "echo: "
 *   page.reload()           → focus is lost (no thread routing); the thread is
 *                             still listed in the sidebar
 *   openThread("hello")     → thread/get rehydrates the partial + resubscribes
 *   core.tripGate()         → the gated tail streams in → "echo: hello", done
 */
test("reload mid-stream rehydrates the partial and resumes to completion", async ({
	chat,
	core,
}) => {
	await chat.goto();

	// First message mints a thread (titled with the prompt) and starts the Run.
	await chat.send("hello");

	// Chunk 1 streamed: the partial is visible, the gated tail is not.
	await chat.waitForAssistantText(/echo:/);
	await chat.expectNoAssistantText("echo: hello");

	// Reload mid-stream. The Run keeps running in Core; the page forgets focus.
	await chat.reload();

	// Reopen the thread → thread/get rehydrates the partial + resubscribes.
	await chat.openThread("hello");
	await chat.waitForAssistantText(/echo:/);
	await chat.expectNoAssistantText("echo: hello");

	// Release the gate → the remaining tail streams into the resubscribed run.
	core.tripGate();

	// The bubble now shows the full echo — the reloaded page resumed the stream.
	await chat.waitForAssistantText("echo: hello");

	// Exactly one assistant bubble; the user bubble is intact too.
	await expect(chat.assistantBubbles()).toHaveCount(1);
	await expect(chat.userBubbles().filter({ hasText: "hello" })).toHaveCount(1);
});
