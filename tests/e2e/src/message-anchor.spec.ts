import { expect, test } from "./fixtures.js";
import { dbPathFor, seedEntities, sqlite } from "./seed.js";

/**
 * Issue #184, end-to-end: a Library Entity that was captured from a chat message
 * deep-links back to the EXACT capturing message — not the thread bottom.
 *
 * This is the full wired proof of the whole anchor path, every hop a real seam:
 *   Core provenance read (`EntitySourceView.message_id`, slice 1) →
 *   web codec (`parseSource` surfaces `messageId`) →
 *   EntityDetail "Captured from" navigate with `?focusedMessageId` (slice 2 UI) →
 *   ChatColumn's existing scroll / lamplight-highlight / consume-then-strip
 *   machinery (already shipped for ⌘K message search, ADR-0042).
 * The unit/component suites cover each hop alone; only this spec proves the wire.
 *
 * We seed several user messages with the TARGET first and six more after it, in a
 * SHORT (600px) viewport so the transcript overflows and the target starts
 * decisively ABOVE the fold. A passing `toBeInViewport()` on the target can
 * therefore only be the scroll-to-message jump the anchor fires, never the
 * initial paint (which would land at the top/bottom, not on the early message).
 *
 * The Entity's `entity_sources` row points at the target message (`created_from`),
 * which is what makes it "captured from" that message; the seeded `threads.title`
 * is the visible label on the "Captured from" link we click.
 *
 * No reload-to-rehydrate dance (unlike scroll-to-message.spec.ts): we SEED the
 * messages directly, so the rendered rows carry their server message ids from the
 * first `thread/get` — the same ids the provenance read returns as `message_id`,
 * which ChatColumn matches as `[data-message-id="<seeded id>"]`.
 *
 * The anchorless fallback (a source carrying no message id → plain thread-open) is
 * NOT exercised here: a real thread source always resolves a capturing message id,
 * so seeding "no anchor" would be a contrived broken row. That branch is covered
 * by the EntityDetail unit suite (the `search: {}` case).
 */

// A short viewport forces the transcript to overflow so the early target is above
// the fold — the in-viewport assertion then can only be the scroll jump.
test.use({ viewport: { width: 1024, height: 600 } });

const THREAD_ID = "01900000-0000-7000-8000-000000000200";
const RUN_ID = "01900000-0000-7000-8000-000000000201";
const TODO_ID = "01900000-0000-7000-8000-000000000202";
const SOURCE_ID = "01900000-0000-7000-8000-000000000203";

const THREAD_TITLE = "Trip planning brain dump";
const TODO_TITLE = "Book the lighthouse tour";

// The capturing message — FIRST in the transcript, so six later messages push it
// off the fold once the thread renders. Its body is a distinctive phrase we locate
// with `chat.userBubble`.
const TARGET_PHRASE = "remember the zylophant ferry timetable for Friday";

// Six later messages, each long enough that the six together overflow the 600px
// viewport and bury the target above the fold.
const LATER_MESSAGES = [
	"Also I need to compare the coastal hotels and pick one with parking near the harbour.",
	"Then sort out the rental car insurance and the airport pickup window times.",
	"Confirm the dinner reservation for the second night somewhere with a sea view.",
	"Check whether the museum passes are cheaper bought as a bundle in advance.",
	"Pack the binoculars and the rain jackets in case the weather turns on us.",
	"That is everything I can think of for the trip planning for now, thanks.",
];

test("a Captured-from link deep-links to the exact capturing message, highlighted and in view", async ({
	chat,
	core,
	page,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	seedThreadEntityAndSource(dbPath);

	// Open the Library Todo's inspector. The detail panel is the complementary
	// region labelled "<title> details".
	await page.goto(`${core.url}/library/todos?id=${TODO_ID}`);
	const detail = page.getByRole("complementary", {
		name: new RegExp(`${TODO_TITLE} details`, "i"),
	});
	await expect(detail).toBeVisible({ timeout: 15_000 });

	// Activate the "Captured from" link — its visible label is the thread title.
	await page.getByRole("button", { name: new RegExp(THREAD_TITLE) }).click();

	// We land on the thread's route, anchored to the capturing message.
	await expect.poll(() => chat.pathname()).toMatch(/^\/thread\//);

	// The target is the exact message that was anchored — not just "some message in
	// the thread". It carries the lamplight ring (assert while it's up; it
	// self-clears after ~1.6s) and it was scrolled into view despite starting above
	// the fold, which can only be the anchor's scroll jump.
	const target = chat.userBubble(TARGET_PHRASE);
	await expect(target).toHaveCount(1, { timeout: 15_000 });
	await expect(target.locator("[data-highlighted]")).toHaveCount(1);
	await expect(target).toBeInViewport();

	// Consume-then-strip (ADR-0042): once consumed, the anchor is gone from the URL,
	// so a reload or Back can't re-fire the jump.
	await expect.poll(() => chat.search()).toBe("");
});

/**
 * Seed the Todo (via `seedEntities`), then in one tx: a titled thread, one
 * completed run, several user messages (the TARGET first, then six later ones), and
 * an `entity_sources` row tying the Todo to the TARGET message (`created_from`).
 * The cross-FK between `runs.user_message_id` and `messages.run_id` resolves at
 * COMMIT (both are DEFERRABLE INITIALLY DEFERRED), so the run can name a message
 * inserted after it.
 *
 * The provenance read resolves the thread + capturing message id by joining
 * `entity_sources.source_message_id` → `messages.id` → `threads.title`
 * (crates/core/src/db/queries.rs `provenance_for_entities`), and surfaces
 * `message_id = source_message.id` — the same server id the rendered row carries.
 */
function seedThreadEntityAndSource(dbPath: string): void {
	const base = Date.now();
	const bodies = [TARGET_PHRASE, ...LATER_MESSAGES];
	const messageId = (i: number) =>
		`01900000-0000-7000-8000-0000000003${String(i).padStart(2, "0")}`;
	const targetMessageId = messageId(0);

	// The captured Entity itself must exist BEFORE the `entity_sources` row that
	// references it (`entity_sources.entity_id` is a non-deferrable FK to
	// `entities`). It is a plain user-write Todo — its origin is the
	// `entity_sources` row below, not a proposal id.
	seedEntities(dbPath, [
		{ id: TODO_ID, type: "todo", data: { title: TODO_TITLE } },
	]);

	const messageStmts = bodies
		.map((body, i) => {
			// Strictly increasing created_at keeps the chronological order stable, so
			// the TARGET (i=0) renders first and stays above the fold.
			const at = base + i;
			const id = messageId(i);
			return `
			INSERT INTO messages (id, thread_id, run_id, role, status, created_at, updated_at)
			VALUES ('${id}', '${THREAD_ID}', '${RUN_ID}', 'user', 'completed', ${at}, ${at});
			INSERT INTO message_parts (message_id, seq, type, text)
			VALUES ('${id}', 0, 'text', ${sqlText(body)});`;
		})
		.join("\n");

	sqlite(
		dbPath,
		`
		BEGIN IMMEDIATE;
		INSERT INTO threads (id, title, created_at, last_activity_at)
		VALUES ('${THREAD_ID}', ${sqlText(THREAD_TITLE)}, ${base}, ${base});
		INSERT INTO runs
			(id, thread_id, workflow_name, workflow_version, provider, model, thinking_level, user_message_id, status, started_at, ended_at, terminal_reason)
		VALUES
			('${RUN_ID}', '${THREAD_ID}', 'default', '1.0.0', 'faux', 'fake-model', 'off', '${targetMessageId}', 'completed', ${base}, ${base}, 'completed');
		${messageStmts}
		INSERT INTO entity_sources (id, entity_id, source_message_id, relation, created_at)
		VALUES ('${SOURCE_ID}', '${TODO_ID}', '${targetMessageId}', 'created_from', ${base});
		COMMIT;
		`,
	);
}

function sqlText(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}
