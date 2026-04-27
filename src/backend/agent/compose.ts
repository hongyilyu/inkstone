import type { AgentTool } from "@mariozechner/pi-agent-core";
import { readTool } from "./tools";
import type { AgentInfo } from "./types";

/**
 * Tools every agent receives through the foundation layer. Kept minimal
 * on ship: `read` only. Future additions (e.g. a memory tool once the
 * memory files land, or a skill tool once the skills system lands) are
 * added here.
 *
 * Frozen so external modules can't `.push(...)` or swap indices. The
 * "`compose.ts` owns what's in `BASE_TOOLS`" invariant is now enforced
 * at the language level. `composeTools` already returns a fresh array
 * via spread, so compositions are unaffected.
 */
export const BASE_TOOLS: readonly AgentTool<any>[] = Object.freeze([readTool]);

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
