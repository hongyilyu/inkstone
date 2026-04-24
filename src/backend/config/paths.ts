import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Shared XDG-style paths for Inkstone's persisted state.
 *
 * `config.ts` and `auth.ts` both need the config dir; `session.ts` uses the
 * state dir. Centralizing here keeps the XDG fallback logic in one place and
 * lets callers import a ready-made file path instead of rebuilding it.
 */

const HOME = process.env.HOME ?? homedir();

export const CONFIG_DIR = join(
	process.env.XDG_CONFIG_HOME ?? join(HOME, ".config"),
	"inkstone",
);

export const STATE_DIR = join(
	process.env.XDG_STATE_HOME ?? join(HOME, ".local", "state"),
	"inkstone",
);

export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const AUTH_FILE = join(CONFIG_DIR, "auth.json");
export const SESSION_FILE = join(STATE_DIR, "session.json");
