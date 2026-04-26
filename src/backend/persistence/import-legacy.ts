/**
 * One-shot import of the legacy `~/.local/state/inkstone/session.json`
 * into the SQLite session store.
 *
 * Trigger: on first boot after the DB lands, if the DB has zero sessions
 * AND the old JSON file exists, import it as a single session row with
 * its display messages. The legacy file had no `AgentMessage[]`, so
 * hydrating `agent.state.messages` on resume will still be empty for
 * imported sessions — that's the same behavior as before the DB (known
 * issue); new sessions going forward get full restore.
 *
 * After a successful import the JSON file is renamed to
 * `session.json.migrated` rather than deleted, so the user can recover
 * by hand if the import loses something. Never re-imports on subsequent
 * boots because the rename takes the trigger away.
 */

import { existsSync, readFileSync, renameSync, statSync } from "node:fs";
import type { DisplayMessage, SessionData } from "@bridge/view-model";
import { count } from "drizzle-orm";
import { getDb } from "./db/client";
import { sessions } from "./db/schema";
import { reportPersistenceError } from "./errors";
import { SESSION_FILE } from "./paths";
import {
	appendDisplayMessage,
	createSession,
	runInTransaction,
} from "./sessions";

const MIGRATED_SUFFIX = ".migrated";

function migrateLegacyDisplayMessage(msg: DisplayMessage): DisplayMessage {
	// Pre-`parts` sessions stored a `text: string`; rebuild as one text part.
	if (Array.isArray(msg.parts)) return msg;
	const legacy = msg as DisplayMessage & { text?: string };
	return {
		...msg,
		parts: legacy.text ? [{ type: "text", text: legacy.text }] : [],
	};
}

export function importLegacySessionJsonIfNeeded(defaultAgent: string): void {
	if (!existsSync(SESSION_FILE)) return;

	let raw: string;
	try {
		raw = readFileSync(SESSION_FILE, "utf-8");
	} catch (error) {
		reportPersistenceError({ kind: "db", action: "import-read", error });
		return;
	}

	// Empty sentinel from `clearSession()` — nothing to import.
	if (!raw.trim() || raw.trim() === "{}") {
		try {
			renameSync(SESSION_FILE, SESSION_FILE + MIGRATED_SUFFIX);
		} catch {
			// best-effort — not fatal
		}
		return;
	}

	// Only import if the DB is empty. Otherwise we'd risk duplicating a
	// session the user has already interacted with after a botched
	// previous import.
	const db = getDb();
	let existing: number;
	try {
		existing = db.select({ n: count() }).from(sessions).all()[0]?.n ?? 0;
	} catch (error) {
		reportPersistenceError({ kind: "db", action: "import-count", error });
		return;
	}
	if (existing > 0) return;

	let data: SessionData;
	try {
		data = JSON.parse(raw) as SessionData;
	} catch (error) {
		reportPersistenceError({ kind: "db", action: "import-parse", error });
		return;
	}

	const agent = data.currentAgent ?? defaultAgent;
	const messages = Array.isArray(data.messages)
		? data.messages.map(migrateLegacyDisplayMessage)
		: [];

	try {
		const rec = createSession({
			agent,
			activeArticle: data.activeArticle ?? null,
		});
		// Batch all message inserts into one transaction — one write per
		// message would be N statements; the import runs once per install
		// so a single atomic batch is both faster and cleaner.
		runInTransaction((tx) => {
			for (const m of messages) {
				appendDisplayMessage(tx, rec.id, m);
			}
		});
		// Treat imported session as ended — it was persisted by the old
		// save-on-turn-end flow, so it's fine to start a fresh one on the
		// next prompt.
	} catch (error) {
		reportPersistenceError({ kind: "db", action: "import-insert", error });
		return;
	}

	try {
		const stat = statSync(SESSION_FILE);
		void stat;
		renameSync(SESSION_FILE, SESSION_FILE + MIGRATED_SUFFIX);
	} catch (error) {
		// Non-fatal — the DB row is the canonical copy now. Worst case
		// the user has a stale `session.json` lying next to the DB; the
		// zero-sessions gate above keeps us from re-importing it.
		reportPersistenceError({ kind: "db", action: "import-rename", error });
	}
}
