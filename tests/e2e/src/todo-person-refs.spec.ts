import { expect, test } from "./fixtures.js";
import { dbPathFor, seedEntities, sqliteScalar } from "./seed.js";

/**
 * Full-system Todo Person Reference (CONTEXT.md "Todo Person Reference" + "Inbox"):
 * the user adds a `related` Person to a Todo through the rail editor's multi-row
 * People picker, and (a) the ref round-trips through Core onto the Todo detail and
 * (b) the Todo drops out of Inbox (active + no project + no due + no person ref →
 * adding a person ref leaves Inbox). The create-then-edit shape gives a before/after
 * Inbox proof: the title-only Todo IS in Inbox; after linking a Person it is NOT.
 *
 * The DB ground-truth backstop reads `todo_person_refs` via `sqliteScalar` (mirrors
 * todo-recurrence): a `role='related'` row keyed to the seeded Person must exist, so
 * a client-only persist (no tier-2 write) cannot pass.
 *
 * Determinism: no Run is started, so the default gate-fixture Worker is never
 * spawned — this is a pure Core write via `entity/mutate` (mirrors library-crud /
 * todo-recurrence). Unique per-test names keep parallel workers from colliding.
 */

test("add a related person to a Todo via the rail editor → persists and the Todo leaves Inbox", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	const testId = test.info().testId;
	// Unique per-test names so the DB ground-truth filters and the picker option
	// can't collide with a preseeded or parallel-worker row of the same name.
	const personName = `Dana ${testId}`;
	const personId = "01900000-0000-7000-8000-0000000000d1";
	const title = `Draft the launch note ${testId}`;

	// A Person must exist before it can be offered in the row picker.
	seedEntities(dbPath, [
		{ id: personId, type: "person", data: { name: personName } },
	]);

	// ── Create a title-only Todo (→ it lands in Inbox) ──────────────────────────
	await page.goto(`${core.url}/library/todos`);
	await page.getByRole("button", { name: /new todo/i }).click();

	const createRail = page.getByRole("complementary", { name: /new todo/i });
	await expect(createRail).toBeVisible({ timeout: 15_000 });
	await createRail.getByLabel("Title").fill(title);
	await createRail.getByRole("button", { name: /^save$/i }).click();

	// The new Todo lands in the live collection (live rows replace the mock preview).
	const collection = page.getByRole("region", { name: /todos/i });
	await expect(collection.getByText(title)).toBeVisible({ timeout: 15_000 });

	// Before: a title-only active Todo with no person ref is in Inbox.
	await page.goto(`${core.url}/library/gtd?filt=inbox`);
	const inboxBefore = page.getByRole("region", { name: /inbox/i });
	await expect(inboxBefore.getByText(title)).toBeVisible({ timeout: 15_000 });

	// ── Edit it: add a related Person row, Save ─────────────────────────────────
	const todoId = sqliteScalar(
		dbPath,
		`SELECT id FROM entities WHERE type='todo' AND json_extract(data,'$.title')='${title}';`,
	);
	await page.goto(`${core.url}/library/todos?id=${todoId}`);
	const detail = page.getByRole("complementary", {
		name: `${title} details`,
	});
	await expect(detail).toBeVisible({ timeout: 15_000 });
	await detail.getByRole("button", { name: /edit todo/i }).click();

	// Add exactly one person row, then scope to it. A new row defaults role =
	// "Related"; the `.last()` selector pins to the single row we just added.
	// `exact` keeps the "Person"/"Role" selects from also matching the row's
	// "Remove person row N" button (its accessible name contains "person").
	await detail.getByRole("button", { name: /add person/i }).click();
	await detail
		.getByLabel("Person", { exact: true })
		.last()
		.selectOption({ label: personName });
	await expect(detail.getByLabel("Role", { exact: true }).last()).toHaveValue(
		"related",
	);

	await detail.getByRole("button", { name: /^save$/i }).click();

	// ── Assert (through Core / UI-observable first) ─────────────────────────────
	// (a) The detail panel, re-rendered from Core's row, shows the linked Person
	// with its "Related" role chip — proves the ref round-tripped to tier 2 and back.
	await expect(
		detail.getByRole("button", { name: new RegExp(`${personName} Related`) }),
	).toBeVisible({ timeout: 15_000 });

	// (b) The Todo is no longer in Inbox: adding a person ref left Inbox.
	await page.goto(`${core.url}/library/gtd?filt=inbox`);
	const inboxAfter = page.getByRole("region", { name: /inbox/i });
	await expect(inboxAfter.getByText(title)).toHaveCount(0, { timeout: 15_000 });

	// (c) DB ground truth: a `todo_person_refs` row for this Todo carries the
	// related Person — proves the round-trip reached tier 2, not just the cache.
	const refRole = sqliteScalar(
		dbPath,
		`SELECT role FROM todo_person_refs WHERE todo_id='${todoId}' AND person_id='${personId}';`,
	);
	expect(refRole).toBe("related");
});
