import { expect, test } from "./fixtures.js";
import { FAUX_WORKER_CMD } from "./spawnCore.js";

/**
 * End-to-end: a message becomes findable by a substring of its body through the
 * whole real stack — Core's `message/search` (a LIKE scan over the assembled
 * `message_parts` text of completed messages) → ui-sdk → the ⌘K palette → thread
 * navigation.
 *
 * We drive a REAL conversation through the faux interpreter Worker (not a direct
 * SQL seed): search reads the live `message_parts` of completed messages, so the
 * only way to land a searchable row is to actually send.
 */
test.use({
	coreOptions: {
		workerCmd: FAUX_WORKER_CMD,
		fauxResponse: "noted, I will remember that",
	},
});

// The user message body. The thread title is the prompt's word-boundary slug
// (crates/core thread_create / ADR-0048: ≤ 32 scalars, last whole word), so the
// coined token "zylophant" (index 100) lands FAR PAST the slug cutoff: the title
// can't match it, only the indexed body can — which is exactly what proves the
// message-search path, not thread-title match.
const MESSAGE_BODY =
	"Reminder to myself: I really need to sort out the family logistics before next week, especially the zylophant daycare schedule and pickup times.";

// Interior fragment (drops the leading "z") — searching this proves substring /
// trigram matching, not a prefix match.
const NEEDLE = "ylophant";

test("⌘K finds a message by a body substring and navigates to its thread", async ({
	chat,
}) => {
	await chat.goto();

	// Drive a genuine Run: indexes the user message at creation and completes the
	// assistant message at run completion, through the real Core seams.
	await chat.send(MESSAGE_BODY);
	await chat.waitForAssistantText("noted, I will remember that");

	// Start a fresh chat so the source thread is no longer focused — then a click
	// on the search hit must demonstrably NAVIGATE back to it.
	await chat.newChat();
	await expect(chat.userBubbles()).toHaveCount(0);

	// Open the palette and search an interior fragment of the message body.
	await chat.openCommandPalette();
	await chat.searchCommandPalette(NEEDLE);

	// A "Messages" group hit appears carrying the snippet (around the match) and
	// the source thread's title. Scoped to the Messages group so this proves the
	// message-search path specifically — the thread title (the word-boundary slug)
	// does NOT contain the needle, so the Threads group never matches it.
	const messageHits = chat.commandPaletteGroupOptions("Messages");
	await expect(messageHits).toHaveCount(1);
	const hit = messageHits.first();

	// Snippet coverage: this fragment lives inside the rendered snippet window
	// (Core keeps ±32 chars of context around the match, ADR-0035) and is far PAST
	// the slug cutoff — so it can ONLY come from the snippet span, not the title.
	// A snippet-render regression breaks this even if the title matches.
	await expect(hit).toContainText("especially the zylophant daycare schedule");

	// Title coverage: the thread title is the prompt's word-boundary slug (ADR-0048:
	// ≤ 32 scalars, last whole word), so this leading fragment comes from the title
	// span only — it sits OUTSIDE the snippet window (which starts at "…fore next
	// week"), proving both the snippet and the title render on the hit.
	await expect(hit).toContainText("Reminder to myself: I really");

	// The Threads group must NOT have surfaced this query (proves it's the body
	// match, not the title, driving the hit).
	await expect(chat.commandPaletteGroupOptions("Threads")).toHaveCount(0);

	// Activate the hit: palette closes and the app lands on the source thread,
	// whose user message (with the coined token) is back in the transcript.
	await hit.click();
	await expect(chat.commandPalette()).toBeHidden();
	await expect(
		chat.userBubbles().filter({ hasText: "zylophant daycare schedule" }),
	).toHaveCount(1);
});
