import type { AgentTool } from "@mariozechner/pi-agent-core";
import { readTool, updateSidebarTool } from "./tools";
import type { AgentInfo } from "./types";

/**
 * Tools every agent receives. Frozen at module load so external modules
 * can't mutate the array. See `docs/AGENT-DESIGN.md` D4 (no opt-out) +
 * D5 (ship mechanism, defer content).
 */
export const BASE_TOOLS: readonly AgentTool<any>[] = Object.freeze([
	readTool,
	updateSidebarTool,
]);

/**
 * Shared system-prompt prefix prepended to every agent. Empty today —
 * the mechanism is the point. See `docs/AGENT-DESIGN.md` D5.
 */
export const BASE_PREAMBLE = "";

export function composeTools(info: AgentInfo): AgentTool<any>[] {
	return [...BASE_TOOLS, ...info.extraTools];
}

/**
 * Render the agent's declared zones as a `<your workspace>` block the
 * LLM sees at the top of its system prompt. Single source of truth
 * with `composeZonesOverlay`: the same `AgentZone[]` drives both the
 * permission dispatcher and the prompt text, so the LLM's stated
 * workspace can't drift from the enforced one.
 *
 * Omitted entirely when the agent has no zones (example agent).
 *
 * The policy verbs map to concrete phrasing so the LLM can reason
 * about the rule, not just the directory:
 *   - `auto`    → "write freely"
 *   - `confirm` → "confirm before write"
 */
function composeZonesBlock(info: AgentInfo): string {
	if (info.zones.length === 0) return "";
	const lines = info.zones.map((z) => {
		const policy = z.write === "auto" ? "write freely" : "confirm before write";
		return `  - ${z.path} (${policy})`;
	});
	return [
		"<your workspace>",
		"Primary write zones:",
		...lines,
		"You may read anywhere in the vault.",
		"</your workspace>",
	].join("\n");
}

export function composeSystemPrompt(info: AgentInfo): string {
	const zonesBlock = composeZonesBlock(info);
	const body = info.buildInstructions();
	const sections = [zonesBlock, BASE_PREAMBLE, body].filter(
		(s) => s.length > 0,
	);
	return sections.join("\n\n");
}
