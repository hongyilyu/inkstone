import { FAUX_WORKER_CMD } from "./spawnCore.js";
import { expect, test } from "./fixtures.js";

/**
 * Run-error surfacing (real-worker-codex slice 1 + the interpreter path): when
 * the provider/Run fails, the assistant turn must show an error in the UI —
 * never a silent blank bubble. Driven offline by the faux provider failing the
 * turn (`fauxError` → stopReason "error"), which produces the exact `error`
 * Run Event a real network/provider failure yields.
 */
test.use({
	coreOptions: {
		workerCmd: FAUX_WORKER_CMD,
		fauxError: "the provider is unavailable",
	},
});

test("a failed run surfaces an error in the assistant bubble", async ({
	chat,
	page,
}) => {
	await chat.goto();

	await chat.send("hi there");

	// The faux provider fails the turn; the interpreter emits an `error` Run
	// Event, which the UI renders as an error on the assistant turn (not a
	// blank bubble, not a hang). The error bubble also carries a "Try again"
	// retry affordance (added in #90), so assert the message is CONTAINED, not
	// that it's the bubble's only text.
	const error = page.getByTestId("assistant-error");
	await expect(error).toBeVisible({ timeout: 15_000 });
	await expect(error).toContainText("the provider is unavailable");
});
