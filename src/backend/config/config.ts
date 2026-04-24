import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { reportPersistenceError } from "./errors";
import { CONFIG_DIR, CONFIG_FILE } from "./paths";
import { type Config, Config as Schema } from "./schema";

/**
 * Load/save Inkstone's user config from `~/.config/inkstone/config.json`.
 *
 * Parsing goes through the Zod schema in `./schema.ts`, so:
 *   - typos in top-level keys are flagged (strictObject)
 *   - `thinkingLevels` values are validated against pi-agent-core's enum
 *   - the user gets a field-level error message on bad input
 *
 * Every field is optional, so an empty object is always a valid Config and
 * makes a safe fallback when validation or JSON parse fails. Module-level
 * cache is intentional: config is read everywhere, writes are rare, and a
 * restart is the expected way to pick up external edits.
 */

let cached: Config | null = null;

export function loadConfig(): Config {
	if (cached) return cached;
	if (!existsSync(CONFIG_FILE)) {
		cached = {};
		return cached;
	}
	try {
		const raw = readFileSync(CONFIG_FILE, "utf-8");
		const parsed = Schema.safeParse(JSON.parse(raw));
		if (parsed.success) {
			cached = parsed.data;
			return cached;
		}
		// Zod validation failed — format each issue as `path: message` so the
		// user can see exactly which field is wrong. Falls back to defaults
		// so the app still boots; the user can fix the file and restart.
		const details = parsed.error.issues
			.map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
			.join("\n");
		reportPersistenceError({
			kind: "config",
			action: "load",
			error: new Error(`invalid config.json:\n${details}`),
		});
		cached = {};
		return cached;
	} catch (error) {
		// JSON.parse threw or readFileSync threw. Same fallback — surface
		// the underlying error and boot with defaults.
		reportPersistenceError({ kind: "config", action: "load", error });
		cached = {};
		return cached;
	}
}

export function saveConfig(updates: Partial<Config>): void {
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
		return;
	}
	try {
		if (!existsSync(CONFIG_DIR)) {
			mkdirSync(CONFIG_DIR, { recursive: true });
		}
		writeFileSync(CONFIG_FILE, JSON.stringify(parsed.data, null, 2), "utf-8");
		cached = parsed.data;
	} catch (error) {
		// Keep the in-memory `cached` pointing at the old on-disk value so a
		// failed save doesn't desync `loadConfig()` readers from what's
		// actually persisted. The handler surfaces the failure to the user.
		reportPersistenceError({ kind: "config", action: "save", error });
	}
}
