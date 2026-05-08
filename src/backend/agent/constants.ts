import { loadConfig } from "../persistence/config";

/**
 * Absolute path to the Obsidian vault root.
 *
 * Read from `config.vaultDir` (`$XDG_CONFIG_HOME/inkstone/config.json`
 * or `~/.config/inkstone/config.json`). The schema marks `vaultDir` as
 * required; `loadConfig` synthesizes a default of
 * `~/Documents/Obsidian/LifeOS` when no config file exists yet (first
 * run), so this access is always defined.
 *
 * The value is captured at module load; changing `config.vaultDir` at
 * runtime requires a restart. That's fine because every derived path
 * (`ARTICLES_DIR`, etc.) and every path check in `permissions.ts` reads
 * `VAULT_DIR` as a module constant at call time.
 */
export const VAULT_DIR = loadConfig().vaultDir;
export const ARTICLES_DIR = `${VAULT_DIR}/010 RAW/013 Articles`;
export const SCRAPS_DIR = `${VAULT_DIR}/020 HUMAN/022 Scraps`;
export const NOTES_DIR = `${VAULT_DIR}/020 HUMAN/023 Notes`;
export const TEMPLATES_DIR = `${VAULT_DIR}/009 BINS/091 Templates`;
