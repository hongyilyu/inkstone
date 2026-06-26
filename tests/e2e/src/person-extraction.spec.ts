import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import type { ChatPage } from "./page-objects/ChatPage.js";
import { seedAcceptedPerson, sqlite, sqlValue } from "./seed-proposal.js";
import { FAUX_WORKER_CMD } from "./spawnCore.js";

/**
 * Person extraction from an accepted Journal Entry, end-to-end (slice 4): real
 * Core + the faux-provider interpreter Worker in `extract` mode + the built Web
 * Client. The Worker reads the scenario (journal text + the Person name to look
 * for) from `extractParamsFile`, issues a REAL `search_entities` call, and
 * branches on whether the e2e seeded that Person — proposing a reference to the
 * existing one, or a `create_person` sourced from the Journal Entry then a
 * reference once it exists. A rejected `create_person` leaves no durable rows.
 */

const scenarioDir = mkdtempSync(path.join(tmpdir(), "inkstone-extract-"));
const extractParamsFile = path.join(scenarioDir, "scenario.json");

const PERSON_NAME = "Alice";
const JOURNAL_TEXT = "Caught up with Alice over coffee.";

// Known id for the seeded Person so case (a) can assert entity_refs.target_entity_id.
const SEEDED_PERSON_ID = "01900000-0000-7000-8000-0000000004a1";

// NO file-level afterAll rmSync here: under `fullyParallel` (workers: 4) a file-level
// afterAll fires once PER WORKER, so a worker draining the nested describe would delete
// this shared dir while a top-level test on another worker is still mid-write → ENOENT.
// The dir holds one static JSON written in beforeAll; leaving it for the OS tmpdir reaper
// removes the race at its source. (The nested describe owns its OWN dir + afterAll below.)

test.use({
	coreOptions: {
		workerCmd: FAUX_WORKER_CMD,
		faux: "extract",
		extractParamsFile,
	},
});

test.beforeAll(() => {
	writeFileSync(
		extractParamsFile,
		JSON.stringify({ journal_text: JOURNAL_TEXT, person_name: PERSON_NAME }),
	);
});

test("existing Person: accept JE then reference the seeded Person", async ({
	chat,
	workspace,
}) => {
	const dbPath = path.join(workspace.path, "db.sqlite");
	seedAcceptedPerson(dbPath, SEEDED_PERSON_ID, PERSON_NAME);

	await chat.goto();
	await chat.send("Caught up with Alice over coffee today.");
	await acceptJournalEntry(chat);

	// The follow-up: a reference to the existing Alice.
	const refCard = pendingCard(chat);
	await expect(refCard).toBeVisible({ timeout: 15_000 });
	await expect(refCard).toContainText("Reference existing Entity");
	await refCard.getByRole("button", { name: /link entity/i }).click();
	await expect(acceptedCard(chat)).toContainText(/linked in journal/i, {
		timeout: 15_000,
	});

	// The reference links the new Journal Entry to the seeded Person.
	expect(
		sqlite(
			dbPath,
			`SELECT COUNT(*) FROM entity_refs WHERE target_entity_id = ${sqlValue(SEEDED_PERSON_ID)};`,
		).trim(),
	).toBe("1");
});

test("missing Person: accept JE creates the Person sourced from it, then references it", async ({
	chat,
	workspace,
}) => {
	const dbPath = path.join(workspace.path, "db.sqlite");

	await chat.goto();
	await chat.send("Caught up with Alice over coffee today.");
	await acceptJournalEntry(chat);

	// Search found no Alice → a create_person proposal sourced from the JE.
	const personCard = pendingCard(chat);
	await expect(personCard).toBeVisible({ timeout: 15_000 });
	await expect(personCard).toContainText(PERSON_NAME);
	await personCard.getByRole("button", { name: /add person/i }).click();
	await expect(acceptedCard(chat)).toContainText(/added person/i, {
		timeout: 15_000,
	});

	// One Person entity with the scenario name, sourced from the Journal Entry.
	expect(
		sqlite(
			dbPath,
			`SELECT COUNT(*) FROM entities WHERE type = 'person' AND json_extract(data, '$.name') = ${sqlValue(PERSON_NAME)};`,
		).trim(),
	).toBe("1");
	expect(
		sqlite(
			dbPath,
			`SELECT COUNT(*) FROM entity_sources s
			 JOIN entities p ON p.id = s.entity_id AND p.type = 'person'
			 JOIN entities je ON je.id = s.source_entity_id AND je.type = 'journal_entry'
			 WHERE s.relation = 'created_from' AND s.source_message_id IS NULL;`,
		).trim(),
	).toBe("1");

	// Re-search now finds the new Person → a reference proposal links it.
	const refCard = pendingCard(chat);
	await expect(refCard).toBeVisible({ timeout: 15_000 });
	await expect(refCard).toContainText("Reference existing Entity");
	await refCard.getByRole("button", { name: /link entity/i }).click();
	await expect(acceptedCard(chat)).toContainText(/linked in journal/i, {
		timeout: 15_000,
	});

	// The reference links the Journal Entry to the newly created Person.
	expect(
		sqlite(
			dbPath,
			`SELECT COUNT(*) FROM entity_refs r
			 JOIN entities p ON p.id = r.target_entity_id AND p.type = 'person'
			 JOIN entities je ON je.id = r.source_entity_id AND je.type = 'journal_entry';`,
		).trim(),
	).toBe("1");
});

test("rejected create_person leaves no Person, source, or reference", async ({
	chat,
	workspace,
}) => {
	const dbPath = path.join(workspace.path, "db.sqlite");

	await chat.goto();
	await chat.send("Caught up with Alice over coffee today.");
	await acceptJournalEntry(chat);

	// The create_person proposal — reject it.
	const personCard = pendingCard(chat);
	await expect(personCard).toBeVisible({ timeout: 15_000 });
	await expect(personCard).toContainText(PERSON_NAME);
	await personCard.getByRole("button", { name: /dismiss/i }).click();
	await expect(rejectedCard(chat)).toContainText(/dismissed/i, {
		timeout: 15_000,
	});

	// No Person, no source-from-JE, no reference — but the Journal Entry remains.
	expect(
		sqlite(
			dbPath,
			"SELECT COUNT(*) FROM entities WHERE type = 'person';",
		).trim(),
	).toBe("0");
	expect(
		sqlite(
			dbPath,
			"SELECT COUNT(*) FROM entity_sources WHERE relation = 'created_from' AND source_entity_id IS NOT NULL;",
		).trim(),
	).toBe("0");
	expect(sqlite(dbPath, "SELECT COUNT(*) FROM entity_refs;").trim()).toBe("0");
	expect(
		sqlite(
			dbPath,
			"SELECT COUNT(*) FROM entities WHERE type = 'journal_entry';",
		).trim(),
	).toBe("1");
});

test.describe("Person extraction from the accepted Journal Entry Decision", () => {
	const decisionScenarioDir = mkdtempSync(
		path.join(tmpdir(), "inkstone-extract-decision-"),
	);
	const decisionExtractParamsFile = path.join(
		decisionScenarioDir,
		"scenario.json",
	);

	test.use({
		coreOptions: {
			workerCmd: FAUX_WORKER_CMD,
			faux: "extract",
			extractParamsFile: decisionExtractParamsFile,
		},
	});

	test.beforeAll(() => {
		writeFileSync(
			decisionExtractParamsFile,
			JSON.stringify({
				journal_text: JOURNAL_TEXT,
				person_name: PERSON_NAME,
				journal_entry_id_source: "decision_result",
			}),
		);
	});

	test.afterAll(() => {
		rmSync(decisionScenarioDir, { recursive: true, force: true });
	});

	test("missing Person can be edited and accepted using the accepted Journal Entry id", async ({
		chat,
		workspace,
	}) => {
		const dbPath = path.join(workspace.path, "db.sqlite");

		await chat.goto();
		await chat.send("Caught up with Alice over coffee today.");
		await acceptJournalEntry(chat);

		const personCard = pendingCard(chat);
		await expect(personCard).toBeVisible({ timeout: 15_000 });
		await expect(personCard).toContainText(PERSON_NAME);
		const personRunId = await personCard.getAttribute("data-proposal");
		expect(personRunId).not.toBeNull();

		await personCard.getByRole("button", { name: /^edit$/i }).click();
		await expect(
			personCard.getByRole("textbox", { name: /name/i }),
		).toHaveValue(PERSON_NAME);
		await personCard
			.getByRole("textbox", { name: /note/i })
			.fill("Met over coffee.");
		await personCard.getByRole("button", { name: /save changes/i }).click();
		await expect(
			chat.page.locator(`[data-proposal="${personRunId}"]`),
		).toContainText(/added person/i, { timeout: 15_000 });

		expect(
			sqlite(
				dbPath,
				`SELECT COUNT(*) FROM entities
				 WHERE type = 'person'
				 AND json_extract(data, '$.name') = ${sqlValue(PERSON_NAME)}
				 AND json_extract(data, '$.note') = ${sqlValue("Met over coffee.")};`,
			).trim(),
		).toBe("1");
		expect(
			sqlite(
				dbPath,
				`SELECT COUNT(*) FROM entity_sources s
				 JOIN entities p ON p.id = s.entity_id AND p.type = 'person'
				 JOIN entities je ON je.id = s.source_entity_id AND je.type = 'journal_entry'
				 WHERE s.relation = 'created_from' AND s.source_message_id IS NULL;`,
			).trim(),
		).toBe("1");

		const refCard = pendingCard(chat);
		await expect(refCard).toBeVisible({ timeout: 15_000 });
		await expect(refCard).toContainText("Reference existing Entity");
		await refCard.getByRole("button", { name: /link entity/i }).click();
		await expect(acceptedCard(chat)).toContainText(/linked in journal/i, {
			timeout: 15_000,
		});
	});
});

/** Accept the anchor create_journal_entry proposal and wait for its accepted
 * state. The accepted card renders only its status copy (no body text), so pin
 * to the stable `data-proposal` run id captured while the card is still pending
 * — that id survives the pending → accepted transition unambiguously. */
async function acceptJournalEntry(chat: ChatPage): Promise<void> {
	const jeCard = chat.page
		.locator('[data-proposal-status="pending"]')
		.filter({ hasText: JOURNAL_TEXT });
	await expect(jeCard).toBeVisible({ timeout: 15_000 });
	const runId = await jeCard.getAttribute("data-proposal");
	expect(runId).not.toBeNull();
	await jeCard.getByRole("button", { name: /add journal entry/i }).click();
	await expect(chat.page.locator(`[data-proposal="${runId}"]`)).toContainText(
		/added to journal/i,
		{ timeout: 15_000 },
	);
}

/** The newest pending proposal card — used for each follow-up after the first. */
function pendingCard(chat: { page: Page }) {
	return chat.page.locator('[data-proposal-status="pending"]').last();
}

/** The newest accepted proposal card — a card's status flips off "pending" once decided. */
function acceptedCard(chat: { page: Page }) {
	return chat.page.locator('[data-proposal-status="accepted"]').last();
}

/** The newest rejected proposal card. */
function rejectedCard(chat: { page: Page }) {
	return chat.page.locator('[data-proposal-status="rejected"]').last();
}
