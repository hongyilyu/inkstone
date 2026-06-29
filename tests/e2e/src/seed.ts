import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Direct tier-2 seeding for full-system specs that drive Core's read/write
 * surfaces without a Run (ADR-0033 `entity/mutate`, ADR-0031 GTD views). Mirrors
 * the seed helper in `gtd-views.spec.ts`: open the per-test Workspace DB with the
 * `sqlite3` CLI and INSERT canonical rows exactly as an accepted Proposal would.
 *
 * Seeded rows are `created_by='user'` with no proposal id — the same shape a
 * direct user CRUD write lands, so `entity/list` returns them verbatim.
 */

/** Resolve the per-test Workspace DB path from a `workspace.path` fixture value. */
export function dbPathFor(workspacePath: string): string {
	return path.join(workspacePath, "db.sqlite");
}

interface SeedEntity {
	readonly id: string;
	readonly type: "person" | "project" | "todo" | "journal_entry" | "media";
	readonly data: unknown;
}

interface SeedPersonRef {
	readonly todoId: string;
	readonly personId: string;
	readonly role: "waiting_on" | "related";
}

/** Insert entities (+ optional todo_person_refs) into the Workspace DB in one tx. */
export function seedEntities(
	dbPath: string,
	entities: readonly SeedEntity[],
	personRefs: readonly SeedPersonRef[] = [],
): void {
	const now = Date.now();
	const entityStmt = (e: SeedEntity) =>
		`INSERT INTO entities (id, type, schema_version, data, created_by, created_via_proposal_id, created_at, updated_at)
			VALUES (${sqlValue(e.id)}, ${sqlValue(e.type)}, 1, ${jsonValue(e.data)}, 'user', NULL, ${now}, ${now});`;
	const refStmt = (r: SeedPersonRef) =>
		`INSERT INTO todo_person_refs (todo_id, person_id, role, created_at, updated_at)
			VALUES (${sqlValue(r.todoId)}, ${sqlValue(r.personId)}, ${sqlValue(r.role)}, ${now}, ${now});`;

	sqlite(
		dbPath,
		`
		BEGIN IMMEDIATE;
		${entities.map(entityStmt).join("\n")}
		${personRefs.map(refStmt).join("\n")}
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

/** Query a single scalar value (first column of the first row), trimmed. */
export function sqliteScalar(dbPath: string, query: string): string {
	return execFileSync("sqlite3", [dbPath], {
		input: `.timeout 5000\n${query}`,
		encoding: "utf8",
	}).trim();
}

function sqlValue(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function jsonValue(value: unknown): string {
	return sqlValue(JSON.stringify(value));
}
