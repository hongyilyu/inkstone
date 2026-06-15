import { execFileSync } from "node:child_process";

/**
 * Provenance seeding for full-system specs that need an Entity already accepted
 * VIA A PROPOSAL before the Run starts — the `created_by='proposal'` shape, the
 * exact rows an accepted Proposal lands. This is the contract sibling of
 * `seed.ts`, which seeds the `created_by='user'` direct-CRUD shape.
 *
 * It builds the full provenance chain once
 *   threads → runs → messages → message_parts → tool_calls → proposals
 *   → entities → entity_revisions
 * parameterized on entity type / mutation_kind / payload, so it can seed an
 * accepted Person or Project today and extend to JournalEntry later. All ids are
 * derived from the entity id, so each seeded Entity carries its own self-consistent
 * chain in a fresh per-test Workspace DB.
 */

/** The accepted-via-proposal entity types this seed currently supports. */
type SeededEntityType = "person" | "project" | "journal_entry";

interface SeedAcceptedEntity {
	readonly id: string;
	readonly type: SeededEntityType;
	readonly mutationKind: string;
	readonly payload: unknown;
}

/** Insert one accepted-via-proposal Entity and its full provenance chain. */
export function seedAcceptedEntity(
	dbPath: string,
	entity: SeedAcceptedEntity,
): void {
	const now = Date.now();
	const { id, type, mutationKind, payload } = entity;
	const threadId = `seed-thread-${id}`;
	const runId = `seed-run-${id}`;
	const userMessageId = `seed-msg-${id}`;
	const toolCallId = `tc_seed_${type}_${id}`;
	const proposalId = `seed-proposal-${id}`;
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
		VALUES (${sqlValue(userMessageId)}, 0, 'text', ${jsonValue(payload)});
		INSERT INTO tool_calls (id, run_id, name, request_payload, status, result_payload, requested_at, resolved_at)
		VALUES (${sqlValue(toolCallId)}, ${sqlValue(runId)}, 'propose_workspace_mutation', '{}', 'completed', '{}', ${now}, ${now});
		INSERT INTO proposals (id, tool_call_id, mutation_kind, status, decided_by, decided_at, applied_at)
		VALUES (${sqlValue(proposalId)}, ${sqlValue(toolCallId)}, ${sqlValue(mutationKind)}, 'accepted', 'user', ${now}, ${now});
		INSERT INTO entities (id, type, schema_version, data, created_by, created_via_proposal_id, created_at, updated_at)
		VALUES (${sqlValue(id)}, ${sqlValue(type)}, 1, ${jsonValue(payload)}, 'proposal', ${sqlValue(proposalId)}, ${now}, ${now});
		INSERT INTO entity_revisions (entity_id, seq, data, proposal_id, created_at)
		VALUES (${sqlValue(id)}, 1, ${jsonValue(payload)}, ${sqlValue(proposalId)}, ${now});
		COMMIT;
		`,
	);
}

/** Seed a single accepted Person (`create_person`) with a known id and name. */
export function seedAcceptedPerson(
	dbPath: string,
	personId: string,
	name: string,
): void {
	seedAcceptedEntity(dbPath, {
		id: personId,
		type: "person",
		mutationKind: "create_person",
		payload: { name },
	});
}

/** Seed a single accepted Project (`create_project`) with a known id and name,
 * with the `status: "active"` that create_project stores. */
export function seedAcceptedProject(
	dbPath: string,
	projectId: string,
	name: string,
): void {
	seedAcceptedEntity(dbPath, {
		id: projectId,
		type: "project",
		mutationKind: "create_project",
		payload: { name, status: "active" },
	});
}

/** Run `input` against the DB through the `sqlite3` CLI with FKs on. */
export function sqlite(dbPath: string, input: string): string {
	return execFileSync("sqlite3", [dbPath], {
		input: `.timeout 5000\nPRAGMA foreign_keys = ON;\n${input}`,
		encoding: "utf8",
	});
}

export function sqlValue(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

export function jsonValue(value: unknown): string {
	return sqlValue(JSON.stringify(value));
}
