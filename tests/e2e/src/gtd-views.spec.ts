import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test } from "./fixtures.js";

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
	const dbPath = path.join(workspace.path, "db.sqlite");
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
	const now = Date.now();
	const entity = (
		id: string,
		type: string,
		data: unknown,
	) => `INSERT INTO entities (id, type, schema_version, data, created_by, created_via_proposal_id, created_at, updated_at)
		VALUES (${sqlValue(id)}, ${sqlValue(type)}, 1, ${jsonValue(data)}, 'user', NULL, ${now}, ${now});`;
	const ref = (
		todoId: string,
		personId: string,
		role: string,
	) => `INSERT INTO todo_person_refs (todo_id, person_id, role, created_at, updated_at)
		VALUES (${sqlValue(todoId)}, ${sqlValue(personId)}, ${sqlValue(role)}, ${now}, ${now});`;

	sqlite(
		dbPath,
		`
		BEGIN IMMEDIATE;
		${entity(PERSON_ALICE, "person", { name: "Alice", aliases: ["Allie"] })}
		${entity(PERSON_BOB, "person", { name: "Bob" })}
		${entity(PROJECT_MIGRATION, "project", {
			name: "API migration",
			status: "active",
			outcome: "Move to /v2 behind an alias.",
			next_review_at: "2000-01-01T20:00:00",
		})}
		${entity(TODO_INBOX, "todo", { title: "Buy stamps", status: "active" })}
		${entity(TODO_WAITING, "todo", {
			title: "Wait for Alice's draft",
			status: "active",
		})}
		${entity(TODO_IN_PROJECT, "todo", {
			title: "Cut over the API",
			status: "active",
			project_id: PROJECT_MIGRATION,
		})}
		${entity(TODO_DONE, "todo", {
			title: "Old completed task",
			status: "completed",
			completed_at: "2026-06-01T12:00:00",
		})}
		${ref(TODO_WAITING, PERSON_ALICE, "waiting_on")}
		${ref(TODO_IN_PROJECT, PERSON_BOB, "related")}
		COMMIT;
		`,
	);
}

function sqlite(dbPath: string, input: string): string {
	return execFileSync("sqlite3", [dbPath], {
		input: `.timeout 5000
PRAGMA foreign_keys = ON;
${input}`,
		encoding: "utf8",
	});
}

function sqlValue(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function jsonValue(value: unknown): string {
	return sqlValue(JSON.stringify(value));
}
