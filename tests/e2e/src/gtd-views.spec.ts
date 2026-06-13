import { expect, test } from "./fixtures.js";
import { dbPathFor, seedEntities } from "./seed.js";

/**
 * Full-system GTD V1 read surfaces (ADR-0031/0032): seed Todos, People, a
 * Project, and todo_person_refs directly into the per-test Workspace DB, then
 * drive the real Library through Core's `entity/list` to assert the derived
 * Inbox / Waiting / Review views and the Todo detail projection — including the
 * person_refs that ride on the Todo rows (the slice-3 contract change).
 */

const PERSON_ALICE = "01900000-0000-7000-8000-0000000000a1";
const PERSON_BOB = "01900000-0000-7000-8000-0000000000a2";
const PROJECT_MIGRATION = "01900000-0000-7000-8000-0000000000b1";
const TODO_INBOX = "01900000-0000-7000-8000-0000000000c1";
const TODO_WAITING = "01900000-0000-7000-8000-0000000000c2";
const TODO_IN_PROJECT = "01900000-0000-7000-8000-0000000000c3";
const TODO_DONE = "01900000-0000-7000-8000-0000000000c4";

test("GTD views derive Inbox, Waiting, Review and Todo detail from live data", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	seedGtdWorkspace(dbPath);

	// ── Inbox: the unorganized errand only ──────────────────────────────────
	await page.goto(`${core.url}/library/inbox`);
	const inbox = page.getByRole("region", { name: /inbox/i });
	await expect(inbox.getByText("Buy stamps")).toBeVisible({ timeout: 15_000 });
	// Organized todos must not leak into Inbox.
	await expect(inbox.getByText("Wait for Alice's draft")).toHaveCount(0);
	await expect(inbox.getByText("Cut over the API")).toHaveCount(0);

	// ── Waiting: only the waiting_on todo ───────────────────────────────────
	await page.goto(`${core.url}/library/waiting`);
	const waiting = page.getByRole("region", { name: /waiting/i });
	await expect(waiting.getByText("Wait for Alice's draft")).toBeVisible({
		timeout: 15_000,
	});
	// A related-only ref (Bob on the project todo) must not appear here.
	await expect(waiting.getByText("Cut over the API")).toHaveCount(0);
	await expect(waiting.getByText("Buy stamps")).toHaveCount(0);

	// ── Review: the overdue active project ──────────────────────────────────
	await page.goto(`${core.url}/library/review`);
	const review = page.getByRole("region", { name: /review/i });
	await expect(review.getByText("API migration")).toBeVisible({
		timeout: 15_000,
	});

	// ── Todo detail: linked person with role + owning project ───────────────
	await page.goto(`${core.url}/library/todos?id=${TODO_WAITING}`);
	const detail = page.getByRole("complementary", {
		name: /Wait for Alice's draft details/i,
	});
	await expect(detail).toBeVisible({ timeout: 15_000 });
	// The waiting_on Person rides on the Todo row's person_refs (slice-3 wire):
	// the linked-person row is a button labelled by the name + its role chip.
	await expect(
		detail.getByRole("button", { name: /Alice Waiting on/ }),
	).toBeVisible();

	// ── Todo detail: owning Project link (derived from project_id) ──────────
	await page.goto(`${core.url}/library/todos?id=${TODO_IN_PROJECT}`);
	const projectDetail = page.getByRole("complementary", {
		name: /Cut over the API details/i,
	});
	await expect(projectDetail).toBeVisible({ timeout: 15_000 });
	await expect(
		projectDetail.getByRole("button", { name: /API migration/ }),
	).toBeVisible();
});

function seedGtdWorkspace(dbPath: string): void {
	seedEntities(
		dbPath,
		[
			{
				id: PERSON_ALICE,
				type: "person",
				data: { name: "Alice", aliases: ["Allie"] },
			},
			{ id: PERSON_BOB, type: "person", data: { name: "Bob" } },
			{
				id: PROJECT_MIGRATION,
				type: "project",
				data: {
					name: "API migration",
					status: "active",
					outcome: "Move to /v2 behind an alias.",
					next_review_at: "2000-01-01T20:00:00",
				},
			},
			{
				id: TODO_INBOX,
				type: "todo",
				data: { title: "Buy stamps", status: "active" },
			},
			{
				id: TODO_WAITING,
				type: "todo",
				data: { title: "Wait for Alice's draft", status: "active" },
			},
			{
				id: TODO_IN_PROJECT,
				type: "todo",
				data: {
					title: "Cut over the API",
					status: "active",
					project_id: PROJECT_MIGRATION,
				},
			},
			{
				id: TODO_DONE,
				type: "todo",
				data: {
					title: "Old completed task",
					status: "completed",
					completed_at: "2026-06-01T12:00:00",
				},
			},
		],
		[
			{ todoId: TODO_WAITING, personId: PERSON_ALICE, role: "waiting_on" },
			{ todoId: TODO_IN_PROJECT, personId: PERSON_BOB, role: "related" },
		],
	);
}
