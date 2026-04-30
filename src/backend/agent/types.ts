import type { DisplayPart } from "@bridge/view-model";
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
 * A `deny` policy was considered and cut: zones today only model write
 * permissions, and the matching rule kind (`blockInsideDirs`) now
 * exists as a standalone primitive that agents can opt into via
 * `getPermissions`. Adding a `deny` zone-policy that maps to
 * `blockInsideDirs` is a small ergonomics win when a real agent wants
 * it — deferred per D8 until one does.
 */
export interface AgentZone {
	/** Vault-relative path (e.g. `"020 HUMAN/023 Notes"`). */
	path: string;
	/** Write policy for this zone. */
	write: "auto" | "confirm";
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
 *                    after the slash name plus a `prompt` function the
 *                    shell injects. Commands typically compose a user
 *                    message (e.g. inline file content) and call
 *                    `prompt(text)` to kick off a turn. The optional
 *                    second argument `displayParts` overrides the user
 *                    bubble's rendered parts without changing what
 *                    reaches pi-agent-core — `text` is still the single
 *                    string pi-ai sees, so the LLM gets the full
 *                    payload while the bubble can stay compact. Reader's
 *                    `/article` is the reference pattern: `text` carries
 *                    `Path: + Content:`; `displayParts` is a short prose
 *                    line plus a file chip.
 *
 * The TUI's `BridgeAgentCommands` (`src/tui/context/agent.tsx`) converts
 * each `AgentCommand` into a `CommandOption` in the unified registry, so
 * slash dispatch, palette, and keybinds all share one surface.
 */
/**
 * Helpers injected into `AgentCommand.execute` by the TUI bridge.
 *
 * `prompt` is always available. The optional helpers require an
 * interactive frontend — headless callers may omit them, and commands
 * that need them should throw a clear error when they're absent.
 */
export interface AgentCommandHelpers {
	/**
	 * Send a user message and start an LLM turn. `text` is what pi-
	 * agent-core (and in turn pi-ai) hands to the LLM. The optional
	 * `displayParts` replace the user bubble's rendered parts without
	 * changing what reaches the model — the LLM still sees the full
	 * `text`. Reader's `/article` uses this to inline the full article
	 * content in `text` while rendering a compact "short prose + file
	 * chip" bubble via `displayParts`.
	 */
	prompt(text: string, displayParts?: DisplayPart[]): Promise<void>;
	/**
	 * Push a user-role bubble into the conversation (persisted to DB)
	 * without starting an LLM turn. Useful for displaying informational
	 * content (e.g. a recommendation list) that the user can read before
	 * deciding what to do next.
	 */
	displayMessage?(text: string): void;
	/**
	 * Ask the user to pick one string from a list. Resolves with the
	 * picked value, or `undefined` if the user cancelled (ESC).
	 * TUI implementation opens a `DialogSelect`; a future headless
	 * caller can stub this with a stdin prompt.
	 */
	pickFromList?(params: {
		title: string;
		size?: "medium" | "large" | "xlarge";
		options: { title: string; value: string; description?: string }[];
	}): Promise<string | undefined>;
}

export interface AgentCommand {
	name: string;
	description?: string;
	argHint?: string;
	takesArgs?: boolean;
	execute(args: string, helpers: AgentCommandHelpers): void | Promise<void>;
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
 * system prompt. Nullary by design — if an agent ever needs per-turn
 * context (session state, today's date, etc.), it owns that in its
 * own folder and reads it at compose time. The composer prepends the
 * zones block and `BASE_PREAMBLE`.
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
 * reader's `frontmatterOnlyInDirs` rule on the Articles zone.
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
