import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { AgentOverlay } from "./permissions";

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
 * A declared write zone on an agent's workspace. Read is always
 * vault-wide; zones only constrain where an agent may write.
 *
 * - `path` is vault-relative (e.g. `"020 HUMAN/023 Notes"`). Resolved
 *   against `VAULT_DIR` at compose time via `node:path.join` so
 *   leading/trailing slashes normalize. Absolute paths are rejected —
 *   see `composeZonesOverlay`.
 * - `write` policy:
 *   - `auto`    — agent writes freely inside this zone, no prompt.
 *   - `confirm` — user is prompted before each write (dispatcher's
 *                 `confirmDirs` rule).
 *
 * The permission dispatcher always enforces `insideDirs: [VAULT_DIR]`
 * as a tool baseline (see `./tools.ts`), so writes outside the vault
 * are blocked regardless of zones. An agent with empty `zones` can
 * still write inside the vault but nowhere specifically declared —
 * the example agent uses this shape.
 *
 * A `deny` policy was considered and cut: the directory-block semantics
 * that `deny` would want don't compose with the current `blockPath`
 * rule kind, which does exact-path equality (not prefix matching).
 * Revisit when a real agent needs read-only access to a specific
 * directory inside its workspace; the right shape at that point is
 * likely a new `blockInsideDirs` rule kind, not a `deny` zone policy
 * shoehorned onto `blockPath`.
 */
export interface AgentZone {
	/** Vault-relative path (e.g. `"020 HUMAN/023 Notes"`). */
	path: string;
	/** Write policy for this zone. */
	write: "auto" | "confirm";
}

/**
 * Runtime capabilities the shell injects into `AgentCommand.execute` at
 * dispatch time. Kept as a named object (not a positional arg) so
 * adding a capability later — e.g. `confirm(question)` for a command
 * that wants user approval, `notify(msg)` for a toast — is additive,
 * not breaking.
 *
 * Why this isn't `AgentActions` directly: commands shouldn't be able to
 * clear the session, switch agent/model, or open dialogs. Those are
 * shell concerns and live as regular `CommandOption` entries in the TUI
 * registry, closing over `AgentActions` at their own call sites. See
 * `docs/SLASH-COMMANDS.md` Path A + `src/tui/app.tsx` for that boundary.
 *
 * `setActiveArticle` is reader-shaped vocabulary on a generic contract
 * — acknowledged leak. The alternative (microtask mirror of module
 * state from the TUI) was considered and rejected as more magical.
 * When a second agent needs similar "shell, please mirror + persist
 * this state change" wiring, this will be the point where a generic
 * replacement lands (candidate shape: `ctx.syncStore(key, value)`).
 * Until then the explicit named method is clearer than an abstraction
 * with one caller.
 *
 * @example
 * // Shell side (src/tui/context/agent.tsx) — build the context at
 * // dispatch time and hand it to the command. `setActiveArticle`
 * // closes over `currentSessionId` so the persistence call has a
 * // target:
 * const ctx: AgentCommandContext = {
 *   prompt: wrappedActions.prompt,
 *   setActiveArticle: (id) => {
 *     setActiveArticle(id);             // backend module state
 *     setStore("activeArticle", id);    // solid store mirror
 *     if (currentSessionId) persistActiveArticle(currentSessionId, id);
 *   },
 * };
 * await cmd.execute(args, ctx);
 *
 * @example
 * // Agent side — mutate owned state via ctx, then kick off a turn.
 * // The shell's `prompt()` wrapper recomposes `systemPrompt` from the
 * // new state before streaming, so no explicit "refresh" step is needed:
 * execute: async (args, ctx) => {
 *   ctx.setActiveArticle(args);
 *   await ctx.prompt(`Read ${args}`);
 * }
 */
export interface AgentCommandContext {
	prompt(text: string): Promise<void>;
	setActiveArticle(id: string | null): void;
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
 *     ctx.setActiveArticle(id);          // mutate agent-owned state
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
 * and reads it at compose time. The composer prepends the zones block
 * and `BASE_PREAMBLE`.
 *
 * `zones` declares the agent's write workspace. Feeds both
 * `composeSystemPrompt` (emits a `<your workspace>` block so the LLM
 * knows where it works) and `composeZonesOverlay` (emits the matching
 * permission rules so the dispatcher enforces it). Read is always
 * vault-wide; zones only constrain writes. Empty array = no declared
 * workspace (example agent).
 *
 * `commands` declares the agent's user-facing verbs. The TUI bridges
 * them into the unified command registry at mount time (see
 * `src/tui/context/agent.tsx:BridgeAgentCommands`); they then share the
 * same slash-dispatch + palette surface as shell-level commands
 * declared in `src/tui/app.tsx`.
 *
 * `getPermissions()` returns an agent-scoped permission overlay that
 * layers on top of each tool's baseline (see `./permissions.ts`).
 * Zones cover the common case (directory-based write policies); this
 * callback is the escape hatch for rules zones can't express — e.g.
 * reader's `frontmatterOnlyFor` rule tied to `activeArticle` state.
 * Called by the permission dispatcher ONCE PER TOOL CALL, so
 * state-dependent rules can inline fresh values each time. Rules
 * themselves are pure data — only the overlay *factory* is a function.
 * Absent when the agent needs no bespoke rules.
 */
export interface AgentInfo {
	name: string;
	displayName: string;
	description: string;
	colorKey: AgentColorKey;
	extraTools: AgentTool<any>[];
	zones: AgentZone[];
	buildInstructions(): string;
	commands?: AgentCommand[];
	getPermissions?(): AgentOverlay;
}
