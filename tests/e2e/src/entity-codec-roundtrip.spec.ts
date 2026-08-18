import { expect, test } from "./fixtures.js";
import { dbPathFor, seedEntities, sqliteScalar } from "./seed.js";

/**
 * The per-Entity-Type codec's full-replace contract, proven end-to-end through
 * the real editor → `entity/mutate` → Core → re-read loop (no Worker/LLM). The
 * editors and `useLibraryItems` route through one codec
 * (`apps/web/src/lib/entityCodec.ts`), so a single place owns each kind's wire
 * shape. `library-crud.spec.ts` proves the happy CRUD path per kind; THIS spec
 * pins the semantic a naive "one builder for all kinds" consolidation would
 * silently flatten — the exact regression the codec exists to prevent:
 *
 *  - `update_project` is a full-document REPLACE that must replay the VERBATIM
 *    stored data (ADR-0033/slice-7): editing a rendered field must not drop a
 *    server-managed field the form never shows (`review_every`).
 *
 * Asserts DB ground truth, so a codec regression can't pass.
 */

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
