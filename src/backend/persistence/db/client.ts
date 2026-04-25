/**
 * SQLite client for Inkstone's persistence layer.
 *
 * - Uses `bun:sqlite` via `drizzle-orm/bun-sqlite`. Bun ships SQLite
 *   built-in, so no native dep and no platform split (unlike opencode's
 *   bun/node dual client — Inkstone runs only under Bun).
 * - Lazy-initialized singleton. First call opens the file, applies PRAGMAs,
 *   runs pending migrations, then returns the drizzle handle.
 * - PRAGMAs follow opencode's settings: WAL journal, NORMAL sync,
 *   foreign-keys on, 5 s busy timeout, ~64 MB page cache.
 * - Migrations live under `migrations/` and are generated via
 *   `drizzle-kit`. Runtime applies them via `drizzle-orm/bun-sqlite/migrator`.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { DB_FILE, STATE_DIR } from "../paths";
import * as schema from "./schema";

export type DB = BunSQLiteDatabase<typeof schema>;

let cached: DB | null = null;

/**
 * Resolve the migrations folder from its on-disk location inside the
 * source tree. `import.meta.dir` points at this file's directory
 * (`src/backend/persistence/db/`), so the sibling `migrations/` folder is
 * one join away. Works both when running from source (`bun run ...`) and
 * when bundled if the migrations are co-located, which is how we ship
 * today.
 */
function migrationsDir(): string {
	return `${import.meta.dir}/migrations`;
}

export function getDb(): DB {
	if (cached) return cached;

	mkdirSync(dirname(DB_FILE), { recursive: true });
	// Also ensure STATE_DIR exists as a stable anchor for any future
	// sibling state files. Idempotent when the parent already exists.
	mkdirSync(STATE_DIR, { recursive: true });

	const sqlite = new Database(DB_FILE, { create: true });

	// PRAGMAs — mirror opencode's `src/storage/db.ts:89-94`.
	sqlite.exec("PRAGMA journal_mode = WAL;");
	sqlite.exec("PRAGMA synchronous = NORMAL;");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	sqlite.exec("PRAGMA busy_timeout = 5000;");
	sqlite.exec("PRAGMA cache_size = -64000;");

	const db = drizzle(sqlite, { schema });

	// Apply pending migrations before returning. Synchronous under
	// bun:sqlite so callers don't need an async bootstrap.
	migrate(db, { migrationsFolder: migrationsDir() });

	cached = db;
	return cached;
}
