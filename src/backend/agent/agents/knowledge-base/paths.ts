import { VAULT_DIR } from "../../constants";

/**
 * Knowledge-base agent path constants. Scoped to this agent rather than
 * lifted into shared `../../constants.ts` because the LifeOS folder
 * layout (`010 RAW/`, `020 HUMAN/`, `040 FORGE/`, `090 SYSTEM/`) is a
 * per-agent contract, not vault-wide. Other agents (reader, future
 * agents) read from different folders under the same vault root.
 *
 * `VAULT_DIR` is the only shared resolution point; everything else is
 * derived here so the agent's permission overlay and any future
 * search/list helpers reference one source of truth.
 */
export const KB_RAW_DIR = `${VAULT_DIR}/010 RAW`;
export const KB_HUMAN_DIR = `${VAULT_DIR}/020 HUMAN`;
export const KB_FORGE_DIR = `${VAULT_DIR}/040 FORGE`;
export const KB_SYSTEM_DIR = `${VAULT_DIR}/090 SYSTEM/099 LLM Wiki`;
