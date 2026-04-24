import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionData } from "@bridge/view-model";
import { reportPersistenceError } from "./errors";

const STATE_DIR = join(
	process.env.XDG_STATE_HOME ||
		join(process.env.HOME || "~", ".local", "state"),
	"inkstone",
);
const SESSION_FILE = join(STATE_DIR, "session.json");

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
	} catch {
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
