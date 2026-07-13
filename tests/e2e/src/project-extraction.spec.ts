import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures.js";
import {
	acceptedCard,
	acceptJournalEntry,
	pendingCard,
} from "./proposal-cards.js";
import { seedAcceptedProject, sqlite, sqlValue } from "./seed-proposal.js";
import { FAUX_WORKER_CMD } from "./spawnCore.js";

/**
 * Project extraction from an accepted Journal Entry, end-to-end (slice 5): real
 * Core + the faux-provider interpreter Worker in `extract` mode + the built Web
 * Client. The extraction machine is the same one slice 4 exercised for People,
 * now generalized to a Project target — the Worker reads the scenario (journal
 * text + the Project name, when present) from `extractParamsFile`, issues a REAL
 * `search_entities` call, and branches on the REAL result:
 *
 *  - an existing Project → propose a reference to it;
 *  - a missing outcome-like Project → propose a `create_project` sourced from the
 *    Journal Entry, then re-search and reference the newly created Project;
 *  - a scenario with NO extraction target (a bare category like "Work") → accept
 *    the Journal Entry and propose NOTHING — the category stays plain text.
 */

const scenarioDir = mkdtempSync(path.join(tmpdir(), "inkstone-extract-proj-"));
const extractParamsFile = path.join(scenarioDir, "scenario.json");

const PROJECT_NAME = "Ship API v2 migration";
const JOURNAL_TEXT = "Kicked off the API v2 migration today.";

// Known id for the seeded Project so case (a) can assert entity_refs.target_entity_id.
const SEEDED_PROJECT_ID = "01900000-0000-7000-8000-0000000005a1";

test.afterAll(() => {
	rmSync(scenarioDir, { recursive: true, force: true });
});

test.use({
	coreOptions: {
		workerCmd: FAUX_WORKER_CMD,
		faux: "extract",
		extractParamsFile,
	},
});

test("existing Project: accept JE then reference the seeded Project", async ({
	chat,
	workspace,
}) => {
	writeScenario({ journal_text: JOURNAL_TEXT, project_name: PROJECT_NAME });
	const dbPath = path.join(workspace.path, "db.sqlite");
	seedAcceptedProject(dbPath, SEEDED_PROJECT_ID, PROJECT_NAME);

	await chat.goto();
	await chat.send(JOURNAL_TEXT);
	await acceptJournalEntry(chat, JOURNAL_TEXT);

	// The follow-up: a reference to the existing Project.
	const refCard = pendingCard(chat);
	await expect(refCard).toBeVisible({ timeout: 15_000 });
	await expect(refCard).toContainText("Reference existing Entity");
	await refCard.getByRole("button", { name: /link entity/i }).click();
	await expect(acceptedCard(chat)).toContainText(/linked in journal/i, {
		timeout: 15_000,
	});

	// The reference links the new Journal Entry to the seeded Project.
	expect(
		sqlite(
			dbPath,
			`SELECT COUNT(*) FROM entity_refs WHERE target_entity_id = ${sqlValue(SEEDED_PROJECT_ID)};`,
		).trim(),
	).toBe("1");
});

test("missing Project: accept JE creates the Project sourced from it, then references it", async ({
	chat,
	workspace,
}) => {
	writeScenario({ journal_text: JOURNAL_TEXT, project_name: PROJECT_NAME });
	const dbPath = path.join(workspace.path, "db.sqlite");

	await chat.goto();
	await chat.send(JOURNAL_TEXT);
	await acceptJournalEntry(chat, JOURNAL_TEXT);

	// Search found no Project → a create_project proposal sourced from the JE.
	const projectCard = pendingCard(chat);
	await expect(projectCard).toBeVisible({ timeout: 15_000 });
	await expect(projectCard).toContainText(PROJECT_NAME);
	await projectCard.getByRole("button", { name: /add project/i }).click();
	await expect(acceptedCard(chat)).toContainText(/added project/i, {
		timeout: 15_000,
	});

	// One Project entity with the scenario name, sourced from the Journal Entry.
	expect(
		sqlite(
			dbPath,
			`SELECT COUNT(*) FROM entities WHERE type = 'project' AND json_extract(data, '$.name') = ${sqlValue(PROJECT_NAME)};`,
		).trim(),
	).toBe("1");
	expect(
		sqlite(
			dbPath,
			`SELECT COUNT(*) FROM entity_sources s
			 JOIN entities p ON p.id = s.entity_id AND p.type = 'project'
			 JOIN entities je ON je.id = s.source_entity_id AND je.type = 'journal_entry'
			 WHERE s.relation = 'created_from' AND s.source_message_id IS NULL;`,
		).trim(),
	).toBe("1");

	// Re-search now finds the new Project → a reference proposal links it.
	const refCard = pendingCard(chat);
	await expect(refCard).toBeVisible({ timeout: 15_000 });
	await expect(refCard).toContainText("Reference existing Entity");
	await refCard.getByRole("button", { name: /link entity/i }).click();
	await expect(acceptedCard(chat)).toContainText(/linked in journal/i, {
		timeout: 15_000,
	});

	// The reference links the Journal Entry to the newly created Project.
	expect(
		sqlite(
			dbPath,
			`SELECT COUNT(*) FROM entity_refs r
			 JOIN entities p ON p.id = r.target_entity_id AND p.type = 'project'
			 JOIN entities je ON je.id = r.source_entity_id AND je.type = 'journal_entry';`,
		).trim(),
	).toBe("1");
});

test('category "Work": accept JE proposes no extraction (category stays plain text)', async ({
	chat,
	workspace,
}) => {
	// No project_name / person_name → the extraction machine names no target.
	writeScenario({ journal_text: "Spent the morning on Work." });
	const dbPath = path.join(workspace.path, "db.sqlite");

	await chat.goto();
	await chat.send("Spent the morning on Work.");
	await acceptJournalEntry(chat, "Spent the morning on Work.");

	// The Worker confirms with "Done — added it." and proposes nothing further.
	await expect(
		chat.assistantBubbles().filter({ hasText: /done — added it\./i }),
	).toBeVisible({ timeout: 15_000 });

	// No follow-up proposal card ever appears: the only card is the accepted JE.
	await expect(chat.page.locator("[data-proposal]")).toHaveCount(1);
	await expect(
		chat.page.locator('[data-proposal-status="pending"]'),
	).toHaveCount(0);

	// The Journal Entry persists; no Project, source-from-JE, or reference exists.
	expect(
		sqlite(
			dbPath,
			"SELECT COUNT(*) FROM entities WHERE type = 'journal_entry';",
		).trim(),
	).toBe("1");
	expect(
		sqlite(
			dbPath,
			"SELECT COUNT(*) FROM entities WHERE type = 'project';",
		).trim(),
	).toBe("0");
	expect(
		sqlite(
			dbPath,
			"SELECT COUNT(*) FROM entity_sources WHERE relation = 'created_from' AND source_entity_id IS NOT NULL;",
		).trim(),
	).toBe("0");
	expect(sqlite(dbPath, "SELECT COUNT(*) FROM entity_refs;").trim()).toBe("0");
});

/** Write the extraction scenario to the file the Worker reads (per test, before goto). */
function writeScenario(scenario: {
	journal_text: string;
	project_name?: string;
	person_name?: string;
}): void {
	// Re-ensure the dir: under `fullyParallel` the module-level afterAll (rmSync)
	// can delete the mkdtemp dir between this file's tests on a worker, throwing
	// ENOENT here. mkdirSync(recursive) is idempotent when it still exists.
	mkdirSync(scenarioDir, { recursive: true });
	writeFileSync(extractParamsFile, JSON.stringify(scenario));
}
