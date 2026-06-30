import { expect, test } from "./fixtures.js";
import { FAUX_WORKER_CMD } from "./spawnCore.js";

/**
 * Issue #138 + ADR-0061 (end-to-end): activating a ⌘K message-search hit
 * deep-links to `/thread/<id>?focusedMessageId=<id>`, which scrolls the EXACT
 * matched Message into view, briefly highlights it, then strips the param from
 * the URL (consume-then-strip) — not just landing on the Thread.
 *
 * We drive a REAL multi-turn conversation through the faux Worker so the body
 * text is indexed at Core's seams and the transcript genuinely overflows the
 * viewport. Then we navigate away (New Chat → `/`) before activating the hit, so
 * picking it is a true cross-surface deep-link whose server `message_id` lines up
 * with the (cold-or-warm) rehydrated row.
 *
 * The needle sits EARLY (turn 2) with six turns below it, and the chat pins to
 * the bottom — so the matched message starts decisively above the fold. A passing
 * in-viewport assertion can therefore only be the scroll-to-message jump, never
 * the initial paint. A short viewport makes the overflow certain.
 */
test.use({
	viewport: { width: 1024, height: 600 },
	coreOptions: {
		workerCmd: FAUX_WORKER_CMD,
		fauxResponse: "noted, I will remember that",
	},
});

// Turn 1 becomes the Thread title (Core derives a word-boundary slug from the
// prompt — ADR-0048), so it must NOT carry the needle — otherwise a Threads-group
// title match could masquerade as the message-body hit we mean to prove.
const TITLE_PROMPT =
	"Planning the week ahead and sorting out the various errands I keep forgetting";

// Turn 2, the target — near the TOP of a long transcript ("deep in scrollback").
// The coined token "zylophant" can only come from the indexed body, never the
// title (turn 1) nor any other turn.
const NEEDLE_BODY =
	"Most important this week: sort out the zylophant vet appointment downtown on Friday.";
const NEEDLE = "ylophant";

// Six later turns push the target up off the fold once the view pins to bottom.
const LATER_TURNS = [
	"Next, the grocery run for the weekend.",
	"Then confirm the dentist booking for the kids.",
	"The car is due for its annual service inspection.",
	"Reply to the landlord about the lease renewal.",
	"Book the train tickets before the prices climb again.",
	"That's everything I can think of for now, thanks.",
];

test("⌘K message hit deep-links to the exact message, highlights it, then strips the anchor", async ({
	chat,
}) => {
	await chat.goto();

	// Build a real, overflowing transcript. Each send is a genuine Run; a finished
	// turn exposes a Copy control, so the copy-button count is a monotonic
	// "turns completed" signal that orders the sends.
	const prompts = [TITLE_PROMPT, NEEDLE_BODY, ...LATER_TURNS];
	for (let i = 0; i < prompts.length; i++) {
		await chat.send(prompts[i]);
		await expect(chat.copyButtons()).toHaveCount(i + 1, { timeout: 15_000 });
	}

	// Reload first: the live transcript carried client-minted message ids, but the
	// search hit returns Core's server message_id. A reload onto the thread URL
	// cold-hydrates via thread/get (reload-survival, ADR-0061) so the rendered rows
	// now carry server ids — the ones the hit's anchor will match. Then New Chat
	// back to `/` so opening the hit is a true cross-surface deep-link.
	await chat.reload();
	await expect.poll(() => chat.pathname()).toMatch(/^\/thread\//);
	await chat.newChat();
	await expect.poll(() => chat.pathname()).toBe("/");
	await expect(chat.userBubbles()).toHaveCount(0);

	// Find the message by an interior substring of its body and activate the hit.
	await chat.openCommandPalette();
	await chat.searchCommandPalette(NEEDLE);
	const messageHits = chat.commandPaletteGroupOptions("Messages");
	await expect(messageHits).toHaveCount(1);
	await messageHits.first().click();

	// The palette closes and we land on the thread's route, anchored to the message.
	await expect(chat.commandPalette()).toBeHidden();
	await expect.poll(() => chat.pathname()).toMatch(/^\/thread\//);

	const target = chat.userBubble("zylophant vet appointment");
	await expect(target).toHaveCount(1, { timeout: 15_000 });

	// The lamplight ring blooms on the matched message — assert while it's up
	// (it self-clears after ~1.6s) and confirm it's THAT message wearing it.
	await expect(target.locator("[data-highlighted]")).toHaveCount(1);

	// The matched message was scrolled into view. It starts above the fold (turn 2
	// of eight, bottom-pinned), so being in-viewport can only be the jump.
	await expect(target).toBeInViewport();

	// Consume-then-strip (ADR-0061): the anchor is gone from the URL once consumed,
	// so a reload or Back can't re-fire the jump.
	await expect.poll(() => chat.search()).toBe("");
});

test("a stale ?focusedMessageId (no such message) strips itself and still shows the thread", async ({
	chat,
}) => {
	// A shared/typo'd deep link whose message id isn't in the thread must NOT
	// wedge the thread at the top with the param stuck forever — once hydration
	// settles and the id isn't found, the anchor strips (ADR-0061 consume-then-strip).
	await chat.goto();
	await chat.send("A normal message in this thread");
	await chat.waitForAssistantText(/noted/i);
	const threadPath = chat.pathname();

	// Re-open the SAME thread with a bogus anchor (a valid-looking but absent id).
	await chat.gotoPath(
		`${threadPath}?focusedMessageId=00000000-0000-0000-0000-000000000bad`,
	);

	// The thread still renders (it exists), and the dead anchor strips off the URL.
	await expect(
		chat.userBubbles().filter({ hasText: "A normal message" }),
	).toHaveCount(1, { timeout: 15_000 });
	await expect.poll(() => chat.search()).toBe("");
	expect(chat.pathname()).toBe(threadPath);
});
