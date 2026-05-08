import type { DisplayPart } from "@bridge/view-model";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { AgentOverlay } from "./permissions";

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
 * A declared write zone on an agent's workspace.
 * See `docs/ARCHITECTURE.md` § Zones for what zones do, why read is
 * always vault-wide, and how `composeZonesOverlay` derives permission
 * rules from this data.
 *
 * `path` is vault-relative (resolved via `path.join` against
 * `VAULT_DIR` at compose time; absolute paths are rejected).
 *
 * `write` policy:
 *   - `auto`    — write inside this zone without prompting
 *   - `confirm` — prompt the user before each write inside this zone
 */
export interface AgentZone {
	path: string;
	write: "auto" | "confirm";
}

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
	execute(args: string, helpers: AgentCommandHelpers): void | Promise<void>;
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
	 * receives. Optional `displayParts` replace the user bubble's
	 * rendered parts without changing what reaches the model — reader's
	 * `/article` uses this to inline full article content in `text`
	 * while rendering a compact "prose + file chip" bubble.
	 */
	prompt(text: string, displayParts?: DisplayPart[]): Promise<void>;
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
 *                         Composer prepends the zones + commands blocks.
 *   - `zones`             empty array = no declared workspace.
 *   - `getPermissions`    escape hatch for rules zones can't express
 *                         (e.g. reader's `frontmatterOnlyInDirs`,
 *                         knowledge-base's `blockInsideDirs` over RAW
 *                         + HUMAN). Called once per tool call so
 *                         state-dependent rules can inline fresh values.
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
