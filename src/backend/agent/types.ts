import type { DisplayPart } from "@bridge/view-model";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TSchema } from "typebox";
import type { AgentOverlay, Rule } from "./permissions";

/**
 * Inkstone-shipped tool definition: a pi-agent-core `AgentTool` plus a
 * required `baseline: Rule[]` field that declares the permission rules
 * applied to every call of this tool, regardless of agent.
 *
 * Empty `[]` is an explicit "no baseline rules" declaration — required
 * so the contract is local to the tool definition and grep-able. A
 * missing field is a TS compile error, replacing the old runtime
 * registry coverage check.
 *
 * Refines ADR-0009: rules are data, and baselines now live on the tool
 * (not in a module-load registry). Per-agent overlays still come from
 * `AgentInfo.getPermissions?()`.
 */
// biome-ignore lint/suspicious/noExplicitAny: matches pi-agent-core's
// `AgentTool<P, D = any>` default so `AgentTool<S>` and `InkstoneTool<S>`
// resolve to the same `D` and stay structurally assignable.
export interface InkstoneTool<
	TParameters extends TSchema = TSchema,
	// biome-ignore lint/suspicious/noExplicitAny: see comment above.
	TDetails = any,
> extends AgentTool<TParameters, TDetails> {
	baseline: Rule[];
}

// Theme keys used for per-agent accents. Must match keys on `ThemeColors`
// (`src/tui/context/theme.tsx`) — bad keys fail at compile time.
export type AgentColorKey =
	| "secondary"
	| "accent"
	| "primary"
	| "success"
	| "warning"
	| "error"
	| "info";

/**
 * User-facing verb an agent declares (typed slash, palette, keybind).
 * Distinct from a tool: tools are model-invoked mid-turn; commands are
 * user-invoked at turn boundaries. See `docs/SLASH-COMMANDS.md` for
 * the slash-dropdown UX and `docs/ARCHITECTURE.md` § Commands for the
 * unified-registry bridge.
 *
 * Field semantics:
 *   - `argHint`     placeholder rendered next to `name` in the palette.
 *                   Set whenever the command accepts an arg (required
 *                   OR optional). Also the dropdown-UX signal: argHint
 *                   set → selecting from the dropdown inserts `/name `
 *                   so the user can type; unset → fires immediately.
 *   - `takesArgs`   if true, typed slash REQUIRES non-empty args;
 *                   otherwise the slash text falls through as a plain
 *                   prompt. Narrower than `argHint`: a command with
 *                   an *optional* arg sets `argHint` + `takesArgs:
 *                   false` (e.g. reader's `/article`).
 *   - `argGuide`    one-liner shown beneath the textarea after the
 *                   user types `/name ` (verb + space, no args yet).
 *                   No fallback to `argHint`.
 *   - `canExecute`  optional pre-dispatch predicate. Consulted by the
 *                   slash gate AFTER `takesArgs` / `argHint` shape rules
 *                   have accepted. Returning `false` rejects dispatch
 *                   and the prompt falls through to the plain-prompt
 *                   path with the literal `/`-prefixed text intact.
 *                   Used by optional-arg commands (`argHint` set,
 *                   `takesArgs: false`) where the shape rules can't
 *                   tell prose-after-verb from a real arg — see
 *                   reader's `/article`. Pure boolean, no async, no
 *                   side effects (gate is hit on every keystroke-ish
 *                   submit decision; do cheap checks only).
 *   - `execute`     receives the raw arg string + `AgentCommandHelpers`.
 *                   Typically composes a user message and calls
 *                   `helpers.prompt(text)` to start a turn.
 */
export interface AgentCommand {
	name: string;
	description?: string;
	argHint?: string;
	argGuide?: string;
	takesArgs?: boolean;
	canExecute?(args: string): boolean;
	execute(args: string, helpers: AgentCommandHelpers): void | Promise<void>;
}

/**
 * Per-turn options on `AgentCommandHelpers.prompt` /
 * `AgentContextValue.actions.prompt`.
 *
 * `displayParts` — replaces the user bubble's rendered parts without
 * changing what reaches the model. Reader's `/article` uses this to
 * inline full article content in `text` while rendering a compact
 * "prose + file chip" bubble. When omitted, the bubble renders as a
 * single text part containing `text`.
 *
 * `title` — declares the session title at dispatch time. Persisted
 * verbatim and the LLM title task is skipped. Used when the caller
 * already knows the session's identity (reader's `/article` passes
 * the article's frontmatter `title` or filename stem) — better than
 * any model paraphrase for finding the session in the list later.
 * Only honored on the first turn of a session (when there's a title
 * task to skip); ignored on subsequent turns. Trimmed and capped to
 * `MAX_TITLE_CHARS` by the receiver — same bound the LLM-cleaned
 * title path enforces, so both shapes share one invariant.
 */
export interface PromptOptions {
	displayParts?: DisplayPart[];
	title?: string;
}

/**
 * Helpers injected into `AgentCommand.execute`. `prompt` is always
 * available; the optional helpers require an interactive frontend
 * (headless callers may omit them, and commands that need them should
 * throw a clear error when they're absent).
 */
export interface AgentCommandHelpers {
	/**
	 * Send a user message and start an LLM turn. `text` is what the LLM
	 * receives; `opts` controls the bubble's display shape and the
	 * session title — see `PromptOptions`.
	 */
	prompt(text: string, opts?: PromptOptions): Promise<void>;
	/**
	 * Push a user-role bubble into the conversation (persisted) without
	 * starting an turn. Useful for informational content the user can
	 * read before deciding what to do next.
	 */
	displayMessage?(text: string): void;
	/**
	 * Ask the user to pick one string from a list. Resolves with the
	 * picked value, or `undefined` on ESC. TUI implementation opens a
	 * `DialogSelect`; a future headless caller can stub this with a
	 * stdin prompt.
	 */
	pickFromList?(params: {
		title: string;
		size?: "medium" | "large" | "xlarge";
		options: { title: string; value: string; description?: string }[];
	}): Promise<string | undefined>;
}

/**
 * A named agent persona — flat data, no inheritance.
 * See `docs/ARCHITECTURE.md` § Agent Registry for the registry shape,
 * how composers apply shared behavior, and the field-by-field rationale.
 *
 * Notable per-field rules:
 *   - `extraTools`        appended to `BASE_TOOLS`; no opt-out (D4).
 *   - `buildInstructions` nullary; called once per session/agent-swap,
 *                         not per turn (cache-stability invariant D9).
 *                         Composer prepends the workspace + commands blocks.
 *   - `getPermissions`    declarative permission overlay for the agent.
 *                         Per ADR 0009, this is the single source of
 *                         truth for both the dispatcher and the
 *                         system prompt's `<your workspace>` block —
 *                         same `Rule[]`, same bytes, no drift. Called
 *                         once per tool call so state-dependent rules
 *                         can inline fresh values.
 */
export interface AgentInfo {
	name: string;
	displayName: string;
	description: string;
	colorKey: AgentColorKey;
	extraTools: InkstoneTool<any>[];
	buildInstructions(): string;
	commands?: AgentCommand[];
	getPermissions?(): AgentOverlay;
	/**
	 * Opt out of `BASE_TOOLS` (`read` + `update_sidebar`) at compose
	 * time. Default `false` preserves ADR 0002's "every agent gets the
	 * base set" shape; only the router sets this `true` because per
	 * ADR 0007 it's a one-shot classifier with exactly one tool
	 * (`dispatch`). Without the opt-out, the router would carry `read`
	 * with the vault baseline — a misbehaving model could inspect vault
	 * files before dispatching, contradicting the classifier-only
	 * design and adding privacy/latency surface for no functional gain.
	 *
	 * Future agents that genuinely need a sandboxed prompt-only shape
	 * can reuse this flag rather than re-deriving the workaround.
	 */
	omitBaseTools?: boolean;
}
