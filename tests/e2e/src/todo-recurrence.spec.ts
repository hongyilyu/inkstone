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

	await page.goto(`${core.url}/library/todos`);
	await page.getByRole("button", { name: /new todo/i }).click();

	const rail = page.getByRole("complementary", { name: /new todo/i });
	await expect(rail).toBeVisible({ timeout: 15_000 });

	await rail.getByLabel("Title").fill("Submit the weekly report");
	// A due date is REQUIRED: the editor defaults the recurrence anchor to due_at
	// when a due date is set, and Core rejects a rule whose anchor date is absent.
	await rail.getByLabel("Due").fill("2026-12-31");

	await rail.getByLabel("Repeats").check();
	await rail.getByLabel("Every").fill("2");
	await rail.getByLabel("Unit").selectOption({ label: "Weeks" });
	// Schedule and Anchor keep their defaults (Regular / Due date). Toggling
	// Repeats with a due date present defaults the anchor to "Due date".
	await expect(rail.getByLabel("Schedule")).toHaveValue("regular");
	await expect(rail.getByLabel("Anchor")).toHaveValue("due_at");

	await rail.getByRole("button", { name: /^save$/i }).click();

	// The new Todo lands in the live collection (live rows replace the mock preview).
	const collection = page.getByRole("region", { name: /todos/i });
	await expect(collection.getByText("Submit the weekly report")).toBeVisible({
		timeout: 15_000,
	});

	// On a successful create the rail re-navigates to the new Todo's detail panel,
	// whose recurrence badge reads the rule re-fetched from Core (ADR-0037 summary:
	// interval 2 / unit week / regular → "Repeats every 2 weeks").
	const detail = page.getByRole("complementary", {
		name: /Submit the weekly report details/i,
	});
	await expect(detail).toBeVisible({ timeout: 15_000 });
	await expect(detail.getByText(/repeats every 2 weeks/i)).toBeVisible({
		timeout: 15_000,
	});

	// DB ground truth: the persisted Todo's data carries the recurrence rule —
	// proves the round-trip reached tier 2, not just the client cache.
	expect(
		sqliteScalar(
			dbPath,
			`SELECT json_extract(data,'$.recurrence.unit') FROM entities WHERE type='todo' AND json_extract(data,'$.title')='Submit the weekly report';`,
		),
	).toBe("week");
	expect(
		sqliteScalar(
			dbPath,
			`SELECT json_extract(data,'$.recurrence.interval') FROM entities WHERE type='todo' AND json_extract(data,'$.title')='Submit the weekly report';`,
		),
	).toBe("2");
	expect(
		sqliteScalar(
			dbPath,
			`SELECT json_extract(data,'$.recurrence.schedule') FROM entities WHERE type='todo' AND json_extract(data,'$.title')='Submit the weekly report';`,
		),
	).toBe("regular");
	expect(
		sqliteScalar(
			dbPath,
			`SELECT json_extract(data,'$.recurrence.anchor') FROM entities WHERE type='todo' AND json_extract(data,'$.title')='Submit the weekly report';`,
		),
	).toBe("due_at");
});
