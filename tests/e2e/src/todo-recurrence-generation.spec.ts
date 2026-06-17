import { expect, test } from "./fixtures.js";
import { dbPathFor, seedEntities, sqliteScalar } from "./seed.js";

/**
 * Full-system recurrence occurrence generation (ADR-0039): completing a recurring
 * Todo in the Library rail spawns its next occurrence in the SAME Core write tx.
 * The user marks a seeded weekly Todo "Completed"; Core advances the due date one
 * week and lands a fresh active successor, carrying the project and rule forward,
 * while the original stays completed.
 *
 * The strong assertions read the DB ground truth — the successor row, its
 * advanced due_at, and its carried project_id — so a client-only effect or an
 * apply-path regression can't pass. Determinism: no Run is started (pure Core
 * `entity/mutate` completion), so the gate-fixture Worker is never spawned.
 */

const PROJECT = "01900000-0000-7000-8000-0000000000a1";
const TODO = "01900000-0000-7000-8000-0000000000a2";

test("completing a recurring Todo spawns its next occurrence", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	seedEntities(dbPath, [
		{
			id: PROJECT,
			type: "project",
			data: { name: "Operations", status: "active" },
		},
		{
			id: TODO,
			type: "todo",
			data: {
				title: "Submit the weekly status report",
				status: "active",
				due_at: "2026-06-19T17:00:00",
				project_id: PROJECT,
				recurrence: { interval: 1, unit: "week", anchor: "due_at" },
			},
		},
	]);

	await page.goto(`${core.url}/library/todos?id=${TODO}`);
	const detail = page.getByRole("complementary", {
		name: /Submit the weekly status report details/i,
	});
	await expect(detail).toBeVisible({ timeout: 15_000 });

	// Complete it through the editor's Status select.
	await detail.getByRole("button", { name: /edit todo/i }).click();
	await detail.getByLabel("Status").selectOption({ label: "Completed" });
	await detail.getByRole("button", { name: /^save$/i }).click();

	// The successor lands in the live collection: two rows now carry the title
	// (the completed original + the fresh active occurrence).
	const collection = page.getByRole("region", { name: /todos/i });
	await expect(
		collection.getByText("Submit the weekly status report"),
	).toHaveCount(2, { timeout: 15_000 });

	// DB ground truth: the original stays completed…
	expect(
		sqliteScalar(
			dbPath,
			`SELECT json_extract(data,'$.status') FROM entities WHERE id='${TODO}';`,
		),
	).toBe("completed");

	// …and exactly one OTHER todo exists — the successor — active, due one week
	// later, with the project and rule carried forward.
	expect(
		sqliteScalar(
			dbPath,
			`SELECT count(*) FROM entities WHERE type='todo' AND id != '${TODO}';`,
		),
	).toBe("1");
	const successor = (field: string) =>
		sqliteScalar(
			dbPath,
			`SELECT json_extract(data,'${field}') FROM entities WHERE type='todo' AND id != '${TODO}';`,
		);
	expect(successor("$.status")).toBe("active");
	expect(successor("$.due_at")).toBe("2026-06-26T17:00:00");
	expect(successor("$.project_id")).toBe(PROJECT);
	expect(successor("$.recurrence.interval")).toBe("1");
	expect(successor("$.recurrence.unit")).toBe("week");
	expect(successor("$.completed_at")).toBe("");
});
