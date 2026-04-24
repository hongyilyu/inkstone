import type { AgentTool } from "@mariozechner/pi-agent-core";
import { readFileTool } from "./tools/read-file";

/**
 * Theme keys used for per-agent accents. Must match keys on `ThemeColors`
 * (see `src/tui/context/theme.tsx`). Declared as a string union so bad keys
 * fail at compile time when a new agent is added.
 */
export type AgentColorKey =
	| "secondary"
	| "accent"
	| "primary"
	| "success"
	| "warning"
	| "error"
	| "info";

/**
 * Context passed to an agent's `buildInstructions` at compose time. Agents
 * that don't care about an argument simply ignore it; the composer always
 * provides the full shape so adding a new field (e.g. today's date, vault
 * path) is a one-file change.
 */
export interface AgentBuildContext {
	activeArticle: string | null;
}

/**
 * A named agent persona. Flat data object — no inheritance. Shared
 * behavior (base tools, base preamble) is applied at runtime by the
 * composers below, not baked into the type.
 *
 * `extraTools` is appended to `BASE_TOOLS`. Every agent gets the base
 * set unconditionally; per-user-decision there is no opt-out field.
 *
 * `buildInstructions(ctx)` returns the agent-specific portion of the
 * system prompt. The composer prepends `BASE_PREAMBLE` (empty today,
 * grows in future PRs with universal tool-use discipline + memory files).
 */
export interface AgentInfo {
	name: string;
	displayName: string;
	description: string;
	colorKey: AgentColorKey;
	extraTools: AgentTool<any>[];
	buildInstructions(ctx: AgentBuildContext): string;
}

/**
 * Tools every agent receives through the foundation layer. Kept minimal
 * on ship: `read_file` only. Future additions (`memory_write`,
 * `web_search`, `skill`) land here once their supporting systems exist.
 */
export const BASE_TOOLS: AgentTool<any>[] = [readFileTool];

/**
 * Shared prompt prefix applied to every agent's system prompt. Empty
 * today — the mechanism is the point. Future PRs will grow this into a
 * composed block that includes persona guidance, tool-use discipline,
 * and memory-file contents (`user.md`, `memory.md` from
 * `~/.config/inkstone/`).
 */
export const BASE_PREAMBLE = "";

export function composeTools(info: AgentInfo): AgentTool<any>[] {
	return [...BASE_TOOLS, ...info.extraTools];
}

export function composeSystemPrompt(
	info: AgentInfo,
	ctx: AgentBuildContext,
): string {
	const body = info.buildInstructions(ctx);
	return BASE_PREAMBLE ? `${BASE_PREAMBLE}\n\n${body}` : body;
}
