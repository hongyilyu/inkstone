import { expect, test } from "./fixtures.js";

// Gated 2-chunk fixture: chunk 1 streams, then the worker blocks on the gate.
// We never trip it — the Run stays open mid-stream, giving a race-free window to
// click Stop. This drives run/cancel through the real UI (composer Stop button),
// complementing run-cancel.spec.ts which exercises the raw WebSocket path.
test.use({ coreOptions: { chunks: 2 } });

test("clicking Stop cancels a streaming run and settles the bubble", async ({
	chat,
}) => {
	await chat.goto();

	await chat.send("hi there");

	// Chunk 1 streamed: the partial is visible, the gated tail is not. This proves
	// the Run is mid-stream, so the Stop click is not racing a completion.
	await chat.waitForAssistantText(/echo:/);
	await chat.expectNoAssistantText("echo: hi there");

	// Stop replaces Send while the Run is active; clicking it cancels via run/cancel.
	await chat.stop();

	// The reply settles to the cancelled/incomplete state. Cancel carries NO
	// provider error, so the bubble shows the default "stopped" copy (distinct
	// from run-error.spec.ts, which asserts a provider message).
	const settled = chat.assistantError();
	await expect(settled).toBeVisible({ timeout: 15_000 });
	await expect(settled).toContainText("stopped before it finished");

	// The Run never completed: the gated tail never arrives and there is exactly
	// one assistant turn. Stop is gone; Send is back.
	await chat.expectNoAssistantText("echo: hi there");
	await expect(chat.assistantBubbles()).toHaveCount(1);
	await expect(chat.page.getByRole("button", { name: /^stop$/i })).toHaveCount(
		0,
	);
	await expect(
		chat.page.getByRole("button", { name: /^send$/i }),
	).toBeVisible();
});
