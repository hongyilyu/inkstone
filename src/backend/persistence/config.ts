import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { reportPersistenceError } from "./errors";
import { CONFIG_FILE, ensureConfigDir, writeFileAtomic } from "./paths";
import { type Config, Config as Schema } from "./schema";

/**
 * Load/save Inkstone's user config from `~/.config/inkstone/config.json`.
 *
 * Parsing goes through the Zod schema in `./schema.ts`, so:
 *   - typos in top-level keys are flagged (strictObject)
 *   - `thinkingLevels` values are validated against pi-agent-core's enum
 *   - the user gets a field-level error message on bad input
 *
 * `vaultDir` is required by the schema (one binary serves one vault).
 * When the file is missing or unparseable, `loadConfig` returns a
 * minimal-but-valid Config (`{ vaultDir: DEFAULT_VAULT_DIR }`) so the
 * TUI can still mount and surface the error via the toast layer
 * (`reportPersistenceError`). Throwing from this function would crash
 * `ThemeProvider` (which calls `loadConfig` at App mount, outside the
 * `ErrorBoundary` that wraps `AgentProvider`), leaving the user with
 * no UI to fix the problem.
 *
 * Module-level cache is intentional: config is read everywhere, writes
 * are rare, and a restart is the expected way to pick up external edits.
 */

const DEFAULT_VAULT_DIR = join(homedir(), "Documents/Obsidian/LifeOS");

function fallbackConfig(): Config {
	return { vaultDir: DEFAULT_VAULT_DIR };
}

let cached: Config | null = null;

export function loadConfig(): Config {
	if (cached) return cached;
	if (!existsSync(CONFIG_FILE)) {
		// First run: synthesize a default config in memory. We do NOT
		// write it to disk here — `saveConfig` is the single write seam
		// and runs lazily on the user's first preference change.
		cached = fallbackConfig();
		return cached;
	}
	try {
		const raw = readFileSync(CONFIG_FILE, "utf-8");
		const parsed = Schema.safeParse(JSON.parse(raw));
		if (parsed.success) {
			cached = parsed.data;
			return cached;
		}
		// Zod validation failed — format each issue as `path: message` so
		// the user can see exactly which field is wrong. Fall back to the
		// default Config so the app still boots; the user can fix the
		// file and restart.
		const details = parsed.error.issues
			.map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
			.join("\n");
		reportPersistenceError({
			kind: "config",
			action: "load",
			error: new Error(`invalid config.json:\n${details}`),
		});
		cached = fallbackConfig();
		return cached;
	} catch (error) {
		// JSON.parse threw or readFileSync threw. Same fallback — surface
		// the underlying error and boot with defaults.
		reportPersistenceError({ kind: "config", action: "load", error });
		cached = fallbackConfig();
		return cached;
	}
}

export function saveConfig(updates: Partial<Config>): boolean {
	const current = loadConfig();
	const merged = { ...current, ...updates };
	// Validate the merged result before writing. All current call sites pass
	// typed `Partial<Config>`, so this is a tripwire for future callers who
	// might widen the type or bypass TS (e.g. `as any`). Without it, an
	// invalid value could be persisted and then fall back to defaults on the
	// next load — silently losing every other field the user had set.
	const parsed = Schema.safeParse(merged);
	if (!parsed.success) {
		const details = parsed.error.issues
			.map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
			.join("\n");
		reportPersistenceError({
			kind: "config",
			action: "save",
			error: new Error(`refusing to save invalid config:\n${details}`),
		});
		return false;
	}
	try {
		ensureConfigDir();
		writeFileAtomic(CONFIG_FILE, JSON.stringify(parsed.data, null, 2), 0o600);
		cached = parsed.data;
		return true;
	} catch (error) {
		// Keep the in-memory `cached` pointing at the old on-disk value so a
		// failed save doesn't desync `loadConfig()` readers from what's
		// actually persisted. The handler surfaces the failure to the user.
		reportPersistenceError({ kind: "config", action: "save", error });
		return false;
	}
}

/**
 * Drop the in-memory config cache so the next `loadConfig()` re-reads
 * from disk. Exists for tests that seed `config.json` *after* a module
 * import path has already triggered a `loadConfig()` read — without
 * this, the cached value shadows the newly-written file. Not intended
 * for production use: Inkstone reads config at startup and writes
 * through `saveConfig`, which updates the cache in place.
 */
export function resetConfigCache(): void {
	cached = null;
}
