import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import type { ChatPage } from "./page-objects/ChatPage.js";
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

/** Seed a single accepted Person with a known id and name (no Journal Entry —
 * the Worker proposes that). Mirrors journal-entry-ref.spec.ts's person seed. */
function seedAcceptedPerson(
	dbPath: string,
	personId: string,
	name: string,
): void {
	const now = Date.now();
	const threadId = "01900000-0000-7000-8000-0000000004b0";
	const runId = "01900000-0000-7000-8000-0000000004b1";
	const userMessageId = "01900000-0000-7000-8000-0000000004b2";
	const toolCallId = "tc_seed_person";
	const proposalId = "01900000-0000-7000-8000-0000000004b3";
	const payload = { name };
	sqlite(
		dbPath,
		`
		BEGIN IMMEDIATE;
		INSERT INTO threads (id, title, created_at, last_activity_at)
		VALUES (${sqlValue(threadId)}, 'Seed thread', ${now}, ${now});
		INSERT INTO runs
			(id, thread_id, workflow_name, workflow_version, provider, model, thinking_level, user_message_id, status, started_at, ended_at, terminal_reason)
		VALUES
			(${sqlValue(runId)}, ${sqlValue(threadId)}, 'default', '1.0.0', 'faux', 'fake-model', 'off', ${sqlValue(userMessageId)}, 'completed', ${now}, ${now}, 'completed');
		INSERT INTO messages (id, thread_id, run_id, role, status, created_at, updated_at)
		VALUES (${sqlValue(userMessageId)}, ${sqlValue(threadId)}, ${sqlValue(runId)}, 'user', 'completed', ${now}, ${now});
		INSERT INTO message_parts (message_id, seq, type, text)
		VALUES (${sqlValue(userMessageId)}, 0, 'text', ${sqlValue(name)});
		INSERT INTO tool_calls (id, run_id, name, request_payload, status, result_payload, requested_at, resolved_at)
		VALUES (${sqlValue(toolCallId)}, ${sqlValue(runId)}, 'propose_workspace_mutation', '{}', 'completed', '{}', ${now}, ${now});
		INSERT INTO proposals (id, tool_call_id, mutation_kind, status, decided_by, decided_at, applied_at)
		VALUES (${sqlValue(proposalId)}, ${sqlValue(toolCallId)}, 'create_person', 'accepted', 'user', ${now}, ${now});
		INSERT INTO entities (id, type, schema_version, data, created_by, created_via_proposal_id, created_at, updated_at)
		VALUES (${sqlValue(personId)}, 'person', 1, ${jsonValue(payload)}, 'proposal', ${sqlValue(proposalId)}, ${now}, ${now});
		INSERT INTO entity_revisions (entity_id, seq, data, proposal_id, created_at)
		VALUES (${sqlValue(personId)}, 1, ${jsonValue(payload)}, ${sqlValue(proposalId)}, ${now});
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
