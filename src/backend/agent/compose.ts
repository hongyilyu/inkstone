import { relative } from "node:path";
import { VAULT_DIR } from "./constants";
import { composeOverlay } from "./overlay";
import type { Rule } from "./permissions";
import { editTool, readTool, updateSidebarTool, writeTool } from "./tools";
import { makeSuggestCommandTool } from "./tools/suggest-command";
import type { AgentInfo, InkstoneTool } from "./types";
import { todayLocalDate } from "./util/local-date";

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
	assertMutatingToolsHaveWorkspace(info, tools);
	return tools;
}

// Catches the common path where an agent composes the shared
// `writeTool` / `editTool` re-exports without declaring a writable
// workspace. A future agent that calls `createWriteTool(VAULT_DIR)`
// directly (bypassing the shared pool) would slip past this check —
// the `tools.ts` convention is the safety net, not this assertion.
//
// Reads from `composeOverlay(info)` so the contract follows whatever
// declaration shape an agent uses. An `insideDirs` rule with a
// non-empty `dirs` array on the write tool's overlay is the formal
// "agent has a writable workspace" signal.
function assertMutatingToolsHaveWorkspace(
	info: AgentInfo,
	tools: InkstoneTool<any>[],
): void {
	const hasSharedMutatingTool = tools.some(
		(tool) => tool.name === writeTool.name || tool.name === editTool.name,
	);
	if (!hasSharedMutatingTool) return;
	const overlay = composeOverlay(info);
	const writeRules: Rule[] = overlay[writeTool.name] ?? [];
	const hasWritable = writeRules.some(
		(r) => r.kind === "insideDirs" && r.dirs.length > 0,
	);
	if (hasWritable) return;
	throw new Error(
		`Agent '${info.name}' composes mutating file tools but declares no writable workspace ` +
			`(getPermissions must include an insideDirs rule for '${writeTool.name}').`,
	);
}

// Render `<your workspace>` from the same merged overlay the dispatcher
// evaluates. Per ADR 0009, the LLM-facing block and the enforcement path
// derive from one declarative `Rule[]` — same bytes, no drift. Each rule
// kind projects to a labelled list:
//   insideDirs            → "You can write to:" (allowlist; every other
//                           path is implicitly denied by the dispatcher)
//   confirmDirs           → "(confirm before each write)" suffix on the
//                           writable line for matching dirs
//   frontmatterOnlyInDirs → "Edits restricted to frontmatter in:"
function composeWorkspaceBlock(info: AgentInfo): string {
	const overlay = composeOverlay(info);
	const writeRules = overlay[writeTool.name] ?? [];
	const editRules = overlay[editTool.name] ?? [];

	const writableDirs = collectDirs(writeRules, "insideDirs");
	const confirmDirs = new Set(collectDirs(writeRules, "confirmDirs"));
	const frontmatterOnly = collectDirs(editRules, "frontmatterOnlyInDirs");

	if (writableDirs.length === 0 && frontmatterOnly.length === 0) {
		return "";
	}

	const lines: string[] = ["<your workspace>"];
	if (writableDirs.length > 0) {
		lines.push("You can write to:");
		for (const dir of writableDirs) {
			const policy = confirmDirs.has(dir)
				? "confirm before each write"
				: "write freely";
			lines.push(`  - ${rel(dir)} (${policy})`);
		}
	}
	if (frontmatterOnly.length > 0) {
		lines.push("Edits restricted to frontmatter in:");
		for (const dir of frontmatterOnly) {
			lines.push(`  - ${rel(dir)}`);
		}
	}
	// Read is always vault-wide per AGENT-DESIGN D12 — projected as a fixed
	// invariant line, not derived from rules. If agent-scoped read fences
	// ever ship, project them from `overlay[readTool.name]` above.
	lines.push("You may read anywhere in the vault.");
	lines.push("</your workspace>");
	return lines.join("\n");
}

function collectDirs(rules: Rule[], kind: Rule["kind"]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const r of rules) {
		if (r.kind !== kind) continue;
		for (const d of r.dirs) {
			if (!seen.has(d)) {
				seen.add(d);
				out.push(d);
			}
		}
	}
	return out;
}

function rel(absDir: string): string {
	return relative(VAULT_DIR, absDir) || ".";
}

// Render an `<env>` block fixing today's date for the LLM. Without
// this, the model infers "today" from filenames or content and
// guesses wrong (frontmatter dates were the trigger). Local time,
// YYYY-MM-DD — unambiguous, locale-free, parseable. OpenCode emits
// the same block from `session/system.ts`.
//
// Captured once per `composeSystemPrompt` call. Since the prompt is
// composed at session creation and only re-composed on agent swap
// (`selectAgent`), the date stays byte-stable for the session and
// preserves D9's cache-prefix invariant. Sessions that survive past
// local midnight retain the original date — acceptable trade-off vs.
// invalidating the cache_control prefix every day. See
// `util/local-date.ts` for the shared formatter; local-time choice is
// load-bearing for this cache invariant.
function composeEnvBlock(): string {
	return ["<env>", `Today's date: ${todayLocalDate()}`, "</env>"].join("\n");
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
	const envBlock = composeEnvBlock();
	const workspaceBlock = composeWorkspaceBlock(info);
	const commandsBlock = composeCommandsBlock(info);
	const body = info.buildInstructions();
	const sections = [
		envBlock,
		workspaceBlock,
		commandsBlock,
		BASE_PREAMBLE,
		body,
	].filter((s) => s.length > 0);
	return sections.join("\n\n");
}
