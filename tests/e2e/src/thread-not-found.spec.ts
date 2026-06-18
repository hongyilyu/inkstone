import { expect, test } from "./fixtures.js";

/**
 * Unknown-Thread not-found state (ADR-0042, B-additive). Navigating to a
 * `/thread/<id>` whose id is a well-formed UUID Core has never seen (a stale
 * shared link, a deleted Thread) shows an honest "thread isn't available" state
 * with a Back-to-New-Chat exit — NOT an eternal skeleton, and NOT a retry that
 * can't succeed.
 *
 * The id must be a syntactically valid UUID: a malformed id is rejected at decode
 * as invalid_params (-32602 → the recoverable error path), whereas a well-formed
 * but unknown id is unknown_thread (-32001 → not-found). This proves the tag split.
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
