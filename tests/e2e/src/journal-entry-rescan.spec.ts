import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures.js";
import { jsonValue, sqlite, sqlValue } from "./seed-proposal.js";
import { FAUX_WORKER_CMD, PROPOSE_WORKER_CMD } from "./spawnCore.js";

/**
 * Journal-Entry re-scan, end-to-end (ADR-0042, slice 6): real Core + the built Web
 * Client. An ACCEPTED Journal Entry J whose prose names a person ("Priya") the first
 * pass missed sits in thread T. The user opens J in the Library and clicks "Scan
 * again" (slice 5), which calls `journal_entry/rescan { je_id: J }`; Core resolves
 * J's origin Thread T and spawns a fresh agent Run THERE. The faux re-scan turn is
 * scripted — the deterministic `propose-worker` fixture emits ONE `apply_intent_graph`
 * in ANCHOR-REUSE mode (journal_entry.existing_id = J + a "Priya" person node + a
 * journal_ref carrying match_text "Priya"). Accepting splices a chip into J's STORED
 * body and writes the backlink, minting NO new Journal Entry.
 *
 * The agent's recognition is non-deterministic against a real model, so the proposal
 * is scripted (the resolve/apply behavior of anchor-reuse is proven by the Core unit
 * tests; this spec proves the slice-5 button → slice-6 RPC → spawn → anchor-reuse
 * apply path). Asserts the four acceptance facts: (a) a new Person "Priya" exists;
 * (b) an entity_refs row from J → Priya; (c) entities still has exactly ONE
 * journal_entry, == J (no new JE minted); (d) J's latest revision body now carries
 * an entity_ref chip where "Priya" was, surrounding prose intact.
 */

// UUID-shaped so the rescan result's thread_id parses + navigates (the JE id rides a
// plain-string `je_id` param, but T flows back through the UUID-typed thread route).
const THREAD_ID = "01900000-0000-7000-8000-0000000000c0";
const RUN_ID = "01900000-0000-7000-8000-0000000000c1";
const USER_MSG_ID = "01900000-0000-7000-8000-0000000000c2";
const JE_ID = "01900000-0000-7000-8000-0000000000c3";
const PROPOSAL_ID = "01900000-0000-7000-8000-0000000000c4";
const TOOL_CALL_ID = "tc_je_rescan_seed";

const JE_PROSE = "Caught up with Priya about the roadmap.";
const PERSON_NAME = "Priya";

const proposalDir = mkdtempSync(
	path.join(tmpdir(), "inkstone-rescan-proposal-"),
);
const proposalParamsFile = path.join(proposalDir, "proposal.json");

test.afterAll(() => {
	rmSync(proposalDir, { recursive: true, force: true });
});

function dbPathFor(workspacePath: string): string {
	return path.join(workspacePath, "db.sqlite");
}

function count(dbPath: string, sql: string): string {
	return sqlite(dbPath, sql).trim();
}

/** Seed an ACCEPTED Journal Entry J in thread T, created_from a user Message in T
 * (the provenance the rescan RPC + the in-tx cross-thread guard both read). Its prose
 * names "Priya" as plain text — nothing chipped yet. */
function seedAcceptedJournalEntry(dbPath: string): void {
	const now = Date.now();
	const payload = {
		occurred_at: "2026-06-10T10:30:00",
		body: [{ type: "text", text: JE_PROSE }],
	};
	sqlite(
		dbPath,
		`
		BEGIN IMMEDIATE;
		INSERT INTO threads (id, title, created_at, last_activity_at)
		VALUES (${sqlValue(THREAD_ID)}, 'Roadmap sync', ${now}, ${now});
		INSERT INTO runs
			(id, thread_id, workflow_name, workflow_version, provider, model, thinking_level, user_message_id, status, started_at, ended_at, terminal_reason)
		VALUES
			(${sqlValue(RUN_ID)}, ${sqlValue(THREAD_ID)}, 'default', '1.0.0', 'faux', 'fake-model', 'off', ${sqlValue(USER_MSG_ID)}, 'completed', ${now}, ${now}, 'completed');
		INSERT INTO messages (id, thread_id, run_id, role, status, created_at, updated_at)
		VALUES (${sqlValue(USER_MSG_ID)}, ${sqlValue(THREAD_ID)}, ${sqlValue(RUN_ID)}, 'user', 'completed', ${now}, ${now});
		INSERT INTO message_parts (message_id, seq, type, text)
		VALUES (${sqlValue(USER_MSG_ID)}, 0, 'text', ${sqlValue(JE_PROSE)});
		INSERT INTO tool_calls (id, run_id, name, request_payload, status, result_payload, requested_at, resolved_at)
		VALUES (${sqlValue(TOOL_CALL_ID)}, ${sqlValue(RUN_ID)}, 'propose_workspace_mutation', ${jsonValue({ mutation_kind: "create_journal_entry", payload })}, 'completed', '{}', ${now}, ${now});
		INSERT INTO proposals (id, tool_call_id, mutation_kind, status, decided_by, decided_at, applied_at)
		VALUES (${sqlValue(PROPOSAL_ID)}, ${sqlValue(TOOL_CALL_ID)}, 'create_journal_entry', 'accepted', 'user', ${now}, ${now});
		INSERT INTO entities (id, type, schema_version, data, created_by, created_via_proposal_id, created_at, updated_at)
		VALUES (${sqlValue(JE_ID)}, 'journal_entry', 1, ${jsonValue(payload)}, 'proposal', ${sqlValue(PROPOSAL_ID)}, ${now}, ${now});
		INSERT INTO entity_revisions (entity_id, seq, data, proposal_id, created_at)
		VALUES (${sqlValue(JE_ID)}, 1, ${jsonValue(payload)}, ${sqlValue(PROPOSAL_ID)}, ${now});
		INSERT INTO entity_sources (id, entity_id, source_message_id, relation, created_at)
		VALUES ('es_je_rescan', ${sqlValue(JE_ID)}, ${sqlValue(USER_MSG_ID)}, 'created_from', ${now});
		COMMIT;
		`,
	);
}

// ── The full button → RPC → spawn → anchor-reuse apply flow ──────────────────
test.describe("Scan again drives an anchor-reuse re-scan", () => {
	// The re-scan Run's turn is scripted by the deterministic propose-worker fixture:
	// it emits the anchor-reuse graph from this params file, then parks.
	test.use({
		coreOptions: { workerCmd: PROPOSE_WORKER_CMD, proposalParamsFile },
	});

	test("re-scan splices the missed Person into J — no new JE minted", async ({
		chat,
		page,
		workspace,
	}) => {
		const dbPath = dbPathFor(workspace.path);
		seedAcceptedJournalEntry(dbPath);
		// The anchor-reuse graph the re-scan turn proposes: reuse J (NO body), one
		// "Priya" person node, one journal_ref splicing at the exact substring "Priya".
		writeFileSync(
			proposalParamsFile,
			JSON.stringify({
				mutation_kind: "apply_intent_graph",
				payload: {
					journal_entry: {
						handle: "@je",
						existing_id: JE_ID,
						occurred_at: "2026-06-10T10:30:00",
					},
					entities: [{ handle: "@priya", type: "person", name: PERSON_NAME }],
					links: [
						{
							kind: "journal_ref",
							from: "@je",
							to: "@priya",
							match_text: PERSON_NAME,
						},
					],
				},
				rationale: "re-scan found a Person mentioned but not yet captured",
			}),
		);

		// Open J's Library detail and click "Scan again" (slice 5) — this fires the
		// journal_entry/rescan RPC and navigates to J's origin Thread T.
		await chat.gotoPath(`/library/journal?id=${JE_ID}`);
		await page
			.getByRole("button", { name: /scan again for missed entities/i })
			.click();

		// We land on T; the spawned re-scan Run proposes the anchor-reuse graph, which
		// rehydrates the review card.
		await expect(page).toHaveURL(new RegExp(`/thread/${THREAD_ID}`), {
			timeout: 15_000,
		});
		const card = page.locator('[data-proposal-kind="apply_intent_graph"]');
		await expect(card).toBeVisible({ timeout: 15_000 });
		await expect(card.locator('[data-graph-node="@priya"]')).toContainText(
			PERSON_NAME,
		);

		const runId = await card.getAttribute("data-proposal");
		expect(runId).not.toBeNull();
		const decidedCard = page.locator(`[data-proposal="${runId}"]`);

		// Accept the single new Person — anchor-reuse applies in one tx.
		await card.getByRole("button", { name: /apply 1 item/i }).click();
		await expect(decidedCard).toContainText(/applied/i, { timeout: 15_000 });

		// (a) A new Person "Priya" exists in the Library.
		expect(
			count(
				dbPath,
				`SELECT COUNT(*) FROM entities WHERE type = 'person' AND json_extract(data, '$.name') = ${sqlValue(PERSON_NAME)};`,
			),
		).toBe("1");
		const priyaId = count(
			dbPath,
			`SELECT id FROM entities WHERE type = 'person' AND json_extract(data, '$.name') = ${sqlValue(PERSON_NAME)};`,
		);
		expect(priyaId.length).toBeGreaterThan(0);

		// (b) An entity_refs row from J (the existing JE) → Priya — the backlink.
		expect(
			count(
				dbPath,
				`SELECT COUNT(*) FROM entity_refs WHERE source_entity_id = ${sqlValue(JE_ID)} AND target_entity_id = ${sqlValue(priyaId)};`,
			),
		).toBe("1");

		// (c) Exactly ONE journal_entry row, and it is still J — NO new JE minted.
		expect(
			count(
				dbPath,
				"SELECT COUNT(*) FROM entities WHERE type = 'journal_entry';",
			),
		).toBe("1");
		expect(
			count(dbPath, "SELECT id FROM entities WHERE type = 'journal_entry';"),
		).toBe(JE_ID);

		// (d) J's LATEST revision body now carries an entity_ref chip where "Priya"
		// was, with the surrounding prose intact. The splice rewrites the single text
		// node into text("Caught up with ") + entity_ref(ref_id) + text(" about the
		// roadmap."), so the latest body has exactly one entity_ref node whose ref_id
		// is the backlink's id, and "Priya" no longer appears as plain text.
		const refId = count(
			dbPath,
			`SELECT id FROM entity_refs WHERE source_entity_id = ${sqlValue(JE_ID)} AND target_entity_id = ${sqlValue(priyaId)};`,
		);
		const latestBody = sqlite(
			dbPath,
			`SELECT data FROM entity_revisions WHERE entity_id = ${sqlValue(JE_ID)} ORDER BY seq DESC LIMIT 1;`,
		).trim();
		const body = JSON.parse(latestBody).body as Array<{
			type: string;
			text?: string;
			ref_id?: string;
		}>;
		const chips = body.filter((n) => n.type === "entity_ref");
		expect(chips).toHaveLength(1);
		expect(chips[0].ref_id).toBe(refId);
		// Surrounding prose intact; "Priya" is now a chip, not plain text.
		const prose = body
			.filter((n) => n.type === "text")
			.map((n) => n.text ?? "")
			.join("");
		expect(prose).toBe("Caught up with  about the roadmap.");
		expect(prose).not.toContain(PERSON_NAME);
	});
});

// ── Empty re-scan: a text-only turn proposes nothing ─────────────────────────
test.describe("an empty re-scan proposes nothing", () => {
	// The faux interpreter just replies conversationally (no tool call), so the
	// re-scan Run completes with text and NO proposal card.
	test.use({
		coreOptions: {
			workerCmd: FAUX_WORKER_CMD,
			fauxResponse:
				"I re-read that entry and didn't find anything new to capture.",
		},
	});

	test("a re-scan that finds nothing new shows a reply and no proposal card", async ({
		chat,
		page,
		workspace,
	}) => {
		const dbPath = dbPathFor(workspace.path);
		seedAcceptedJournalEntry(dbPath);

		await chat.gotoPath(`/library/journal?id=${JE_ID}`);
		await page
			.getByRole("button", { name: /scan again for missed entities/i })
			.click();

		await expect(page).toHaveURL(new RegExp(`/thread/${THREAD_ID}`), {
			timeout: 15_000,
		});
		// The conversational reply lands; NO proposal card appears.
		await chat.waitForAssistantText(/didn't find anything new to capture/i);
		await expect(
			page.locator('[data-proposal-kind="apply_intent_graph"]'),
		).toHaveCount(0);
		// Nothing minted: still exactly one journal_entry (J), zero People.
		expect(
			count(
				dbPath,
				"SELECT COUNT(*) FROM entities WHERE type = 'journal_entry';",
			),
		).toBe("1");
		expect(
			count(dbPath, "SELECT COUNT(*) FROM entities WHERE type = 'person';"),
		).toBe("0");
	});
});
