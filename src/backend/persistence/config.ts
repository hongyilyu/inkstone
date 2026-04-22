import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
	if (!existsSync(CONFIG_DIR)) {
		mkdirSync(CONFIG_DIR, { recursive: true });
	}
	writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), "utf-8");
	cached = merged;
}
