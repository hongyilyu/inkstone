import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { seedAcceptedPerson, sqlite, sqlValue } from "./seed-proposal.js";
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

// One scenario file per DESCRIBE block, each in its own temp dir torn down by that
// describe's own afterAll. A single module-level dir + a FILE-LEVEL afterAll races under
// `fullyParallel` (workers: 4): the afterAll fires once PER WORKER as it drains, so a
// sibling describe's worker can rmSync the shared dir while another describe's test is
// mid-write → `scenario.json` ENOENT. Per-describe dirs make a dir only removable by the
// describe that created it. (The middle "boundary" describe uses the propose worker and
// no scenario file, so it needs none.)
const matrixScenarioDir = mkdtempSync(
	path.join(tmpdir(), "inkstone-capture-matrix-"),
);
const matrixCaptureParamsFile = path.join(matrixScenarioDir, "scenario.json");
const enrichScenarioDir = mkdtempSync(
	path.join(tmpdir(), "inkstone-capture-enrich-"),
);
const enrichCaptureParamsFile = path.join(enrichScenarioDir, "scenario.json");

test.describe("Direct capture intent matrix (faux capture mode)", () => {
	test.use({
		coreOptions: {
			workerCmd: FAUX_WORKER_CMD,
			faux: "capture",
			captureParamsFile: matrixCaptureParamsFile,
		},
	});
	test.afterAll(() => {
		rmSync(matrixScenarioDir, { recursive: true, force: true });
	});

	test("Todo intent: 'Remind me to buy milk' → Add Todo card → Message-sourced Todo", async ({
		chat,
		workspace,
	}) => {
		writeScenario(matrixCaptureParamsFile, {
			intent: "todo",
			todo: { title: "Buy milk" },
		});
		const dbPath = path.join(workspace.path, "db.sqlite");

		await chat.goto();
		await chat.send("Remind me to buy milk.");

		const card = pendingCard(chat);
		await expect(card).toBeVisible({ timeout: 15_000 });
		// The per-kind presentation table drives the review copy + title; assert both
		// render through the real browser, not just the accept button.
		await expect(card).toContainText("Inkstone wants to add a Todo.");
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
		writeScenario(matrixCaptureParamsFile, {
			intent: "project",
			project: { name: "Ship API v2 migration" },
		});
		const dbPath = path.join(workspace.path, "db.sqlite");

		await chat.goto();
		await chat.send("Start a project for API v2 migration.");

		const card = pendingCard(chat);
		await expect(card).toBeVisible({ timeout: 15_000 });
		await expect(card).toContainText("Inkstone wants to add a Project.");
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
		writeScenario(matrixCaptureParamsFile, {
			intent: "person",
			person: { name: "Alice", note: "daycare coordinator" },
		});
		const dbPath = path.join(workspace.path, "db.sqlite");

		await chat.goto();
		await chat.send("Remember Alice is the daycare coordinator.");

		const card = pendingCard(chat);
		await expect(card).toBeVisible({ timeout: 15_000 });
		await expect(card).toContainText("Inkstone wants to add a Person.");
		await expect(card).toContainText("Alice");
		await expect(card).toContainText("daycare coordinator");
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
		writeScenario(matrixCaptureParamsFile, { intent: "conversation" });
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
			captureParamsFile: enrichCaptureParamsFile,
		},
	});
	test.afterAll(() => {
		rmSync(enrichScenarioDir, { recursive: true, force: true });
	});

	test("existing Person: accept the Todo, then accept the update_todo link → todo_person_refs row", async ({
		chat,
		workspace,
	}) => {
		writeScenario(enrichCaptureParamsFile, {
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
		writeScenario(enrichCaptureParamsFile, {
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
function writeScenario(
	file: string,
	scenario: {
		intent: "todo" | "project" | "person" | "conversation";
		todo?: { title: string; note?: string; due_at?: string; defer_at?: string };
		project?: { name: string; outcome?: string };
		person?: { name: string; note?: string; aliases?: string[] };
		enrich?: {
			person_name?: string;
			person_role?: "waiting_on" | "related";
			project_name?: string;
		};
	},
): void {
	writeFileSync(file, JSON.stringify(scenario));
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
