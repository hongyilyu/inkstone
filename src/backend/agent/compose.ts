import { editTool, readTool, updateSidebarTool, writeTool } from "./tools";
import { makeSuggestCommandTool } from "./tools/suggest-command";
import type { AgentInfo, InkstoneTool } from "./types";

/** Tools every agent receives. Frozen at load. See `docs/AGENT-DESIGN.md` D4 + D5. */
export const BASE_TOOLS: readonly InkstoneTool<any>[] = Object.freeze([
	readTool,
	updateSidebarTool,
]);

/** Shared system-prompt prefix. Empty today — see `docs/AGENT-DESIGN.md` D5. */
export const BASE_PREAMBLE = "";

/**
 * Compose an agent's runtime tool set: `BASE_TOOLS` + `info.extraTools` +
 * an agent-scoped `suggest_command` tool (omitted when `info.commands`
 * is empty; empty enum has no valid call shape).
 *
 * `info.omitBaseTools` skips `BASE_TOOLS` entirely. Today only the
 * router opts out — per ADR 0007 it's a one-shot classifier with
 * exactly one tool (`dispatch`). Default behavior is unchanged for
 * every other agent (ADR 0002's "every agent gets the base set" still
 * holds wherever the flag isn't set).
 */
export function composeTools(info: AgentInfo): InkstoneTool<any>[] {
	const base = info.omitBaseTools ? [] : BASE_TOOLS;
	const tools: InkstoneTool<any>[] = [...base, ...info.extraTools];
	const suggest = makeSuggestCommandTool(info.commands ?? []);
	if (suggest) tools.push(suggest);
	assertMutatingToolsHaveZones(info, tools);
	return tools;
}

// Catches the common path where an agent composes the shared
// `writeTool` / `editTool` re-exports without declaring zones. A
// future agent that calls `createWriteTool(VAULT_DIR)` directly
// (bypassing the shared pool) would slip past this check — the
// `tools.ts` convention is the safety net, not this assertion.
function assertMutatingToolsHaveZones(
	info: AgentInfo,
	tools: InkstoneTool<any>[],
): void {
	if (info.zones.length > 0) return;
	const hasSharedMutatingTool = tools.some(
		(tool) => tool.name === writeTool.name || tool.name === editTool.name,
	);
	if (!hasSharedMutatingTool) return;
	throw new Error(
		`Agent '${info.name}' composes mutating file tools but declares no write zones.`,
	);
}

// Render `info.zones` as a `<your workspace>` block. Pairs with
// `composeZonesOverlay` (one declaration drives prompt + permissions);
// see `docs/AGENT-DESIGN.md` D12. Policy verb mapping: `auto` → "write
// freely", `confirm` → "confirm before write".
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

// Render `info.commands` as a `<commands>` block. Skips entries
// without a description; omitted entirely when none have one. Cache-
// stability invariant: see `docs/AGENT-DESIGN.md` D9.
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
