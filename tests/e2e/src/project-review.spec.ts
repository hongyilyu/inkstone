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

	await page.goto(`${core.url}/library/gtd?filt=review`);
	const review = page.getByRole("region", { name: /review/i });
	await expect(review.getByText("Quarterly planning")).toBeVisible({
		timeout: 15_000,
	});

	await review.getByRole("button", { name: /mark reviewed/i }).click();

	// Session-snapshot model (ADR-0034 / grill Q12): the just-reviewed project
	// stays in the queue, with the action flipping to its done state, rather than
	// vanishing mid-session.
	await expect(review.getByRole("button", { name: /reviewed/i })).toBeDisabled({
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

	// On RE-ENTRY the snapshot re-derives: the project (now due in the future) is
	// gone and the queue is empty.
	await page.goto(`${core.url}/library/gtd?filt=inbox`);
	await page.goto(`${core.url}/library/gtd?filt=review`);
	await expect(review.getByText("All caught up")).toBeVisible({
		timeout: 15_000,
	});
	await expect(review.getByText("Quarterly planning")).toHaveCount(0);
});

const PROJECT_A = "01900000-0000-7000-8000-000000020010";
const PROJECT_B = "01900000-0000-7000-8000-000000020011";
const TODO_A1 = "01900000-0000-7000-8000-000000020012";

test("focused review queue steps between projects and completes a todo inline", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	seedEntities(dbPath, [
		{
			id: PROJECT_A,
			type: "project",
			data: {
				name: "Alpha rollout",
				status: "active",
				next_review_at: "2000-01-01T20:00:00",
				review_every: { interval: 1, unit: "week" },
				last_reviewed_at: "2026-05-01T20:00:00",
			},
		},
		{
			id: PROJECT_B,
			type: "project",
			data: {
				name: "Beta cleanup",
				status: "active",
				next_review_at: "2000-01-02T20:00:00",
			},
		},
		{
			id: TODO_A1,
			type: "todo",
			data: {
				title: "Ship the alpha",
				status: "active",
				project_id: PROJECT_A,
			},
		},
	]);

	await page.goto(`${core.url}/library/gtd?filt=review`);
	const review = page.getByRole("region", { name: /review/i });

	// First project focused, with its cadence, last-reviewed, counter, and its todo.
	await expect(review.getByText("Alpha rollout")).toBeVisible({
		timeout: 15_000,
	});
	await expect(review.getByText("Project 1 of 2")).toBeVisible();
	await expect(review.getByText("Every week")).toBeVisible();
	await expect(review.getByText("Ship the alpha")).toBeVisible();

	// Complete the todo inline via its status circle (update_todo).
	await review.getByRole("button", { name: /mark todo complete/i }).click();
	await expect
		.poll(() =>
			sqliteScalar(
				dbPath,
				`SELECT json_extract(data,'$.status') FROM entities WHERE id='${TODO_A1}';`,
			),
		)
		.toBe("completed");

	// Step to the next due project with the chevron.
	await review.getByRole("button", { name: /next project/i }).click();
	await expect(review.getByText("Beta cleanup")).toBeVisible();
	await expect(review.getByText("Project 2 of 2")).toBeVisible();

	// Mark it reviewed; Core stamps it...
	await review.getByRole("button", { name: /mark reviewed/i }).click();
	await expect
		.poll(() =>
			sqliteScalar(
				dbPath,
				`SELECT json_extract(data,'$.last_reviewed_at') IS NOT NULL FROM entities WHERE id='${PROJECT_B}';`,
			),
		)
		.toBe("1");

	// ...and the session snapshot keeps it in place: the action flips to its done
	// state, the project stays visible, and the counter holds at 2 of 2 (grill Q12).
	await expect(
		review.getByRole("button", { name: /reviewed/i }),
	).toBeDisabled();
	await expect(review.getByText("Beta cleanup")).toBeVisible();
	await expect(review.getByText("Project 2 of 2")).toBeVisible();
});
