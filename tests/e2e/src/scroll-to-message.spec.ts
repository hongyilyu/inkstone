import { expect, test } from "./fixtures.js";
import { FAUX_WORKER_CMD } from "./spawnCore.js";

/**
 * Issue #138 (end-to-end): activating a ⌘K message-search hit scrolls the EXACT
 * matched Message into view and briefly highlights it — not just landing on the
 * Thread. This completes the "findable" half of the product thesis.
 *
 * We drive a REAL multi-turn conversation through the faux Worker so the body
 * text is indexed at Core's seams and the transcript genuinely overflows the
 * viewport. Then we RELOAD: store-only thread focus is dropped, so picking the
 * hit forces a true cold `thread/get` hydration — the "come back to it later"
 * path the feature exists for, and the one where the hit's server `message_id`
 * lines up with the rehydrated row.
 *
 * The needle sits EARLY (turn 2) with six turns below it, and the chat pins to
 * the bottom on hydration — so the matched message starts decisively above the
 * fold. A passing in-viewport assertion can therefore only be the scroll-to-
 * message jump, never the initial paint. A short viewport makes the overflow
 * certain.
 */
test.use({
	viewport: { width: 1024, height: 600 },
	coreOptions: {
		workerCmd: FAUX_WORKER_CMD,
		fauxResponse: "noted, I will remember that",
	},
});

// Turn 1 becomes the Thread title (Core truncates the prompt to 80 chars), so it
// must NOT carry the needle — otherwise a Threads-group title match could
// masquerade as the message-body hit we mean to prove.
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

test("⌘K message hit scrolls the exact matched message into view and highlights it", async ({
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

	// Reload: thread focus is store-only, so this drops it and forces the next
	// open to cold-hydrate via thread/get (server message ids, not the live
	// client-minted ones). The chat returns to the fresh-start surface.
	await chat.reload();
	await expect(chat.userBubbles()).toHaveCount(0);

	// Find the message by an interior substring of its body and activate the hit.
	await chat.openCommandPalette();
	await chat.searchCommandPalette(NEEDLE);
	const messageHits = chat.commandPaletteGroupOptions("Messages");
	await expect(messageHits).toHaveCount(1);
	await messageHits.first().click();

	// The palette closes and the thread cold-hydrates back into the transcript.
	await expect(chat.commandPalette()).toBeHidden();
	const target = chat.userBubble("zylophant vet appointment");
	await expect(target).toHaveCount(1, { timeout: 15_000 });

	// The lamplight ring blooms on the matched message — assert while it's up
	// (it self-clears after ~1.6s) and confirm it's THAT message wearing it.
	await expect(target.locator("[data-highlighted]")).toHaveCount(1);

	// The matched message was scrolled into view. It starts above the fold (turn 2
	// of eight, bottom-pinned), so being in-viewport can only be the jump.
	await expect(target).toBeInViewport();
});
