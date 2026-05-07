import type { AgentTool } from "@mariozechner/pi-agent-core";
import { readTool, updateSidebarTool } from "./tools";
import { makeSuggestCommandTool } from "./tools/suggest-command";
import type { AgentInfo } from "./types";

/** Tools every agent receives. Frozen at load. See `docs/AGENT-DESIGN.md` D4 + D5. */
export const BASE_TOOLS: readonly AgentTool<any>[] = Object.freeze([
	readTool,
	updateSidebarTool,
]);

/** Shared system-prompt prefix. Empty today — see `docs/AGENT-DESIGN.md` D5. */
export const BASE_PREAMBLE = "";

/**
 * Compose an agent's runtime tool set: `BASE_TOOLS` + `info.extraTools` +
 * an agent-scoped `suggest_command` tool (omitted when `info.commands`
 * is empty; empty enum has no valid call shape).
 */
export function composeTools(info: AgentInfo): AgentTool<any>[] {
	const tools: AgentTool<any>[] = [...BASE_TOOLS, ...info.extraTools];
	const suggest = makeSuggestCommandTool(info.commands ?? []);
	if (suggest) tools.push(suggest);
	return tools;
}

/**
 * Render `info.zones` as a `<your workspace>` block. Single source of
 * truth with `composeZonesOverlay` (see `docs/AGENT-DESIGN.md` D12):
 * one declaration drives both the prompt text and the permission
 * rules. Omitted when `info.zones` is empty. Policy verbs: `auto` →
 * "write freely", `confirm` → "confirm before write".
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
 * Render `info.commands` as a `<commands>` block so the LLM can name
 * user-facing verbs and route freeform requests through
 * `suggest_command`. Skips entries without a description; omitted
 * entirely when no described command exists. See
 * `docs/AGENT-DESIGN.md` D9 for the stability invariant (block must
 * stay byte-stable per session for prompt-cache hits).
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
