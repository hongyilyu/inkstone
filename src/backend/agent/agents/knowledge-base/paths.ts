/**
 * LifeOS folder layout — single source of truth for the knowledge-base
 * agent. The workflow text in `instructions.ts`, the agent's `zones`,
 * and the permission overlay all read from here, so adjusting the
 * vault layout (or testing against a different one) is one file.
 *
 * Paths are vault-relative; callers `join(VAULT_DIR, …)` when they
 * need absolute paths (e.g. for the permission overlay).
 */

// Top-level folders.
export const KB_RAW = "010 RAW";
export const KB_HUMAN = "020 HUMAN";
export const KB_FORGE = "040 FORGE";
export const KB_SYSTEM = "090 SYSTEM/099 LLM Wiki";

// Forge subfolders.
export const KB_FORGE_SOURCE_NOTES = `${KB_FORGE}/041 Source Notes`;
export const KB_FORGE_PERSON_NOTES = `${KB_FORGE}/042 Person Notes`;
export const KB_FORGE_PROJECT_NOTES = `${KB_FORGE}/043 Project Notes`;
export const KB_FORGE_MAPS = `${KB_FORGE}/044 Maps`;
export const KB_FORGE_SYNTHESES = `${KB_FORGE}/045 Syntheses`;
export const KB_FORGE_OUTPUTS = `${KB_FORGE}/046 Outputs`;
export const KB_FORGE_MAINTENANCE = `${KB_FORGE}/047 Maintenance`;
export const KB_FORGE_INDEX = `${KB_FORGE}/index.md`;
export const KB_FORGE_LOG = `${KB_FORGE}/log.md`;

// Human subfolders referenced by the query workflow's read order.
export const KB_HUMAN_DAILY = `${KB_HUMAN}/021 Daily`;
export const KB_HUMAN_SCRAPS = `${KB_HUMAN}/022 Scraps`;
export const KB_HUMAN_NOTES = `${KB_HUMAN}/023 Notes`;

// Raw subfolder used as an example in the source-link rule.
export const KB_RAW_ARTICLES = `${KB_RAW}/013 Articles`;

// System files lint may write to.
export const KB_TEMPLATES = `${KB_SYSTEM}/Templates`;
export const KB_TAGS_GUIDANCE = `${KB_SYSTEM}/tags-guidance.md`;
