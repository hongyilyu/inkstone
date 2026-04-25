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
 * Capabilities exposed to `AgentCommand.execute`. Narrow by design — only
 * the two hooks commands actually need today: kick off a new turn
 * (`prompt`) and rebuild the system prompt after mutating agent-owned
 * state (`refreshSystemPrompt`). Anything a shell knows how to do —
 * clearing the session, switching agent/model, opening a dialog — is
 * not a command concern and is deliberately absent.
 *
 * Shell-level verbs (`/clear`) live in the TUI command registry as
 * regular `CommandOption` entries that close over `AgentActions`. See
 * `docs/SLASH-COMMANDS.md` Path A + `src/tui/app.tsx` for the shell
 * registration point.
 */
export interface AgentCommandContext {
	prompt(text: string): Promise<void>;
	refreshSystemPrompt(): void;
}

/**
 * A user-facing verb an agent declares. Commands are conceptually
 * distinct from tools: tools are model-invoked mid-turn (`AgentTool`),
 * commands are user-invoked at turn boundaries.
 *
 * `execute(args, ctx)` can do any mix of:
 *   - Mutate agent-scoped session state (held as module-level state in
 *     the agent's folder).
 *   - Call `ctx.refreshSystemPrompt()` after state changes.
 *   - Call `ctx.prompt(template)` to kick off an LLM turn with a
 *     command-specific template.
 *
 * `takesArgs` means typed slash submission requires a non-empty argument
 * string before dispatch; otherwise the slash text falls through as a
 * plain prompt. A future slash-command dropdown can also use it to
 * rewrite the textarea to `/name ` instead of invoking immediately.
 *
 * The TUI bridges each `AgentCommand` into a `CommandOption` in the
 * unified registry (see `src/tui/context/agent.tsx:BridgeAgentCommands`),
 * so agent-declared verbs share the same slash-dispatch + palette
 * surface as shell-level commands.
 */
export interface AgentCommand {
	name: string;
	description?: string;
	argHint?: string;
	takesArgs?: boolean;
	execute(args: string, ctx: AgentCommandContext): void | Promise<void>;
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
 * `commands` declares the agent's user-facing verbs. The TUI bridges
 * them into the unified command registry at mount time (see
 * `src/tui/context/agent.tsx:BridgeAgentCommands`); they then share the
 * same slash-dispatch + palette surface as shell-level commands
 * declared in `src/tui/app.tsx`.
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
