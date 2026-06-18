import { expect, test } from "./fixtures.js";
import { FAUX_WORKER_CMD } from "./spawnCore.js";

/**
 * URL-addressable Threads (ADR-0042): the focused Thread IS the route. A first
 * send mints a Thread and navigates to `/thread/<id>`; a reload onto that URL
 * cold-hydrates the same conversation (reload-survival — the store starts empty,
 * so only the URL could have restored it); New Chat returns to `/`; and the
 * browser Back button walks the Thread history stack.
 *
 * Driven through the faux Worker so each send is a real Run with a real,
 * server-assigned thread id surfaced in the URL.
 */
test.use({
	// A short viewport makes a handful of turns overflow, so "last message visible"
	// after a cold reload can only be the bottom-scroll, not the initial paint.
	viewport: { width: 1024, height: 600 },
	coreOptions: {
		workerCmd: FAUX_WORKER_CMD,
		fauxResponse: "noted, I will remember that",
	},
});

test("a first send mints a Thread and puts its id in the URL", async ({
	chat,
}) => {
	await chat.goto();
	// Fresh surface: the welcome route, no Thread in the URL.
	expect(chat.pathname()).toBe("/");

	await chat.send("Plan the offsite in Lisbon");
	await chat.waitForAssistantText(/noted/i);

	// The URL now carries the minted Thread id (ADR-0042).
	await expect.poll(() => chat.pathname()).toMatch(/^\/thread\/[0-9a-f-]+$/i);
});

test("reloading a Thread URL cold-hydrates the same conversation", async ({
	chat,
}) => {
	await chat.goto();
	await chat.send("Remember the dentist on Friday");
	await chat.waitForAssistantText(/noted/i);
	const threadUrl = chat.pathname();
	expect(threadUrl).toMatch(/^\/thread\//);

	// Reload: the store reinitializes empty, so anything that survives came from
	// the URL. The transcript rehydrates via thread/get and the URL is unchanged.
	await chat.reload();
	expect(chat.pathname()).toBe(threadUrl);
	await expect(chat.userBubbles().filter({ hasText: "dentist" })).toHaveCount(
		1,
		{ timeout: 15_000 },
	);
});

test("reloading a long Thread cold-lands at the bottom (latest message)", async ({
	chat,
}) => {
	await chat.goto();

	// Build an overflowing transcript: the first turn sits well above the fold,
	// the last turn at the bottom.
	const turns = [
		"First: the very first thing at the top of the list",
		"Second errand to handle this week",
		"Third item, still scrolled up high",
		"Fourth, somewhere in the middle",
		"Fifth, getting lower now",
		"Sixth, the final and most recent message",
	];
	for (let i = 0; i < turns.length; i++) {
		await chat.send(turns[i]);
		await expect(chat.copyButtons()).toHaveCount(i + 1, { timeout: 15_000 });
	}
	const threadUrl = chat.pathname();

	// Cold reload: store starts empty, thread/get rehydrates the full transcript.
	await chat.reload();
	expect(chat.pathname()).toBe(threadUrl);
	await expect(chat.userBubbles()).toHaveCount(turns.length, {
		timeout: 15_000,
	});

	// Lands at the bottom (ADR-0042): the latest turn is in view, the first is not.
	await expect(chat.userBubble("the very first thing")).not.toBeInViewport();
	await expect(chat.userBubble("final and most recent")).toBeInViewport();
});

test("New Chat returns to the root welcome route", async ({ chat }) => {
	await chat.goto();
	await chat.send("First topic");
	await chat.waitForAssistantText(/noted/i);
	expect(chat.pathname()).toMatch(/^\/thread\//);

	await chat.newChat();
	await expect.poll(() => chat.pathname()).toBe("/");
	// Welcome surface: no messages on screen.
	await expect(chat.userBubbles()).toHaveCount(0);
});

test("Back walks the Thread history stack between two Threads", async ({
	chat,
}) => {
	await chat.goto();

	// Thread A.
	await chat.send("Apple harvest planning");
	await chat.waitForAssistantText(/noted/i);
	const threadA = chat.pathname();

	// New Chat → Thread B (a second mint).
	await chat.newChat();
	await expect.poll(() => chat.pathname()).toBe("/");
	await chat.send("Bicycle repair checklist");
	await chat.waitForAssistantText(/noted/i);
	const threadB = chat.pathname();
	expect(threadB).not.toBe(threadA);

	// Back from B lands on the welcome route we visited between the two sends…
	await chat.page.goBack();
	await expect.poll(() => chat.pathname()).toBe("/");
	// …and Back again lands on Thread A, proving thread navigation pushed history.
	await chat.page.goBack();
	await expect.poll(() => chat.pathname()).toBe(threadA);
	await expect(
		chat.userBubbles().filter({ hasText: "Apple harvest" }),
	).toHaveCount(1, { timeout: 15_000 });
});
