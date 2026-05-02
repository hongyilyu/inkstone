# Inkstone — Slash-Command Design

This doc captures the design exploration for a slash-command dropdown in the prompt. A first implementation landed in commit `8ff3876` and was reverted in the same PR; the revert commit references this doc. Pick up from here when returning to the feature.

**Status:**
- **Registry unification (Path A below): implemented.** `CommandOption.slash?: SlashSpec` + unified dispatch through `command.canRunSlash` / `command.triggerSlash`; `AgentCommand` bridges into `CommandOption` via `BridgeAgentCommands`; `/clear` is a palette entry in `Layout()`. The two previously-disconnected command paths (hardcoded `startsWith` in `prompt.tsx` + palette registry) now share one registration surface.
- **Dropdown UI: implemented.** `src/tui/components/prompt-autocomplete.tsx` — fuzzysort-filtered list of slash entries above the textarea. Column-0-only trigger, keyboard nav (Up/Down/Ctrl+P/Ctrl+N), Enter/Tab select, Esc dismiss. UX decision: plan (A) from §5 — dropdown-gated invocation (Enter selects when matches exist; falls through to plain prompt when empty). Argful commands insert `/name ` and close the dropdown. No `suspended` signal needed — the autocomplete's `useKeyboard` handler `preventDefault`s consumed keys directly.

## 1. Problem

Historically the prompt had two disconnected command paths:

- **Hardcoded `startsWith` checks** in `src/tui/components/prompt.tsx` for `/clear` and `/article <filename>`. Later superseded by a backend `AgentCommand` + `runAgentCommand` path.
- **Palette registry** via `CommandProvider` in `src/tui/components/dialog/command.tsx` for `/agents`, `/models`, `/effort`, `/themes`, `/connect` — shown in Ctrl+P.

After the registry unification, both flows go through the same `CommandOption` registry. The remaining gap is UX: users still can't discover or invoke commands by typing `/` in the prompt textarea with dropdown autocompletion. OpenCode, Discord, Slack, and Claude Code all support a live slash-command dropdown; Inkstone should too.

## 2. Current state (post-unification)

- `CommandOption.slash?: SlashSpec` — name / takesArgs / argHint.
- `command.canRunSlash(name, args)` + `command.triggerSlash(name, args)` on the provider API.
- `prompt.tsx` submit handler dispatches typed `/name args` through `triggerSlash`; unknown or arg-missing slashes fall through as plain prompts.
- `/clear` is a `CommandOption` registered by `Layout()` in `src/tui/app.tsx` with `slash: { name: "clear" }` that closes over `actions.clearSession`.
- `AgentCommand` entries from the current agent are bridged into palette entries via `BridgeAgentCommands` in `src/tui/context/agent.tsx`; argful commands set `hidden: true` so they don't appear in Ctrl+P.
- Dispatch precedence: agent-scoped entries beat shell-scoped on slash-name collision (first-match, agent-bridge registers first).
- No dropdown UI yet.

## 3. OpenCode reference pattern

From the `explore`-agent report during design:

- **Single registry**, with an optional `slash?: { name, aliases? }` field on each entry. Dropdown reads only entries with `slash`; palette shows all visible entries.
- **Three invocation routes** into the same `onSelect`: direct keybind, Ctrl+P palette, `/name` dropdown.
- **Trigger rule**: `/` typed at `cursorOffset === 0`. Dismisses on whitespace / `Escape` / explicit select.
- **Fuzzysort filtering** over display + description + aliases, with a 2× prefix-match boost, 10-item cap.
- **Two kinds of slash command**:
  - Palette-backed (immediate — selection opens a dialog; typed text is wiped from the textarea).
  - Text-verb (server/MCP commands — selection rewrites `/name ` and lets the user type args).
- **Positioning**: `<box position="absolute" zIndex={100}>` above the textarea, with a `setInterval(50ms)` polling loop to recompute position against the anchor.
- **Both UIs coexist**: a single registry entry can be invocable via keybind, palette, and slash simultaneously.

Reference file: `/home/hongyi/dev/opencode/packages/opencode/src/cli/cmd/tui/component/prompt/autocomplete.tsx` (672 lines — includes `@` mentions, frecency, directory-expand, mouse handling, width-padding, category grouping).

## 4. Decisions made in the exploration

- **Coexist with Ctrl+P palette**, don't replace. Both UIs over the same registry.
- **Trigger at column 0 only** — `/` typed as the first char of the textarea value. OpenCode's rule.
- **Hidden-only keybind entries** (e.g., Tab agent-cycle, ESC session-interrupt) stay in the registry; dropdown just filters them out by not having a `slash` field.
- **Conditional `/` hint** in the prompt footer when the textarea is empty; wording distinct from the existing `ctrl+p commands` label.
- **No prefix-match boost and no 10-item cap** — Inkstone's registry is small enough (5 visible entries today) that fuzzysort defaults rank correctly and nothing gets dropped.
- **Position strategy first attempt**: sibling-in-parent `position="absolute" bottom={6} left={0} right={0}` inside the prompt outer box — inherits layout reactively without polling. OpenCode's 50ms polling loop is a fallback if OpenTUI's layout model fights this.

## 5. Open UX principle (unresolved — the reason for revert)

Raised by the user late in the exploration:

> Dropdown should be a **suggestion**, not a trap. The user's explicit intent to invoke a command = selecting from the dropdown while it's active. If the user presses Esc, or keeps typing past the match, they're telling us "this isn't a command, it's prompt text" — and we should treat it as such.

Implications the exploration surfaced:

- **Invocation trigger is ambiguous.** Two readings of "eventually matches some command option":
  - **(A) Enter-while-dropdown-is-active-and-has-a-match** — standard chat-app UX. Typing past the match or Esc dismisses intent; next Enter submits as plain prompt.
  - **(B) Auto-invoke the moment typed text equals a command name exactly** — more aggressive, can surprise users who intend to keep writing after e.g. `/clear`.
- **`/article <filename>` breaks under the principle.** To provide `foo.md`, the user MUST type past the `/article` match, which the principle reads as "user is ignoring the dropdown = plain prompt." Three resolutions:
  - Build a `DialogArticle` picker now (reverses earlier "defer picker" decision).
  - Keep the hardcoded `/article foo.md` parser as a carve-out — principle violated for one command, honest about why.
  - Drop the `/article` slash feature entirely and surface article-loading via a different flow.
- **Hardcoded `/clear` parser's fate.** If the principle holds cleanly, `/clear ` (trailing space) + Enter should be plain prompt — but today's hardcoded parser fires on `text().trim() === "/clear"`. Either remove the hardcoded parser (let dropdown be the only invocation path) or keep as a safety net (pragmatic, principle-violating).

The exploration ended because (A) the first implementation had a bug (`/clear` swallowed — see §7), and (B) the user's UX principle arrived mid-remediation, which reshapes the whole feature. Revisit when the UX decisions are resolved.

## 6. Architecture tension — layer boundary (resolved for the registry half)

`backend/` cannot import `DialogContext` from `src/tui/ui/dialog.tsx` (enforced by Biome `noRestrictedImports` rules in `biome.json`). A single `SlashCommand` type in backend with `execute(args, { actions, dialog }) => void` is therefore impossible — the type would need to reference a TUI type.

**Path A shipped.** `SlashCommand` lives in backend as `AgentCommand` with a narrow `AgentCommandContext` (`{ prompt }` only — `refreshSystemPrompt` was removed once the shell's `prompt()` wrapper took over composing `systemPrompt` at the turn boundary). The TUI's `BridgeAgentCommands` component adapts each `AgentCommand` into a `CommandOption` with a `slash` field, closing over `wrappedActions` for the execute context. Dialog-opening commands stay as native `CommandOption` literals with `onSelect(dialog)`. Both kinds flow through the same registry; typed submit, palette, and keybinds treat them identically.

The two rejected alternatives (B1: hoist `SlashCommand` into TUI; B2: hoist + mirror folders) stay rejected — B1's disconnection of handlers from agent folders and B2's 2× folder count don't pay off.

## 7. First attempt (reverted in commit right after `8ff3876`)

### What shipped in `8ff3876`

- New file: `src/tui/components/autocomplete.tsx` (177 lines).
- `CommandOption.slash?: { name: string }` field and `setSuppressed` signal on `CommandProvider`.
- `slash: { name: ... }` added to the 5 palette entries in `src/tui/app.tsx`.
- `<Autocomplete>` mounted inside the prompt outer box; `handleSubmit` short-circuit via `autoRef?.visible()`; conditional `/ slash` footer hint.
- Known Issue + completion entries in `docs/TODO.md`.

### Bug found by review (`/clear` swallowed)

Trace:

1. User types `/clear`. Matches regex `^/[^\s]*$` → `visible()` stays true.
2. Fuzzysort over `["agents","models","effort","themes","connect"]` finds no subsequence match for `"clear"` → `filtered()` is `[]`.
3. Dropdown renders nothing (the `<Show when={visible() && filtered().length > 0}>` guard), but internal `visible` is true.
4. Enter → `handleSubmit` hits `if (autoRef?.visible()) { select(); return; }`. `select()` no-ops on empty filtered. Function returns. The hardcoded `/clear` branch below never runs.

Same bug shape for any typed `/xxx` that doesn't fuzzy-match a registered slash. The success criterion in that commit claimed this case was covered; it wasn't.

### Remediation paths discussed mid-revert

- **Narrow fix**: add `hasSelection: () => filtered().length > 0` to the ref; `handleSubmit` gates on `visible() && hasSelection()`. Defense-in-depth: Autocomplete's `useKeyboard` skips Enter/Tab when `filtered().length === 0` so `<input>`'s `onSubmit` fires naturally.
- **Architectural fix**: unified registry — the `/clear` bug is a symptom of the two-disconnected-paths problem. Per Path A: introduce `SlashCommand` type, `BUILTIN_SLASH_COMMANDS = [clearCommand]`, `AgentInfo.slashCommands`, reader declares `/article`, `handleSubmit` dispatches via registry lookup. Bug fixes itself because `/clear` is now an actual registry entry.

The user pushed for the architectural fix — then raised the UX principle in §5, which turns out to have larger implications than can be resolved without a separate design pass.

## 8. Implementation-budget notes for the next attempt

- Reviewer's soft ceiling was ~120–150 lines for `autocomplete.tsx`. First attempt landed at 177 (structural JSX + keyboard switch, not speculative features). Every block traced to a success criterion or failure mode.
- **Biome rules**: avoid non-null assertions. Narrow types with predicate filters (`.filter((e): e is SlashEntry => !!e.slash)`) or use `?. ?? ""` fallbacks. The first attempt hit this — resolved by using a narrowing predicate on the `entries` memo and `match[1] ?? ""` on the regex group.
- **Position strategy**: first attempt used sibling-in-parent `<box position="absolute" bottom={6} left={0} right={0}>` inside the prompt outer box. Smoke-tested as booting without crash; full interactive rendering under multiple terminal sizes was not verified before revert. OpenCode's 50ms polling loop is the fallback.
- **Keybind suppression**: `CommandProvider`'s `useKeyboard` fires earlier than the Autocomplete-owned `useKeyboard` (registration order — `CommandProvider` is mounted higher in the tree). `evt.preventDefault` from a later handler arrives too late. First attempt solved this via a `setSuppressed` signal on `CommandContext` that the Autocomplete toggles via `createEffect` while visible. Alternative: expose the dropdown-visibility as a signal somewhere CommandProvider can read, or restructure so the Autocomplete's handler registers first.

## 9. When to revisit — checklist

Before picking up the **dropdown UI**:

1. **Resolve §5's UX principle.** Specifically: what triggers invocation (A vs B vs neither), and `/article`'s fate (picker / carve-out / drop). The hardcoded `/clear` parser is already gone — `/clear` is a registry entry now.
2. **Path A is shipped** (see §6 Status). No remaining authoring-path decision.
3. **Pick a positioning strategy upfront** — sibling-in-parent vs polling — and name which terminal-size / layout scenarios are in the verification matrix.
4. **Budget the Autocomplete component** with awareness that ~180 lines is the realistic floor for the trimmed feature set (not 120); anything larger than ~220 warrants a pause.

Once the dropdown ships cleanly, delete this doc (or collapse into `AGENT-DESIGN.md` D9 as "resolved").

## References

- Revert commit: the commit immediately following `8ff3876` on the `refactor/agent-shell-base-layer` branch.
- OpenCode autocomplete: `/home/hongyi/dev/opencode/packages/opencode/src/cli/cmd/tui/component/prompt/autocomplete.tsx`
- OpenCode command registry: `/home/hongyi/dev/opencode/packages/opencode/src/cli/cmd/tui/component/dialog-command.tsx`
- Inkstone design rationale (layer boundaries, pressure points): `docs/AGENT-DESIGN.md`
- Inkstone pressure point for agent-declared session verbs: `docs/AGENT-DESIGN.md` → "Reader-specific vocabulary leaks onto AgentActions"
