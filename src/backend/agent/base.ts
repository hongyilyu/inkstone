import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { VAULT_DIR } from "./constants";
import type { AgentOverlay, Rule } from "./permissions";
import { editTool, readTool, writeTool } from "./tools";

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
 * Derive a permission overlay from an agent's zones. Produces rules
 * for the two mutating tools (`edit`, `write`) that the reader cares
 * about today; if a future agent composes additional mutating tools,
 * extend the key set.
 *
 * Policy by `AgentZone.write`:
 *   - `auto`    — no rule needed; writes inside this zone pass through
 *                 the vault baseline unchanged.
 *   - `confirm` — emit a `confirmDirs` rule listing the zone path.
 *
 * Zone paths are joined with `VAULT_DIR` via `node:path.join` so
 * leading/trailing slashes normalize. Absolute paths and paths containing
 * `..` segments are rejected at compose time to catch misconfiguration
 * loudly — a zone `/etc` or `../etc` would otherwise produce a path
 * outside the vault, and silent failure would leave the zone inert
 * (or worse, apply its `confirm`-semantics to something the agent was
 * never meant to touch).
 *
 * Returns an empty overlay for agents with no zones (example agent).
 */
export function composeZonesOverlay(info: AgentInfo): AgentOverlay {
	if (info.zones.length === 0) return {};

	const confirmPaths: string[] = [];
	for (const zone of info.zones) {
		if (zone.path.startsWith("/")) {
			throw new Error(
				`Zone path must be vault-relative, got absolute path: '${zone.path}' on agent '${info.name}'.`,
			);
		}
		if (zone.path.split("/").some((seg) => seg === "..")) {
			throw new Error(
				`Zone path must not escape the vault via '..' segments: '${zone.path}' on agent '${info.name}'.`,
			);
		}
		if (zone.write === "confirm") {
			confirmPaths.push(join(VAULT_DIR, zone.path));
		}
	}

	const overlay: AgentOverlay = {};
	if (confirmPaths.length > 0) {
		const rule: Rule = { kind: "confirmDirs", dirs: confirmPaths };
		overlay[writeTool.name] = [rule];
		overlay[editTool.name] = [rule];
	}
	return overlay;
}

/**
 * Merge the agent's optional custom overlay with the zones-derived
 * overlay. Custom rules come first (stricter escape hatches) so the
 * dispatcher's first-block-wins evaluation short-circuits on them
 * before the zone-level confirm prompts fire.
 *
 * Concrete case: reader's active article lives inside the Articles
 * zone (confirmDirs). A `write` against it should block outright
 * (custom `blockPath`), not confirm-then-block. Putting custom rules
 * first lets the block win without a wasted prompt. An `edit` of
 * frontmatter should pass without a confirm prompt because
 * `frontmatterOnlyFor` evaluates first and returns `undefined` (pass);
 * only then does the zone's `confirmDirs` fire. Net: confirm only
 * when no custom rule has an opinion.
 *
 * Keys with rules in both overlays are concatenated; custom first,
 * zones second.
 */
export function composeOverlay(info: AgentInfo): AgentOverlay {
	const zones = composeZonesOverlay(info);
	const custom = info.getPermissions?.() ?? {};
	const merged: AgentOverlay = { ...custom };
	for (const [toolName, rules] of Object.entries(zones)) {
		if (!rules) continue;
		merged[toolName] = [...(merged[toolName] ?? []), ...rules];
	}
	return merged;
}

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

/**
 * Render the agent's declared zones as a `<your workspace>` block the
 * LLM sees at the top of its system prompt. Single source of truth
 * with `composeZonesOverlay`: the same `AgentZone[]` drives both the
 * permission dispatcher and the prompt text, so the LLM's stated
 * workspace can't drift from the enforced one.
 *
 * Omitted entirely when the agent has no zones (example agent).
 *
 * The policy verbs map to concrete phrasing so the LLM can reason
 * about the rule, not just the directory:
 *   - `auto`    → "write freely"
 *   - `confirm` → "confirm before write"
 */
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

export function composeSystemPrompt(info: AgentInfo): string {
	const zonesBlock = composeZonesBlock(info);
	const body = info.buildInstructions();
	const sections = [zonesBlock, BASE_PREAMBLE, body].filter(
		(s) => s.length > 0,
	);
	return sections.join("\n\n");
}
