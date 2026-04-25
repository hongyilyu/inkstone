# Inkstone — Architecture

## Overview

Inkstone is a terminal UI application built with OpenTUI (Solid reconciler) that uses pi-agent-core as a headless LLM agent backend. The agent runs in-process — no server, no worker threads, no network boundary.

The codebase is split into three layers with enforced dependency direction so the agent and the frontend can be worked on in parallel and the TUI can eventually be swapped for a desktop or web frontend without touching the agent logic.

## Layer boundaries

```
┌─────────────┐       ┌──────────────┐       ┌────────────────────┐
│  src/tui/   │──────▶│ src/bridge/  │◀──────│    src/backend/    │
│  Solid +    │       │  pure types  │       │  pi-agent-core,    │
│  OpenTUI    │──────▶│              │       │  tools, persist    │
└─────────────┘       └──────────────┘       └────────────────────┘
       └──────────── can call actions ─────────────▶
```

| Layer | Purpose | Runtime deps |
|---|---|---|
| `src/backend/` | Headless agent — pi-agent-core `Agent`, tools, guard, system prompt, config + session persistence, **provider registry**. No Solid, no OpenTUI, no UI. | pi-agent-core, pi-ai, diff, typebox, fs |
| `src/bridge/` | Shared type contract between backend and any frontend. Pure TS, zero runtime. | none |
| `src/tui/` | Solid + OpenTUI frontend — components, dialogs, theme, keybinds, store wiring. | solid-js, @opentui/* |

**Dependency rules** (mechanically enforced by Biome's `noRestrictedImports` rule via `overrides` in `biome.json`):

- `tui/` may import from `bridge/`, `backend/`.
- `backend/` may import from `bridge/` (types only, zero runtime cost). **Must not** import from `tui/`.
- `bridge/` must not import from `backend/` or `tui/`.

Each boundary rule uses two glob patterns per forbidden target so both bypass forms fail lint:

- `@tui/*` — the alias form.
- `**/tui/**` — any relative path that climbs into `tui/` (e.g. `../tui/app`, `../../tui/app`, `./tui/x`).

Same pair (`@backend/*` + `**/backend/**`) for the backend restriction on bridge.

### Path aliases

Cross-layer imports use `tsconfig.json` aliases; intra-layer imports stay relative. Aliases are the *preferred* spelling (clearer at a glance that the line crosses a layer boundary), but the boundary rule is independent of the spelling — writing `../tui/...` from `backend/` fails lint just as surely as `@tui/...`.

| Alias | Resolves to |
|---|---|
| `@backend/*` | `src/backend/*` |
| `@bridge/*` | `src/bridge/*` |
| `@tui/*` | `src/tui/*` |

### Lint + format

`bun run ci` runs Biome with recommended rules (a11y off because there's no HTML; `noExplicitAny` off because of intentional `any` for unexported OpenTUI event types). Boundary rules fail the build if violated. Run `bun run check` locally to auto-fix format and safe lint issues; use `bun run lint` to see remaining warnings.

### Type-placement rule

| Location | Purpose | Example |
|---|---|---|
| `bridge/view-model.ts` | Shared view-state contract any frontend would render/persist | `DisplayMessage`, `AgentStoreState`, `SessionData` |
| `backend/agent/*` | Backend's public API surface — consumed directly by frontends | `AgentActions`, re-exports from pi-agent-core |
| `tui/**` | Frontend-internal only | `AgentContextValue`, theme accessors, component props |

Bridge is for types **both sides need to agree on as a shared data shape**. Backend's API types (e.g. `AgentActions`) are published *by* the backend *to* its consumers; they don't go through the bridge.

## Data Flow

```
User input (textarea)
  → command parsing (/article, /model, etc.)
  → agent.prompt(text)
    → pi-agent-core Agent loop
      → LLM API call (provider from registry — Bedrock today)
      → tool calls (read_file, edit_file, write_file, quote_article)
        → beforeToolCall guard (block/confirm/allow)
      → streaming events
    → agent.subscribe() callback
      → batch() Solid store updates
        → fine-grained reactivity → UI re-render
```

## File Structure

```
src/
  index.tsx                         Entry: createCliRenderer() + render(<tui.App />)

  backend/                          Headless — no Solid, no OpenTUI
    agent/
      index.ts                      Agent instance, createAgentActions, query getters
      agents.ts                     Registry assembler — imports each agent's AgentInfo literal and exports AGENTS[]
      constants.ts                  VAULT_DIR, ARTICLES_DIR, SCRAPS_DIR, etc.
      guard.ts                      beforeToolCall (frontmatter guard + confirm); cross-cutting, stays at top level
      base/                         Foundation layer — the "base agent"
        index.ts                    AgentInfo type + AgentColorKey + BASE_TOOLS + BASE_PREAMBLE + composeTools + composeSystemPrompt
        tools/
          read-file.ts              readFileSync, scoped to VAULT_DIR — available to every agent via BASE_TOOLS
      agents/                       Custom agents, one self-contained folder each
        reader/
          index.ts                  readerAgent: AgentInfo literal
          instructions.ts           buildReaderInstructions(articleId) — the reader's system-prompt body + 6-stage workflow
          tools/
            quote-article.ts        Paragraph search in active article
            edit-file.ts            String replace + unified diff, scoped to VAULT_DIR
            write-file.ts           writeFileSync/append, scoped to VAULT_DIR
        example/
          index.ts                  exampleAgent: AgentInfo literal (1-line prompt, no extra tools)
    providers/
      types.ts                      ProviderInfo interface (id, displayName, listModels, getApiKey, isConnected, authInstructions)
      amazon-bedrock.ts             Bedrock provider — wraps pi-ai `getModels("amazon-bedrock")`, auth via `getEnvApiKey`
      kiro.ts                       Amazon Kiro provider — wraps `pi-kiro/core`; registers `kiro-api` with pi-ai; OAuth (Builder ID / IdC) with lazy refresh
      index.ts                      PROVIDERS registry + getProvider/listProviders/resolveModel helpers
    config/
      config.ts                     providerId + modelId + themeId + currentAgent + vaultDir (shared JSON; Zod-validated on load via `config/schema.ts`)
      auth.ts                       OAuth credentials loader/saver (provider-keyed; Zod-validated on load)
      auth.json                     Runtime file (~/.config/inkstone/auth.json, mode 0600)
      session.ts                    DisplayMessage[] + activeArticle (JSON; SQLite candidate)
      errors.ts                     Shared persistence-file error hook (setPersistenceErrorHandler / reportPersistenceError); `kind: "config" | "auth" | "session"`
      paths.ts                      Shared XDG paths: CONFIG_DIR, STATE_DIR, CONFIG_FILE, AUTH_FILE, SESSION_FILE
      schema.ts                     Zod schemas for Config + AuthFile (strictObject, field-level validation)

  bridge/                           Pure TS — shared type contract
    view-model.ts                   DisplayMessage, AgentStoreState, SessionData

  tui/                              Solid + OpenTUI
    app.tsx                         Provider stack + root layout + app_exit + scroll keybinds; registers top-level commands via `useCommand().register`
    context/
      agent.tsx                     AgentProvider + useAgent (Solid store + event reducer); wires persistence error hook to toast
      theme.tsx                     Theme loading, resolution, application (SyntaxStyle FFI)
    ui/
      dialog.tsx                    Stack-based modal rendering (uses `Keybind.match("dialog_close")`)
      dialog-confirm.tsx            Promise-based yes/no confirmation (local y/n/arrow keys)
      dialog-select.tsx             Fuzzy filterable select list (uses `Keybind.match("select_*")`)
      dialog-prompt.tsx             Promise-based single-line input (`DialogPrompt.show(...)`)
      dialog-auth-wait.tsx          Read-only URL + user-code + progress screen used during OAuth device-code flows
      toast.tsx                     Toast notifications
    components/
      conversation.tsx              Scrollbox + message list (user-bubble border + `▣` glyph derive from active agent color)
      prompt.tsx                    Textarea prompt with /command parsing, agent label, tab-cycle hint (hints via `Keybind.print`); streaming indicator = `SpinnerWave` colored by the active agent
      spinner.tsx                   Simple braille-dot spinner (`Spinner`). Not used by the prompt; kept importable for future subagent-status / background-tool indicators
      spinner-wave.tsx              `SpinnerWave` — 8-cell bidirectional knight-rider wave. Port of OpenCode's `ui/spinner.ts` (blocks + bidirectional branches only); 54 precomputed frames at 40 ms interval, per-cell RGBA derived from a single base color via a 6-step trail + alpha fade
      sidebar.tsx                   Session metadata panel (title, context, article)
      open-page.tsx                 Empty-state welcome page
      dialog-command.tsx            `CommandProvider` + `useCommand` + internal palette. Registry-driven: components call `register(() => CommandOption[])`; the provider's `useKeyboard` dispatches any matching `keybind` and opens the palette on `command_list`.
      dialog-agent.tsx              Agent selection dialog
      dialog-model.tsx              Model selection dialog
      dialog-variant.tsx            Reasoning-effort (ThinkingLevel) picker — opened standalone via the "Effort" palette entry for reasoning-capable models
      dialog-theme.tsx              Theme selection dialog
      dialog-provider.tsx           Provider selection dialog
    util/
      format.ts                     formatTokens, formatCost, formatDuration, displayPath (~-collapse for home dir, platform-neutral)
      keybind.ts                    `KEYBINDS` action map + `match(action, evt)` + `print(action)` (single source of truth for all keybinds outside dialog-confirm's local y/n)
```

## Provider Stack

```tsx
<ThemeProvider>
  <ToastProvider>
    <DialogProvider>
      <CommandProvider>
        <AgentProvider>
          <Layout />
        </AgentProvider>
      </CommandProvider>
    </DialogProvider>
  </ToastProvider>
</ThemeProvider>
```

`CommandProvider` sits inside `DialogProvider` because its dispatch loop reads the dialog stack (to yield to open dialogs). `AgentProvider` runs inside `CommandProvider` so `Layout` can call both `useAgent()` and `useCommand()`.

## Agent Integration

The `AgentProvider` creates a pi-agent-core `Agent` instance (via `backend/agent/`) and subscribes to its events. State is held in a `createStore`:

```ts
{
  messages: DisplayMessage[]     // full history (see below for shape)
  isStreaming: boolean
  activeArticle: string | null
  modelName: string
  modelProvider: string          // provider *id* (e.g. "amazon-bedrock"); format via getProvider(id).displayName at render time
  contextWindow: number
  modelReasoning: boolean        // pi-ai's Model.reasoning capability flag; gates visibility of the "Effort" palette entry + statusline effort badge
  thinkingLevel: ThinkingLevel   // pi-agent-core's reasoning effort for the active model; "off" when model is non-reasoning or user disabled it
  status: "idle" | "streaming" | "tool_executing"
  totalTokens: number            // accumulated across all assistant turns
  totalCost: number              // accumulated across all assistant turns
  lastTurnStartedAt: number      // Date.now() when user prompt sent; consumed in agent_end
  currentAgent: string           // active agent name (e.g. "reader" | "example")
}
```

Both `DisplayMessage` and `AgentStoreState` are defined in `src/bridge/view-model.ts` — they are the cross-frontend view-state contract.

`DisplayMessage`:

```ts
{
  id: string
  role: "user" | "assistant"
  parts: DisplayPart[]     // ordered blocks; user messages always a single text part
  agentName?: string   // assistant only, set in message_end
  modelName?: string   // assistant only, set in message_end
  duration?: number    // assistant only, ms, set in agent_end
  error?: string       // assistant only, pi-ai errorMessage on stopReason error/aborted
}

type DisplayPart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
```

Events from `agent.subscribe()` are batched via `batch()` and applied to the store by the switch statement in `tui/context/agent.tsx`. Solid's fine-grained reactivity ensures only affected UI nodes re-render.

> Design note: the event → view-state reducer is intentionally kept inline in the TUI's `AgentProvider` (not extracted to a shared `bridge/` module). If a second non-TUI frontend arrives, factor it out then. Avoids speculative abstraction for a single-consumer project.

## Markdown Rendering

Assistant messages are rendered through OpenTUI's `<markdown>` component in `src/tui/components/conversation.tsx`. The component takes a `SyntaxStyle` built by `generateSyntax(colors)` in `src/tui/context/theme.tsx`, which maps ~40 Tree-sitter scopes (markup.* for markdown structure, plus core code scopes for fenced blocks) onto the active theme's existing named colors. The style is exposed as a reactive accessor `useTheme().syntax()` and re-creates whenever the theme id changes, so switching themes re-paints already-rendered markdown.

Each assistant bubble iterates `msg.parts` and renders one `<markdown>` per block, so interleaved thinking/text from a single turn renders in emission order. The `streaming` prop is enabled only on the **tail block of the last bubble** while `store.isStreaming` is true, so the markdown parser keeps only that trailing block unstable during deltas and finalizes earlier blocks. Markdown syntax markers (`**`, `` ` ``, `#`, etc.) are concealed by default — users see rendered output, not source. User messages remain plain `<text>` inside the left-border bubble, reading `msg.parts[0].text` (user turns always hold exactly one text part).

### Thinking blocks

Ported from OpenCode's `ReasoningPart` (`routes/session/index.tsx:1437-1468`), trimmed to Inkstone's scope:

- Part type: `DisplayPart` with `type: "thinking"` — a first-class sibling to `text`, dispatched by the `parts` iterator in `conversation.tsx`.
- Event capture: `message_update` in `context/agent.tsx` branches on `assistantMessageEvent.type` (typed as pi-ai's `AssistantMessageEvent` union). `thinking_start` pushes a fresh `{ type: "thinking", text: "" }` part; `thinking_delta` appends to the tail part's text after a runtime guard that the tail's `type === "thinking"` (cheap insurance against upstream event reordering); `thinking_end` pops the part when `lastPart.text.replace("[REDACTED]", "").trim()` is empty. That predicate covers both redacted-thinking shapes: Anthropic's `redacted: true` path emits no `thinking_delta` at all (empty text), while OpenRouter emits the literal `[REDACTED]` as a delta chunk that would otherwise render verbatim (`"[REDACTED]".trim()` is truthy). OpenCode filters the same literal at render time (`routes/session/index.tsx:1443`); Inkstone filters reducer-side because it has no `showThinking` toggle, so a stored-but-never-rendered part would just be dead weight in persistence. Same switch dispatches `text_start` / `text_delta` symmetrically for assistant text.
- Part-type immutability: `part.type` is reducer-guaranteed to be stable for the lifetime of the part — `message_update` only ever pushes new parts or appends to the tail's `text`, never mutates `type`. The `ReasoningPart` / `TextPart` dispatch inside `<For>` in `conversation.tsx` reads `part.type` non-reactively (the `<For>` item callback evaluates the branch once per render and keys items by reference). If future work ever mutates `part.type` in-place, the renderer must be refactored to a reactive primitive (e.g. `<Switch>/<Match>` keyed on a memo of `part.type`) or the dispatch will stick to the first-seen type.
- Visual treatment: left bar (`┃` via `SplitBorderChars`) in `theme.backgroundElement`, `paddingLeft={2}`, `marginTop={1}` when not the first block, single `<markdown>` body with `"_Thinking:_ "` prepended to the part text so the label renders inline as italic markdown (per OpenCode's `ReasoningPart`). Body is rendered with `syntaxStyle={subtleSyntax()}`, no outer `fg` override — an outer `fg` would flatten all tokens to one color and defeat per-scope dimming.
- Part stacking: each non-first part carries `marginTop={1}`, the first part carries `marginTop={0}`. Intentional divergence from OpenCode's `AssistantMessage`, which sets `marginTop={1}` unconditionally on every part (`routes/session/index.tsx:1450, 1475`). OpenCode renders assistant bodies as a bare fragment so each `marginTop` lands directly; Inkstone wraps the body in a `<box flexDirection="column">` inside an outer `<For>` with `gap={1}` between bubbles, so an unconditional first-part `marginTop={1}` would double-space against the outer gap. Footer uses `paddingTop={1}` on its own box (same pattern as OpenCode's `box paddingLeft={3}` + `text marginTop={1}` at line 1403-1404, simplified).
- **Always rendered** when present — no `showThinking` toggle, no keybind, no palette entry. Matches the current "no slash-command system" constraint; a toggle lands when slash-commands or a KV layer do.
- Trimmed from OpenCode's port: per-turn elapsed timer, "Thinking..." spinner, transcript/export parity (Inkstone has no export flow). The `subtleSyntax()` variant (60%-alpha syntax rules) and its `thinkingOpacity` theme knob ARE ported — see below.

### subtleSyntax (reasoning-block dimming)

Ported verbatim from OpenCode's `generateSubtleSyntax` (`opencode/.../context/theme.tsx`). `generateSubtleSyntax(colors)` in `src/tui/context/theme.tsx` maps over `getSyntaxRules(colors)` and, for every rule with a `foreground`, rebuilds the `RGBA` at alpha `colors.thinkingOpacity` (default `0.6`, set per-theme on `ThemeColors`). `useTheme().subtleSyntax()` exposes the memoized `SyntaxStyle`, re-created on theme switch with the same `onCleanup(() => style.destroy())` FFI cleanup as the normal `syntax()` memo. Used only by `ReasoningPart`. Normal text parts continue to use `syntax()` at full saturation.


`SyntaxStyle` wraps an FFI pointer into Zig-side allocations that JS GC cannot reclaim. The memo registers an `onCleanup(() => style.destroy())` so the previous instance is released on theme switch (recompute) and on provider disposal (app exit) — see `src/tui/context/theme.tsx`.

## Per-Message Status Line

Each completed assistant message renders its own status line directly below its markdown body in `src/tui/components/conversation.tsx`:

```
▣ Reader · Claude Opus 4.6 (US) · 1m 2s
```

### Field scopes (per-message vs. per-turn)

`DisplayMessage` splits footer fields by scope. This matters for tool-driven turns, which emit multiple assistant messages.

- **Per-message** — `agentName`, `modelName`, `error`. Written in `message_end`. Each assistant bubble records the agent and model that produced *that specific* reply, sourced from the assistant event (not from mutable store state). A tool turn with two assistant messages produces two bubbles, each with its own correct `agentName`/`modelName`. `error` carries pi-ai's `AssistantMessage.errorMessage` when the turn ended with `stopReason === "error" | "aborted"` — each bubble can fail independently, and the failure is scoped to the specific assistant boundary that produced it.
- **Per-turn** — `duration`. Written in `agent_end`. Represents the wall-clock time from the user's prompt to the turn completing. Stamped only on the turn-closing assistant bubble, which is `messages[length - 1]` when `agent_end` fires (tool results aren't rendered as display bubbles, so the last bubble is always the turn-closing assistant message). Intermediate assistant bubbles in a tool turn intentionally carry `agentName` + `modelName` without a `duration` — "how long did the whole turn take?" only has a single answer per turn, and the turn-closing bubble is where it belongs.

The conversation renderer shows the footer whenever `msg.modelName` is present, and adds the duration pip only when `msg.duration > 0`, so intermediate tool-turn bubbles render `▣ Reader · <model>` without a duration, and the turn-closing bubble renders the full `▣ Reader · <model> · <duration>`. When `msg.error` is set, a warning-bordered panel (left border in `theme.error`, muted body text) renders between the part list and the footer, mirroring OpenCode's per-message error surface (`routes/session/index.tsx:1374-1387`). An errored bubble with empty parts (the common case — pi-ai returns empty content on provider errors) still renders because the outer gate is `msg.parts.length > 0 || msg.error`, not parts alone. Abort (`stopReason === "aborted"`) currently uses the same panel; differentiating it via a muted `· interrupted` footer suffix (OpenCode's pattern at `routes/session/index.tsx:1407-1409`) is tracked as future work.

### Bubble-per-assistant-boundary

`AgentProvider` pushes a fresh empty assistant `DisplayMessage` on every pi-agent-core `message_start` event whose `message.role === "assistant"` (filtering out user/toolResult starts, which are handled elsewhere or not rendered). `message_update` deltas append to the last-pushed bubble, and `message_end` stamps `agentName` / `modelName` onto that same bubble.

This mirrors pi-agent-core's own boundaries: a tool-using turn emits one assistant `message_start` / `message_end` pair before the tool call and another after the tool result. Each pair gets its own display bubble with its own per-message footer data, so saved sessions replay the original assistant boundaries and the per-message fields cannot leak between them. `<Show when={msg.parts.length > 0 || msg.error}>` in `conversation.tsx` hides bubbles that are neither visible content nor a failure (e.g., a pure tool-call assistant message with `stopReason === "toolUse"`), so empty bubbles don't clutter the conversation while errored bubbles (empty parts + populated `error`) still render.

Sourcing the model from `event.message` (rather than the mutable `store.modelName`) means switching models mid-run via Ctrl+P does not relabel the in-flight assistant reply. `store.modelName` continues to reflect the currently-selected model for the sidebar and the next prompt.

### Duration and transient state

`lastTurnStartedAt` is a transient set in `prompt()` and consumed in `agent_end`. Once written to the turn-closing message it's not read again, so messages loaded from a persisted session render their original footer unchanged even though the transient is `0` at startup.

Older messages that predate these fields (legacy sessions) simply render without a footer because `modelName` is `undefined`.

## Guard Logic

The `beforeToolCall` hook runs before each tool execution:

1. **Path validation**: reject any path resolving outside VAULT_DIR
2. **Article file protection**: allow frontmatter edits, block content edits and full writes
3. **Notes/scraps confirmation**: show DialogConfirm, await user response

The confirmation dialog is async — `beforeToolCall` awaits the dialog promise before returning `{ block: true/false }`.

## Agent Registry

Multi-agent support is a **flat registry with runtime composition** — no inheritance. Each agent is a self-contained folder under `src/backend/agent/agents/<name>/` that exports an `AgentInfo` literal (name, displayName, description, `colorKey`, `extraTools`, `buildInstructions`, optionally `commands`). `src/backend/agent/agents.ts` is a thin assembler that imports each agent's literal and exports them as `AGENTS: AgentInfo[]`. The registry is a plain array — it never changes at runtime — so frontends that need the agent list import it directly rather than going through the bridge. Only the *selected* agent name crosses the bridge as reactive state (`AgentStoreState.currentAgent`).

> **Design rationale:** see [`AGENT-DESIGN.md`](./AGENT-DESIGN.md) for why the system is shaped this way (composition over inheritance, folder-per-agent, base layer, no opt-out on `BASE_TOOLS`, vault ≠ config, commands vs tools), what alternatives were rejected, and how future features (skills, memory) are designed to plug in without restructuring.

### Base layer (the "base agent")

`src/backend/agent/base/` owns everything shared across agents:

- `AgentInfo` (the type) and `AgentColorKey`.
- `AgentCommand` + `CommandContext` types (see Commands below).
- `BASE_TOOLS: readonly AgentTool[]` — tools every agent receives. Today just `read_file` (scoped to `VAULT_DIR`). Frozen at module load so external modules can't mutate.
- `BUILTIN_COMMANDS: readonly AgentCommand[]` — session-global commands available under every agent. Today `[{ name: "clear", ... }]`. Frozen.
- `BASE_PREAMBLE: string` — a shared system-prompt prefix. **Empty today** — the mechanism is the point. Future PRs will grow this into a composed block that includes persona guidance, tool-use discipline, and memory-file contents (`user.md`, `memory.md` from `~/.config/inkstone/`).
- `composeTools(info)` — returns `[...BASE_TOOLS, ...info.extraTools]`. Every agent gets the base set unconditionally; there is no opt-out flag.
- `composeSystemPrompt(info)` — prepends `BASE_PREAMBLE` to `info.buildInstructions()` when non-empty; otherwise returns the instructions unchanged. Nullary — `buildInstructions` reads any agent-owned state (e.g. reader's `activeArticle`) directly.

`backend/agent/index.ts` calls both composers at the moments where the agent's tools or system prompt must be rebuilt: initial `getAgent()` instantiation, `setAgent()`, `clearSession()`, and whenever a command calls `ctx.refreshSystemPrompt()`.

### Agents on ship

| Name | extraTools | Composed tools | Commands | Prompt behavior | Color |
|------|------------|----------------|----------|-----------------|-------|
| `reader` | `edit_file`, `write_file`, `quote_article` | `read_file` + the extras | `article` (+ built-in `clear`) | Embeds the active article and the 6-stage reading workflow | `theme.secondary` |
| `example` | — | `read_file` only | (built-in `clear` only) | Short static "general-purpose assistant" prompt | `theme.accent` |

### Adding a new agent

The folder-per-agent shape makes this a local change:

1. Create `src/backend/agent/agents/<name>/index.ts` exporting `<name>Agent: AgentInfo`.
2. If the agent needs an agent-specific system prompt, add `instructions.ts` next to it and import it from `index.ts`.
3. If it owns tools that no other agent uses, add them under `agents/<name>/tools/`.
4. If it has user-facing verbs, declare them as `AgentCommand[]` and set `commands: [...]` on the `AgentInfo`.
5. Add one import + one entry in `backend/agent/agents.ts`.

No changes to `base/`, to `backend/agent/index.ts`, to the TUI, or to config schemas are required.

### Commands

Commands are user-invoked verbs, distinct from tools (which are LLM-invoked mid-turn). See [`AGENT-DESIGN.md` D9](./AGENT-DESIGN.md) for the rationale; this section documents the runtime.

**Type shape** (`backend/agent/base/index.ts`):

```ts
export interface CommandContext {
  prompt(text: string): Promise<void>;
  abort(): void;
  clearSession(): void;
  refreshSystemPrompt(): void;
}

export interface AgentCommand {
  name: string;
  description?: string;
  argHint?: string;
  takesArgs?: boolean;
  execute(args: string, ctx: CommandContext): void | Promise<void>;
}
```

**Sources**:
- `BUILTIN_COMMANDS` in `base/` — session-global. Today: `/clear`.
- `AgentInfo.commands` on a custom agent — agent-scoped. Today: reader's `/article`.

**Dispatch** (`AgentActions.runAgentCommand(name, args?)` in `backend/agent/index.ts`):

```
runAgentCommand(name, args)
  → info = getAgentInfo(currentAgent)
  → cmd = info.commands?.find(c => c.name === name)         ← agent-scoped first
       ?? BUILTIN_COMMANDS.find(c => c.name === name)       ← built-in fallback
  → if !cmd: throw "Unknown command"
  → cmd.execute(args, ctx)
      ctx = {
        prompt:              actions.prompt,
        abort:               actions.abort,
        clearSession:        actions.clearSession,
        refreshSystemPrompt: rebuild a.state.systemPrompt,
      }
```

Agent-scoped commands take precedence over built-ins on name collision (intentional — an agent can override a built-in).

**TUI submit path** (`tui/components/prompt.tsx`):

```
user types "/article foo.md" + Enter
  → handleSubmit
    → value.startsWith("/") → split on first space
      → name="article", args="foo.md"
      → actions.runAgentCommand("article", "foo.md")
        → reader's articleCommand.execute("foo.md", ctx)
          → setActiveArticle("foo.md")              (reader module state)
          → ctx.refreshSystemPrompt()               (rebuild with article context)
          → await ctx.prompt("Read foo.md")         (streaming turn begins)
      → setText("")                                  (clear input)

user types "/xyz" + Enter
  → handleSubmit
    → actions.runAgentCommand("xyz", "")
      → throws "Unknown command"
    → .catch → restore original text (user can edit / resubmit)
```

**Session restore** bypasses the command dispatcher — it rehydrates state without triggering a prompt turn. `context/agent.tsx` calls `setActiveArticle(saved.activeArticle)` + `actions.refreshSystemPrompt()` directly.

### Switching rules

Switching is intentionally locked to empty sessions (`store.messages.length === 0`), diverging from OpenCode's always-on `agent_cycle`. This matches Inkstone's "one agent per session" model and avoids the bookkeeping OpenCode needs (per-message `agent` stamps on user bubbles, tool-result routing, mid-stream prompt rebuilds).

- **Tab / Shift+Tab** on the open page cycle forward / backward through the registry. Registered as hidden commands via `useCommand().register` in `Layout()` (`src/tui/app.tsx`), gated by `store.messages.length === 0` inside the registration callback so the bindings auto-disable once a message exists.
- **Command palette → Agents** opens `DialogAgent`, the entry is hidden once `store.messages.length > 0`.
- **Persistence**: the selected agent is saved to `config.json` as `currentAgent` on every switch and restored at boot. Unknown names fall back to the first registry entry.

### Data flow (agent switching)

```
setAgent(name)
  → AgentActions.setAgent (backend/agent/index.ts)
    → currentAgent = info.name
    → a.state.systemPrompt = composeSystemPrompt(info)
    → a.state.tools        = composeTools(info)
    → saveConfig({ currentAgent })
  → tui wrapper (context/agent.tsx)
    → setStore("currentAgent", getCurrentAgent())
      → prompt label, input border, user-bubble border, assistant ▣ glyph all re-theme via `theme[getAgentInfo(store.currentAgent).colorKey]`
```

The composers (`composeSystemPrompt`, `composeTools`) are defined in `backend/agent/base/index.ts`. With `BASE_PREAMBLE === ""`, `composeSystemPrompt(info)` is a pass-through to `info.buildInstructions()`.

The assistant `message_end` handler stamps `agentName` onto the new bubble using `getAgentInfo(store.currentAgent).displayName`. Because switching is locked mid-session, the stamped name is guaranteed to be the agent that actually produced the reply.

## Provider Registry

Providers are declared in `src/backend/providers/` as a static registry — same pattern as `agent/agents.ts`. The registry wraps pi-ai's per-API stream functions (`getModels(provider)` + pi-ai's internal `api-registry`) with the user-facing metadata Inkstone needs: display name, connection check, auth instructions.

### Why a registry on top of pi-ai

pi-ai already owns streaming for each API it ships (`bedrock-converse-stream`, `anthropic-messages`, `openai-responses`, …). Inkstone's `ProviderInfo` sits above that:

- The registry owns the list of providers Inkstone actually exposes (pi-ai ships many; a given Inkstone build may surface a subset).
- Each provider decides how its credentials resolve and reports a connected/disconnected status so the UI can gate on it.
- Custom providers that pi-ai doesn't ship (e.g. Bedrock-Converse-compatible endpoints like Amazon Kiro) can return hand-built `Model<Api>` objects with a custom `baseUrl`, reusing pi-ai's existing stream function for that API. No change to pi-ai itself.
- The extension point for fundamentally-different custom providers (own `streamFn`) is intentionally *not* wired here. Add it when the first such provider lands; not speculatively.

### `ProviderInfo` shape

```ts
interface ProviderInfo {
  id: string;                        // e.g. "amazon-bedrock"
  displayName: string;               // "Amazon Bedrock"
  defaultModelId: string;            // curated default when config is empty / stale
  listModels(): Model<Api>[];
  getApiKey(): string | undefined;   // forwarded to Agent.getApiKey hook
  isConnected(): boolean;            // credentials configured?
  authInstructions: string;          // shown in Connect dialog on a miss
}
```

`defaultModelId` is required (not optional) so every provider declares its own curated fallback rather than depending on registry order. The agent module throws on boot if the declared default no longer resolves through `listModels()`, surfacing pi-ai registry drift loudly instead of silently relocating the user to an arbitrary model.

One provider ships today:

| id | displayName | Default | Auth detection | Models |
|---|---|---|---|---|
| `amazon-bedrock` | Amazon Bedrock | `us.anthropic.claude-opus-4-7` | pi-ai's `getEnvApiKey("amazon-bedrock")` (AWS_PROFILE / AWS_ACCESS_KEY_ID+SECRET / AWS_BEARER_TOKEN_BEDROCK / ECS/IRSA) **or** presence of `~/.aws/credentials` / `~/.aws/config` (honoring AWS_SHARED_CREDENTIALS_FILE / AWS_CONFIG_FILE overrides). IMDS-only EC2 is not probed. | `getModels("amazon-bedrock")` from pi-ai |
| `kiro` | Amazon Kiro | `claude-opus-4-7` | Presence of saved OAuth creds in `~/.config/inkstone/auth.json` (mode 0600). Device-code login triggered from Connect dialog. | `kiroModels` from `pi-kiro/core`, region-filtered via `filterModelsByRegion` + `baseUrl` rewrite per `resolveApiRegion(creds.region)` |

`getApiKey()` returns `undefined` for Bedrock because pi-ai's Bedrock stream function reads AWS env vars directly via the AWS SDK chain — forwarding anything through pi-agent-core's `getApiKey` hook would be silently dropped. For Kiro, `getApiKey()` is async: it checks `creds.expires`, calls `refreshKiroToken()` if past-due, persists the refreshed pair, and returns the fresh `access` token. On refresh failure it clears stored creds and throws a "run Connect again" error — pi-agent-core surfaces this via the existing error-bubble path.

### Kiro provider — registration, region scoping, refresh

The `kiro.ts` module has three responsibilities on top of the shared `ProviderInfo` contract:

1. **API registration** — at module load it calls `registerApiProvider({ api: "kiro-api", stream: streamKiro, streamSimple: streamKiro })` with pi-ai so pi-agent-core's default `streamFn` (pi-ai's `streamSimple`) can dispatch to `pi-kiro/core`'s `streamKiro` whenever it sees `model.api === "kiro-api"`. `backend/providers/index.ts` imports `./kiro` so registration fires before the agent module resolves any model. We don't pass a custom `streamFn` to `new Agent(...)` — the registry is the canonical dispatch point.
2. **Region scoping** — pi-kiro ships one canonical `kiroModels` catalog; per-region availability is a runtime filter and the `baseUrl` has to be rewritten to point at the user's API region (`q.{region}.amazonaws.com`). `listModels()` reads the saved creds, computes `resolveApiRegion(creds.region)`, runs `filterModelsByRegion(kiroModels, apiRegion)`, and clones each model with the rewritten `baseUrl`. Returns `[]` when not signed in so `DialogModel` hides Kiro entries until the user authenticates. Mirrors pi-kiro's `modifyModels` hook in `extension.ts:32-41`, applied here because we consume pi-kiro through `/core` (not pi's extension runtime).
3. **Lazy refresh** — `getApiKey()` checks `Date.now() > creds.expires`, and on miss calls `refreshKiroToken()` and `saveKiroCreds()` before returning. No background scheduler — refresh happens at the single point that actually needs a fresh token. On refresh failure we `clearKiroCreds()` and throw, pushing the user back through Connect.

### Credential storage — `~/.config/inkstone/auth.json`

Kept separate from `config.json` because OAuth tokens are sensitive (pi-kiro's `oauth.ts:55-72` explicitly calls out the refresh token + `clientSecret` pair as credentials that can mint access tokens for the user's AWS identity). `config.json` is frequently screenshared (themes, model ids) so a split avoids accidental leaks. File mode is forced to `0600` (directory `0700`) on every write via `chmodSync`. Shape is keyed by provider id (`{ kiro?: KiroCredentials }`) so future interactive providers slot in without migration.

### Agent integration

`backend/agent/index.ts` no longer hardcodes `"amazon-bedrock"`:

- Active state is `(currentProviderId, currentModelId)` loaded from `config.json` (legacy configs with only `modelId` fall back to `DEFAULT_PROVIDER`).
- `getApiKey` hook dispatches to `getProvider(provider).getApiKey()`.
- `setModel(model)` reads the incoming `Model<Api>`'s `.provider` + `.id` and persists both.
- `resolveModel(providerId, modelId)` looks up the live `Model<Api>` object through the registry at each access, so a provider implementation can mint custom models dynamically.

### UI: three palette entries

| Palette entry | Dialog | Behavior |
|---|---|---|
| **Models** | `DialogModel` | Flat list of models from every connected provider, `description` = provider display name. Empty placeholder when zero providers connected, directing the user to Connect. Auto-closes on select (backend `setModel` also auto-restores the per-model stored effort). |
| **Effort** | `DialogVariant` | Standalone reasoning-effort picker for the currently-active model. Registered only when `store.modelReasoning === true` — non-reasoning models hide the entry to avoid palette noise. See "Effort variants" below. |
| **Connect** | `DialogProvider` | All providers, sorted connected-first, `description` = `"✓ Connected"` / `"Not configured"`. Disconnected Kiro → device-code login flow (prompts → auth-wait → save → DialogModel scoped to Kiro). Disconnected Bedrock → toast with `authInstructions`. Connected select is a no-op (reserved for future disconnect/manage). |

#### Kiro device-code login flow

`startKiroLogin` in `components/dialog-provider.tsx` wires pi-kiro's `loginKiro` callbacks against the existing dialog stack:

- `onPrompt({ message, placeholder, allowEmpty })` → `DialogPrompt.show(...)` returns a promise. pi-kiro calls this up to twice (Builder ID vs IdC start URL, optional IdC region). Each call uses `dialog.replace`, so only one dialog is on the stack at any time — sidesteps pi-kiro's documented mirrored-cursor glitch (`oauth.ts:16-23`), where two input widgets appended to the same container double-render typed characters.
- `onAuth({ url, instructions })` → replaces the prompt with `DialogAuthWait` showing the verification URL (primary color), user code + expiry note, and a live progress line fed by `onProgress`.
- `onProgress(msg)` → updates a signal consumed by `DialogAuthWait`.
- Cancellation: closing any dialog in the chain resolves the prompt promise to `null` (`DialogPrompt.show`) or invokes the wait dialog's `onClose`, which aborts the `AbortController` passed to `loginKiro`. pi-kiro throws "Login cancelled"; we swallow it silently and `dialog.clear()`.
- Success: `saveKiroCreds(creds)`, success toast, then `DialogModel.show(...)` scoped to `{ providerId: "kiro", modelId: "claude-opus-4-7" }` so the user lands on the freshly-available catalog. Mirrors OpenCode's chain in `component/dialog-provider.tsx:183-184`.
- Failure (non-cancel): error toast with the pi-kiro error message.

The Models dialog does not drill down through providers — with only connected providers in the list, flat is simpler. When a future provider adds an API-key auth flow, the two-step would land as: DialogProvider → api-key input → DialogModel scoped to the newly-connected provider. That scoped form can be re-added to `DialogModel` (via an optional `providerId` prop) when needed.

### Effort variants (reasoning levels)

Reasoning-capable models expose a dedicated **Effort** palette entry that opens `DialogVariant` on the currently-active model and lets the user pick a pi-agent-core `ThinkingLevel`. Inkstone follows OpenCode's standalone-entry pattern (OpenCode's `variant.list` command + `/variants` slash, `dialog-variant.tsx`) trimmed to pi-ai's unified level enum — no per-SDK `variants()` switch is needed because pi-ai already owns the provider-specific mapping internally.

The entry is **not** a cascade from the Models dialog. Picking a model via Models is a one-step action that sets the model and auto-restores its stored effort (see "setModel auto-restore" below); changing effort on the current model is a separate palette action. This mirrors how OpenCode separates model selection from variant selection in its palette and slash-command surface (`opencode/src/cli/cmd/tui/app.tsx:532-544`).

**Entry visibility** — driven reactively by `store.modelReasoning`:

- `model.reasoning === false` → Effort entry hidden from Ctrl+P (OpenCode uses a `hidden` flag on the `variant.list` command with `local.model.variant.list().length === 0` — same intent, simpler shape since Inkstone is palette-only)
- `model.reasoning === true` → Effort entry shown between Models and Themes

**Level set per model** — computed by `availableThinkingLevels(model)` in `backend/agent/index.ts`:

- `model.reasoning === false` → `["off"]` (Effort entry hidden anyway)
- `model.reasoning === true` → `["off", "minimal", "low", "medium", "high"]`, plus `"xhigh"` iff pi-ai's `supportsXhigh(model)` returns true (Claude Opus 4.6/4.7, GPT-5.2+)

`"off"` is an explicit first-class option (not a synthetic "Default" row), matching pi-agent-core's `ThinkingLevel = "off" | ...` sentinel — picking "Off" literally sets `Agent.state.thinkingLevel = "off"`, which disables `reasoning:` on the next pi-ai stream call.

pi-ai internally collapses some levels to the same wire value on certain models (e.g. `"minimal"` → `effort: "low"` on adaptive Claude; `xhigh` budget → `high`'s 16384 tokens on non-adaptive Claude). That's a pi-ai design choice — the collapsed levels produce identical model behavior — so Inkstone surfaces the full pi-agent-core enum and lets pi-ai do the mapping. The only capability gate we apply is `supportsXhigh(model)`, which is pi-ai's own exported helper (not a mirror of internals).

**On the "max" wire value:** Anthropic renamed their top-tier adaptive-thinking effort between Opus 4.6 (wire name: `"max"`) and Opus 4.7 (wire name: `"xhigh"`). pi-ai maps the unified `ThinkingLevel = "xhigh"` to whichever wire value is top for the target model — so on Opus 4.6 it sends `output_config: { effort: "max" }`, on Opus 4.7 it sends `output_config: { effort: "xhigh" }` (`pi-mono/packages/ai/src/providers/amazon-bedrock.ts:493-514`, tests at `pi-mono/packages/ai/test/bedrock-thinking-payload.test.ts:64-76` and `stream.test.ts:1247`). OpenCode exposes separate `xhigh` + `max` rows for Opus 4.7, but under pi-mono's contract that's redundant — both land at the same "top tier". Inkstone follows pi-mono, so `xhigh` on Opus 4.7 IS the maximum reasoning tier reachable via the Anthropic API.

**Storage — per-model, keyed by `${providerId}/${modelId}`:**

```jsonc
// config.json
{
  "providerId": "amazon-bedrock",
  "modelId": "us.anthropic.claude-opus-4-7",
  "thinkingLevels": {
    "amazon-bedrock/us.anthropic.claude-opus-4-7": "high",
    "amazon-bedrock/anthropic.claude-sonnet-4": "medium"
  }
}
```

Missing key resolves to `"off"`. Matches OpenCode's `local.model.variant: Record<${providerID}/${modelID}, string | undefined>` keying so a model remembers the effort the user last picked for it.

**Data flow:**

```
Ctrl+P → Effort
  → DialogVariant.show(dialog, currentModel, currentLevel, onSelect)
    → user picks level
      → actions.setThinkingLevel(level)
        → AgentActions.setThinkingLevel (backend/agent/index.ts)
          → a.state.thinkingLevel = level
          → thinkingLevels[`${providerId}/${modelId}`] = level
          → saveConfig({ thinkingLevels: { ... } })
        → tui wrapper (context/agent.tsx)
          → setStore("thinkingLevel", level)
            → prompt.tsx renders `· <level>` in warning color when level !== "off"
```

**setModel auto-restore:** `AgentActions.setModel(model)` also re-applies `a.state.thinkingLevel = resolveThinkingLevel(model)` after swapping the model, so switching back to a previously-used reasoning model restores its prior effort without the user needing to re-pick it via the Effort entry. The TUI wrapper mirrors this by calling `setStore("thinkingLevel", getCurrentThinkingLevel())` after `setModel`, so the status-line suffix tracks model switches in lockstep. The wrapper also writes `setStore("modelReasoning", model.reasoning)` so the palette's Effort-entry visibility updates in the same tick.

**Safety guard:** pi-ai/pi-agent-core already ignores `reasoning:` on non-reasoning models (`pi-mono/packages/ai/src/providers/amazon-bedrock.ts:623-625`), so Inkstone doesn't re-guard capability in `resolveThinkingLevel`.

**Non-goals (deferred):**

- Mid-session effort cycle keybind (OpenCode uses `ctrl+t`). Palette-only access is consistent with Inkstone's current pattern (model switch is also palette-only).
- Per-message effort stamping. `DisplayMessage` stays lean — effort is session-scope, matching OpenCode's statusline-only display.
- User-configurable per-model level lists (`config.provider[X].models[Y].variants`). pi-ai's `supportsXhigh` + `model.reasoning` already cover every model in the current registry; custom overrides are speculative.

### modelProvider in AgentStoreState

`AgentStoreState.modelProvider` holds the **provider id** (e.g. `"amazon-bedrock"`), not a display string. Frontends resolve to the display name through `getProvider(id).displayName` at render time (`components/prompt.tsx`). Keeping the store free of formatted strings means provider metadata changes propagate without a store update.

## Keybinds + Commands

Keyboard shortcuts are in two layers — a pure data map (actions → binding strings) plus a registry-based dispatcher — ported from OpenCode's `util/keybind.ts` + `component/dialog-command.tsx` pattern.

### Layer 1 — `src/tui/util/keybind.ts`

The central `KEYBINDS` constant is a `Record<action, bindingString>`. Each value is a comma-separated list of alternates; each alternate is a `+`-separated list of modifier tokens and a key name. Supported tokens: `ctrl`, `alt` / `meta` / `option`, `shift`, `super`, `esc` (alias for `escape`). A value of `"none"` disables the action.

The module exports two pure functions:

- `Keybind.match(action, evt): boolean` — true iff the `ParsedKey` event matches any alternate for the action.
- `Keybind.print(action): string` — human-readable label (`"ctrl+p"`, `"shift+tab"`, …) used in prompt hints and palette footers so labels stay in sync with bindings.

Bindings are pre-parsed once at module load. No provider, no reactivity — bindings are static constants. When user overrides (`config.json`) land, they can be added without changing the call-site API.

Action naming groups by scope:

| Prefix / name | Scope |
|---|---|
| `app_exit` | Top-level renderer exit, in `app.tsx` |
| `command_list` | CommandProvider — opens the Ctrl+P palette |
| `agent_cycle`, `agent_cycle_reverse` | CommandProvider — registered commands in `app.tsx` |
| `session_interrupt` | CommandProvider — registered by `prompt.tsx`, streaming-gated. ESC double-tap aborts the in-flight turn (see below) |
| `messages_*` | Top-level scroll handler in `app.tsx` (only mounted while the session view is rendered) |
| `dialog_close` | `ui/dialog.tsx` — dismisses the top-of-stack dialog |
| `select_*` | `ui/dialog-select.tsx` — local nav (arrow keys + emacs `ctrl+n`/`ctrl+p`) |

`dialog-confirm.tsx` uses its own inline `y`/`n`/`left`/`right`/`return` checks — those keys are dialog-local and don't belong in the shared map.

### Session interrupt (double-tap ESC)

Ported from OpenCode (`opencode/src/cli/cmd/tui/component/prompt/index.tsx:273-303, 1325-1330`). The `session_interrupt` keybind (default `escape`) is registered by `Prompt()` in `src/tui/components/prompt.tsx` via `useCommand().register`, with the registration memo gated on `store.isStreaming` — so the binding is live only while a turn is in flight. When idle, the registration returns `[]` and ESC falls through (no global handler is listening).

Double-tap semantics live in a local signal inside `Prompt()` (`interrupt: number`, not in `AgentStoreState` — pure UI transient, no cross-frontend contract):

- **First ESC** → `interrupt` increments to 1; the prompt hint flips from `esc interrupt` (in `theme.text` + `theme.textMuted`) to `esc again to interrupt` (both spans in `theme.primary`); a 5 s timer is armed to reset `interrupt` to 0.
- **Second ESC within 5 s** → `actions.abort()` is called (pi-agent-core `Agent.abort()`), `interrupt` resets to 0, the pending timer is cleared.
- **5 s elapses without a second press** → `interrupt` resets to 0, the hint reverts to `esc interrupt`. The next press starts the sequence over — a single ESC after the timeout does **not** abort.

Inkstone additionally scopes the arm to the current turn via a `createEffect` on `store.isStreaming`: when streaming flips back to false, the pending 5 s timer is cleared and `interrupt` returns to 0. Without this reset, a single ESC press late in a turn that completes before the timer fires would leave `interrupt === 1`; the first ESC of the next turn would then satisfy the `next >= 2` branch in `handleInterrupt` and abort immediately instead of arming the double-tap. OpenCode's prompt carries the same latent bug (`opencode/src/cli/cmd/tui/component/prompt/index.tsx:290-294`); this is an intentional Inkstone divergence.

`actions.abort()` is the existing `AgentActions.abort` (`backend/agent/index.ts:154`) that forwards to pi-agent-core's `Agent.abort()`. pi-agent-core fires `message_end` with `stopReason === "aborted"`, which is already surfaced by `AgentProvider`'s reducer onto the assistant bubble's `error` field (`tui/context/agent.tsx:153-165`) and rendered via the shared error panel in `conversation.tsx`. No new event-handling is required.

### Collision safety

`ctrl+p` is both `command_list` (global) and one alternate of `select_up` (dialog-local). This is safe because:

- CommandProvider's dispatcher returns early on `dialog.stack.length > 0`.
- DialogSelect calls `evt.preventDefault()` on nav matches, so even if handler order were reversed, the downstream CommandProvider would skip via its `defaultPrevented` check.

`escape` is both `session_interrupt` (global, streaming-only) and `dialog_close` (dialog-local). Dialog's `useKeyboard` in `ui/dialog.tsx` returns early when `store.stack.length === 0`, and calls `preventDefault` + `stopPropagation` when closing. CommandProvider's dispatcher additionally short-circuits on `dialog.stack.length > 0` before iterating registered keybinds. So: dialog open ⇒ ESC closes the dialog, no interrupt; dialog closed + streaming ⇒ ESC runs the interrupt handler; dialog closed + idle ⇒ `session_interrupt` isn't registered, ESC is a no-op.

Ctrl+C follows the same scope rule: inside a dialog it's caught by `ui/dialog.tsx`'s `dialog_close`; at the session view it's caught by `app.tsx`'s `app_exit` (gated to `dialog.stack.length === 0`).

### Data flow

```
keypress
  ↓
useKeyboard dispatch order (roughly):
  dialog.tsx            → match("dialog_close")?      yes: close + preventDefault; else skip
  dialog-select.tsx     → match("select_*")?          yes: act + preventDefault
  CommandProvider       → (dialog open? skip)
                        → match("command_list")?      yes: open palette
                        → iterate registrations, match(keybind)?  yes: fire onSelect
  app.tsx Layout        → (dialog open? skip scroll)
                        → match("app_exit")?           yes: destroy renderer
                        → match("messages_*")?         yes: scroll
```

### Non-goals (deferred; see docs/TODO.md)

- User overrides in `config.json`
- Leader-chord (`<leader>X`) support
- Plugin-registered keybinds
- Textarea `input_*` action mapping (OpenTUI defaults are currently fine)

## Key Patterns (from OpenCode)

- `createSimpleContext()` — factory for typed context providers
- Stack-based dialog system with focus save/restore
- KV persistence via JSON file in state directory
- Theme resolution: hex → refs → dark/light variants → RGBA
- Named-action keybind map + command registry (see Keybinds + Commands section). Leader-chord and user overrides still deferred — see docs/TODO.md.
