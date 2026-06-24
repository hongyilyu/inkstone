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

/** Seed a single accepted Person (`create_person`) with a known id and name, plus
 * an optional `note` (the field `libraryItemSubtitle` renders, so two same-named
 * People can be told apart in a disambiguation picker). */
export function seedAcceptedPerson(
	dbPath: string,
	personId: string,
	name: string,
	note?: string,
): void {
	seedAcceptedEntity(dbPath, {
		id: personId,
		type: "person",
		mutationKind: "create_person",
		payload: note === undefined ? { name } : { name, note },
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

/**
 * Seed a PARKED `apply_intent_graph` proposal (ADR-0042) the user can review and
 * decide. Unlike {@link seedAcceptedEntity} (which lands an already-accepted
 * Entity), this builds the rows a parked Run carries while it AWAITS a decision:
 *   threads → runs(status='parked', awaiting_tool_call_id) → messages(user +
 *   streaming assistant) → tool_calls(pending, request_payload = the graph
 *   envelope) → proposals(pending) → run_log(proposal_pending milestone)
 * so opening the Thread rehydrates the review card (the no-hub subscribe reads
 * `parked` and re-pushes `proposal/pending`, exactly like a real park). Accepting
 * resolves+applies the graph in one tx (the resume then spawns a Worker, but the
 * apply is committed before resume, so DB assertions hold regardless).
 *
 * `graph` is the intent-graph payload (the `{journal_entry?, entities, links}`
 * object); it is wrapped in the `{mutation_kind, payload, rationale}` request
 * envelope Core reads at `proposal/get`.
 */
export function seedParkedIntentGraphProposal(
	dbPath: string,
	options: { graph: unknown; title?: string; rationale?: string },
): void {
	const now = Date.now();
	// `run_id`/`thread_id` flow through UUID-typed wire params (`run/subscribe`,
	// `proposal/get`, `thread/get`), so the seeded ids MUST be UUID-shaped — a
	// non-UUID would fail param decode and never rehydrate the card. (Entity ids
	// in `seedAcceptedEntity` need not be, since they never cross a UUID param.)
	const threadId = "01900000-0000-7000-8000-00000000ab01";
	const runId = "01900000-0000-7000-8000-00000000ab02";
	const userMessageId = "01900000-0000-7000-8000-00000000ab03";
	const assistantMessageId = "01900000-0000-7000-8000-00000000ab04";
	const toolCallId = "tc_seed_intentgraph";
	const proposalId = "01900000-0000-7000-8000-00000000ab05";
	const title = options.title ?? "Captured note";
	const requestPayload = {
		mutation_kind: "apply_intent_graph",
		payload: options.graph,
		rationale: options.rationale ?? "Recognized these from your note.",
	};
	sqlite(
		dbPath,
		`
		BEGIN IMMEDIATE;
		INSERT INTO threads (id, title, created_at, last_activity_at)
		VALUES (${sqlValue(threadId)}, ${sqlValue(title)}, ${now}, ${now});
		INSERT INTO runs
			(id, thread_id, workflow_name, workflow_version, provider, model, thinking_level, user_message_id, status, started_at)
		VALUES
			(${sqlValue(runId)}, ${sqlValue(threadId)}, 'default', '1.0.0', 'faux', 'fake-model', 'off', ${sqlValue(userMessageId)}, 'parked', ${now});
		INSERT INTO messages (id, thread_id, run_id, role, status, created_at, updated_at)
		VALUES (${sqlValue(userMessageId)}, ${sqlValue(threadId)}, ${sqlValue(runId)}, 'user', 'completed', ${now}, ${now});
		INSERT INTO message_parts (message_id, seq, type, text)
		VALUES (${sqlValue(userMessageId)}, 0, 'text', ${sqlValue(title)});
		INSERT INTO messages (id, thread_id, run_id, role, status, created_at, updated_at)
		VALUES (${sqlValue(assistantMessageId)}, ${sqlValue(threadId)}, ${sqlValue(runId)}, 'assistant', 'streaming', ${now}, ${now});
		INSERT INTO message_parts (message_id, seq, type, text)
		VALUES (${sqlValue(assistantMessageId)}, 0, 'text', '');
		INSERT INTO run_steps (run_id, seq, kind, message_id, part_seq, tool_call_id, created_at)
		VALUES (${sqlValue(runId)}, 0, 'message', ${sqlValue(userMessageId)}, 0, NULL, ${now});
		INSERT INTO run_steps (run_id, seq, kind, message_id, part_seq, tool_call_id, created_at)
		VALUES (${sqlValue(runId)}, 1, 'message', ${sqlValue(assistantMessageId)}, 0, NULL, ${now});
		INSERT INTO tool_calls (id, run_id, name, request_payload, status, requested_at)
		VALUES (${sqlValue(toolCallId)}, ${sqlValue(runId)}, 'propose_workspace_mutation', ${jsonValue(requestPayload)}, 'pending', ${now});
		INSERT INTO run_steps (run_id, seq, kind, message_id, part_seq, tool_call_id, created_at)
		VALUES (${sqlValue(runId)}, 2, 'tool_call', NULL, NULL, ${sqlValue(toolCallId)}, ${now});
		INSERT INTO proposals (id, tool_call_id, mutation_kind, status)
		VALUES (${sqlValue(proposalId)}, ${sqlValue(toolCallId)}, 'apply_intent_graph', 'pending');
		INSERT INTO run_log (run_id, run_seq, kind, payload, created_at)
		VALUES (${sqlValue(runId)}, 0, 'proposal_pending', ${jsonValue({ proposal_id: proposalId, tool_call_id: toolCallId, mutation_kind: "apply_intent_graph" })}, ${now});
		UPDATE runs SET awaiting_tool_call_id = ${sqlValue(toolCallId)} WHERE id = ${sqlValue(runId)};
		COMMIT;
		`,
	);
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
