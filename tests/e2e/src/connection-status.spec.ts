import { expect, test } from "./fixtures.js";

/**
 * Socket-liveness indicator + connection-specific send copy on a real SIGTERM
 * (ADR-0051): real Core + built Web Client. This is the user-visible DEGRADED
 * state — the always-on NavShell indicator morphing to "Lost connection" once
 * the client's own socket drops and its unbounded reconnect can't re-open
 * (Core is gone), plus a send attempted while offline surfacing the
 * connection-specific copy (not the generic "Couldn't send…" fallback).
 *
 * Auto-recovery (reconnect → connected) is deliberately NOT covered here:
 * `spawnCore` uses a random port + fresh tempdir, so a same-port Core RESTART
 * isn't supported by the harness. The recovery round-trip is proven in ui-sdk
 * vitest (slice 1). Do NOT try to restart Core in this spec.
 *
 * Selector choice: target the indicator by its visible "Lost connection" label
 * text (`getByText("Lost connection", { exact: true })`) — the page-object idiom
 * (no impl-only testid), which doubles as the assertion that the disconnected
 * treatment rendered. EXACT text isolates the visible glyph from the sr-only
 * role="status" span, whose copy also begins "Lost connection…". The default
 * `coreOptions: {}` (gate fixture) is fine: the test never completes a Run — it
 * sends, kills Core, then probes the degraded surface.
 */
test("SIGTERM Core: indicator shows Lost connection and an offline send shows the connection copy", async ({
	chat,
	core,
}) => {
	const { page } = chat;

	await chat.goto();

	// Connected resting state: the quiet dot carries no word, so the connected
	// signal is the ABSENCE of any degraded text (don't over-assert the dot).
	await expect(page.getByText(/lost connection/i)).toHaveCount(0);
	await expect(page.getByText(/reconnecting/i)).toHaveCount(0);

	// Fire a send, THEN SIGTERM Core so the in-flight request is dropped before Core
	// answers it. `chat.goto()` landed on the welcome (no focused thread), so this
	// mints a thread → `sendNewThread` → `thread/create` request, written over the
	// open socket and awaiting a reply. Killing Core mid-flight fails that pending
	// request with `connection_lost`, which ChatColumn maps to the connection-
	// specific copy. (A send issued AFTER the link is fully down instead blocks on
	// the SDK's writer latch — open-gated — so the in-flight drop is the
	// deterministic way to surface the failure with Core gone for good.)
	await chat.send("are you there?");
	await core.shutdown();

	// The send-error alert shows the CONNECTION-SPECIFIC copy. The /lost its
	// connection/i pattern matches CONNECTION_SEND_FAILURE ("Inkstone may have lost
	// its connection…") and would NOT match the generic "Couldn't send your
	// message." fallback.
	await expect(page.getByRole("alert")).toHaveText(/lost its connection/i, {
		timeout: 15_000,
	});

	// The always-on indicator reaches the "Lost connection" treatment. (We don't
	// race the brief "Reconnecting…" ramp — asserting it is flaky — only the
	// durable terminal state.) Target the VISIBLE label by EXACT text: the
	// indicator also renders an sr-only role="status" span whose text starts with
	// "Lost connection…", so a loose /lost connection/i matches both (strict-mode
	// violation); the exact match isolates the visible glyph's word.
	await expect(page.getByText("Lost connection", { exact: true })).toBeVisible({
		timeout: 15_000,
	});
	// The role="status" region stably announces the retrying text once disconnected.
	await expect(
		page.getByRole("status").filter({ hasText: /lost connection.*retrying/i }),
	).toHaveText(/lost connection to inkstone\. retrying/i, { timeout: 15_000 });
});
