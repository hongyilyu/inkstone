import path from "node:path";
import { expect, test } from "./fixtures.js";
import {
	seedParkedIntentGraphProposal,
	sqlite,
	sqlValue,
} from "./seed-proposal.js";
import { FAUX_WORKER_CMD } from "./spawnCore.js";

// The seeded proposal is decided through real Core; accepting RESUMES the parked
// Run, which spawns a Worker. Use the faux interpreter (provider="faux") so resume
// needs no live credential/token resolution — the apply commits in-tx before the
// (detached) resume spawns, so the DB assertions hold regardless of the resumed
// turn's content.
test.use({ coreOptions: { workerCmd: FAUX_WORKER_CMD, faux: "propose" } });

/**
 * Intent-graph sequential review card, end-to-end (ADR-0042, slice 8): real Core +
 * the built Web Client. A PARKED `apply_intent_graph` proposal is seeded directly
 * (its graph payload is static — the resolve/apply behavior is proven by the Core
 * unit tests; this spec proves the UI review surface + the atomic commit). Opening
 * the Thread rehydrates the review card; Core ships the resolved plan via
 * `proposal/get` and the card renders a node queue with create badges.
 *
 * Two headline behaviors:
 *  1. Accept everything + Apply → all four entities exist and the Todo is linked.
 *  2. Reject the Project node + commit → the Todo lands standalone (no project
 *     link), and the Project is not created.
 *
 * The #179 shape: a Journal Entry + Project "Lead Ads" + Person "Morris" + Todo
 * "Figure out the Rodeo side", with the Todo linked to the Project and the Person,
 * and the JE referencing both.
 */

const TODO_TITLE = "Figure out the Rodeo side";
const PROJECT_NAME = "Lead Ads";
const PERSON_NAME = "Morris";
const NOTE_TITLE = "Met Morris about Lead Ads and the Rodeo side";

// The #179 intent graph: JE anchor + Project + Person + Todo, all linked.
const GRAPH = {
	journal_entry: {
		handle: "@je",
		occurred_at: "2026-06-10T10:30:00",
		body: [
			{ type: "text", text: "Met " },
			{ type: "entity_ref", target: "@morris" },
			{ type: "text", text: " about " },
			{ type: "entity_ref", target: "@leadads" },
			{ type: "text", text: " and the Rodeo side." },
		],
	},
	entities: [
		{ handle: "@leadads", type: "project", name: PROJECT_NAME },
		{ handle: "@morris", type: "person", name: PERSON_NAME },
		{ handle: "@rodeo", type: "todo", title: TODO_TITLE },
	],
	links: [
		{ kind: "todo_project", from: "@rodeo", to: "@leadads" },
		{ kind: "todo_person", from: "@rodeo", to: "@morris", role: "related" },
		{ kind: "journal_ref", from: "@je", to: "@morris" },
		{ kind: "journal_ref", from: "@je", to: "@leadads" },
	],
};

function dbPathFor(workspacePath: string): string {
	return path.join(workspacePath, "db.sqlite");
}

function count(dbPath: string, sql: string): string {
	return sqlite(dbPath, sql).trim();
}

test("accept-all commit lands all four entities, linked", async ({
	chat,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	seedParkedIntentGraphProposal(dbPath, { graph: GRAPH, title: NOTE_TITLE });

	await chat.goto();
	await chat.openThread(NOTE_TITLE);

	// The graph review card rehydrates with the 4-node plan + create badges.
	const card = chat.page.locator('[data-proposal-kind="apply_intent_graph"]');
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(card).toContainText(/3 items to review/i); // JE is not a plan node
	await expect(card.locator('[data-graph-node="@leadads"]')).toContainText(
		PROJECT_NAME,
	);
	await expect(card.locator('[data-graph-node="@morris"]')).toContainText(
		PERSON_NAME,
	);
	await expect(card.locator('[data-graph-node="@rodeo"]')).toContainText(
		TODO_TITLE,
	);
	await expect(card.getByText("New").first()).toBeVisible();

	// Pin the stable run-id locator (survives the kind/status transition, like
	// project-extraction.spec.ts) before deciding — the accepted card renders only
	// its status copy.
	const runId = await card.getAttribute("data-proposal");
	expect(runId).not.toBeNull();
	const decidedCard = chat.page.locator(`[data-proposal="${runId}"]`);

	// Apply everything (the default staging accepts every resolvable node).
	await card.getByRole("button", { name: /apply 3 items/i }).click();
	await expect(decidedCard).toContainText(/applied/i, { timeout: 15_000 });

	// All four entities exist: JE + Project + Person + Todo.
	expect(
		count(
			dbPath,
			"SELECT COUNT(*) FROM entities WHERE type = 'journal_entry';",
		),
	).toBe("1");
	expect(
		count(
			dbPath,
			`SELECT COUNT(*) FROM entities WHERE type = 'project' AND json_extract(data, '$.name') = ${sqlValue(PROJECT_NAME)};`,
		),
	).toBe("1");
	expect(
		count(
			dbPath,
			`SELECT COUNT(*) FROM entities WHERE type = 'person' AND json_extract(data, '$.name') = ${sqlValue(PERSON_NAME)};`,
		),
	).toBe("1");
	// The Todo is linked to the Project (its data.project_id is the Project's id).
	expect(
		count(
			dbPath,
			`SELECT COUNT(*) FROM entities todo
			 JOIN entities project ON project.id = json_extract(todo.data, '$.project_id')
			 WHERE todo.type = 'todo' AND project.type = 'project'
			   AND json_extract(project.data, '$.name') = ${sqlValue(PROJECT_NAME)};`,
		),
	).toBe("1");
	// The Todo is linked to the Person via todo_person_refs.
	expect(
		count(
			dbPath,
			`SELECT COUNT(*) FROM todo_person_refs r
			 JOIN entities p ON p.id = r.person_id AND p.type = 'person'
			 WHERE json_extract(p.data, '$.name') = ${sqlValue(PERSON_NAME)};`,
		),
	).toBe("1");
	// The JE references both entities (woven once).
	expect(count(dbPath, "SELECT COUNT(*) FROM entity_refs;")).toBe("2");
});

test("rejecting the Project lands the Todo standalone (no project, no link)", async ({
	chat,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	seedParkedIntentGraphProposal(dbPath, { graph: GRAPH, title: NOTE_TITLE });

	await chat.goto();
	await chat.openThread(NOTE_TITLE);

	const card = chat.page.locator('[data-proposal-kind="apply_intent_graph"]');
	await expect(card).toBeVisible({ timeout: 15_000 });
	const runId = await card.getAttribute("data-proposal");
	expect(runId).not.toBeNull();
	const decidedCard = chat.page.locator(`[data-proposal="${runId}"]`);

	// Reject the Project node — its row's Reject toggle.
	await card.getByRole("button", { name: /reject lead ads/i }).click();
	await expect(card.locator('[data-graph-node="@leadads"]')).toHaveAttribute(
		"data-node-stage",
		"reject",
	);
	// The downgrade is surfaced before Apply (ADR-0042 "shows this downgrade").
	await expect(card).toContainText(/without its project link/i);

	// Commit: the Todo + Person are accepted, the Project rejected.
	await card.getByRole("button", { name: /apply 2 items/i }).click();
	await expect(decidedCard).toContainText(/applied/i, { timeout: 15_000 });

	// The Project was NOT created.
	expect(
		count(dbPath, "SELECT COUNT(*) FROM entities WHERE type = 'project';"),
	).toBe("0");
	// The Todo lands standalone — it exists with NO project_id.
	expect(
		count(
			dbPath,
			`SELECT COUNT(*) FROM entities WHERE type = 'todo' AND json_extract(data, '$.title') = ${sqlValue(TODO_TITLE)} AND json_extract(data, '$.project_id') IS NULL;`,
		),
	).toBe("1");
	// The Person was created and still linked to the Todo (only the project link dropped).
	expect(
		count(
			dbPath,
			`SELECT COUNT(*) FROM entities WHERE type = 'person' AND json_extract(data, '$.name') = ${sqlValue(PERSON_NAME)};`,
		),
	).toBe("1");
	expect(count(dbPath, "SELECT COUNT(*) FROM todo_person_refs;")).toBe("1");
});
