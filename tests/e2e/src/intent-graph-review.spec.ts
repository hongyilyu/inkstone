import path from "node:path";
import { expect, test } from "./fixtures.js";
import {
	seedAcceptedPerson,
	seedAcceptedProject,
	seedParkedIntentGraphProposal,
	sqlite,
	sqlValue,
} from "./seed-proposal.js";
import { FAUX_PROPOSE_JOURNAL_FIXTURE, FAUX_WORKER_CMD } from "./spawnCore.js";

// The seeded proposal is decided through real Core; accepting RESUMES the parked
// Run, which spawns a Worker. Use the faux interpreter (provider="faux") so resume
// needs no live credential/token resolution — the apply commits in-tx before the
// (detached) resume spawns, so the DB assertions hold regardless of the resumed
// turn's content. Resume-only: the scenario's turns are never consumed, but the
// propose mode requires a params file uniformly (fail-fast, no silent default).
test.use({
	coreOptions: {
		workerCmd: FAUX_WORKER_CMD,
		faux: "propose",
		proposeParamsFile: FAUX_PROPOSE_JOURNAL_FIXTURE,
	},
});

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

test("editing a create node sends edited_fields; the minted entity carries the correction", async ({
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

	const EDITED_TITLE = "Sort out the Rodeo logistics";

	// Open the Todo's inline edit form, correct the title, Save. Match the button's
	// accessible name ("Edit <title>") as a literal substring — no RegExp, so a title
	// with regex metacharacters can't break the locator.
	await card
		.getByRole("button", { name: `Edit ${TODO_TITLE}`, exact: false })
		.click();
	const title = card.getByLabel("Title");
	await expect(title).toHaveValue(TODO_TITLE);
	await title.fill(EDITED_TITLE);
	await card.getByRole("button", { name: /save/i }).click();

	// The collapsed row reflects the correction and is badged "Edited".
	await expect(card.locator('[data-graph-node="@rodeo"]')).toContainText(
		EDITED_TITLE,
	);
	await expect(card.locator('[data-graph-node="@rodeo"]')).toHaveAttribute(
		"data-node-edited",
		"true",
	);

	// Apply: the edited_fields correction rides the decision vector to Core.
	await card.getByRole("button", { name: /apply 3 items/i }).click();
	await expect(decidedCard).toContainText(/applied/i, { timeout: 15_000 });

	// The minted Todo carries the EDITED title, not the model's proposed one.
	expect(
		count(
			dbPath,
			`SELECT COUNT(*) FROM entities WHERE type = 'todo' AND json_extract(data, '$.title') = ${sqlValue(EDITED_TITLE)};`,
		),
	).toBe("1");
	expect(
		count(
			dbPath,
			`SELECT COUNT(*) FROM entities WHERE type = 'todo' AND json_extract(data, '$.title') = ${sqlValue(TODO_TITLE)};`,
		),
	).toBe("0");
	// The edited Todo keeps its project link (the edit does not disturb resolution).
	expect(
		count(
			dbPath,
			`SELECT COUNT(*) FROM entities todo
			 JOIN entities project ON project.id = json_extract(todo.data, '$.project_id')
			 WHERE todo.type = 'todo' AND project.type = 'project'
			   AND json_extract(project.data, '$.name') = ${sqlValue(PROJECT_NAME)};`,
		),
	).toBe("1");
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

// --- Near-match default-to-existing (ADR-0042 amendment) --------------------
// The reported bug: a note "...synced on Lead Ads testing..." proposed "Lead Ads
// testing" as a NEW Project when a "Lead Ads" Project already exists. With the
// near-match safety net, Core flags the existing "Lead Ads" on the create node's
// resolved plan, and the card DEFAULTS to reusing it — a blind Apply links to the
// existing Project and mints NO duplicate.

const EXISTING_PROJECT_ID = "01900000-0000-7000-8000-00000000c001";
const NEAR_MATCH_NOTE = "1600-1800 synced on Lead Ads testing";

// A graph proposing a Project named "Lead Ads testing" (the near-twin) + a Todo.
const NEAR_MATCH_GRAPH = {
	journal_entry: {
		handle: "@je",
		occurred_at: "2026-06-10T16:00:00",
		body: [
			{ type: "text", text: "Synced on " },
			{ type: "entity_ref", target: "@leadads" },
			{ type: "text", text: "." },
		],
	},
	entities: [
		{ handle: "@leadads", type: "project", name: "Lead Ads testing" },
		{
			handle: "@figure",
			type: "todo",
			title: "Figure out why Lead Ads testing ads still do not show up",
		},
	],
	links: [
		{ kind: "todo_project", from: "@figure", to: "@leadads" },
		{ kind: "journal_ref", from: "@je", to: "@leadads" },
	],
};

test("a near-twin Project defaults to the existing entity; Apply mints no duplicate", async ({
	chat,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	// An accepted "Lead Ads" Project already exists.
	seedAcceptedProject(dbPath, EXISTING_PROJECT_ID, "Lead Ads");
	seedParkedIntentGraphProposal(dbPath, {
		graph: NEAR_MATCH_GRAPH,
		title: NEAR_MATCH_NOTE,
	});

	await chat.goto();
	await chat.openThread(NEAR_MATCH_NOTE);

	const card = chat.page.locator('[data-proposal-kind="apply_intent_graph"]');
	await expect(card).toBeVisible({ timeout: 15_000 });

	// The Project node defaults to reusing the existing "Lead Ads": "Existing «…»"
	// badge + the re-point attribute carrying the existing entity's id.
	const projectRow = card.locator('[data-graph-node="@leadads"]');
	await expect(projectRow).toContainText("Lead Ads testing"); // proposed label kept
	await expect(projectRow).toContainText(/Existing «Lead Ads»/);
	await expect(projectRow).toHaveAttribute(
		"data-node-repoint",
		EXISTING_PROJECT_ID,
	);

	const runId = await card.getAttribute("data-proposal");
	expect(runId).not.toBeNull();
	const decidedCard = chat.page.locator(`[data-proposal="${runId}"]`);

	// Apply everything — the default re-points the Project onto the existing one.
	await card.getByRole("button", { name: /apply 2 items/i }).click();
	await expect(decidedCard).toContainText(/applied/i, { timeout: 15_000 });

	// NO duplicate: exactly ONE project named "Lead Ads", and ZERO "Lead Ads testing".
	expect(
		count(dbPath, "SELECT COUNT(*) FROM entities WHERE type = 'project';"),
	).toBe("1");
	expect(
		count(
			dbPath,
			`SELECT COUNT(*) FROM entities WHERE type = 'project' AND json_extract(data, '$.name') = ${sqlValue("Lead Ads")};`,
		),
	).toBe("1");
	expect(
		count(
			dbPath,
			`SELECT COUNT(*) FROM entities WHERE type = 'project' AND json_extract(data, '$.name') = ${sqlValue("Lead Ads testing")};`,
		),
	).toBe("0");
	// The Todo is linked to the EXISTING "Lead Ads" project (re-point joined the link).
	expect(
		count(
			dbPath,
			`SELECT COUNT(*) FROM entities WHERE type = 'todo' AND json_extract(data, '$.project_id') = ${sqlValue(EXISTING_PROJECT_ID)};`,
		),
	).toBe("1");
});

test("'Create new instead' overrides the near-match and mints the new Project", async ({
	chat,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	seedAcceptedProject(dbPath, EXISTING_PROJECT_ID, "Lead Ads");
	seedParkedIntentGraphProposal(dbPath, {
		graph: NEAR_MATCH_GRAPH,
		title: NEAR_MATCH_NOTE,
	});

	await chat.goto();
	await chat.openThread(NEAR_MATCH_NOTE);

	const card = chat.page.locator('[data-proposal-kind="apply_intent_graph"]');
	await expect(card).toBeVisible({ timeout: 15_000 });
	const projectRow = card.locator('[data-graph-node="@leadads"]');
	await expect(projectRow).toHaveAttribute(
		"data-node-repoint",
		EXISTING_PROJECT_ID,
	);

	const runId = await card.getAttribute("data-proposal");
	expect(runId).not.toBeNull();
	const decidedCard = chat.page.locator(`[data-proposal="${runId}"]`);

	// Opt out of the default: mint a new Project instead.
	await projectRow.getByRole("button", { name: /create new instead/i }).click();
	await expect(projectRow).not.toHaveAttribute("data-node-repoint");
	await expect(projectRow).toContainText("New");

	await card.getByRole("button", { name: /apply 2 items/i }).click();
	await expect(decidedCard).toContainText(/applied/i, { timeout: 15_000 });

	// NOW there are TWO projects — the existing "Lead Ads" and the new "Lead Ads testing".
	expect(
		count(dbPath, "SELECT COUNT(*) FROM entities WHERE type = 'project';"),
	).toBe("2");
	expect(
		count(
			dbPath,
			`SELECT COUNT(*) FROM entities WHERE type = 'project' AND json_extract(data, '$.name') = ${sqlValue("Lead Ads testing")};`,
		),
	).toBe("1");
});

// --- Ambiguous-node disambiguation picker (#181) ----------------------------
// When extraction's @morris node matches 2+ existing People named "Morris", Core
// marks the node `ambiguous` and surfaces the competing candidates. The picker lets
// the user choose WHICH existing Morris the node reuses: picking writes that
// entity_id as the per-node override, collapsing ambiguous → reuse, so an otherwise
// force-rejected capture applies. (The override apply is Rust-unit-tested in
// decide.rs `decision_vector_entity_id_override_resolves_ambiguous`; this proves the
// full UI → wire → apply path.)

const MORRIS_ONE_ID = "01900000-0000-7000-8000-00000000d001";
const MORRIS_TWO_ID = "01900000-0000-7000-8000-00000000d002";
// The two Morris People are told apart ONLY by their note — the disambiguating
// subtitle the picker renders (libraryItemSubtitle). Asserting on these in the real
// proposal/get → library cache → subtitle path pins the affordance that justifies
// the picker (identical labels otherwise).
const MORRIS_ONE_NOTE = "from the Rodeo sync";
const MORRIS_TWO_NOTE = "the Lead Ads contact";
const AMBIGUOUS_NOTE = "Synced with Morris on the Rodeo side";

// A graph: a Todo linked to the ambiguous @morris person node (no project), so the
// only plan nodes are the Todo (create) and Morris (ambiguous).
const AMBIGUOUS_GRAPH = {
	journal_entry: {
		handle: "@je",
		occurred_at: "2026-06-10T17:00:00",
		body: [
			{ type: "text", text: "Synced with " },
			{ type: "entity_ref", target: "@morris" },
			{ type: "text", text: " on the Rodeo side." },
		],
	},
	entities: [
		{ handle: "@morris", type: "person", name: "Morris" },
		{ handle: "@rodeo", type: "todo", title: "Figure out the Rodeo side" },
	],
	links: [
		{ kind: "todo_person", from: "@rodeo", to: "@morris", role: "related" },
		{ kind: "journal_ref", from: "@je", to: "@morris" },
	],
};

test("picking a candidate for an ambiguous node reuses the chosen existing entity", async ({
	chat,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	// TWO accepted People named "Morris" with DISTINCT notes, so the @morris node
	// resolves `ambiguous` and the picker can tell the candidates apart by subtitle.
	seedAcceptedPerson(dbPath, MORRIS_ONE_ID, "Morris", MORRIS_ONE_NOTE);
	seedAcceptedPerson(dbPath, MORRIS_TWO_ID, "Morris", MORRIS_TWO_NOTE);
	seedParkedIntentGraphProposal(dbPath, {
		graph: AMBIGUOUS_GRAPH,
		title: AMBIGUOUS_NOTE,
	});

	await chat.goto();
	await chat.openThread(AMBIGUOUS_NOTE);

	const card = chat.page.locator('[data-proposal-kind="apply_intent_graph"]');
	await expect(card).toBeVisible({ timeout: 15_000 });

	// The Morris node renders ambiguous with a 2-candidate picker; it is NOT yet
	// acceptable (accept disabled), so the Apply count covers only the Todo.
	const morrisRow = card.locator('[data-graph-node="@morris"]');
	await expect(morrisRow).toContainText("Needs disambiguation");
	// Each candidate carries its disambiguating SUBTITLE, resolved through the REAL
	// proposal/get → library cache → libraryItemSubtitle path (not a mocked hook) —
	// the affordance that lets the user tell two identically-named People apart.
	await expect(
		morrisRow.locator(`[data-candidate="${MORRIS_ONE_ID}"]`),
	).toContainText(MORRIS_ONE_NOTE);
	await expect(
		morrisRow.locator(`[data-candidate="${MORRIS_TWO_ID}"]`),
	).toContainText(MORRIS_TWO_NOTE);
	await expect(
		card.getByRole("button", { name: /accept morris/i }),
	).toBeDisabled();
	await expect(
		card.getByText(/match more than one existing entry/i),
	).toBeVisible();
	// Unpicked: Apply sweeps only the Todo (Morris stays reject-only).
	await expect(
		card.getByRole("button", { name: /apply 1 item/i }),
	).toBeVisible();

	const runId = await card.getAttribute("data-proposal");
	expect(runId).not.toBeNull();
	const decidedCard = chat.page.locator(`[data-proposal="${runId}"]`);

	// Pick the SECOND Morris — the node flips to reuse and is re-pointed onto it.
	await morrisRow.locator(`[data-candidate="${MORRIS_TWO_ID}"] input`).check();
	await expect(morrisRow).toHaveAttribute("data-node-repoint", MORRIS_TWO_ID);
	await expect(morrisRow).toContainText("Existing «Morris»");
	// Now both nodes are acceptable → Apply covers 2 items.
	await card.getByRole("button", { name: /apply 2 items/i }).click();
	await expect(decidedCard).toContainText(/applied/i, { timeout: 15_000 });

	// NO third Morris minted — exactly the two seeded People remain.
	expect(
		count(dbPath, "SELECT COUNT(*) FROM entities WHERE type = 'person';"),
	).toBe("2");
	// The Todo's person ref points at the CHOSEN Morris (MORRIS_TWO_ID), not the other.
	expect(
		count(
			dbPath,
			`SELECT COUNT(*) FROM todo_person_refs WHERE person_id = ${sqlValue(MORRIS_TWO_ID)};`,
		),
	).toBe("1");
	expect(
		count(
			dbPath,
			`SELECT COUNT(*) FROM todo_person_refs WHERE person_id = ${sqlValue(MORRIS_ONE_ID)};`,
		),
	).toBe("0");
	// The Todo itself was created (one Todo total).
	expect(
		count(dbPath, "SELECT COUNT(*) FROM entities WHERE type = 'todo';"),
	).toBe("1");
});
