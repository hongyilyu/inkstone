import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { AgentBlock, Config, ModelRef } from "./schema";

/**
 * Pure resolvers + setters over the unified config shape.
 *
 * Resolution rule (single chain, no further fallbacks here):
 *   per-agent override -> top-level default -> caller's responsibility
 *
 * The `null` return from `resolveAgentModel` means "no preference set
 * anywhere"; the caller then falls back to the connected provider's
 * default (see `resolveModelRef` in `agent/index.ts`). Keeping that
 * provider-default step out of these resolvers keeps them dependency-
 * free and trivially testable.
 *
 * Setters intentionally do NOT prune empty agent blocks or empty
 * `thinkingLevels` maps. The schema accepts both shapes, and pruning
 * branches buy zero runtime behavior — only marginally tidier JSON.
 * If hand-edited config tidiness ever matters, that's a separate
 * concern best handled by a one-shot tidy command, not by sprinkling
 * cleanup logic across every setter.
 */

const thinkingKey = (providerId: string, modelId: string): string =>
	`${providerId}/${modelId}`;

export function resolveAgentModel(
	cfg: Config,
	agentName: string,
): ModelRef | null {
	return cfg.agents?.[agentName]?.model ?? cfg.model ?? null;
}

export function resolveAgentThinkingLevel(
	cfg: Config,
	agentName: string,
	providerId: string,
	modelId: string,
): ThinkingLevel {
	const key = thinkingKey(providerId, modelId);
	return (
		cfg.agents?.[agentName]?.thinkingLevels?.[key] ??
		cfg.thinkingLevels?.[key] ??
		"off"
	);
}

/**
 * Return a new `Config` with `agents[agentName].model` set to `model`,
 * or with the per-agent `model` field removed when `model` is `null`.
 *
 * Pure: caller persists via `saveConfig`. Sparse-by-default: when the
 * agent block did not exist, it is created with just `model`. When the
 * agent block already had `thinkingLevels`, that is preserved.
 */
export function setAgentModel(
	cfg: Config,
	agentName: string,
	model: ModelRef | null,
): Config {
	const prevAgents = cfg.agents ?? {};
	const prevBlock = prevAgents[agentName] ?? {};
	const nextBlock: AgentBlock =
		model === null
			? { ...prevBlock, model: undefined }
			: { ...prevBlock, model };
	return { ...cfg, agents: { ...prevAgents, [agentName]: nextBlock } };
}

/**
 * Return a new `Config` with
 * `agents[agentName].thinkingLevels[providerId/modelId]` set to `level`,
 * or with that single key removed when `level` is `null`. Other entries
 * in the agent's `thinkingLevels` map are preserved.
 */
export function setAgentThinkingLevel(
	cfg: Config,
	agentName: string,
	providerId: string,
	modelId: string,
	level: ThinkingLevel | null,
): Config {
	const prevAgents = cfg.agents ?? {};
	const prevBlock = prevAgents[agentName] ?? {};
	const prevLevels = prevBlock.thinkingLevels ?? {};
	const key = thinkingKey(providerId, modelId);
	const nextLevels = { ...prevLevels };
	if (level === null) {
		delete nextLevels[key];
	} else {
		nextLevels[key] = level;
	}
	const nextBlock: AgentBlock = { ...prevBlock, thinkingLevels: nextLevels };
	return { ...cfg, agents: { ...prevAgents, [agentName]: nextBlock } };
}
