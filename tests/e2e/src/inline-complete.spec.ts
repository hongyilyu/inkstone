import { expect, test } from "./fixtures.js";
import { dbPathFor, seedEntities, sqliteScalar } from "./seed.js";

/**
 * Full-system inline-complete (slice 1): completing an active Todo from a live
 * list via its inline status circle (the shared TodoRow CompleteCircle) fires a
 * real `update_todo` write that Core persists — the row leaves the active list.
 * Uses the Inbox surface, the most deterministic active-todo list: an
 * unorganized active todo (no project_id, no person_refs) derives into Inbox.
 *
 * Determinism: no Run is started, so the gate-fixture Worker is never spawned.
 * The seeded row is `created_by='user'` exactly as a direct user CRUD write lands.
 */

const TODO = "01900000-0000-7000-8000-0000000000d1";
const TODO_DEFER = "01900000-0000-7000-8000-0000000000d2";

/** Expected `defer_at` for "Tomorrow": local wall-clock today+1 at midnight.
 * Mirrors the app's `dayToLocal(addDays(1))` (= the day part of
 * `localNowString(addDays(1))` + `T00:00:00`). Computed locally so the e2e never
 * imports app code. There's a vanishing risk the day rolls over between this
 * call and the app's; ~1s test, ignored (the other specs don't guard it either). */
function expectedTomorrow(): string {
	const d = new Date();
	d.setDate(d.getDate() + 1);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T00:00:00`;
}

test("complete an active Inbox todo inline → Core persists update_todo and the row leaves the list", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	seedEntities(dbPath, [
		{
			id: TODO,
			type: "todo",
			data: { title: "Mail the contract", status: "active" },
		},
	]);

	await page.goto(`${core.url}/library/inbox`);
	const inbox = page.getByRole("region", { name: /inbox/i });
	await expect(inbox.getByText("Mail the contract")).toBeVisible({
		timeout: 15_000,
	});

	// Click the inline complete circle (update_todo via the shared TodoRow).
	await inbox.getByRole("button", { name: /mark todo complete/i }).click();

	// DB ground truth: the real write, not just the optimistic UI flip.
	await expect
		.poll(() =>
			sqliteScalar(
				dbPath,
				`SELECT json_extract(data,'$.status') FROM entities WHERE id='${TODO}';`,
			),
		)
		.toBe("completed");
	expect(
		sqliteScalar(
			dbPath,
			`SELECT json_extract(data,'$.completed_at') IS NOT NULL FROM entities WHERE id='${TODO}';`,
		),
	).toBe("1");

	// Inbox derives from active todos; once status=completed the row drops out.
	await expect(inbox.getByText("Mail the contract")).toHaveCount(0, {
		timeout: 15_000,
	});
});

test("quick-defer an active Inbox todo to Tomorrow → Core persists defer_at = (today+1)T00:00:00", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	seedEntities(dbPath, [
		{
			id: TODO_DEFER,
			type: "todo",
			data: { title: "Renew the lease", status: "active" },
		},
	]);

	await page.goto(`${core.url}/library/inbox`);
	const inbox = page.getByRole("region", { name: /inbox/i });
	await expect(inbox.getByText("Renew the lease")).toBeVisible({
		timeout: 15_000,
	});

	// Open the quick-defer menu on the row (Base UI Popover) and choose Tomorrow.
	// The menu renders in a Popover Portal that may sit OUTSIDE the inbox region,
	// so locate the item on `page`, not `inbox`.
	await inbox.getByRole("button", { name: /defer todo/i }).click();
	await page.getByRole("button", { name: /^tomorrow$/i }).click();

	// DB ground truth (load-bearing): the real `update_todo` write restamps
	// `defer_at` to tomorrow@midnight, the exact value the app computes via
	// `dayToLocal(addDays(1))` → `<today+1>T00:00:00`.
	await expect
		.poll(() =>
			sqliteScalar(
				dbPath,
				`SELECT json_extract(data,'$.defer_at') FROM entities WHERE id='${TODO_DEFER}';`,
			),
		)
		.toBe(expectedTomorrow());

	// Inbox derivation (`inboxTodos`, ADR-0031) is availability-blind: a `defer_at`
	// does NOT remove an active, unorganized todo from Inbox — only project/due/
	// person-ref do (see libraryItems.test.ts "keeps a todo that only has a defer
	// date (still inbox)"). So the row stays; we assert it persists rather than the
	// false "leaves the list". Reload to prove the deferred row hydrates back in.
	await page.reload();
	await expect(inbox.getByText("Renew the lease")).toBeVisible({
		timeout: 15_000,
	});

	// Visible feedback (the point of quick-defer): the deferred row now shows the
	// shared "Available <day>" chip (DeferChip, #232) carrying the YYYY-MM-DD day
	// slice — the exact tomorrow the write persisted.
	await expect(
		inbox.getByText(`Available ${expectedTomorrow().slice(0, 10)}`),
	).toBeVisible({ timeout: 15_000 });
});
