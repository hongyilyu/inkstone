import { expect, test } from "./fixtures.js";
import { dbPathFor, seedEntities, sqliteScalar } from "./seed.js";

/**
 * Full-system Project Review "Mark reviewed" (ADR-0034): the user-path
 * `entity/mutate` with `mark_project_reviewed`. Core reads the Project, stamps
 * `last_reviewed_at`, advances `next_review_at` to the next Sunday anchor, and
 * seeds the weekly cadence — no Worker/LLM in the loop. Drives the real Review
 * view in the browser and asserts the DB ground truth so an apply regression
 * can't pass.
 *
 * Determinism: no Run is started, so the gate-fixture Worker is never spawned.
 */

const PROJECT_DUE = "01900000-0000-7000-8000-000000020001";

test("mark a due project reviewed → it leaves Review and Core advances next_review_at", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	seedEntities(dbPath, [
		{
			id: PROJECT_DUE,
			type: "project",
			// A long-past anchor with no cadence: unambiguously due, and exercises
			// the absent-`review_every` weekly default (grill Q4b/Q5).
			data: {
				name: "Quarterly planning",
				status: "active",
				next_review_at: "2000-01-01T20:00:00",
			},
		},
	]);

	await page.goto(`${core.url}/library/review`);
	const review = page.getByRole("region", { name: /review/i });
	await expect(review.getByText("Quarterly planning")).toBeVisible({
		timeout: 15_000,
	});

	await review.getByRole("button", { name: /mark reviewed/i }).click();

	// The project drops off the due list (its next_review_at jumped to the future).
	await expect(review.getByText("Quarterly planning")).toHaveCount(0, {
		timeout: 15_000,
	});
	await expect(review.getByText("All caught up")).toBeVisible({
		timeout: 15_000,
	});

	// DB ground truth: review was stamped and the next date advanced to a future
	// Sunday 20:00 anchor; the absent cadence materialized as weekly.
	expect(
		sqliteScalar(
			dbPath,
			`SELECT json_extract(data,'$.last_reviewed_at') IS NOT NULL FROM entities WHERE id='${PROJECT_DUE}';`,
		),
	).toBe("1");
	expect(
		sqliteScalar(
			dbPath,
			`SELECT json_extract(data,'$.next_review_at') > '2000-01-01T20:00:00' FROM entities WHERE id='${PROJECT_DUE}';`,
		),
	).toBe("1");
	expect(
		sqliteScalar(
			dbPath,
			`SELECT json_extract(data,'$.next_review_at') LIKE '%T20:00:00' FROM entities WHERE id='${PROJECT_DUE}';`,
		),
	).toBe("1");
	expect(
		sqliteScalar(
			dbPath,
			`SELECT json_extract(data,'$.review_every.unit') FROM entities WHERE id='${PROJECT_DUE}';`,
		),
	).toBe("week");

	// The review write appended a revision (the seed inserts no revision row, so
	// this is the first), proving a real tier-2 mutation, not just an optimistic UI.
	expect(
		sqliteScalar(
			dbPath,
			`SELECT count(*) FROM entity_revisions WHERE entity_id='${PROJECT_DUE}';`,
		),
	).toBe("1");
});
