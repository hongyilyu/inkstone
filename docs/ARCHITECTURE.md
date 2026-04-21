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
| `src/backend/` | Headless agent — pi-agent-core `Agent`, tools, guard, system prompt, config + session persistence. No Solid, no OpenTUI, no UI. | pi-agent-core, pi-ai, diff, typebox, fs |
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
      → LLM API call (Bedrock)
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
      prompt.ts                     READING_RULES system prompt
      constants.ts                  VAULT_DIR, ARTICLES_DIR, SCRAPS_DIR, etc.
      guard.ts                      beforeToolCall (frontmatter guard + confirm)
      tools/
        quote-article.ts            Paragraph search in active article
        read-file.ts                readFileSync, scoped to VAULT_DIR
        edit-file.ts                String replace + unified diff, scoped to VAULT_DIR
        write-file.ts               writeFileSync/append, scoped to VAULT_DIR
    persistence/
      config.ts                     modelId + themeId (shared JSON)
      session.ts                    DisplayMessage[] + activeArticle (JSON; SQLite candidate)

  bridge/                           Pure TS — shared type contract
    view-model.ts                   DisplayMessage, AgentStoreState, SessionData

  tui/                              Solid + OpenTUI
    app.tsx                         Provider stack + root layout + global keybinds
    context/
      agent.tsx                     AgentProvider + useAgent (Solid store + event reducer)
      theme.tsx                     Theme loading, resolution, application (SyntaxStyle FFI)
      helper.tsx                    createSimpleContext() factory
    ui/
      dialog.tsx                    Stack-based modal rendering
      dialog-confirm.tsx            Promise-based yes/no confirmation
      dialog-select.tsx             Fuzzy filterable select list
      toast.tsx                     Toast notifications
    components/
      conversation.tsx              Scrollbox + message list
      prompt.tsx                    Textarea prompt with /command parsing
      sidebar.tsx                   Session metadata panel (title, context, article)
      open-page.tsx                 Empty-state welcome page
      dialog-command.tsx            Ctrl+P command palette
      dialog-model.tsx              Model selection dialog
      dialog-theme.tsx              Theme selection dialog
      dialog-provider.tsx           Provider selection dialog
    util/
      format.ts                     formatTokens, formatCost, formatDuration
```

## Provider Stack

```tsx
<ThemeProvider>
  <ToastProvider>
    <DialogProvider>
      <AgentProvider>
        <Layout />
      </AgentProvider>
    </DialogProvider>
  </ToastProvider>
</ThemeProvider>
```

## Agent Integration

The `AgentProvider` creates a pi-agent-core `Agent` instance (via `backend/agent/`) and subscribes to its events. State is held in a `createStore`:

```ts
{
  messages: DisplayMessage[]     // full history (see below for shape)
  isStreaming: boolean
  activeArticle: string | null
  modelName: string
  modelProvider: string
  contextWindow: number
  status: "idle" | "streaming" | "tool_executing"
  totalTokens: number            // accumulated across all assistant turns
  totalCost: number              // accumulated across all assistant turns
  lastTurnStartedAt: number      // Date.now() when user prompt sent; consumed in agent_end
}
```

Both `DisplayMessage` and `AgentStoreState` are defined in `src/bridge/view-model.ts` — they are the cross-frontend view-state contract.

`DisplayMessage`:

```ts
{
  id: string
  role: "user" | "assistant"
  text: string
  agentName?: string   // assistant only, set in message_end
  modelName?: string   // assistant only, set in message_end
  duration?: number    // assistant only, ms, set in agent_end
}
```

Events from `agent.subscribe()` are batched via `batch()` and applied to the store by the switch statement in `tui/context/agent.tsx`. Solid's fine-grained reactivity ensures only affected UI nodes re-render.

> Design note: the event → view-state reducer is intentionally kept inline in the TUI's `AgentProvider` (not extracted to a shared `bridge/` module). If a second non-TUI frontend arrives, factor it out then. Avoids speculative abstraction for a single-consumer project.

## Markdown Rendering

Assistant messages are rendered through OpenTUI's `<markdown>` component in `src/tui/components/conversation.tsx`. The component takes a `SyntaxStyle` built by `generateSyntax(colors)` in `src/tui/context/theme.tsx`, which maps ~40 Tree-sitter scopes (markup.* for markdown structure, plus core code scopes for fenced blocks) onto the active theme's existing named colors. The style is exposed as a reactive accessor `useTheme().syntax()` and re-creates whenever the theme id changes, so switching themes re-paints already-rendered markdown.

The `streaming` prop is enabled only on the final message while `store.isStreaming` is true, so the markdown parser keeps the trailing block unstable during deltas and finalizes token parsing on `agent_end`. Markdown syntax markers (`**`, `` ` ``, `#`, etc.) are concealed by default — users see rendered output, not source. User messages remain plain `<text>` inside the left-border bubble.

`SyntaxStyle` wraps an FFI pointer into Zig-side allocations that JS GC cannot reclaim. The memo registers an `onCleanup(() => style.destroy())` so the previous instance is released on theme switch (recompute) and on provider disposal (app exit) — see `src/tui/context/theme.tsx`.

## Per-Message Status Line

Each completed assistant message renders its own status line directly below its markdown body in `src/tui/components/conversation.tsx`:

```
▣ Reader · Claude Opus 4.6 (US) · 1m 2s
```

### Field scopes (per-message vs. per-turn)

`DisplayMessage` splits footer fields by scope. This matters for tool-driven turns, which emit multiple assistant messages.

- **Per-message** — `agentName`, `modelName`. Written in `message_end`. Each assistant bubble records the agent and model that produced *that specific* reply, sourced from the assistant event (not from mutable store state). A tool turn with two assistant messages produces two bubbles, each with its own correct `agentName`/`modelName`.
- **Per-turn** — `duration`. Written in `agent_end`. Represents the wall-clock time from the user's prompt to the turn completing. Stamped only on the turn-closing assistant bubble, which is `messages[length - 1]` when `agent_end` fires (tool results aren't rendered as display bubbles, so the last bubble is always the turn-closing assistant message). Intermediate assistant bubbles in a tool turn intentionally carry `agentName` + `modelName` without a `duration` — "how long did the whole turn take?" only has a single answer per turn, and the turn-closing bubble is where it belongs.

The conversation renderer shows the footer whenever `msg.modelName` is present, and adds the duration pip only when `msg.duration > 0`, so intermediate tool-turn bubbles render `▣ Reader · <model>` without a duration, and the turn-closing bubble renders the full `▣ Reader · <model> · <duration>`.

### Bubble-per-assistant-boundary

`AgentProvider` pushes a fresh empty assistant `DisplayMessage` on every pi-agent-core `message_start` event whose `message.role === "assistant"` (filtering out user/toolResult starts, which are handled elsewhere or not rendered). `message_update` deltas append to the last-pushed bubble, and `message_end` stamps `agentName` / `modelName` onto that same bubble.

This mirrors pi-agent-core's own boundaries: a tool-using turn emits one assistant `message_start` / `message_end` pair before the tool call and another after the tool result. Each pair gets its own display bubble with its own per-message footer data, so saved sessions replay the original assistant boundaries and the per-message fields cannot leak between them. `<Show when={msg.text}>` in `conversation.tsx` hides bubbles that never received visible text (e.g., a pure tool-call assistant message), so empty bubbles don't clutter the conversation.

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

## Key Patterns (from OpenCode)

- `createSimpleContext()` — factory for typed context providers
- Stack-based dialog system with focus save/restore
- KV persistence via JSON file in state directory
- Theme resolution: hex → refs → dark/light variants → RGBA
- Keybind system with leader key support
