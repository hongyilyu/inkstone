import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../persistence/config";

/**
 * Absolute path to the Obsidian vault root.
 *
 * Resolution order:
 *   1. `config.vaultDir` — user-specified in `$XDG_CONFIG_HOME/inkstone/config.json`
 *      (or `~/.config/inkstone/config.json`).
 *   2. `~/Documents/Obsidian/LifeOS` — platform-neutral default via `os.homedir()`.
 *
 * The value is captured at module load; changing `config.vaultDir` at runtime
 * requires a restart. That's fine because every derived path (`ARTICLES_DIR`,
 * etc.) and every path-guard check in `guard.ts` reads `VAULT_DIR` as a
 * module constant at call time.
 */
export const VAULT_DIR =
	loadConfig().vaultDir ?? join(homedir(), "Documents/Obsidian/LifeOS");
export const ARTICLES_DIR = `${VAULT_DIR}/010 RAW/013 Articles`;
export const SCRAPS_DIR = `${VAULT_DIR}/020 HUMAN/022 Scraps`;
export const NOTES_DIR = `${VAULT_DIR}/020 HUMAN/023 Notes`;
export const TEMPLATES_DIR = `${VAULT_DIR}/009 BINS/091 Templates`;
