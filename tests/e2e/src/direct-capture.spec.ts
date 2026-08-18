import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures.js";
import { acceptedCard, pendingCard } from "./proposal-cards.js";
import { sqlite, sqlValue } from "./seed-proposal.js";
import { FAUX_PROPOSE_JOURNAL_FIXTURE, FAUX_WORKER_CMD } from "./spawnCore.js";

/**
 * Direct capture intent matrix, end-to-end: real Core + the faux `capture`
 * Worker + the built Web Client. A project/person-shaped Message proposes the
 * right create_* card, sourced from the user Message — NO Journal Entry.
 * Accepting resumes the Run and lands a Message-sourced Accepted Entity. Tasks
 * are NOT captured (ADR-0064: they redirect to TickTick), so there is no Todo row.
 *
 *   | Message intent          | first proposal card |
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
			proposeParamsFile: FAUX_PROPOSE_JOURNAL_FIXTURE,
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

		// A Journal Entry landed; no direct Project/Person from this path.
		expect(countEntities(dbPath, "journal_entry")).toBe("1");
		expect(countEntities(dbPath, "project")).toBe("0");
		expect(countEntities(dbPath, "person")).toBe("0");
	});
});

/** Write the capture scenario the Worker reads (per test, before goto). */
function writeScenario(
	file: string,
	scenario: {
		intent: "project" | "person" | "conversation";
		project?: { name: string; outcome?: string };
		person?: { name: string; note?: string; aliases?: string[] };
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
