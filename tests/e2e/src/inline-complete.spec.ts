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

test("complete an active Inbox todo inline → Core persists update_todo and the row leaves the list", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	seedEntities(dbPath, [
		{ id: TODO, type: "todo", data: { title: "Mail the contract", status: "active" } },
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
