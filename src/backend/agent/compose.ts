import type { AgentTool } from "@mariozechner/pi-agent-core";
import { hasBaseline } from "./permissions";
import { editTool, readTool, updateSidebarTool, writeTool } from "./tools";
import { makeSuggestCommandTool } from "./tools/suggest-command";
import type { AgentInfo } from "./types";

/** Tools every agent receives. Frozen at load. See `docs/AGENT-DESIGN.md` D4 + D5. */
export const BASE_TOOLS: readonly AgentTool<any>[] = Object.freeze([
	readTool,
	updateSidebarTool,
]);

/**
 * Tools that are intentionally baseline-free because they do not touch
 * filesystem paths. Everything else composed into an agent must
 * register a permission baseline in `permissions.ts`.
 */
const GLOBAL_BASELINE_FREE_TOOLS: ReadonlySet<string> = new Set([
	updateSidebarTool.name,
	"suggest_command",
]);

const AGENT_BASELINE_FREE_TOOLS: Readonly<Record<string, readonly string[]>> = {
	reader: ["search", "list_keys"],
};

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
	assertToolPermissionCoverage(info, tools);
	assertMutatingToolsHaveZones(info, tools);
	return tools;
}

function assertToolPermissionCoverage(
	info: AgentInfo,
	tools: AgentTool<any>[],
): void {
	for (const tool of tools) {
		if (hasBaseline(tool.name) || isBaselineFreeForAgent(info, tool.name)) {
			continue;
		}
		throw new Error(
			`Tool '${tool.name}' on agent '${info.name}' has no permission baseline or baseline-free review entry.`,
		);
	}
}

function isBaselineFreeForAgent(info: AgentInfo, toolName: string): boolean {
	if (GLOBAL_BASELINE_FREE_TOOLS.has(toolName)) return true;
	return AGENT_BASELINE_FREE_TOOLS[info.name]?.includes(toolName) ?? false;
}

function assertMutatingToolsHaveZones(
	info: AgentInfo,
	tools: AgentTool<any>[],
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
