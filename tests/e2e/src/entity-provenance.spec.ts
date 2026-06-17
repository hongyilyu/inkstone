import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures.js";
import type { ChatPage } from "./page-objects/ChatPage.js";
import { sqlite } from "./seed-proposal.js";
import { FAUX_WORKER_CMD } from "./spawnCore.js";

/**
 * Entity Source provenance, end-to-end ("Captured from", ADR-0030): extract a
 * Todo from an accepted Journal Entry (faux `extract` mode), then open the Todo
 * in the Library and follow its "Captured from" footer back to the originating
 * Journal Entry. This is the full read-path proof — Core resolves the
 * `created_from` source, the wire carries it, the codec parses it, and the
 * Inspector renders a working link — that the unit/component suites only cover in
 * isolation.
 *
 * Single-hop (the design decision): a JE-sourced Entity links to the Journal
 * Entry, NOT through it to the chat. The JE then carries its own "Captured from"
 * → Thread, so the chat is one more click away.
 */

const scenarioDir = mkdtempSync(path.join(tmpdir(), "inkstone-provenance-"));
const extractParamsFile = path.join(scenarioDir, "scenario.json");

test.afterAll(() => {
	rmSync(scenarioDir, { recursive: true, force: true });
});

test.describe("Captured-from provenance (faux extract mode)", () => {
	test.use({
		coreOptions: {
			workerCmd: FAUX_WORKER_CMD,
			faux: "extract",
			extractParamsFile,
		},
	});

	test("an extracted Todo links back to its originating Journal Entry", async ({
		chat,
		core,
		workspace,
	}) => {
		const journalText = "Shipped the v2 migration and emailed the team.";
		writeScenario({
			journal_text: journalText,
			todo: { title: "Email the team about v2" },
		});
		const dbPath = path.join(workspace.path, "db.sqlite");

		// 1) Capture: send the journal-worthy message, accept the Journal Entry,
		//    then accept the extracted create_todo.
		await chat.goto();
		await chat.send(journalText);
		await acceptJournalEntry(chat, journalText);

		const todoCard = chat.page
			.locator('[data-proposal-status="pending"]')
			.last();
		await expect(todoCard).toBeVisible({ timeout: 15_000 });
		await expect(todoCard).toContainText("Email the team about v2");
		await todoCard.getByRole("button", { name: /add todo/i }).click();
		await expect(
			chat.page.locator('[data-proposal-status="accepted"]').last(),
		).toBeVisible({ timeout: 15_000 });

		// Ground truth: the Todo is sourced created_from the Journal Entry.
		expect(
			sqlite(
				dbPath,
				`SELECT COUNT(*) FROM entity_sources s
				 JOIN entities t ON t.id = s.entity_id AND t.type = 'todo'
				 JOIN entities je ON je.id = s.source_entity_id AND je.type = 'journal_entry'
				 WHERE s.relation = 'created_from';`,
			).trim(),
		).toBe("1");
		const journalEntryId = sqlite(
			dbPath,
			"SELECT id FROM entities WHERE type = 'journal_entry' LIMIT 1;",
		).trim();

		// 2) Open the Todo in the Library and follow "Captured from".
		await chat.page.goto(`${core.url}/library/todos`);
		const todoRow = chat.page
			.getByRole("region", { name: /todos/i })
			.getByRole("button", { name: /Email the team about v2/i });
		await expect(todoRow).toBeVisible({ timeout: 15_000 });
		await todoRow.click();

		const detail = chat.page.getByRole("complementary", {
			name: /Email the team about v2 details/i,
		});
		await expect(detail).toBeVisible({ timeout: 15_000 });

		// The "Captured from" link carries the Journal Entry title (its body text).
		const capturedLink = detail.getByRole("button", {
			name: new RegExp(journalText.slice(0, 20), "i"),
		});
		await expect(capturedLink).toBeVisible();
		await capturedLink.click();

		// 3) Single-hop: it lands on the source Journal Entry's detail, not the chat.
		await expect(chat.page).toHaveURL(
			new RegExp(`/library/journal\\?id=${journalEntryId}`),
		);
		// The JE detail rail's accessible name is the entry's full body text + " details".
		const journalDetail = chat.page.getByRole("complementary", {
			name: new RegExp(journalText.slice(0, 20), "i"),
		});
		await expect(journalDetail).toBeVisible({ timeout: 15_000 });
	});
});

/** Accept the anchor create_journal_entry proposal and wait for its accepted
 * state, pinned to the stable run id captured while still pending. */
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

/** Write the extraction scenario the Worker reads (per test, before goto). */
function writeScenario(scenario: {
	journal_text: string;
	todo?: { title: string };
}): void {
	writeFileSync(extractParamsFile, JSON.stringify(scenario));
}
