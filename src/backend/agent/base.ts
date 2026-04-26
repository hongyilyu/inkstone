import type { AgentTool } from "@mariozechner/pi-agent-core";
import { readTool } from "./tools";

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
 * Runtime capabilities the shell injects into `AgentCommand.execute` at
 * dispatch time. Today: just `prompt`. Kept as a named object (not a
 * positional arg) so adding a capability later — e.g. `confirm(question)`
 * for a command that wants user approval, `notify(msg)` for a toast — is
 * additive, not breaking.
 *
 * Why this isn't `AgentActions` directly: commands shouldn't be able to
 * clear the session, switch agent/model, or open dialogs. Those are
 * shell concerns and live as regular `CommandOption` entries in the TUI
 * registry, closing over `AgentActions` at their own call sites. See
 * `docs/SLASH-COMMANDS.md` Path A + `src/tui/app.tsx` for that boundary.
 *
 * @example
 * // Shell side (src/tui/context/agent.tsx) — build the context at
 * // dispatch time and hand it to the command:
 * const ctx: AgentCommandContext = { prompt: wrappedActions.prompt };
 * await cmd.execute(args, ctx);
 *
 * @example
 * // Agent side — mutate owned state, then kick off a turn. The shell's
 * // `prompt()` wrapper recomposes `systemPrompt` from the new state
 * // before streaming, so no explicit "refresh" step is needed:
 * execute: async (args, ctx) => {
 *   setActiveArticle(args);
 *   await ctx.prompt(`Read ${args}`);
 * }
 */
export interface AgentCommandContext {
	prompt(text: string): Promise<void>;
}

/**
 * A user-facing verb an agent declares — e.g. reader's `/article
 * <filename>`. Distinct from a tool: tools are model-invoked mid-turn;
 * commands are user-invoked at turn boundaries (typed slash, Ctrl+P
 * palette, keybind).
 *
 * Fields:
 *   - `name`         slash identifier without the leading `/`
 *   - `description`  one-line help shown in the palette
 *   - `argHint`      placeholder like `<filename>` rendered next to `name`
 *   - `takesArgs`    if true, typed slash requires non-empty args;
 *                    otherwise the slash text falls through as a plain
 *                    prompt. A future slash-command dropdown can also
 *                    use it to rewrite the textarea to `/name ` instead
 *                    of invoking immediately.
 *   - `execute`      the agent's behavior. Receives the raw arg string
 *                    after the slash name, plus an `AgentCommandContext`.
 *                    Typically mutates agent-owned state, then calls
 *                    `ctx.prompt(template)` to kick off a turn.
 *
 * The TUI's `BridgeAgentCommands` (`src/tui/context/agent.tsx`) converts
 * each `AgentCommand` into a `CommandOption` in the unified registry, so
 * slash dispatch, palette, and keybinds all share one surface.
 *
 * @example
 * // Reader's `/article <filename>`:
 * const articleCommand: AgentCommand = {
 *   name: "article",
 *   description: "Open an article for guided reading",
 *   argHint: "<filename>",
 *   takesArgs: true,
 *   execute: async (args, ctx) => {
 *     const id = args.trim();
 *     if (!id) return;
 *     setActiveArticle(id);              // mutate agent-owned state
 *     await ctx.prompt(`Read ${id}`);    // kick off a turn
 *   },
 * };
 *
 * // User types "/article foo.md":
 * //   - `args`               = "foo.md"  (text after the slash name)
 * //   - `ctx.prompt(...)`    = shell-injected capability
 * //   - `"Read foo.md"`      = NEW text the command synthesizes; this
 * //                            is the user message the LLM sees, NOT
 * //                            the user's original "/article foo.md".
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
 * Entries typically come from the shared pool in `./tools.ts`; an agent
 * that owns a state-coupled tool can still colocate it under its own
 * folder (none do today).
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
 * on ship: `read` only. Future additions (e.g. a memory tool once the
 * memory files land, or a skill tool once the skills system lands) are
 * added here.
 *
 * Frozen so external modules can't `.push(...)` or swap indices. The
 * "`base.ts` owns what's in `BASE_TOOLS`" invariant is now enforced at
 * the language level. `composeTools` already returns a fresh array via
 * spread, so compositions are unaffected.
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

export function composeSystemPrompt(info: AgentInfo): string {
	const body = info.buildInstructions();
	return BASE_PREAMBLE ? `${BASE_PREAMBLE}\n\n${body}` : body;
}
