import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { FAUX_WORKER_CMD } from "./spawnCore.js";

/**
 * Direct GTD capture intent matrix, end-to-end (slice 5): real Core + the faux
 * `capture` Worker + the built Web Client. A task/project/person-shaped Message
 * proposes the right create_* card, sourced from the user Message — NO Journal
 * Entry. Accepting resumes the Run and lands a Message-sourced Accepted Entity.
 *
 *   | Message intent          | first proposal card |
 *   | "Remind me to buy milk" | Add Todo            |
 *   | "Start a project ..."   | Add Project         |
 *   | "Remember Alice is ..." | Add Person          |
 *   | journal-worthy event    | Journal Entry       |  (PROPOSE worker, contrast)
 *
 * The journal-worthy row uses the PROPOSE worker (not the capture mode), since
 * journal-worthiness is a production-prompt property, not a faux scenario — it
 * asserts the boundary holds across both worker modes.
 */

const scenarioDir = mkdtempSync(path.join(tmpdir(), "inkstone-capture-"));
const captureParamsFile = path.join(scenarioDir, "scenario.json");

test.afterAll(() => {
	rmSync(scenarioDir, { recursive: true, force: true });
});

test.describe("Direct capture intent matrix (faux capture mode)", () => {
	test.use({
		coreOptions: {
			workerCmd: FAUX_WORKER_CMD,
			faux: "capture",
			captureParamsFile,
		},
	});

	test("Todo intent: 'Remind me to buy milk' → Add Todo card → Message-sourced Todo", async ({
		chat,
		workspace,
	}) => {
		writeScenario({ intent: "todo", todo: { title: "Buy milk" } });
		const dbPath = path.join(workspace.path, "db.sqlite");

		await chat.goto();
		await chat.send("Remind me to buy milk.");

		const card = pendingCard(chat);
		await expect(card).toBeVisible({ timeout: 15_000 });
		await expect(card).toContainText("Buy milk");
		await card.getByRole("button", { name: /add todo/i }).click();

		// Accepting resumes the Run to a final assistant message.
		await expect(acceptedCard(chat)).toBeVisible({ timeout: 15_000 });
		await chat.waitForAssistantText(/done/i);

		// Exactly one Todo, no Journal Entry.
		expect(countEntities(dbPath, "todo")).toBe("1");
		expect(countEntities(dbPath, "journal_entry")).toBe("0");
		// Sourced from the user Message: source_message_id set, source_entity_id NULL.
		expect(messageSourcedCount(dbPath, "todo")).toBe("1");
	});

	test("Project intent: 'Start a project ...' → Add Project card → Message-sourced Project", async ({
		chat,
		workspace,
	}) => {
		writeScenario({
			intent: "project",
			project: { name: "Ship API v2 migration" },
		});
		const dbPath = path.join(workspace.path, "db.sqlite");

		await chat.goto();
		await chat.send("Start a project for API v2 migration.");

		const card = pendingCard(chat);
		await expect(card).toBeVisible({ timeout: 15_000 });
		await expect(card).toContainText("Ship API v2 migration");
		await card.getByRole("button", { name: /add project/i }).click();

		await expect(acceptedCard(chat)).toBeVisible({ timeout: 15_000 });
		await chat.waitForAssistantText(/done/i);

		expect(countEntities(dbPath, "project")).toBe("1");
		expect(countEntities(dbPath, "journal_entry")).toBe("0");
		expect(messageSourcedCount(dbPath, "project")).toBe("1");
	});

	test("Person intent: 'Remember Alice is ...' → Add Person card → Message-sourced Person", async ({
		chat,
		workspace,
	}) => {
		writeScenario({
			intent: "person",
			person: { name: "Alice", note: "daycare coordinator" },
		});
		const dbPath = path.join(workspace.path, "db.sqlite");

		await chat.goto();
		await chat.send("Remember Alice is the daycare coordinator.");

		const card = pendingCard(chat);
		await expect(card).toBeVisible({ timeout: 15_000 });
		await expect(card).toContainText("Alice");
		await card.getByRole("button", { name: /add person/i }).click();

		await expect(acceptedCard(chat)).toBeVisible({ timeout: 15_000 });
		await chat.waitForAssistantText(/done/i);

		expect(countEntities(dbPath, "person")).toBe("1");
		expect(countEntities(dbPath, "journal_entry")).toBe("0");
		expect(messageSourcedCount(dbPath, "person")).toBe("1");
	});

	test("conversation intent: a question proposes nothing", async ({
		chat,
		workspace,
	}) => {
		writeScenario({ intent: "conversation" });
		const dbPath = path.join(workspace.path, "db.sqlite");

		await chat.goto();
		await chat.send("What should I focus on today?");

		// A plain reply, no proposal card.
		await chat.waitForAssistantText(/.+/);
		await expect(chat.proposalCard()).toHaveCount(0);

		// And no capture side effects: ordinary conversation persists nothing.
		expect(countEntities(dbPath, "todo")).toBe("0");
		expect(countEntities(dbPath, "project")).toBe("0");
		expect(countEntities(dbPath, "person")).toBe("0");
		expect(countEntities(dbPath, "journal_entry")).toBe("0");
	});
});

test.describe("Direct capture boundary: journal-worthy events still go to a Journal Entry", () => {
	test.use({
		coreOptions: {
			workerCmd: FAUX_WORKER_CMD,
			faux: "propose",
		},
	});

	test("a journal-worthy message proposes a create_journal_entry first", async ({
		chat,
		workspace,
	}) => {
		const dbPath = path.join(workspace.path, "db.sqlite");

		await chat.goto();
		await chat.send("I bought milk after daycare pickup and felt relieved.");

		// The PROPOSE worker proposes a Journal Entry (not a direct GTD entity).
		// Pin to the stable run id: the card drops its "pending" status once
		// accepted, so a pending-filtered locator would stop matching mid-assert.
		const jeCard = chat.page
			.locator('[data-proposal-status="pending"]')
			.filter({ hasText: "Journal Entry" });
		await expect(jeCard).toBeVisible({ timeout: 15_000 });
		const runId = await jeCard.getAttribute("data-proposal");
		expect(runId).not.toBeNull();
		await jeCard.getByRole("button", { name: /add journal entry/i }).click();
		await expect(chat.page.locator(`[data-proposal="${runId}"]`)).toContainText(
			/added to journal/i,
			{ timeout: 15_000 },
		);

		// A Journal Entry landed; no direct Todo/Project/Person from this path.
		expect(countEntities(dbPath, "journal_entry")).toBe("1");
		expect(countEntities(dbPath, "todo")).toBe("0");
		expect(countEntities(dbPath, "project")).toBe("0");
		expect(countEntities(dbPath, "person")).toBe("0");
	});
});

// Direct-capture ENRICHMENT (ADR-0031): after a direct create_todo is accepted,
// the capture Worker recovers the new Todo by search and proposes an update_todo
// that links a Person/Project — either an existing accepted entity, or one it
// creates first when the search comes up empty. The unit suite covers the
// scripted branches; these are the only END-TO-END assertions that the
// search → update_todo link leg actually persists a todo_person_refs row through
// real Core. Drive the full park → accept → resume → accept chain.
const PRIYA_ID = "01900000-0000-7000-8000-0000000005c1";

test.describe("Direct capture enrichment (faux capture mode)", () => {
	test.use({
		coreOptions: {
			workerCmd: FAUX_WORKER_CMD,
			faux: "capture",
			captureParamsFile,
		},
	});

	test("existing Person: accept the Todo, then accept the update_todo link → todo_person_refs row", async ({
		chat,
		workspace,
	}) => {
		writeScenario({
			intent: "todo",
			todo: { title: "email Priya" },
			enrich: { person_name: "Priya", person_role: "related" },
		});
		const dbPath = path.join(workspace.path, "db.sqlite");
		seedAcceptedPerson(dbPath, PRIYA_ID, "Priya");

		await chat.goto();
		await chat.send("Remind me to email Priya.");

		// 1) The direct create_todo card. Accept it; the Run parks then resumes.
		const todoCard = pendingCard(chat);
		await expect(todoCard).toBeVisible({ timeout: 15_000 });
		await expect(todoCard).toContainText("email Priya");
		await todoCard.getByRole("button", { name: /add todo/i }).click();

		// 2) The enrichment follow-up: an update_todo linking the existing Priya.
		const linkCard = chat.page
			.locator('[data-proposal-status="pending"]')
			.last();
		await expect(linkCard).toBeVisible({ timeout: 15_000 });
		await linkCard.getByRole("button", { name: /update todo/i }).click();
		await expect(acceptedCard(chat)).toBeVisible({ timeout: 15_000 });
		await chat.waitForAssistantText(/done/i);

		// One Todo, and its Person Reference links Priya with role 'related'
		// (ADR-0031: in todo_person_refs, not the Todo JSON).
		expect(countEntities(dbPath, "todo")).toBe("1");
		expect(
			sqlite(
				dbPath,
				`SELECT COUNT(*) FROM todo_person_refs WHERE person_id = ${sqlValue(PRIYA_ID)} AND role = 'related';`,
			).trim(),
		).toBe("1");
		// No new Person was created — Priya already existed (only the seed).
		expect(countEntities(dbPath, "person")).toBe("1");
	});

	test("missing Person: accept the Todo, accept the create_person, then accept the update_todo link", async ({
		chat,
		workspace,
	}) => {
		writeScenario({
			intent: "todo",
			todo: { title: "follow up with NewPerson" },
			enrich: { person_name: "NewPerson", person_role: "waiting_on" },
		});
		const dbPath = path.join(workspace.path, "db.sqlite");

		await chat.goto();
		await chat.send("Remind me to follow up with NewPerson.");

		// 1) create_todo → accept.
		const todoCard = pendingCard(chat);
		await expect(todoCard).toBeVisible({ timeout: 15_000 });
		await expect(todoCard).toContainText("follow up with NewPerson");
		await todoCard.getByRole("button", { name: /add todo/i }).click();

		// 2) The Person is not in the Workspace → a create_person card. Accept it.
		const createPersonCard = chat.page
			.locator('[data-proposal-status="pending"]')
			.last();
		await expect(createPersonCard).toBeVisible({ timeout: 15_000 });
		await expect(createPersonCard).toContainText("NewPerson");
		await createPersonCard.getByRole("button", { name: /add person/i }).click();

		// 3) The re-search finds the new Person → an update_todo link card. Accept it.
		const linkCard = chat.page
			.locator('[data-proposal-status="pending"]')
			.last();
		await expect(linkCard).toBeVisible({ timeout: 15_000 });
		await linkCard.getByRole("button", { name: /update todo/i }).click();
		await expect(acceptedCard(chat)).toBeVisible({ timeout: 15_000 });
		await chat.waitForAssistantText(/done/i);

		// The created Person is linked waiting_on; exactly one Todo and one Person.
		expect(countEntities(dbPath, "todo")).toBe("1");
		expect(countEntities(dbPath, "person")).toBe("1");
		expect(
			sqlite(
				dbPath,
				`SELECT COUNT(*) FROM todo_person_refs r
				 JOIN entities p ON p.id = r.person_id AND p.type = 'person'
				 WHERE r.role = 'waiting_on';`,
			).trim(),
		).toBe("1");
	});
});

/** The newest pending proposal card. */
function pendingCard(chat: { page: Page }) {
	return chat.page.locator('[data-proposal-status="pending"]').last();
}

/** The newest accepted proposal card. */
function acceptedCard(chat: { page: Page }) {
	return chat.page.locator('[data-proposal-status="accepted"]').last();
}

/** Write the capture scenario the Worker reads (per test, before goto). */
function writeScenario(scenario: {
	intent: "todo" | "project" | "person" | "conversation";
	todo?: { title: string; note?: string; due_at?: string; defer_at?: string };
	project?: { name: string; outcome?: string };
	person?: { name: string; note?: string; aliases?: string[] };
	enrich?: {
		person_name?: string;
		person_role?: "waiting_on" | "related";
		project_name?: string;
	};
}): void {
	writeFileSync(captureParamsFile, JSON.stringify(scenario));
}

/** Count accepted entities of a given type. */
function countEntities(dbPath: string, type: string): string {
	return sqlite(
		dbPath,
		`SELECT COUNT(*) FROM entities WHERE type = ${sqlValue(type)};`,
	).trim();
}

/** Count entities of `type` whose provenance is a user Message (created_from a
 * Message, NOT an Entity): source_message_id set, source_entity_id NULL. */
function messageSourcedCount(dbPath: string, type: string): string {
	return sqlite(
		dbPath,
		`SELECT COUNT(*) FROM entity_sources s
		 JOIN entities e ON e.id = s.entity_id AND e.type = ${sqlValue(type)}
		 WHERE s.relation = 'created_from'
		   AND s.source_message_id IS NOT NULL
		   AND s.source_entity_id IS NULL;`,
	).trim();
}

/** Seed a single accepted Person with a known id and name (no Journal Entry).
 * Mirrors todo-extraction.spec.ts's person seed — the enrichment "existing
 * Person" case needs an accepted Person already in the Workspace to link. */
function seedAcceptedPerson(
	dbPath: string,
	personId: string,
	name: string,
): void {
	const now = Date.now();
	const threadId = `seed-thread-${personId}`;
	const runId = `seed-run-${personId}`;
	const userMessageId = `seed-msg-${personId}`;
	const toolCallId = `tc_seed_person_${personId}`;
	const proposalId = `seed-proposal-${personId}`;
	const payload = { name };
	sqlite(
		dbPath,
		`
		BEGIN IMMEDIATE;
		INSERT INTO threads (id, title, created_at, last_activity_at)
		VALUES (${sqlValue(threadId)}, 'Seed thread', ${now}, ${now});
		INSERT INTO runs
			(id, thread_id, workflow_name, workflow_version, provider, model, user_message_id, status, started_at, ended_at, terminal_reason)
		VALUES
			(${sqlValue(runId)}, ${sqlValue(threadId)}, 'default', '1.0.0', 'faux', 'fake-model', ${sqlValue(userMessageId)}, 'completed', ${now}, ${now}, 'completed');
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
