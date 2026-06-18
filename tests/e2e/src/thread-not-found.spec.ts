import { expect, test } from "./fixtures.js";

/**
 * Not-found state (ADR-0042, B-additive). Navigating to a `/thread/<id>` Core
 * won't serve shows an honest "thread isn't available" state with a
 * Back-to-New-Chat exit — NOT an eternal skeleton, and NOT a retry that can't
 * succeed. Two deterministic dead-ends route here identically: a well-formed UUID
 * Core has never seen (unknown_thread, -32001 — a stale shared link or deleted
 * Thread) and a malformed non-UUID id (invalid_params, -32602 — a typo'd or
 * truncated link). Both are unrecoverable, so both land on not-found rather than
 * the recoverable retry path (which is reserved for transient fetch failures).
 * The two cases are covered by the two tests below.
 */

// A valid v7-shaped UUID that no Workspace will have minted.
const GHOST_THREAD = "01900000-0000-7000-8000-00000000dead";

test("a /thread/<unknown-uuid> URL shows the not-found state with a New Chat exit", async ({
	chat,
	page,
}) => {
	// Land directly on the unknown-thread deep link.
	await chat.gotoPath(`/thread/${GHOST_THREAD}`);

	// The not-found card renders; no retry affordance (retry can't resurrect it).
	await expect(page.getByText(/this thread isn't available/i)).toBeVisible({
		timeout: 15_000,
	});
	await expect(page.getByRole("button", { name: /try again/i })).toHaveCount(0);

	// The exit routes back to the welcome surface.
	await page.getByRole("button", { name: /back to new chat/i }).click();
	await expect.poll(() => new URL(page.url()).pathname).toBe("/");
	await expect(chat.composer()).toBeVisible();
});

test("a /thread/<malformed-id> URL also shows not-found (no futile retry)", async ({
	chat,
	page,
}) => {
	// A typo'd/truncated shared link carries a non-UUID id → Core rejects it as
	// invalid_params (-32602), a deterministic dead-end. It must land on the same
	// honest not-found state, NOT the retryable error card (deep-review finding).
	await chat.gotoPath("/thread/not-a-real-uuid");

	await expect(page.getByText(/this thread isn't available/i)).toBeVisible({
		timeout: 15_000,
	});
	await expect(page.getByRole("button", { name: /try again/i })).toHaveCount(0);
});
