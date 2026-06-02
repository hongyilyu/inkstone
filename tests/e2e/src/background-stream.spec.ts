import { expect, test } from "./fixtures.js";

// Gated 2-chunk fixture so the Run can be held mid-stream while we navigate away.
test.use({ coreOptions: { chunks: 2 } });

/**
 * Slice 8 — acceptance: a Run is observable independent of which thread is
 * focused, so it keeps streaming in the background while the user is elsewhere.
 *
 *   send "hello"          → thread A starts a Run; partial "echo: " shows
 *   newChat()             → focus clears; A's bubble leaves the viewport
 *   core.tripGate()       → A's gated tail streams while A is OFF-screen
 *   openThread("hello")   → A shows the FULL "echo: hello" — it advanced while away
 *
 * The background run's stream fiber is keyed by run id and survives the focus
 * change (it is not torn down when the focused thread changes), so the store
 * for A keeps accumulating; reopening A just renders the already-complete text.
 */
test("a background Run keeps streaming while another thread is focused", async ({
	chat,
	core,
}) => {
	await chat.goto();

	// Thread A: first send mints it (title = prompt "hello") and starts the Run.
	await chat.send("hello");
	await chat.waitForAssistantText(/echo:/);
	await chat.expectNoAssistantText("echo: hello");

	// Navigate away: New Chat clears focus, so A's messages leave the viewport.
	await chat.newChat();
	await expect(chat.assistantBubbles()).toHaveCount(0);

	// Release the gate while A is OFF-screen — its Run advances in the background.
	core.tripGate();

	// Come back to A. Its assistant bubble shows the FULL echo, proving the Run
	// kept streaming into A's state while the user was on the New Chat surface.
	await chat.openThread("hello");
	await chat.waitForAssistantText("echo: hello");
	await expect(chat.assistantBubbles()).toHaveCount(1);
});
