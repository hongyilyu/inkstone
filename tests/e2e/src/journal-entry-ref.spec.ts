import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures.js";
import { PROPOSE_WORKER_CMD } from "./spawnCore.js";

const proposalDir = mkdtempSync(path.join(tmpdir(), "inkstone-ref-proposal-"));
const proposalParamsFile = path.join(proposalDir, "proposal.json");

const THREAD_ID = "01900000-0000-7000-8000-000000000100";
const SOURCE_ENTITY_ID = "01900000-0000-7000-8000-000000000101";
const TARGET_ENTITY_ID = "01900000-0000-7000-8000-000000000102";

test.afterAll(() => {
	rmSync(proposalDir, { recursive: true, force: true });
});

test.use({
	coreOptions: {
		workerCmd: PROPOSE_WORKER_CMD,
		proposalParamsFile,
	},
});

test("accepting a reference proposal renders a clickable Journal Entry inline ref", async ({
	chat,
	core,
	page,
	workspace,
}) => {
	const dbPath = path.join(workspace.path, "db.sqlite");
	seedAcceptedJournalEntryAndPerson(dbPath);
	writeReferenceProposalParams();

	await chat.goto();
	await chat.openThread("Journal ref thread");
	await expect(chat.page.getByText("Met Ada at school.")).toBeVisible();

	await chat.send("Link Ada in that journal entry.");

	const card = chat.proposalCard();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(card).toContainText("Reference existing Entity");
	await card.getByRole("button", { name: /link entity/i }).click();

	await expect(card).toContainText(/linked in journal/i, { timeout: 15_000 });
	await chat.waitForAssistantText(/done.*added it/i);
	expect(
		sqlite(
			dbPath,
			`SELECT COUNT(*) FROM entity_refs WHERE source_entity_id = '${SOURCE_ENTITY_ID}' AND target_entity_id = '${TARGET_ENTITY_ID}';`,
		).trim(),
	).toBe("1");

	await page.goto(`${core.url}/library/journal`);
	const journal = page.getByRole("region", { name: /journal/i });
	const entry = journal.getByRole("button", {
		name: /Met Ada Lovelace at school\./,
	});
	await expect(entry).toBeVisible({ timeout: 15_000 });
	await entry.click();

	const detail = page.getByRole("complementary", {
		name: /Met Ada Lovelace at school\. details/i,
	});
	const chip = detail.getByRole("button", { name: "Ada Lovelace" });
	await expect(chip).toBeVisible();
	await chip.click();

	await expect(page).toHaveURL(
		new RegExp(`/library/people\\?id=${TARGET_ENTITY_ID}`),
	);
	await expect(
		page.getByRole("complementary", { name: /Ada Lovelace details/i }),
	).toBeVisible();
});

function writeReferenceProposalParams(): void {
	writeFileSync(
		proposalParamsFile,
		JSON.stringify({
			mutation_kind: "reference_existing_entity_from_journal_entry",
			payload: {
				source_entity_id: SOURCE_ENTITY_ID,
				target_entity_id: TARGET_ENTITY_ID,
				label_snapshot: "Ada snapshot",
				body: [
					{ type: "text", text: "Met " },
					{ type: "entity_ref" },
					{ type: "text", text: " at school." },
				],
			},
			rationale: "link the accepted Person from this Journal Entry",
		}),
	);
}

function seedAcceptedJournalEntryAndPerson(dbPath: string): void {
	const now = Date.now();
	const sourcePayload = {
		occurred_at: "2026-06-10T10:30:00",
		body: [{ type: "text", text: "Met Ada at school." }],
	};
	const targetPayload = {
		name: "Ada Lovelace",
		note: "Current canonical name",
	};
	sqlite(
		dbPath,
		`
		BEGIN IMMEDIATE;
		INSERT INTO threads (id, title, created_at, last_activity_at)
		VALUES (${sqlValue(THREAD_ID)}, 'Journal ref thread', ${now}, ${now});

		INSERT INTO runs
			(id, thread_id, workflow_name, workflow_version, provider, model, user_message_id, status, started_at, ended_at, terminal_reason)
		VALUES
			('01900000-0000-7000-8000-000000000111', ${sqlValue(THREAD_ID)}, 'default', '1.0.0', 'faux', 'fake-model', '01900000-0000-7000-8000-000000000112', 'completed', ${now}, ${now}, 'completed');
		INSERT INTO messages (id, thread_id, run_id, role, status, created_at, updated_at)
		VALUES ('01900000-0000-7000-8000-000000000112', ${sqlValue(THREAD_ID)}, '01900000-0000-7000-8000-000000000111', 'user', 'completed', ${now}, ${now});
		INSERT INTO message_parts (message_id, seq, type, text)
		VALUES ('01900000-0000-7000-8000-000000000112', 0, 'text', 'Met Ada at school.');
		INSERT INTO tool_calls (id, run_id, name, request_payload, status, result_payload, requested_at, resolved_at)
		VALUES ('tc_source_ref', '01900000-0000-7000-8000-000000000111', 'propose_workspace_mutation', ${jsonValue(
			{
				mutation_kind: "create_journal_entry",
				payload: sourcePayload,
			},
		)}, 'completed', '{}', ${now}, ${now});
		INSERT INTO proposals (id, tool_call_id, mutation_kind, status, decided_by, decided_at, applied_at)
		VALUES ('01900000-0000-7000-8000-000000000113', 'tc_source_ref', 'create_journal_entry', 'accepted', 'user', ${now}, ${now});
		INSERT INTO entities (id, type, schema_version, data, created_by, created_via_proposal_id, created_at, updated_at)
		VALUES (${sqlValue(SOURCE_ENTITY_ID)}, 'journal_entry', 1, ${jsonValue(sourcePayload)}, 'proposal', '01900000-0000-7000-8000-000000000113', ${now}, ${now});
		INSERT INTO entity_revisions (entity_id, seq, data, proposal_id, created_at)
		VALUES (${sqlValue(SOURCE_ENTITY_ID)}, 1, ${jsonValue(sourcePayload)}, '01900000-0000-7000-8000-000000000113', ${now});
		INSERT INTO entity_sources (id, entity_id, source_message_id, relation, created_at)
		VALUES ('01900000-0000-7000-8000-000000000114', ${sqlValue(SOURCE_ENTITY_ID)}, '01900000-0000-7000-8000-000000000112', 'created_from', ${now});

		INSERT INTO runs
			(id, thread_id, workflow_name, workflow_version, provider, model, user_message_id, status, started_at, ended_at, terminal_reason)
		VALUES
			('01900000-0000-7000-8000-000000000121', ${sqlValue(THREAD_ID)}, 'default', '1.0.0', 'faux', 'fake-model', '01900000-0000-7000-8000-000000000122', 'completed', ${now}, ${now}, 'completed');
		INSERT INTO messages (id, thread_id, run_id, role, status, created_at, updated_at)
		VALUES ('01900000-0000-7000-8000-000000000122', ${sqlValue(THREAD_ID)}, '01900000-0000-7000-8000-000000000121', 'user', 'completed', ${now}, ${now});
		INSERT INTO message_parts (message_id, seq, type, text)
		VALUES ('01900000-0000-7000-8000-000000000122', 0, 'text', 'Ada Lovelace.');
		INSERT INTO tool_calls (id, run_id, name, request_payload, status, result_payload, requested_at, resolved_at)
		VALUES ('tc_target_person', '01900000-0000-7000-8000-000000000121', 'propose_workspace_mutation', '{}', 'completed', '{}', ${now}, ${now});
		INSERT INTO proposals (id, tool_call_id, mutation_kind, status, decided_by, decided_at, applied_at)
		VALUES ('01900000-0000-7000-8000-000000000123', 'tc_target_person', 'seed_entity', 'accepted', 'user', ${now}, ${now});
		INSERT INTO entities (id, type, schema_version, data, created_by, created_via_proposal_id, created_at, updated_at)
		VALUES (${sqlValue(TARGET_ENTITY_ID)}, 'person', 1, ${jsonValue(targetPayload)}, 'proposal', '01900000-0000-7000-8000-000000000123', ${now}, ${now});
		INSERT INTO entity_revisions (entity_id, seq, data, proposal_id, created_at)
		VALUES (${sqlValue(TARGET_ENTITY_ID)}, 1, ${jsonValue(targetPayload)}, '01900000-0000-7000-8000-000000000123', ${now});
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
