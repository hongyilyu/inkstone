import type { AgentTool } from "@mariozechner/pi-agent-core";
import { readTool, updateSidebarTool } from "./tools";
import { makeSuggestCommandTool } from "./tools/suggest-command";
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

/**
 * Compose an agent's runtime tool set: base tools first, per-agent
 * `extraTools` next, and — for agents that declare commands — a
 * dynamically-built `suggest_command` tool whose schema enumerates
 * the agent's command names. Agents with no commands omit the
 * suggestion tool entirely (empty enum has no valid call shape).
 *
 * Composition order is intentional:
 * - BASE_TOOLS first so built-ins appear in a predictable position.
 * - extraTools second so agent-owned tools are adjacent in the list.
 * - suggest_command last so it reads as the "escape hatch" after all
 *   the concrete tools.
 */
export function composeTools(info: AgentInfo): AgentTool<any>[] {
	const tools: AgentTool<any>[] = [...BASE_TOOLS, ...info.extraTools];
	const suggest = makeSuggestCommandTool(info.commands ?? []);
	if (suggest) tools.push(suggest);
	return tools;
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

/**
 * Render the agent's declared user-facing commands so the LLM knows
 * what verbs the user can invoke. Two audiences share one block:
 *
 * - The user reading the LLM's replies benefits when the LLM can
 *   reference commands by exact name (e.g. "you can run /article to
 *   open one").
 * - The LLM itself benefits when deciding whether a freeform user
 *   request ("let's read the article about X") matches a command and
 *   should be routed there. PR5 adds a `suggest_command` tool that
 *   closes that loop; until then the LLM can still name the command
 *   in prose so the user knows what to type.
 *
 * Emits one line per command using `name + argHint` as the heading
 * and `description` as the body, skipping commands without a
 * description (no signal to show). Omitted entirely when the agent
 * has no commands (example agent).
 *
 * Stays byte-stable for the session's lifetime because `info.commands`
 * is declared data, not dynamic state. See D9 — the system prompt
 * must not drift across turns or Anthropic / Bedrock cache prefixes
 * invalidate.
 */
function composeCommandsBlock(info: AgentInfo): string {
	const commands = info.commands ?? [];
	if (commands.length === 0) return "";
	const lines = commands.flatMap((c) => {
		if (!c.description) return [];
		const head = c.argHint ? `/${c.name} ${c.argHint}` : `/${c.name}`;
		return [`  - ${head} — ${c.description}`];
	});
	if (lines.length === 0) return "";
	return [
		"<commands>",
		"User-invoked commands available:",
		...lines,
		"</commands>",
	].join("\n");
}

export function composeSystemPrompt(info: AgentInfo): string {
	const zonesBlock = composeZonesBlock(info);
	const commandsBlock = composeCommandsBlock(info);
	const body = info.buildInstructions();
	const sections = [zonesBlock, commandsBlock, BASE_PREAMBLE, body].filter(
		(s) => s.length > 0,
	);
	return sections.join("\n\n");
}
