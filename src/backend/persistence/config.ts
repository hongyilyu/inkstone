import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { reportPersistenceError } from "./errors";

const CONFIG_DIR = join(
	process.env.XDG_CONFIG_HOME || join(process.env.HOME || "~", ".config"),
	"inkstone",
);
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

interface Config {
	/** Active provider id (e.g. "amazon-bedrock"). Missing on configs written
	 * before the provider abstraction landed; callers should default to the
	 * first registered provider in that case. */
	providerId?: string;
	modelId?: string;
	themeId?: string;
	currentAgent?: string;
	/**
	 * Reasoning effort stored per-model, keyed by `${providerId}/${modelId}`.
	 * Missing key == `"off"`. Matches OpenCode's per-model variant storage
	 * (`tui/context/local.tsx` `local.model.variant`). Scoping per-model keeps
	 * each model at its own sweet-spot effort as the user swaps between them.
	 */
	thinkingLevels?: Record<string, ThinkingLevel>;
	/**
	 * Absolute path to the Obsidian vault root. When unset, `agent/constants.ts`
	 * falls back to `~/Documents/Obsidian/LifeOS` via `os.homedir()`. Users can
	 * point Inkstone at any vault by writing this value into
	 * `$XDG_CONFIG_HOME/inkstone/config.json` (or `~/.config/inkstone/config.json`).
	 */
	vaultDir?: string;
}

let cached: Config | null = null;

export function loadConfig(): Config {
	if (cached) return cached;
	if (!existsSync(CONFIG_FILE)) {
		cached = {};
		return cached;
	}
	try {
		const raw = readFileSync(CONFIG_FILE, "utf-8");
		cached = JSON.parse(raw) as Config;
		return cached;
	} catch {
		cached = {};
		return cached;
	}
}

export function saveConfig(updates: Partial<Config>): void {
	const current = loadConfig();
	const merged = { ...current, ...updates };
	try {
		if (!existsSync(CONFIG_DIR)) {
			mkdirSync(CONFIG_DIR, { recursive: true });
		}
		writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), "utf-8");
		cached = merged;
	} catch (error) {
		// Keep the in-memory `cached` pointing at the old on-disk value so a
		// failed save doesn't desync `loadConfig()` readers from what's
		// actually persisted. The handler surfaces the failure to the user.
		reportPersistenceError({ kind: "config", action: "save", error });
	}
}
