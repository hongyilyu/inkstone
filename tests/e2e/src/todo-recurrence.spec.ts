import { expect, test } from "./fixtures.js";
import { dbPathFor, sqliteScalar } from "./seed.js";

/**
 * Full-system Todo recurrence (ADR-0037): the user creates a Todo with a repeat
 * rule in the Library rail editor and the saved Todo's detail panel shows the
 * cadence after a round-trip through Core. The strong assertion reads the DB
 * ground truth — `data.recurrence` reached tier 2 — so a client-only persist or
 * an `entity/mutate` validation regression can't pass.
 *
 * Determinism: no Run is started, so the default gate-fixture Worker is never
 * spawned — this is a pure Core write via `entity/mutate` (mirrors library-crud).
 */

test("create a recurring Todo via the rail editor → recurrence persists and the detail shows it", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	// Unique per-test title so the DB ground-truth filters can't collide with a
	// preseeded or parallel-worker row carrying the same title.
	const title = `Submit the weekly report ${test.info().testId}`;

	await page.goto(`${core.url}/library/todos`);
	await page.getByRole("button", { name: /new todo/i }).click();

	const rail = page.getByRole("complementary", { name: /new todo/i });
	await expect(rail).toBeVisible({ timeout: 15_000 });

	await rail.getByLabel("Title").fill(title);
	// A due date is REQUIRED: the editor defaults the recurrence anchor to due_at
	// when a due date is set, and Core rejects a rule whose anchor date is absent.
	await rail.getByLabel("Due").fill("2026-12-31");

	await rail.getByLabel("Repeats").check();
	await rail.getByLabel("Every").fill("2");
	await rail.getByLabel("Unit").selectOption({ label: "Weeks" });
	// "Repeat from" keeps its default (Due date). Toggling Repeats with a due
	// date present defaults the anchor to "Due date".
	await expect(rail.getByLabel("Repeat from")).toHaveValue("due_at");

	await rail.getByRole("button", { name: /^save$/i }).click();

	// The new Todo lands in the live collection (live rows replace the mock preview).
	const collection = page.getByRole("region", { name: /todos/i });
	await expect(collection.getByText(title)).toBeVisible({
		timeout: 15_000,
	});

	// On a successful create the rail re-navigates to the new Todo's detail panel,
	// whose recurrence badge reads the rule re-fetched from Core (ADR-0037 summary:
	// interval 2 / unit week → "Repeats every 2 weeks").
	const detail = page.getByRole("complementary", {
		name: `${title} details`,
	});
	await expect(detail).toBeVisible({ timeout: 15_000 });
	await expect(detail.getByText(/repeats every 2 weeks/i)).toBeVisible({
		timeout: 15_000,
	});

	// DB ground truth: the persisted Todo's data carries the recurrence rule —
	// proves the round-trip reached tier 2, not just the client cache. Filtering
	// on the unique title pins the assertion to this test's row.
	const recurrenceField = (field: string) =>
		sqliteScalar(
			dbPath,
			`SELECT json_extract(data,'$.recurrence.${field}') FROM entities WHERE type='todo' AND json_extract(data,'$.title')='${title}';`,
		);
	expect(recurrenceField("unit")).toBe("week");
	expect(recurrenceField("interval")).toBe("2");
	expect(recurrenceField("anchor")).toBe("due_at");
});

/**
 * End condition + next-occurrence preview (ADR-0039 amendment, #227): the rail
 * editor can bound a repeat with an `until` date, the preview block shows Core's
 * computed next-occurrence date for the bounded series, and the saved rule's
 * `end.until` reaches the DB. Pure Core write + read — no Run, no Worker.
 */
test("set a repeat End=On date → preview shows the next occurrence and `until` persists", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	const title = `Weekly check-in ${test.info().testId}`;

	await page.goto(`${core.url}/library/todos`);
	await page.getByRole("button", { name: /new todo/i }).click();

	const rail = page.getByRole("complementary", { name: /new todo/i });
	await expect(rail).toBeVisible({ timeout: 15_000 });

	await rail.getByLabel("Title").fill(title);
	await rail.getByLabel("Defer until").fill("2026-07-01");
	await rail.getByLabel("Repeats").check();
	await rail.getByLabel("Every").fill("1");
	await rail.getByLabel("Unit").selectOption({ label: "Weeks" });
	// Repeat-from defaults to Defer date (no due date set).
	await expect(rail.getByLabel("Repeat from")).toHaveValue("defer_at");

	// Bound the series with an end date well past the next occurrence.
	await rail.getByLabel("End").selectOption("until");
	await rail.getByLabel("End date").fill("2026-12-31");

	// The preview block names itself and shows Core's computed next defer date
	// (one week after 2026-07-01 → 2026-07-08, formatted "Jul 8, 2026").
	await expect(rail.getByText(/dates for next occurrence/i)).toBeVisible({
		timeout: 15_000,
	});
	await expect(rail.getByText(/Jul 8, 2026/i)).toBeVisible({
		timeout: 15_000,
	});

	await rail.getByRole("button", { name: /^save$/i }).click();

	const collection = page.getByRole("region", { name: /todos/i });
	await expect(collection.getByText(title)).toBeVisible({ timeout: 15_000 });

	// Detail summary surfaces the bound (ADR-0037 summary: "... until 2026-12-31").
	const detail = page.getByRole("complementary", { name: `${title} details` });
	await expect(detail).toBeVisible({ timeout: 15_000 });
	await expect(detail.getByText(/until 2026-12-31/i)).toBeVisible({
		timeout: 15_000,
	});

	// DB ground truth: end.until reached tier 2 at day granularity.
	const until = sqliteScalar(
		dbPath,
		`SELECT json_extract(data,'$.recurrence.end.until') FROM entities WHERE type='todo' AND json_extract(data,'$.title')='${title}';`,
	);
	expect(until).toBe("2026-12-31T00:00:00");
});
