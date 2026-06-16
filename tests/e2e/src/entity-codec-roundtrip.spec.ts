import { expect, test } from "./fixtures.js";
import { dbPathFor, seedEntities, sqliteScalar } from "./seed.js";

/**
 * The per-Entity-Type codec's load-bearing asymmetry, proven end-to-end through
 * the real editor → `entity/mutate` → Core → re-read loop (no Worker/LLM). The
 * editors and `useLibraryItems` now route through one codec
 * (`apps/web/src/lib/entityCodec.ts`), so a single place owns each kind's wire
 * shape. `library-crud.spec.ts` proves the happy CRUD path per kind; THIS spec
 * pins the two semantics a naive "one builder for all kinds" consolidation would
 * silently flatten — the exact regressions the codec exists to prevent:
 *
 *  1. `update_todo` is a DIFF/merge with sentinel-null clears (ADR-0033): clearing
 *     ONE field must send `{that_field: null}` and leave every OTHER stored field
 *     intact. A full-replace builder would wipe the untouched fields.
 *  2. `update_project` is a full-document REPLACE that must replay the VERBATIM
 *     stored data (ADR-0033/slice-7): editing a rendered field must not drop a
 *     server-managed field the form never shows (`review_every`).
 *
 * Both assert DB ground truth, so a codec regression can't pass.
 */

test("update_todo clears one field via sentinel-null and preserves the rest (codec diff/merge)", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	const TODO = "01900000-0000-7000-8000-0000000c0de1";
	// A Todo carrying a note, a project link, and a due date. The editor will
	// clear ONLY the due date; the codec must emit update_todo {todo:{due_at:null}}
	// — a merge that leaves note + project_id untouched on the stored row.
	const PROJECT = "01900000-0000-7000-8000-0000000c0de0";
	seedEntities(dbPath, [
		{
			id: PROJECT,
			type: "project",
			data: { name: "Q3 planning", status: "active" },
		},
		{
			id: TODO,
			type: "todo",
			data: {
				title: "Send the agenda",
				status: "active",
				note: "Include the budget section",
				project_id: PROJECT,
				due_at: "2026-07-15T00:00:00",
			},
		},
	]);

	await page.goto(`${core.url}/library/todos?id=${TODO}`);
	const detail = page.getByRole("complementary", {
		name: /Send the agenda details/i,
	});
	await expect(detail).toBeVisible({ timeout: 15_000 });

	await detail.getByRole("button", { name: /edit todo/i }).click();
	const due = detail.getByLabel("Due");
	await expect(due).toHaveValue("2026-07-15");
	await due.fill(""); // clear ONLY the due date
	await detail.getByRole("button", { name: /^save$/i }).click();

	// Live re-read closes the editor back to the detail view (save resolved).
	await expect(detail.getByRole("button", { name: /edit todo/i })).toBeVisible({
		timeout: 15_000,
	});

	// DB ground truth: due_at is gone (sentinel-null clear stripped by apply),
	// but the merge left note + project_id + title intact — NOT a full replace.
	expect(
		sqliteScalar(
			dbPath,
			`SELECT coalesce(json_extract(data,'$.due_at'),'NULL') FROM entities WHERE id='${TODO}';`,
		),
	).toBe("NULL");
	expect(
		sqliteScalar(
			dbPath,
			`SELECT json_extract(data,'$.note') FROM entities WHERE id='${TODO}';`,
		),
	).toBe("Include the budget section");
	expect(
		sqliteScalar(
			dbPath,
			`SELECT json_extract(data,'$.project_id') FROM entities WHERE id='${TODO}';`,
		),
	).toBe(PROJECT);
	expect(
		sqliteScalar(
			dbPath,
			`SELECT json_extract(data,'$.title') FROM entities WHERE id='${TODO}';`,
		),
	).toBe("Send the agenda");
});

test("update_project replays verbatim stored data so a server-managed field survives an edit (codec full-replace)", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	const PROJECT = "01900000-0000-7000-8000-0000000c0de2";
	// A Project whose stored data carries `review_every` — a field the editor form
	// never renders. update_project is a FULL REPLACE, so editing the name must
	// replay the verbatim stored data (the codec's parseProject carries it; build
	// overlays the edit) or `review_every` would be silently dropped.
	seedEntities(dbPath, [
		{
			id: PROJECT,
			type: "project",
			data: {
				name: "Migrate billing",
				status: "active",
				outcome: "All invoices on the new system",
				review_every: { interval: 2, unit: "week" },
				next_review_at: "2026-07-01T00:00:00",
			},
		},
	]);

	await page.goto(`${core.url}/library/projects?id=${PROJECT}`);
	const detail = page.getByRole("complementary", {
		name: /Migrate billing details/i,
	});
	await expect(detail).toBeVisible({ timeout: 15_000 });

	await detail.getByRole("button", { name: /edit project/i }).click();
	const name = detail.getByLabel("Name");
	await expect(name).toHaveValue("Migrate billing");
	await name.fill("Migrate billing to Stripe");
	await detail.getByRole("button", { name: /^save$/i }).click();

	// Live re-read shows the new name (save resolved + Library re-read).
	await expect(
		page
			.getByRole("region", { name: /projects/i })
			.getByText("Migrate billing to Stripe"),
	).toBeVisible({ timeout: 15_000 });

	// The edited field changed…
	expect(
		sqliteScalar(
			dbPath,
			`SELECT json_extract(data,'$.name') FROM entities WHERE id='${PROJECT}';`,
		),
	).toBe("Migrate billing to Stripe");
	// …and the un-rendered server-managed fields SURVIVED the full-replace because
	// the codec replayed the verbatim stored data (would be NULL on a naive replace).
	expect(
		sqliteScalar(
			dbPath,
			`SELECT json_extract(data,'$.review_every.interval') FROM entities WHERE id='${PROJECT}';`,
		),
	).toBe("2");
	expect(
		sqliteScalar(
			dbPath,
			`SELECT json_extract(data,'$.review_every.unit') FROM entities WHERE id='${PROJECT}';`,
		),
	).toBe("week");
	expect(
		sqliteScalar(
			dbPath,
			`SELECT json_extract(data,'$.next_review_at') FROM entities WHERE id='${PROJECT}';`,
		),
	).toBe("2026-07-01T00:00:00");
});
