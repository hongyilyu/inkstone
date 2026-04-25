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
 * Shell capabilities exposed to an `AgentCommand.execute`. Kept narrow —
 * only what commands actually need today (triggering turns, abort,
 * clearing the session, rebuilding the system prompt after state
 * changes). Adding new capabilities here is an explicit decision, not
 * a pass-through of the whole `AgentActions` surface.
 *
 * A command doesn't get direct access to `setModel` / `setAgent` /
 * `runAgentCommand` — those are user-driven actions, not something a
 * command should do during execution.
 */
export interface CommandContext {
	prompt(text: string): Promise<void>;
	abort(): void;
	clearSession(): void;
	refreshSystemPrompt(): void;
}

/**
 * A user-facing verb an agent (or the built-in set) declares. Commands
 * are conceptually distinct from tools: tools are model-invoked mid-turn
 * (`AgentTool`), commands are user-invoked at turn boundaries.
 *
 * `execute(args, ctx)` can do any mix of:
 *   - Mutate agent-scoped session state (held as module-level state in
 *     the agent's folder).
 *   - Call `ctx.refreshSystemPrompt()` after state changes.
 *   - Call `ctx.prompt(template)` to kick off an LLM turn with a
 *     command-specific template.
 *   - Call `ctx.clearSession()` / `ctx.abort()` for shell-level effects.
 *
 * `takesArgs` is a UI hint for a future slash-command dropdown: when
 * true, the dropdown can rewrite the textarea to `/name ` instead of
 * invoking immediately. No behavior in the backend depends on it today.
 */
export interface AgentCommand {
	name: string;
	description?: string;
	argHint?: string;
	takesArgs?: boolean;
	execute(args: string, ctx: CommandContext): void | Promise<void>;
}

/**
 * A named agent persona. Flat data object — no inheritance. Shared
 * behavior (base tools, base preamble) is applied at runtime by the
 * composers below, not baked into the type.
 *
 * `extraTools` is appended to `BASE_TOOLS`. Every agent gets the base
 * set unconditionally; per-user-decision there is no opt-out field.
 *
 * `buildInstructions()` returns the agent-specific portion of the
 * system prompt. Nullary by design — if an agent needs session state
 * (e.g. reader's `activeArticle`), it owns that state in its own folder
 * and reads it at compose time. The composer prepends `BASE_PREAMBLE`
 * (empty today).
 *
 * `commands` declares the agent's user-facing verbs. The shell merges
 * them with `BUILTIN_COMMANDS` and exposes dispatch via
 * `AgentActions.runAgentCommand(name, args)`.
 */
export interface AgentInfo {
	name: string;
	displayName: string;
	description: string;
	colorKey: AgentColorKey;
	extraTools: AgentTool<any>[];
	buildInstructions(): string;
	commands?: AgentCommand[];
}

/**
 * Tools every agent receives through the foundation layer. Kept minimal
 * on ship: `read_file` only. Future additions (e.g. a memory tool once
 * the memory files land, or a skill tool once the skills system lands)
 * are added here.
 *
 * Frozen so external modules can't `.push(...)` or swap indices. The
 * "`base/` owns what's in `BASE_TOOLS`" invariant is now enforced at the
 * language level. `composeTools` already returns a fresh array via
 * spread, so compositions are unaffected.
 */
export const BASE_TOOLS: readonly AgentTool<any>[] = Object.freeze([
	readFileTool,
]);

/**
 * Session-global commands available under every agent. Today: `/clear`
 * only. Frozen for the same reason as `BASE_TOOLS` — `base/` owns the
 * set. Agent-declared commands in `AgentInfo.commands` merge with this
 * list in the dispatcher; agent-scoped entries take precedence on name
 * collision (intentional — an agent can override a built-in for its
 * own semantics).
 */
export const BUILTIN_COMMANDS: readonly AgentCommand[] = Object.freeze([
	{
		name: "clear",
		description: "Clear the session",
		execute: (_, ctx) => ctx.clearSession(),
	},
]);

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

export function composeSystemPrompt(info: AgentInfo): string {
	const body = info.buildInstructions();
	return BASE_PREAMBLE ? `${BASE_PREAMBLE}\n\n${body}` : body;
}
