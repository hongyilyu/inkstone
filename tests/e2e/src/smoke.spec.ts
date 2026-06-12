import { expect, test } from "./fixtures.js";

/**
 * Slice 6 smoke (the canonical example the README points at): a real browser
 * loads the real SPA served by a real Core, and the same-origin WebSocket
 * connects. Asserted through the DOM a user touches, via `ChatPage`.
 *
 * "WS connected" is proven indirectly but reliably: the sidebar's thread list
 * renders its empty-state ("No threads yet.") only after the `thread/list`
 * read resolves over the socket. A page error (failed connect, bad bundle)
 * would surface as a thrown `pageerror`, which we fail on.
 */
test("loads the real SPA against real Core with a live WebSocket", async ({
	chat,
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(err.message));

	await chat.goto();

	// The shell rendered.
	await expect(chat.composer()).toBeVisible();
	await expect(chat.sidebar()).toBeVisible();

	// The thread/list read resolved over the same-origin WS → empty-state shows
	// (a fresh Workspace has no threads). This only appears once the query
	// settles, so it doubles as "the socket connected and answered".
	await expect(chat.sidebar().getByText(/no threads yet/i)).toBeVisible({
		timeout: 15_000,
	});

	expect(errors, `page errors: ${errors.join("; ")}`).toEqual([]);
});
