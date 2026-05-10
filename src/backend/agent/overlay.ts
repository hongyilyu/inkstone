import type { AgentOverlay } from "./permissions";
import type { AgentInfo } from "./types";

/**
 * Build the permission overlay for an agent.
 *
 * Per ADR 0009, permission rules are the single source of truth for
 * both the dispatcher (`dispatchBeforeToolCall`) and the system
 * prompt's `<your workspace>` block (`composeWorkspaceBlock`). Both
 * call this function and consume the same `Rule[]` — same bytes, no
 * drift.
 *
 * Today this is a thin wrapper over `info.getPermissions?.()`. Kept
 * as a function so call sites stay stable across future rule-source
 * additions (e.g. user-level overlays from config).
 */
export function composeOverlay(info: AgentInfo): AgentOverlay {
	return info.getPermissions?.() ?? {};
}
