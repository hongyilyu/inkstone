import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { SessionData } from "@bridge/view-model";
import { reportPersistenceError } from "./errors";
import { SESSION_FILE, STATE_DIR } from "./paths";

/**
 * Persist the most recent session to `~/.local/state/inkstone/session.json`.
 *
 * No Zod schema here — `SessionData` is an internal Inkstone type owned by
 * `@bridge/view-model`, written and read only by Inkstone itself. There's
 * no untrusted-input boundary worth validating against. If the file is
 * corrupt on load we fall back to `null` (treated by callers as "no saved
 * session") and surface the error so the user knows their state was lost.
 */

export function saveSession(data: SessionData): void {
	try {
		if (!existsSync(STATE_DIR)) {
			mkdirSync(STATE_DIR, { recursive: true });
		}
		writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), "utf-8");
	} catch (error) {
		reportPersistenceError({ kind: "session", action: "save", error });
	}
}

export function loadSession(): SessionData | null {
	if (!existsSync(SESSION_FILE)) return null;
	try {
		const raw = readFileSync(SESSION_FILE, "utf-8");
		return JSON.parse(raw) as SessionData;
	} catch (error) {
		reportPersistenceError({ kind: "session", action: "load", error });
		return null;
	}
}

export function clearSession(): void {
	if (!existsSync(SESSION_FILE)) return;
	try {
		writeFileSync(SESSION_FILE, "{}", "utf-8");
	} catch (error) {
		reportPersistenceError({ kind: "session", action: "clear", error });
	}
}
