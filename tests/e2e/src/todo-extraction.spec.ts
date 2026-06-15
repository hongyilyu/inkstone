import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import type { ChatPage } from "./page-objects/ChatPage.js";
import {
	seedAcceptedPerson,
	seedAcceptedProject,
	sqlite,
	sqlValue,
} from "./seed-proposal.js";
import { FAUX_WORKER_CMD, PROMPT_BOUNDARY_WORKER_CMD } from "./spawnCore.js";

/**
 * Todo extraction from an accepted Journal Entry, end-to-end (slice 6): real
 * Core + the faux-provider interpreter Worker in `extract` mode + the built Web
 * Client. This is the same generalized extraction machine slices 4/5 exercised
 * for Person/Project, now driving a NEW Todo target: a DIRECT `create_todo`
 * whose Person/Project links are resolved by REAL `search_entities` calls — no
 * separate reference step.
 *
 *  - (a) "I need to email Alice about Project Y" with Alice (person) AND
 *    "Project Y" (project) pre-seeded accepted → accept JE → exactly ONE
 *    `create_todo` card; accept → a `todo` entity, a `todo_person_refs` row
 *    (person_id=Alice, role='related'), the Todo's `data.project_id` = Project
 *    Y's id, and an `entity_sources` row created_from the JE.
 *  - (b) "Wait for Bob to send Z" with Bob pre-seeded → accept JE →
 *    `create_todo` card; accept → a `todo_person_refs` row role='waiting_on'
 *    for Bob, and no project link (none seeded/searched).
 *
 * The reminder/task boundary ("remember buying milk after daycare pickup")
 * lives in a separate describe block at the foot of this file: it uses the
 * prompt-boundary Worker (NOT the extract faux mode), since journal-worthiness
 * classification is a production-prompt property, not a faux scenario.
 */

const scenarioDir = mkdtempSync(path.join(tmpdir(), "inkstone-extract-todo-"));
const extractParamsFile = path.join(scenarioDir, "scenario.json");

// Known ids for the seeded accepted Person/Project so the cases can assert
// todo_person_refs.person_id and the Todo's data.project_id against them.
const ALICE_ID = "01900000-0000-7000-8000-0000000006a1";
const PROJECT_Y_ID = "01900000-0000-7000-8000-0000000006a2";
const BOB_ID = "01900000-0000-7000-8000-0000000006b1";

test.afterAll(() => {
	rmSync(scenarioDir, { recursive: true, force: true });
});

test.describe("Todo extraction (faux extract mode)", () => {
	test.use({
		coreOptions: {
			workerCmd: FAUX_WORKER_CMD,
			faux: "extract",
			extractParamsFile,
		},
	});

	test("links Person (related) and Project: accept JE then accept the create_todo", async ({
		chat,
		workspace,
	}) => {
		const journalText = "I need to email Alice about Project Y.";
		writeScenario({
			journal_text: journalText,
			todo: {
				title: "Email Alice about Project Y",
				person_name: "Alice",
				person_role: "related",
				project_name: "Project Y",
			},
		});
		const dbPath = path.join(workspace.path, "db.sqlite");
		seedAcceptedPerson(dbPath, ALICE_ID, "Alice");
		seedAcceptedProject(dbPath, PROJECT_Y_ID, "Project Y");

		await chat.goto();
		await chat.send(journalText);
		await acceptJournalEntry(chat, journalText);

		// Exactly ONE follow-up proposal: the create_todo. Accept it.
		const todoCard = pendingCard(chat);
		await expect(todoCard).toBeVisible({ timeout: 15_000 });
		await expect(todoCard).toContainText("Email Alice about Project Y");
		await todoCard.getByRole("button", { name: /add todo/i }).click();
		await expect(acceptedCard(chat)).toBeVisible({ timeout: 15_000 });

		// One Todo entity exists.
		expect(
			sqlite(
				dbPath,
				"SELECT COUNT(*) FROM entities WHERE type = 'todo';",
			).trim(),
		).toBe("1");

		// Its Person Reference (ADR-0031: in todo_person_refs, NOT the Todo JSON)
		// links Alice with role 'related'.
		expect(
			sqlite(
				dbPath,
				`SELECT COUNT(*) FROM todo_person_refs WHERE person_id = ${sqlValue(ALICE_ID)} AND role = 'related';`,
			).trim(),
		).toBe("1");

		// The Todo's owning Project is Project Y (project_id lives in the Todo JSON).
		expect(
			sqlite(
				dbPath,
				`SELECT json_extract(data, '$.project_id') FROM entities WHERE type = 'todo';`,
			).trim(),
		).toBe(PROJECT_Y_ID);

		// The Todo is sourced created_from the Journal Entry.
		expect(
			sqlite(
				dbPath,
				`SELECT COUNT(*) FROM entity_sources s
				 JOIN entities t ON t.id = s.entity_id AND t.type = 'todo'
				 JOIN entities je ON je.id = s.source_entity_id AND je.type = 'journal_entry'
				 WHERE s.relation = 'created_from' AND s.source_message_id IS NULL;`,
			).trim(),
		).toBe("1");
	});

	test("links Person waiting_on with no Project: 'Wait for Bob to send Z'", async ({
		chat,
		workspace,
	}) => {
		const journalText = "Wait for Bob to send Z.";
		writeScenario({
			journal_text: journalText,
			todo: {
				title: "Wait for Bob to send Z",
				person_name: "Bob",
				person_role: "waiting_on",
			},
		});
		const dbPath = path.join(workspace.path, "db.sqlite");
		seedAcceptedPerson(dbPath, BOB_ID, "Bob");

		await chat.goto();
		await chat.send(journalText);
		await acceptJournalEntry(chat, journalText);

		// The create_todo follow-up. Accept it.
		const todoCard = pendingCard(chat);
		await expect(todoCard).toBeVisible({ timeout: 15_000 });
		await expect(todoCard).toContainText("Wait for Bob to send Z");
		await todoCard.getByRole("button", { name: /add todo/i }).click();
		await expect(acceptedCard(chat)).toBeVisible({ timeout: 15_000 });

		// One Todo entity, with Bob linked as waiting_on (ADR-0031 todo_person_refs).
		expect(
			sqlite(
				dbPath,
				"SELECT COUNT(*) FROM entities WHERE type = 'todo';",
			).trim(),
		).toBe("1");
		expect(
			sqlite(
				dbPath,
				`SELECT COUNT(*) FROM todo_person_refs WHERE person_id = ${sqlValue(BOB_ID)} AND role = 'waiting_on';`,
			).trim(),
		).toBe("1");

		// No Project seeded/searched → the Todo carries no project_id.
		expect(
			sqlite(
				dbPath,
				`SELECT json_extract(data, '$.project_id') IS NULL FROM entities WHERE type = 'todo';`,
			).trim(),
		).toBe("1");
	});
});

// The reminder/task boundary: a "remember to…" reminder is NOT journal-worthy,
// so it produces neither a Journal Entry nor any Todo extraction. This is a
// production-prompt property (journal-worthiness classification), which the
// faux extract mode does not model — so it is re-asserted here against the
// prompt-boundary Worker fixture, exactly as proposal-reminder-boundary.spec.ts.
test.describe("Todo extraction boundary (prompt-boundary worker)", () => {
	test.use({
		coreOptions: {
			workerCmd: PROMPT_BOUNDARY_WORKER_CMD,
		},
	});

	test("a reminder produces no Journal Entry and no Todo extraction", async ({
		chat,
	}) => {
		await chat.goto();

		await chat.send("remember buying milk after daycare pickup");

		await chat.waitForAssistantText(/won't save it as a Journal Entry/i);
		await expect(chat.proposalCard()).toHaveCount(0);
	});
});

/** Accept the anchor create_journal_entry proposal and wait for its accepted
 * state. The accepted card renders only its status copy (no body text), so pin
 * to the stable `data-proposal` run id captured while the card is still pending
 * — that id survives the pending → accepted transition unambiguously. */
async function acceptJournalEntry(
	chat: ChatPage,
	bodyText: string,
): Promise<void> {
	const jeCard = chat.page
		.locator('[data-proposal-status="pending"]')
		.filter({ hasText: bodyText });
	await expect(jeCard).toBeVisible({ timeout: 15_000 });
	const runId = await jeCard.getAttribute("data-proposal");
	expect(runId).not.toBeNull();
	await jeCard.getByRole("button", { name: /add journal entry/i }).click();
	await expect(chat.page.locator(`[data-proposal="${runId}"]`)).toContainText(
		/added to journal/i,
		{ timeout: 15_000 },
	);
}

/** The newest pending proposal card — used for the create_todo follow-up. */
function pendingCard(chat: { page: Page }) {
	return chat.page.locator('[data-proposal-status="pending"]').last();
}

/** The newest accepted proposal card — a card's status flips off "pending" once decided. */
function acceptedCard(chat: { page: Page }) {
	return chat.page.locator('[data-proposal-status="accepted"]').last();
}

/** Write the extraction scenario to the file the Worker reads (per test, before goto). */
function writeScenario(scenario: {
	journal_text: string;
	todo?: {
		title: string;
		person_name?: string;
		person_role?: "waiting_on" | "related";
		project_name?: string;
	};
}): void {
	writeFileSync(extractParamsFile, JSON.stringify(scenario));
}
