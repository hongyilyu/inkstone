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

	test("conversation intent: a question proposes nothing", async ({ chat }) => {
		writeScenario({ intent: "conversation" });

		await chat.goto();
		await chat.send("What should I focus on today?");

		// A plain reply, no proposal card.
		await chat.waitForAssistantText(/.+/);
		await expect(chat.proposalCard()).toHaveCount(0);
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
