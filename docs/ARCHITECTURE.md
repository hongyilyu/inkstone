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
- The agent shell (`backend/agent/index.ts` and `backend/agent/agents.ts`) must not deep-import custom-agent tool internals (`agents/<name>/tools/*`). Agent-owned public state/helpers must be re-exported from that agent folder's `index.ts`. (Today no agent has a `tools/` subfolder — the rule stays in place for future state-coupled agent tools.)
- `tui/` must use `@backend/agent` public APIs for agent data and actions, not custom-agent internals under `backend/agent/agents/<name>/`.

Each boundary rule uses two glob patterns per forbidden target so both bypass forms fail lint:

- `@tui/*` — the alias form.
- `**/tui/**` — any relative path that climbs into `tui/` (e.g. `../tui/app`, `../../tui/app`, `./tui/x`).

Same pair (`@backend/*` + `**/backend/**`) for the backend restriction on bridge.

Agent-internal rules additionally block the concrete bypass forms we have seen:

- `./agents/*/tools/**` from the agent shell.
- `@backend/agent/agents/**` (and relative equivalents) from the TUI.

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
| `bridge/view-model.ts` | Shared view-state contract any frontend would render/persist | `DisplayMessage`, `AgentStoreState` |
| `backend/agent/*` | Backend's public API surface — consumed directly by frontends | `AgentActions`, `Session`, re-exports from pi-agent-core |
| `tui/**` | Frontend-internal only | `AgentContextValue`, theme accessors, component props |

Bridge is for types **both sides need to agree on as a shared data shape**. Backend's API types (e.g. `AgentActions`) are published *by* the backend *to* its consumers; they don't go through the bridge.

## Data Flow

```
User input (textarea)
  → executable slash-command lookup (/article, /clear; otherwise plain prompt)
  → agent.prompt(text)
    → pi-agent-core Agent loop
      → LLM API call (provider from registry — Kiro / ChatGPT / OpenRouter)
      → tool calls (read, edit, write)
        → beforeToolCall guard (block/confirm/allow)
      → streaming events
    → agent.subscribe() callback
      → batch() Solid store updates
        → fine-grained reactivity → UI re-render
```

## File Structure

```
src/
  index.tsx                         Entry point — renderer + root component

    backend/                          Headless — no Solid, no OpenTUI
    agent/
      index.ts                      Session factory + public API surface
      agents.ts                     Registry assembler — imports each agent's AgentInfo
      types.ts                      Foundation types (AgentInfo, AgentZone, AgentCommand, etc.)
      compose.ts                    BASE_TOOLS, BASE_PREAMBLE, composeTools, composeSystemPrompt
      zones.ts                      Zone-to-permission rule derivation
      tools.ts                      Shared tool pool (read, write, edit via pi-coding-agent; updateSidebarTool for generic sidebar section management)
      permissions.ts                Declarative permission dispatcher
      constants.ts                  Vault and directory path constants
      agents/                       Custom agents, one self-contained folder each
        reader/
          index.ts                  Reader agent definition (zones, extraTools, permissions)
          instructions.ts           Reader system-prompt body + 6-stage workflow
          recommendations.ts        Article scoring + recommendation list
        example/
          index.ts                  Example agent definition (minimal)
    providers/
      types.ts                      ProviderInfo interface
      kiro.ts                       Amazon Kiro provider (OAuth, region scoping)
      openai-codex.ts               ChatGPT (OpenAI Codex) OAuth provider
      openrouter.ts                 OpenRouter API-key provider
      index.ts                      Provider registry + helpers
    persistence/
      config.ts                     User preferences (JSON, Zod-validated)
      auth.ts                       OAuth credentials loader/saver
      errors.ts                     Shared persistence error hook
      paths.ts                      XDG path resolution
      schema.ts                     Zod schemas for config + auth
      sessions.ts                   SQLite session store (see docs/SQL.md)
      db/
        client.ts                   Lazy bun:sqlite client, WAL PRAGMAs, migrator
        schema.ts                   Drizzle table definitions
        migrations/                 drizzle-kit-generated SQL migrations

  bridge/                           Pure TS — shared type contract
    view-model.ts                   DisplayMessage, DisplayPart (text/thinking/file/tool), SidebarSection, AgentStoreState
    tool-renderers.ts               Tool-arg rendering contract (per-tool one-liner formatters for ToolPart)
    frontmatter.ts                  Article YAML-lite frontmatter parser (parseFrontmatter + fmString/fmStringArray narrowing helpers) — shared by reader's scorer and the reader secondary-page metadata strip

  tui/                              Solid + OpenTUI
    app.tsx                         Provider stack + root layout + module-scoped scroll/input refs
    commands/
      layout-commands.ts            registerLayoutCommands — extracted Layout palette + keybind registrations
    hooks/
      use-layout-keybinds.ts        useLayoutKeybinds — extracted Layout keyboard handler (app_exit, scroll, secondary_page_close)
    context/
      agent.tsx                     Thin barrel re-exporting AgentProvider + useAgent + SessionFactory / Session
      agent/                        Agent provider split (7 modules; see below)
        types.ts                      SessionFactory, AgentContextValue, agentContext (createContext)
        helpers.ts                    Pure helpers: REDACTED_THINKING_PLACEHOLDERS, extractErrorMessage, trimOneLine
        session-state.ts              createSessionState — currentSessionId + turnStartThinkingLevel + preTurnCodexConnections bag + persistThen + ensureSession
        reducer.ts                    createAgentEventHandler — event dispatch table; agent_end decomposed into 5 named helpers
        actions.ts                    createWrappedActions — prompt / setModel / setThinkingLevel / selectAgent / clearSession / resumeSession
        commands.tsx                  BridgeAgentCommands + buildCommandHelpers (agent-declared slash verbs into the palette)
        provider.tsx                  AgentProvider shell + useAgent — composes the bag, installs side-effect handlers with restore-on-unmount, disposes subscription
      theme.tsx                     ThemeProvider + useTheme (re-exports ThemeColors/ThemeDef/themes/getThemeById for backward compat)
    theme/                          Pure-data theme module (no Solid, no JSX)
      types.ts                      ThemeColors + ThemeDef interfaces
      palettes.ts                   Built-in palettes (Dark, Light, Catppuccin Mocha, Dracula), themes[], getThemeById
      syntax.ts                     generateSyntax + generateSubtleSyntax (SyntaxStyle FFI wrappers)
    ui/
      dialog.tsx                    Stack-based modal rendering
      dialog-confirm.tsx            Promise-based yes/no confirmation
      dialog-select.tsx             Fuzzy filterable select list (composition: grouping + row + scroll sync + keyboard nav)
      dialog-select-grouping.ts     Pure `groupByCategory` + `countRows` helpers (no JSX, unit-tested)
      dialog-select-row.tsx         `DialogSelectRow` — presentational row with resolved `active` / `current` props
      dialog-prompt.tsx             Promise-based single-line input
      dialog-auth-wait.tsx          OAuth device-code flow screen
      toast.tsx                     Toast notifications
    components/
      conversation.tsx              Scrollbox + message list routing
      message.tsx                   Bubble rendering (UserMessage, AssistantMessage, TextPart, ReasoningPart, ToolPart)
      user-part.tsx                 Single part inside a user bubble — text or clickable file chip (opens article reader page)
      article-page.tsx              Full-screen article reader page — renders article markdown from disk in a scrollable view
      prompt.tsx                    Textarea prompt with /command parsing + streaming indicator
      prompt-autocomplete.tsx        Slash-command dropdown above the textarea — fuzzysort-filtered list of `CommandOption`s with `slash` fields; column-0-only trigger, keyboard nav, argful insert
      spinner.tsx                   Simple braille-dot spinner
      spinner-wave.tsx              Knight-rider wave spinner (port of OpenCode's)
      sidebar.tsx                   Session metadata panel (title, context, dynamic sidebar sections, back button in article view)
      session-list.tsx              Left-side session history panel (Ctrl+N)
      session-list-item.tsx         Single row renderer for session list
      open-page.tsx                 Empty-state welcome page
      dialog/                       Feature dialogs (compositions of ui/dialog-* primitives)
        command.tsx                 CommandProvider + useCommand + registry (canRunSlashEntry exported for tests)
        command-palette.tsx         `DialogCommand` palette UI — internal to the registry, renders CommandOption[] via DialogSelect
        agent.tsx                   Agent selection dialog
        model.tsx                   Model selection dialog
        variant.tsx                 Reasoning-effort picker
        theme.tsx                   Theme selection dialog
        provider/                   Provider dialog — list + manage/login dispatch
          index.tsx                 DialogProvider list + row dispatch (looks up LOGIN_FLOWS for disconnected rows)
          manage-menu.tsx           Reconnect/Disconnect secondary menu for any connected provider
          login-registry.ts         Provider-id → login-flow lookup table (TUI-side boundary wrapper)
          confirm-and-disconnect.ts Shared Confirm → clearCreds → rehome → toast helper
          login-kiro.tsx            Drive pi-kiro's loginKiro callbacks against the dialog stack
          login-openai-codex.tsx    Drive pi-ai's loginOpenAICodex callbacks against the dialog stack
          set-openrouter-key.tsx    Single DialogPrompt to collect OpenRouter API key → save → scoped DialogModel
    util/
      format.ts                     Token/cost/duration/path formatting helpers
      keybind.ts                    Keybind action map + match/print helpers
      clipboard.ts                  OSC 52 clipboard copy (SSH-safe, used by DialogAuthWait)
```

## Provider Stack

Provider nesting order (see `src/tui/app.tsx`):

```
ThemeProvider
  ToastProvider
    DialogProvider
      CommandProvider
        ErrorBoundary
          AgentProvider
            Layout
```

`CommandProvider` sits inside `DialogProvider` because its dispatch loop reads the dialog stack (to yield to open dialogs). `AgentProvider` runs inside `CommandProvider` so `Layout` can call both `useAgent()` and `useCommand()`.

The `ErrorBoundary` between `CommandProvider` and `AgentProvider` exists specifically to catch `resolveInitialProviderModel`'s synchronous "No provider is connected" throw on first boot — without it, a fresh install crashed through `render()` before any UI mounted, so the user could never reach the Connect dialog. The fallback lives in `src/tui/components/no-provider-fallback.tsx`: it surfaces a Ctrl+P → Connect hint for that specific failure (using `useCommand()` to register a temporary palette entry since the layout-level registration in `layout-commands.ts` is unreachable while `AgentProvider` isn't mounted), and renders a minimal crash line for any other throw (with the raw error logged to `console.error` so dev still gets a stack). The boundary is NOT a general-purpose error handler — component-level error recovery uses its own try/catch.

## Agent Integration

The `AgentProvider` creates a pi-agent-core `Agent` instance (via `backend/agent/`) and subscribes to its events. State is held in a `createStore` whose shape is defined in `src/bridge/view-model.ts` as `AgentStoreState`. Key fields: `messages: DisplayMessage[]`, `isStreaming`, `sidebarSections: SidebarSection[]` (ephemeral dynamic sections set by the `update_sidebar` tool), `articleView: { filename } | null` (non-null = article reader page shown), `modelName`, `modelProvider` (provider id — format via `getProvider(id).displayName` at render time), `contextWindow`, `modelReasoning` (gates the Effort palette entry), `thinkingLevel` (pi-agent-core's reasoning effort; `"off"` when non-reasoning or user-disabled), `status` (`"idle" | "streaming" | "tool_executing"`), `totalTokens`, `totalCost`, `lastTurnStartedAt` (consumed in `agent_end`), `currentAgent`.

Both `DisplayMessage` and `AgentStoreState` are defined in `src/bridge/view-model.ts` — they are the cross-frontend view-state contract.

`DisplayMessage` carries `id`, `role` (`"user" | "assistant"`), `parts: DisplayPart[]` (ordered blocks), and optional assistant-only fields: `agentName`, `modelName` (set in `message_end`), `duration` (ms, set in `agent_end`), `thinkingLevel` (pi-agent-core `ThinkingLevel`, set in `agent_end` on non-off turns), `error` (pi-ai `errorMessage` on `stopReason === "error"` only), `interrupted` (`true` on `stopReason === "aborted"`). `DisplayPart` is a discriminated union: `text` (with `text: string`), `thinking` (with `text: string`), and display-only `file` (with `mime` + `filename`).

The `file` part is display-only. Agent commands like reader's `/article` hand the TUI a compact render shape (short prose + file chip) via `AgentCommand.execute`'s optional `displayParts` callback argument, while the full file content still reaches pi-agent-core as the single prompt `text`. pi-ai's `UserMessage.content` stays a plain string (Inkstone never uses the multi-block form); the split lives entirely between `wrappedActions.prompt` and the user-bubble renderer. See "Commands → Slash dispatch" below and `src/tui/components/message.tsx`'s `UserMessage` for the chip rendering.

Events from `agent.subscribe()` are batched via `batch()` and applied to the store by the switch statement in `tui/context/agent.tsx`. Solid's fine-grained reactivity ensures only affected UI nodes re-render.

> Design note: the event → view-state reducer is intentionally kept inline in the TUI's `AgentProvider` (not extracted to a shared `bridge/` module). If a second non-TUI frontend arrives, factor it out then. Avoids speculative abstraction for a single-consumer project.

## Markdown Rendering

Assistant messages are rendered through OpenTUI's `<markdown>` component in `src/tui/components/message.tsx` (the bubble-rendering module; `conversation.tsx` is a thin list + routing layer that iterates `store.messages` and dispatches to `UserMessage` / `AssistantMessage`). The component takes a `SyntaxStyle` built by `generateSyntax(colors)` in `src/tui/context/theme.tsx`, which maps ~40 Tree-sitter scopes (markup.* for markdown structure, plus core code scopes for fenced blocks) onto the active theme's existing named colors. The style is exposed as a reactive accessor `useTheme().syntax()` and re-creates whenever the theme id changes, so switching themes re-paints already-rendered markdown.

Heading hierarchy is corpus-tuned: H1 uses `primary` (document title; ~102 occurrences in the article corpus), H2 uses `accent` (dominant body heading; ~594 occurrences), H3 uses `secondary` (subsection; ~91), H4 uses `text`, H5 `text`, H6 `textMuted`. All levels render bold. The rule lives in `src/tui/theme/syntax.ts`'s `getSyntaxRules` and therefore applies uniformly to every `<markdown>` call site (assistant body, reasoning, sidebar, reader secondary page).

Each assistant bubble iterates `msg.parts` and renders one `<markdown>` per block, so interleaved thinking/text from a single turn renders in emission order. The `streaming` prop is enabled only on the **tail block of the last bubble** while `store.isStreaming` is true, so the markdown parser keeps only that trailing block unstable during deltas and finalizes earlier blocks. Markdown syntax markers (`**`, `` ` ``, `#`, etc.) are concealed by default — users see rendered output, not source. User messages are plain `<text>` inside the left-border bubble, iterating `msg.parts` so commands that supply explicit `displayParts` (reader's `/article`: `[text, file]`) render a short prose line + a file chip instead of the full payload the LLM sees. Plain user prompts produce a single `text` part, matching the pre-displayParts shape.

### Reader secondary-page affordances

`src/tui/components/secondary-page.tsx` layers two reader-focused affordances on top of the base `<markdown>` render, active only when the caller passes `format: "markdown"` (the default):

- **Frontmatter strip + metadata header.** The component parses leading YAML frontmatter via `parseFrontmatter` in `@bridge/frontmatter` and renders a compact 3-line strip above the body: title in `theme.primary` + bold (plain `<text>` with `TextAttributes.BOLD`, not routed through a markdown H1 — matches the color/weight of the H1 syntax rule but skips the parser), `by <author(s)> · <published>` in `theme.textMuted`, URL in `theme.info` (as plain text so users can copy it). Any subset of those four fields is optional — segments without a surfaced field drop cleanly. Content that doesn't begin with a `---` fence passes through the parser unchanged and skips the header entirely. `format: "text"` callers (raw logs, subagent dumps) bypass the parser so a content body that happens to start with `---` renders verbatim.

- **Reader table options.** The markdown node passes `tableOptions={ style: "grid", wrapMode: "word", borders: true, cellPadding: 1 }` so the ~6 articles in the corpus with real GFM tables render with bordered cells and word wrap. Inline assistant / sidebar / reasoning markdown surfaces use OpenTUI's default compact borderless `"columns"` layout instead — the full-screen reader has the width to afford the extra visual weight, the conversation view doesn't.

The frontmatter parser is a deliberately shallow YAML-lite subset matching the Obsidian Clipper export shape the corpus actually uses: `key: value` lines between `---` fences, optional surrounding single/double quotes on scalars, and block sequences of quoted strings (used for `author:` when articles are co-written). No nested maps, flow sequences, multi-line scalars, or anchors. The same parser also backs reader's recommendation scorer in `src/backend/agent/agents/reader/recommendations.ts` (which projects it onto a 4-key view: `title`, `published`, `description`, `reading_completed`).

### Thinking blocks

Ported from OpenCode's `ReasoningPart` (in `routes/session/index.tsx`), trimmed to Inkstone's scope:

- Part type: `DisplayPart` with `type: "thinking"` — a first-class sibling to `text`, dispatched by the `parts` iterator in `AssistantMessage` (`message.tsx`).
- Event capture: `message_update` in `context/agent.tsx` branches on `assistantMessageEvent.type` (typed as pi-ai's `AssistantMessageEvent` union). `thinking_start` pushes a fresh `{ type: "thinking", text: "" }` part; `thinking_delta` appends to the tail part's text after a runtime guard that the tail's `type === "thinking"` (cheap insurance against upstream event reordering); `thinking_end` pops the part when `lastPart.text.replace("[REDACTED]", "").trim()` is empty. That predicate covers both redacted-thinking shapes: Anthropic's `redacted: true` path emits no `thinking_delta` at all (empty text), while OpenRouter emits the literal `[REDACTED]` as a delta chunk that would otherwise render verbatim (`"[REDACTED]".trim()` is truthy). OpenCode filters the same literal at render time (in `routes/session/index.tsx`); Inkstone filters reducer-side because it has no `showThinking` toggle, so a stored-but-never-rendered part would just be dead weight in persistence. Same switch dispatches `text_start` / `text_delta` symmetrically for assistant text.
- Part-type immutability: `part.type` is reducer-guaranteed to be stable for the lifetime of the part — `message_update` only ever pushes new parts or appends to the tail's `text`, never mutates `type`. The `ReasoningPart` / `TextPart` dispatch inside the parts loop in `AssistantMessage` (`message.tsx`) reads `part.type` non-reactively (the callback evaluates the branch once per render and keys items by reference). If future work ever mutates `part.type` in-place, the renderer must be refactored to a reactive primitive (e.g. `<Switch>/<Match>` keyed on a memo of `part.type`) or the dispatch will stick to the first-seen type.
- Visual treatment: left bar (`┃` via `SplitBorderChars`) in `theme.backgroundElement`, `paddingLeft={2}`, `marginTop={1}` when not the first block, single `<markdown>` body with `"_Thinking:_ "` prepended to the part text so the label renders inline as italic markdown (per OpenCode's `ReasoningPart`). Body is rendered with `syntaxStyle={subtleSyntax()}`, no outer `fg` override — an outer `fg` would flatten all tokens to one color and defeat per-scope dimming.
- Part stacking: each non-first part carries `marginTop={1}`, the first part carries `marginTop={0}`. Intentional divergence from OpenCode's `AssistantMessage`, which sets `marginTop={1}` unconditionally on every part (in `routes/session/index.tsx`). OpenCode renders assistant bodies as a bare fragment so each `marginTop` lands directly; Inkstone wraps the body in a `<box flexDirection="column">` inside an outer `<For>` with `gap={1}` between bubbles, so an unconditional first-part `marginTop={1}` would double-space against the outer gap. Footer uses `paddingTop={1}` on its own box (same pattern as OpenCode's, simplified).
- **Always rendered** when present — no `showThinking` toggle, no keybind, no palette entry. Matches the current "no slash-command system" constraint; a toggle lands when slash-commands or a KV layer do.
- Trimmed from OpenCode's port: per-turn elapsed timer, "Thinking..." spinner, transcript/export parity (Inkstone has no export flow). The `subtleSyntax()` variant (60%-alpha syntax rules) and its `thinkingOpacity` theme knob ARE ported — see below.

### subtleSyntax (reasoning-block dimming)

Ported verbatim from OpenCode's `generateSubtleSyntax` (in `context/theme.tsx`). `generateSubtleSyntax(colors)` in `src/tui/context/theme.tsx` maps over `getSyntaxRules(colors)` and, for every rule with a `foreground`, rebuilds the `RGBA` at alpha `colors.thinkingOpacity` (default `0.6`, set per-theme on `ThemeColors`). `useTheme().subtleSyntax()` exposes the memoized `SyntaxStyle`, re-created on theme switch with the same `onCleanup(() => style.destroy())` FFI cleanup as the normal `syntax()` memo. Used only by `ReasoningPart`. Normal text parts continue to use `syntax()` at full saturation.


`SyntaxStyle` wraps an FFI pointer into Zig-side allocations that JS GC cannot reclaim. The memo registers an `onCleanup(() => style.destroy())` so the previous instance is released on theme switch (recompute) and on provider disposal (app exit) — see `src/tui/context/theme.tsx`.

## Per-Message Status Line

Each completed assistant message renders its own status line directly below its markdown body in `src/tui/components/message.tsx` (inside `AssistantMessage`):

```
▣ Reader · Claude Opus 4.6 (US) · 1m 2s
```

### Field scopes (per-message vs. per-turn)

`DisplayMessage` splits footer fields by scope. This matters for tool-driven turns, which emit multiple assistant messages.

- **Per-message** — `agentName`, `modelName`, `error`, `interrupted`. Written in `message_end`. Each assistant bubble records the agent and model that produced *that specific* reply, sourced from the assistant event (not from mutable store state). A tool turn with two assistant messages produces two bubbles, each with its own correct `agentName`/`modelName`. `error` carries pi-ai's `AssistantMessage.errorMessage` only when `stopReason === "error"` (hard provider failures); `interrupted` is `true` when `stopReason === "aborted"` (user ESC-ESC / Ctrl+C). The split is mutually exclusive at the reducer level — aborts don't populate `error`, so the renderer's `<Show when={msg.error}>` panel gate doesn't need to filter them out. Each *terminating* assistant bubble can fail or be interrupted independently; the outcome is scoped to the specific assistant boundary that produced it. Mid-tool aborts (where the preceding assistant emitted `stopReason === "toolUse"` before the abort, and the abort surfaces through pi-agent-core's `handleRunFailure` in the `agent_end` event) do not stamp `interrupted` onto the preceding bubble — the tool-part's own `"Tool execution interrupted"` error line carries the visual signal for that scenario.
- **Per-turn** — `duration`, `thinkingLevel`. Written in `agent_end`. `duration` is wall-clock time from the user's prompt to the turn completing. `thinkingLevel` is the reasoning effort that produced the turn, snapshotted at the user-prompt commit (not read at `agent_end` time) so a mid-stream `setThinkingLevel` / `setModel` doesn't relabel the historical bubble. Both stamp only on the turn-closing assistant bubble, which is `messages[length - 1]` when `agent_end` fires (tool results aren't rendered as display bubbles, so the last bubble is always the turn-closing assistant message). Intermediate assistant bubbles in a tool turn intentionally carry `agentName` + `modelName` without either per-turn field — "how long did the whole turn take?" / "what effort produced this turn?" only have single answers per turn. `thinkingLevel === "off"` is deliberately NOT persisted: NULL in the DB and `"off"` in memory render identically (no badge), so conflating them is lossless. Interrupted turns skip both per-turn stamps — same rationale as skipping the duration pip: the reply didn't complete, so neither "how long?" nor "what effort?" has a meaningful answer.

The conversation renderer shows the footer whenever `msg.modelName` OR `msg.interrupted` is present, and adds the duration pip only when `msg.duration > 0`, so intermediate tool-turn bubbles render `▣ Reader · <model>` without a duration, and the turn-closing bubble renders the full `▣ Reader · <model> · <duration>`. When `msg.thinkingLevel` is set and non-off, a second suffix `· <level>` (bold, `theme.warning`) follows the duration — mirrors the prompt statusline's own effort badge for a single visual language. Termination outcomes split visually: hard errors (`stopReason === "error"`) populate `msg.error` and render a warning-bordered panel (left border in `theme.error`, muted body text) between the part list and the footer, mirroring OpenCode's per-message error surface (in `routes/session/index.tsx`). User-initiated aborts (`stopReason === "aborted"`) populate `msg.interrupted` instead: no panel, but the footer tints the `▣` glyph `textMuted` (instead of the agent color) and appends a trailing ` · interrupted` span in `textMuted` — mirroring OpenCode's `MessageAbortedError` branch. Bubbles with empty parts still render when either `msg.error` OR `msg.interrupted` is set because the outer gate is `msg.parts.length > 0 || msg.error || msg.interrupted`. A very fast abort that never stamps `modelName` still renders the bare `▣ Reader · interrupted` form because the footer gate widens to `msg.modelName || msg.interrupted`. Interrupted turns explicitly skip the duration pip AND the effort badge — the `agent_end` stamp branch gates on `!last.interrupted` so wall-clock-until-abort / snapshot-at-start-of-abort values don't read like completed-turn metadata next to the `· interrupted` suffix.

### Bubble-per-assistant-boundary

`AgentProvider` pushes a fresh empty assistant `DisplayMessage` on every pi-agent-core `message_start` event whose `message.role === "assistant"` (filtering out user/toolResult starts, which are handled elsewhere or not rendered). `message_update` deltas append to the last-pushed bubble, and `message_end` stamps `agentName` / `modelName` onto that same bubble.

This mirrors pi-agent-core's own boundaries: a tool-using turn emits one assistant `message_start` / `message_end` pair before the tool call and another after the tool result. Each pair gets its own display bubble with its own per-message footer data, so saved sessions replay the original assistant boundaries and the per-message fields cannot leak between them. The `<Show when={msg.parts.length > 0 || msg.error}>` gate in `conversation.tsx` hides bubbles that are neither visible content nor a failure; with tool-call rendering wired in, a pure-tool-call assistant bubble now has a `tool` part and renders normally (so the tool invocation is visible between the pre- and post-tool text bubbles). The actual bubble body, tool-call row, and error panel live in `AssistantMessage` (`message.tsx`).

Tool calls are rendered inline on the assistant bubble that emitted them — `DisplayPart` has a `tool` variant carrying `{ callId, name, args, state, error? }`. The reducer pushes it in `"pending"` state on pi-ai's `toolcall_end` event, then flips to `"completed"` / `"error"` on pi-agent-core's `tool_execution_end`. `ToolPart` renders a single muted line (`⚙ name args`) plus a red error line on failure — see the ToolPart section in `message.tsx` for the visual states.

Sourcing the model from `event.message` (rather than the mutable `store.modelName`) means switching models mid-run via Ctrl+P does not relabel the in-flight assistant reply. `store.modelName` continues to reflect the currently-selected model for the sidebar and the next prompt.

### Duration and transient state

`lastTurnStartedAt` is a transient set in `prompt()` and consumed in `agent_end`. Once written to the turn-closing message it's not read again, so messages loaded from a persisted session render their original footer unchanged even though the transient is `0` at startup.

`turnStartThinkingLevel` (provider-local, not on the store) is the sibling transient for the reasoning-effort stamp. Captured in `wrappedActions.prompt`'s `onSuccess` block alongside `lastTurnStartedAt`, consumed in `agent_end` to stamp `DisplayMessage.thinkingLevel` on the turn-closing bubble, cleared after use. The snapshot-at-turn-start shape (rather than reading `store.thinkingLevel` at `agent_end` time) insulates the historical stamp from a mid-stream `setThinkingLevel` / `setModel`: swapping effort while a reply is streaming doesn't relabel the in-flight bubble.

`duration` and `thinkingLevel` both stamp only the **turn-closing** assistant bubble — the final assistant message whose `stopReason !== "toolUse"`. Intermediate assistant messages in a tool-driven turn carry `agentName` + `modelName` (per-message, stamped in `message_end`) without either per-turn field.

## Permission Dispatcher

Policy enforcement is declarative. The shell wires a single `beforeToolCall` hook that delegates to `dispatchBeforeToolCall` in `src/backend/agent/permissions.ts`. The dispatcher reads the active tool's baseline rules plus the active agent's overlay and evaluates them in order; the first rule that returns `{ block, reason }` short-circuits.

```
[...baselineRules[toolName], ...overlay[toolName]] → evaluate in declaration order
```

### Rule kinds

`Rule` is a tagged-union array. All current rule kinds are path-keyed (they read `args.path`); a tool without a `path` arg passes through.

| Kind | Shape | Purpose |
|---|---|---|
| `insideDirs` | `{ dirs: string[] }` | Resolved path must be inside ANY listed dir. Multiple rules AND-join. |
| `confirmDirs` | `{ dirs: string[] }` | If resolved path is in any listed dir, await `confirmFn`; decline → block. |
| `blockInsideDirs` | `{ dirs: string[]; reason: string }` | Block when resolved path is inside any listed dir. Used for "this whole directory tree is read-only for this agent." |
| `frontmatterOnlyInDirs` | `{ dirs: string[] }` | On `edit` when resolved path is inside any listed dir, every `args.edits[].oldText` must appear inside the file's `---`-delimited frontmatter. |

Path resolution mirrors pi-coding-agent (`~` / `~/` expansion, `@` prefix strip, absolute passes through, relative resolves against `VAULT_DIR`) so the sandbox check operates on the same bytes the tool will touch. pi-coding-agent doesn't re-export those helpers from its package index; the subset is inlined. The `isInsideDir` helper (exported from `permissions.ts`) is the single source of truth for "is this path inside that directory?" — used by the dispatcher and by agent-internal callers like reader's `/article` escape check.

### Tool baselines

Each tool in the shared pool registers baseline rules at module load (`src/backend/agent/tools.ts`):

| Tool | Baseline |
|---|---|
| `read` | `insideDirs: [VAULT_DIR]` |
| `write` | `insideDirs: [VAULT_DIR]` |
| `edit` | `insideDirs: [VAULT_DIR]` |

Baselines own only the hard vault boundary — writes outside `VAULT_DIR` are blocked regardless of agent declarations. Directory-level confirmation lives on zones (per-agent), not on the baseline (global), since D12: having both a baseline `confirmDirs` and a zones-derived `confirmDirs` for the same directory produced double-prompts.

Tools without a registered baseline run unsandboxed (pi-coding-agent's own default). By convention every tool Inkstone composes into `BASE_TOOLS` or an agent's `extraTools` registers its baseline.

### Agent overlays

The dispatcher accepts a combined overlay built by `composeOverlay(info)` in `src/backend/agent/zones.ts`:

```
composeOverlay(info) = info.getPermissions?.() ⊕ composeZonesOverlay(info)
```

**Custom rules come first**, zones come second. Keys with entries in both are concatenated; within a concatenated list, custom rules evaluate before zone rules. First-block-wins means the stricter (file-level) custom rules short-circuit before the looser (directory-level) zone rules fire. Concretely: reader's custom `blockInsideDirs` on Articles rejects a `write` against any article outright, without the zone's confirm prompt firing for a call that would be rejected anyway.

**`composeZonesOverlay(info)`** derives permission rules from `AgentInfo.zones` (see Agent Registry → Zones):

- Each zone with `write: "confirm"` → combined into one `confirmDirs` rule keyed under both `write` and `edit`.
- Each zone with `write: "auto"` → no rule emitted (writes inside the zone pass through the vault baseline unchanged).

Zone paths are joined with `VAULT_DIR` via `node:path.join` so leading/trailing slashes normalize. Absolute zone paths (POSIX `/`, Windows drive-letter, UNC) and paths containing `..` segments throw at compose time (misconfiguration should be loud).

Zones cover directory-level write policies. The `getPermissions?()` callback is the escape hatch for rules zones can't express — reader declares a static overlay on the Articles zone (see `getReaderPermissions` in `src/backend/agent/agents/reader/index.ts`): `blockInsideDirs` on `write` (any article overwrite blocked) and `frontmatterOnlyInDirs` on `edit` (any article edit must target frontmatter).

Reader's directory-level confirm rules (`confirmDirs` on Articles/Notes/Scraps) live in the `zones` declaration. What's in `getPermissions` is the article-specific policy zones can't express: *any* write to Articles is blocked; *any* edit to Articles must touch only frontmatter. The rules are static (they reference `ARTICLES_DIR` directly), so no per-turn state flows through `getPermissions`.

Overlay rules run AFTER tool baselines — an overlay can add restrictions but can't relax them (a later rule can't un-block an earlier block because first-block-wins). No tool today declares a permissive baseline that an overlay would want to tighten.

### What this replaces

The pre-dispatcher guard was a single procedural function in `backend/agent/guard.ts` that pattern-matched tool names and encoded reader's article rule directly. Reader-specific vocabulary leaked into the shell and the shell mutated `ctx.args._articlePath` as a side channel. Both are gone: the dispatcher has no reader knowledge, and reader's `getPermissions` owns its own data.

The zones refactor (D12) further split reader's policy: directory-level confirmation rules now live in declarative `zones` data (which the prompt also reads — see Agent Registry → Zones), while article-specific rules stay in `getPermissions`. The zones refactor also trimmed tool baselines to the hard vault boundary (`insideDirs: [VAULT_DIR]` only); directory-level confirmation moved entirely to zones so agents opt into it per-zone rather than inheriting it globally.

A follow-up pass (the statelessness refactor) replaced reader's state-keyed rules (`blockPath` + `frontmatterOnlyFor`, both keyed on the currently-active article) with static zone-wide rules (`blockInsideDirs` + `frontmatterOnlyInDirs` covering all of Articles). `activeArticle` state is gone — the `/article` command reads the file and inlines it as the opening user message, and the permission rules apply uniformly to every article. Broader protection surface, simpler reader. Tracked as a behavioral shift in TODO.md.

### Adding a rule kind

1. Add a variant to the `Rule` tagged union in `src/backend/agent/permissions.ts`.
2. Handle it in the `evaluateRule` switch. Return `{ block, reason }` to veto, `undefined` to pass. `evaluateRule` is async — a rule may await a user dialog (see `confirmDirs`).
3. Update the Rule kinds table above if the rule has user-visible semantics.

## Agent Registry

Multi-agent support is a **flat registry with runtime composition** — no inheritance. Each agent is a self-contained folder under `src/backend/agent/agents/<name>/` that exports an `AgentInfo` literal (name, displayName, description, `colorKey`, `extraTools`, `zones`, `buildInstructions`, optionally `commands`, optionally `getPermissions`). `src/backend/agent/agents.ts` is a thin assembler that imports each agent's literal and exports them as `AGENTS: AgentInfo[]`. The registry is a plain array — it never changes at runtime — so frontends that need the agent list import it directly rather than going through the bridge. Only the *selected* agent name crosses the bridge as reactive state (`AgentStoreState.currentAgent`).

> **Design rationale:** see [`AGENT-DESIGN.md`](./AGENT-DESIGN.md) for why the system is shaped this way (composition over inheritance, folder-per-agent, base layer, no opt-out on `BASE_TOOLS`, vault ≠ runtime state, commands vs tools, zones as declarative workspace), what alternatives were rejected, and how future features (skills, memory) are designed to plug in without restructuring.

### Base layer (the "base agent")

The foundation layer is split across three files:

- `src/backend/agent/types.ts` — `AgentInfo`, `AgentZone`, `AgentColorKey`, `AgentCommand`. Pure types, no runtime.
- `src/backend/agent/compose.ts` — `BASE_TOOLS`, `BASE_PREAMBLE`, `composeTools(info)`, `composeSystemPrompt(info)`.
- `src/backend/agent/zones.ts` — `composeZonesOverlay(info)`, `composeOverlay(info)`.

Shared constants and helpers:

- `BASE_TOOLS: readonly AgentTool[]` — tools every agent receives. Today: `read` (from the shared pool, scoped to `VAULT_DIR`) and `update_sidebar` (generic sidebar section management — upsert/delete sections by id; no filesystem access, no permission baseline). Frozen at module load so external modules can't mutate.
- `BASE_PREAMBLE: string` — a shared system-prompt prefix. **Empty today** — the mechanism is the point. Future PRs will grow this into a composed block that includes persona guidance, tool-use discipline, and memory-file contents (`user.md`, `memory.md` from `~/.config/inkstone/`).
- `composeTools(info)` — returns `[...BASE_TOOLS, ...info.extraTools]`. Every agent gets the base set unconditionally; there is no opt-out flag.
- `composeSystemPrompt(info)` — builds the full system prompt as three non-empty sections joined by blank lines: the zones block (when `info.zones.length > 0`), `BASE_PREAMBLE` (empty today), and `info.buildInstructions()`. `buildInstructions` is nullary. Called once at `createSession` and again on `Session.selectAgent` (empty-session agent swap); not on every turn — `state.systemPrompt` stays byte-stable for the session's lifetime so Anthropic `cache_control` / Bedrock `cachePoint` prefixes hit. See D9's stability invariant.

### Zones

`AgentInfo.zones: AgentZone[]` declares an agent's write workspace. Each zone is `{ path: string, write: "auto" | "confirm" }` where `path` is vault-relative. The same data drives two places:

- **Prompt**: `composeSystemPrompt` prepends a `<your workspace>` block listing each zone's path and policy verbally (`"write freely"` / `"confirm before write"`). Omitted for agents with empty zones.
- **Permissions**: `composeZonesOverlay` produces the matching D11 rules — all `confirm` zone paths combine into one `confirmDirs` rule under both `write` and `edit`; `auto` emits nothing (the baseline already permits writes inside the vault). Merged with `getPermissions?.()` via `composeOverlay`.

Single source of truth prevents drift between what the LLM is told and what the dispatcher enforces. Read is always vault-wide (bounded only by the tool baseline `insideDirs: [VAULT_DIR]`); zones only constrain writes.

A `deny` policy (read-only zone inside a workspace) was considered and cut in D12. The matching rule kind (`blockInsideDirs`) later shipped for reader's Articles restriction, so zones could now grow a `"deny"` → `blockInsideDirs` mapping cheaply. Deferred per D8 until a real agent wants it — see TODO.md.

Example — reader's zones:

Example — reader's zones (see `src/backend/agent/agents/reader/index.ts`): three `confirm` zones under Articles, Scraps, and Notes.

Example — the example agent (see `src/backend/agent/agents/example/index.ts`): `zones: []`.

Tool implementations come from `@mariozechner/pi-coding-agent` via the shared pool in `backend/agent/tools.ts` — Inkstone does not re-implement read/write/edit. Each factory is called with `VAULT_DIR` as the `cwd` so vault-relative paths resolve inside the vault; absolute paths are honored by the tool and sandboxed by the guard. pi-coding-agent's tool source transitively imports `@mariozechner/pi-tui`, but `wrapToolDefinition` strips the render hooks — the tools are pure `AgentTool<any>` at runtime, and pi-tui is inert code-path-wise (Inkstone renders through OpenTUI in `src/tui/**`).

`backend/agent/index.ts` exports `createSession({ agentName, onEvent })` which builds a pi-agent-core `Agent` bound to one agent name for the session's lifetime. `systemPrompt` + `tools` are composed once from the resolved `AgentInfo` and stay byte-stable across turns — see D9's stability invariant and D13's session-agent binding. `Session.selectAgent(name)` rewrites both fields on an empty session; it throws on non-empty sessions (mid-session agent swap is not supported). `Session.clearSession()` wipes `agent.state.messages` without touching the prompt. Per-turn operations (`prompt`, `abort`, `setModel`, `setThinkingLevel`) live on `Session.actions`.

### Agents on ship

| Name | extraTools | Composed tools | Zones | Commands | Prompt behavior | Color |
|------|------------|----------------|-------|----------|-----------------|-------|
| `reader` | `edit`, `write` | `read`, `update_sidebar` + the extras | `010 RAW/013 Articles` + `020 HUMAN/022 Scraps` + `020 HUMAN/023 Notes`, all confirm | `/article [filename]` | `<your workspace>` block + the 6-stage reading workflow. `/article <filename>` reads the file and sends path + full content as the LLM-facing prompt text, while passing the TUI compact `displayParts = [text "Read this article.", file text/markdown <vault-relative>]` so the bubble renders a short prose line + a clickable file chip (opens the article reader page) instead of the full article body. `/article` (bare) scans ARTICLES_DIR, displays a numbered recommendation list as a user bubble, and opens a DialogSelect picker; selecting an article runs the same compact-bubble loading path. In Stage 2 (keeper mode), the LLM calls `update_sidebar` to pin the first-pass prompts in the sidebar. | `theme.secondary` |
| `example` | — | `read`, `update_sidebar` only | — | — | Short static "general-purpose assistant" prompt, no workspace block | `theme.accent` |

Both agents inherit the shell-level `/clear` verb via the unified command registry (see Commands below) — no per-agent declaration needed.

### Adding a new agent

The folder-per-agent shape makes this a local change:

1. Create `src/backend/agent/agents/<name>/index.ts` exporting `<name>Agent: AgentInfo`.
2. If the agent needs an agent-specific system prompt, add `instructions.ts` next to it and import it from `index.ts`.
3. Declare `zones: AgentZone[]` for write targets inside the vault (or `zones: []` if the agent has no workspace).
4. If it wants tools from the shared pool, import them from `backend/agent/tools.ts` and list them in `extraTools`. If it owns a state-coupled tool that no other agent uses, add it under `agents/<name>/tools/` and re-export any public state helpers from the agent's `index.ts` (so the shell can stay out of deep imports per the boundary rule above).
5. If it has user-facing verbs, declare them as `AgentCommand[]` and set `commands: [...]` on the `AgentInfo`. The TUI's `BridgeAgentCommands` (see Commands below) picks them up automatically.
6. If zones can't express the full policy (e.g. reader's `frontmatterOnlyInDirs` rule on the Articles zone), declare `getPermissions?(): AgentOverlay` on the `AgentInfo`.
7. Add one import + one entry in `backend/agent/agents.ts`.

No changes to `types.ts`, `compose.ts`, `zones.ts`, `tools.ts`, `backend/agent/index.ts`, the TUI, or config schemas are required.

### Commands

Commands are user-invoked verbs, distinct from tools (which are LLM-invoked mid-turn). See [`AGENT-DESIGN.md` D9](./AGENT-DESIGN.md) for the rationale; this section documents the runtime.

**Single unified registry.** Slash verbs (`/clear`, `/article`), palette-only commands (`/models`, `/themes`, `/connect`, `/agents`, `/effort`), and keybind-only actions (ESC interrupt, Tab agent-cycle) all live in the same TUI-side command registry (`src/tui/components/dialog/command.tsx`). Backend `AgentCommand` (declared on `AgentInfo.commands`) and TUI `CommandOption` remain distinct types — the TUI bridges agent-declared verbs into registry entries at mount time, so the runtime registry is unified even though the static types are not. Per [`SLASH-COMMANDS.md`](./SLASH-COMMANDS.md) Path A.

**Type shape.** See `src/tui/components/dialog/command.tsx` for `CommandOption` and `SlashSpec`. A `CommandOption` carries `id`, `title`, optional `description`, optional `keybind` (for global keybind dispatch), optional `slash: SlashSpec` (for typed `/name args` dispatch), `hidden` (to suppress palette display), and `onSelect(dialog, args?)`.

Agent-declared verbs live backend-side. See `src/backend/agent/types.ts` for `AgentCommand` and `AgentCommandHelpers`. A command declares `name`, optional `description` / `argHint` / `takesArgs`, and `execute(args, helpers)`. The helpers bag gives commands `prompt(text, displayParts?)` (always available), plus optional `displayMessage(text)` and `pickFromList({…})` that require an interactive frontend.

`execute` takes an `AgentCommandHelpers` bag the TUI bridge injects:

- `helpers.prompt(text, displayParts?)` starts an LLM turn. The first arg is what pi-agent-core (and in turn pi-ai) hands to the LLM. The optional `displayParts` replace the user bubble's rendered parts without changing what reaches the model — the LLM still sees the full `text`. Reader's `/article` uses this to inline the full article in `text` while rendering a compact "short prose + file chip" bubble via `displayParts = [text "Read this article.", file text/markdown <vault-relative>]`. Commands that omit `displayParts` get the default `[{ type: "text", text }]` shape.
- `helpers.displayMessage(text)` pushes a user bubble without a turn (used for the bare-`/article` recommendation list).
- `helpers.pickFromList({...})` opens a `DialogSelect` picker and resolves with the picked value or `undefined` on cancel.

The optional helpers require an interactive frontend; headless callers omit them and commands that need them throw a clear error. Shell-level verbs (`/clear`) live as regular `CommandOption` entries that close over the TUI wrapper's `clearSession` directly, so they don't need anything handed off.

**System-prompt stability invariant.** `AgentInfo.buildInstructions()` must return a stable string for a given `AgentInfo`. pi-agent-core's `Agent` reads `state.systemPrompt` once per `prompt()` call (via `createContextSnapshot()` in `@mariozechner/pi-agent-core`), and both Anthropic's `cache_control` block and Bedrock's `cachePoint` are pinned to the byte-exact system prefix — any drift between turns invalidates the cache. The shell builds `systemPrompt` at two points only: `createSession` on construction and `Session.selectAgent` on an empty-session agent swap (see D13). `Session.clearSession` wipes messages without touching the prompt. Commands **must not** mutate state that `buildInstructions` reads; dynamic per-turn context (date, cwd, memory recall, file snapshots, article content) goes into a user message via `prompt(text)`. Reader's `/article` is the reference pattern.

**Sources of commands** (all flow into the same registry):

| Source | Registered by | Examples |
|--------|---------------|----------|
| Shell palette entries | `Layout()` in `src/tui/app.tsx` | `/agents`, `/models`, `/effort`, `/themes`, `/connect`, `/clear`, Tab agent-cycle |
| Prompt-local keybinds | `Prompt()` in `src/tui/components/prompt.tsx` | ESC interrupt |
| Agent-declared verbs | `BridgeAgentCommands` in `src/tui/context/agent.tsx`, reactive on `store.currentAgent` | reader's `/article <filename>` |

**Slash dispatch** (`command.triggerSlash(name, args)` in `dialog/command.tsx`):

```
user types "/article foo.md" + Enter
  → handleSubmit (src/tui/components/prompt.tsx)
    → value.startsWith("/") → split on first space
      → name="article", args="foo.md"
      → command.triggerSlash("article", "foo.md") === true
        → entries().find(e => e.slash?.name === "article")
          → BridgeAgentCommands' reader entry (agent-scoped registers first)
          → entry.onSelect(dialog, "foo.md")
            → helpers = buildCommandHelpers()
            → cmd.execute("foo.md", helpers)
              → runArticle("foo.md", helpers.prompt)
                → resolve + validate path inside ARTICLES_DIR
                → readFileSync(articlePath, "utf-8")
                → await helpers.prompt(
                    "Read this article...\n\nPath: ...\n\nContent:\n\n...",
                    [ { type: "text", text: "Read this article." },
                      { type: "file", mime: "text/markdown", filename: <vault-relative> } ],
                  )
                  (first arg is the full LLM-facing text; second arg is
                   what the user bubble renders. pi-agent-core only ever
                   sees the text. systemPrompt was built once at
                   createSession() — unchanged here, so Anthropic's
                   cache_control prefix hits on the next turn.)
      → setText("")                              (clear input)

user types "/article" + Enter (bare — no argument)
  → handleSubmit
    → command.triggerSlash("article", "") === true
      (takesArgs is false, so bare invocation passes the gate)
      → entry.onSelect(dialog, "")
        → helpers = buildCommandHelpers()
        → cmd.execute("", helpers)
          → filename.trim() === "" → bare-case branch
          → recommendArticles(10) → top 10 unread articles
          → helpers.displayMessage(formatRecommendationList(recs))
            (numbered list pushed as a user bubble, persisted to DB)
          → helpers.pickFromList({ title, options })
            (DialogSelect opens; user Arrow+Enter picks one)
          → picked = "Agent Design Is Still Hard.md"
          → runArticle(picked, helpers.prompt)
            → resolve + validate + readFileSync + await helpers.prompt(...)
      → setText("")

user types "/article" + Enter (bare — user cancels picker with ESC)
  → same flow as above until pickFromList
    → dialog.replace onClose fires → resolve(undefined)
    → picked === undefined → return (no turn started)
  → setText("")

user types "/clear" + Enter
  → handleSubmit
    → command.triggerSlash("clear", "") === true
      → Layout's session.clear entry
      → entry.onSelect() → actions.clearSession()
    → setText("")

user types "/xyz" + Enter
  → handleSubmit
    → command.triggerSlash("xyz", "") === false
    → actions.prompt("/xyz")                     (plain prompt)
```

**Precedence on slash-name collision**: first-match wins. `AgentProvider` mounts inside `CommandProvider` (see `src/tui/app.tsx` tree), and `command.register` prepends to the internal registration list — so `BridgeAgentCommands` entries sit ahead of `Layout`'s entries. An agent that declares a verb with the same name as a shell-level verb overrides the shell version for that agent only. This preserves D9's "agent overrides built-in" rule; it's theoretical today (no agent redefines `clear`).

**Slash-command dropdown** (`src/tui/components/prompt-autocomplete.tsx`):

Typing `/` at column 0 in the prompt opens a dropdown above the textarea listing all registered commands with a `slash` field. The dropdown reads `command.visible()` from the unified registry and filters via `fuzzysort` against the text after the leading `/`. Keyboard: Up/Down (+ Ctrl+P/Ctrl+N) navigate, Enter/Tab select, Esc dismiss. When the dropdown is visible with matches, Enter selects the highlighted entry; when no matches remain (user typed past all options), Enter falls through to the existing `handleSubmit` path (plain prompt or `triggerSlash`). Argless commands (e.g. `/clear`) fire immediately on selection; argful commands (e.g. `/article`) insert `/name ` into the textarea and close the dropdown so the user can type the argument. The dropdown dismisses on: Esc, space (whitespace in the text), backspace past the `/`, or explicit selection. Positioned via `position="absolute" bottom={6}` inside the prompt's outer `<box position="relative">`. Ported from OpenCode's `prompt/autocomplete.tsx` (slash-command subset; see also the `@` mention mode below — same component, single mode state machine).

**`@` file mentions** (`src/tui/components/prompt-autocomplete.tsx` mention mode + `src/tui/util/vault-files.ts` + `src/tui/util/mentions.ts`):

Typing `@` after whitespace or at start-of-input opens the same dropdown component in mention mode, listing vault files (`.md` / `.markdown` / `.txt`). Selection inserts a `@path ` span into the textarea and creates an OpenTUI virtual extmark covering the `@path` chars (not the trailing space — the space is ordinary text so the cursor can exit the span naturally). The extmark carries `metadata: { path }` so `handleSubmit` can walk them back into a mention list. Style comes from the `extmark.file` scope in `getSyntaxRules` (`src/tui/context/theme.tsx`) — `theme.warning` + bold — registered inside the shared `SyntaxStyle` so the id resolves against whichever instance is live after a theme switch.

On submit, `prompt.tsx` reads `input.extmarks.getAllForTypeId(promptPartTypeId)` (extmarks come back in *insertion* order; the submit path sorts by `start` before passing to the builder), then calls `buildMentionPayload(text, mentions, readFileSafe)` in `src/tui/util/mentions.ts`. The pure builder produces two parallel outputs: `llmText` (textarea content with each successfully-read `@path` replaced by a `Path: <path>\n\nContent:\n\n<body>` block matching reader's `/article` format) and `displayParts` (interleaved `text` / `file` parts for the user bubble). Failed reads (missing file, symlink, outside vault, I/O error) collapse back to the literal `@path` in both outputs and are aggregated into `failed`, which `handleSubmit` surfaces as a single `"Could not read N file(s)"` toast.

`wrappedActions.prompt(llmText, displayParts)` then handles the split exactly as it does for reader's `/article` — pi-agent-core sees `llmText`, the bubble renders `displayParts`. No new persistence schema; the existing `parts` table columns (`mime`, `filename`) shipped with `/article` round-trip mentions on session resume.

The prompt is an uncontrolled `<textarea>` (`minHeight=1`, `maxHeight=6`, `wrapMode="word"`) — not `<input>`, so long prompts wrap to additional lines instead of horizontally scrolling inside a single-line viewport. No `value=` prop: the renderable owns its buffer, `onContentChange` mirrors `plainText` into the parent's `text()` signal. Writes go through the renderable imperatively — slash selection calls `input.setText(...)` for argful/argless commands; mention selection calls `input.deleteRange` + `input.insertText` + `input.extmarks.create({ metadata: { path } })`. Going uncontrolled was the pivot that fixed typing after extmarks were introduced: a controlled `value={text()}` write-path round-trips through OpenTUI's `InputRenderable.set value` → `setText` → `wrapSetText` which clears all extmarks, so a reactive update on each keystroke would nuke mention spans. `clearInput()` centralizes the submit/clear path (`input.setText("")` + `setText("")`); the buffer's own `setText` call clears extmarks as a side effect, so no separate `extmarks.clear()` is needed.

Textarea keybindings (mirrors OpenCode's `input_submit` / `input_newline` config): `Enter` submits; `Shift+Enter`, `Ctrl+Enter`, `Alt+Enter`, and `Ctrl+J` all insert a newline. `linefeed` is intentionally NOT bound to submit — OpenTUI parses Ctrl+J as `linefeed`, so that binding (which `<input>` hardcodes as a second submit trigger) would shadow Ctrl+J's newline.

Vault file list comes from `listVaultFiles()` (`src/tui/util/vault-files.ts`) — synchronous recursive walker, module-local lazy cache (first `@` trigger walks; subsequent triggers hit the cache). Skips leading-dot entries, `node_modules/`, symlinks (matching `readFileSafe`'s reject so the dropdown never surfaces a file the submit path would fail on). Extension allowlist `ALLOWED_VAULT_EXTENSIONS` (`.md` / `.markdown` / `.txt`) is exported and re-applied inside `readFileSafe` so a manually-typed `@foo.json` also fails (without the re-check, the manual path would bypass the filter). `invalidateVaultFileCache()` is exported but currently has no callers — reserved for a future "refresh" command or `fs.watch` hook.

Slash + mention modes are mutually exclusive by construction (single `mode: "slash" | "mention" | null` state machine). When slash is already active, typing `@` becomes slash filter text, not a mention trigger — intentional; slash wins while active.

Trimmed from OpenCode's equivalent: frecency ranking, directory expansion, line-range mentions (`@foo.md#10-20`), `@agent` sub-agent routing, mouse handling, `input.traits.capture` (Inkstone keeps the existing `useKeyboard` dispatch pattern for now).

**No session auto-resume.** Boot always shows the openpage. Past session rows linger on disk for a future `/resume` command. This removes the "align agent before seeding messages" reconciliation window the previous resume flow had to manage — agent is now picked at session construction and fixed for the lifetime (see D13).

### Switching rules

Switching is intentionally locked to empty sessions (`store.messages.length === 0`), diverging from OpenCode's always-on `agent_cycle`. This matches Inkstone's "one agent per session" model and avoids the bookkeeping OpenCode needs (per-message `agent` stamps on user bubbles, tool-result routing, mid-stream prompt rebuilds).

- **Tab / Shift+Tab** on the open page cycle forward / backward through the registry. Registered as hidden commands via `useCommand().register` in `Layout()` (`src/tui/app.tsx`), gated by `store.messages.length === 0` inside the registration callback so the bindings auto-disable once a message exists.
- **Command palette → Agents** opens `DialogAgent`, the entry is hidden once `store.messages.length > 0`.
- **Persistence**: the selected agent is saved to `config.json` as `currentAgent` on every switch and restored at boot. Unknown names fall back to the first registry entry.

### Data flow (agent switching)

```
selectAgent(name)                                 [only legal on empty session]
  → TUI wrapper (context/agent.tsx)
    → guard: throw if store.messages.length > 0
    → agentSession.selectAgent(name)              [Session, backend/agent/index.ts]
      → guard: throw if agent.state.messages.length > 0
      → info = getAgentInfo(name)                 [closure reference updated]
      → a.state.systemPrompt = composeSystemPrompt(info)
      → a.state.tools        = composeTools(info)
      → saveConfig({ currentAgent })
    → setStore("currentAgent", agentSession.agentName)
      → prompt label, input border, user-bubble border, assistant ▣ glyph all re-theme via `theme[getAgentInfo(store.currentAgent).colorKey]`
```

The mid-session agent swap is rejected both by the UI (Tab/palette gates on empty sessions) and by the backend (throws on non-empty). See D13 for the rationale. The composers (`composeSystemPrompt`, `composeTools`) are defined in `backend/agent/compose.ts`. `composeSystemPrompt(info)` joins up to three non-empty sections: a `<your workspace>` zones block (present when `info.zones` is non-empty — e.g. reader), `BASE_PREAMBLE` (empty today), and `info.buildInstructions()`. For agents with no zones and an empty preamble, the result is just the agent's instructions.

The assistant `message_end` handler stamps `agentName` onto the new bubble using `getAgentInfo(store.currentAgent).displayName`. Because switching is locked mid-session, the stamped name is guaranteed to be the agent that actually produced the reply.

## Provider Registry

Providers are declared in `src/backend/providers/` as a static registry — same pattern as `agent/agents.ts`. The registry wraps pi-ai's per-API stream functions (`getModels(provider)` + pi-ai's internal `api-registry`) with the user-facing metadata Inkstone needs: display name, connection check, auth instructions.

### Why a registry on top of pi-ai

pi-ai already owns streaming for each API it ships (`bedrock-converse-stream`, `anthropic-messages`, `openai-responses`, …). Inkstone's `ProviderInfo` sits above that:

- The registry owns the list of providers Inkstone actually exposes (pi-ai ships many; a given Inkstone build may surface a subset).
- Each provider decides how its credentials resolve and reports a connected/disconnected status so the UI can gate on it.
- Custom providers that pi-ai doesn't ship (e.g. Amazon Kiro's Converse-compatible endpoint) can return hand-built `Model<Api>` objects with a custom `baseUrl`, reusing pi-ai's existing stream function for that API. No change to pi-ai itself.
- The extension point for fundamentally-different custom providers (own `streamFn`) is intentionally *not* wired here. Add it when the first such provider lands; not speculatively.

### `ProviderInfo` shape

See `src/backend/providers/types.ts` for the interface. Each provider declares `id`, `displayName`, `defaultModelId` (curated fallback when config is empty/stale), optional `titleModelId` (cheap model for background session-title generation), `listModels()`, `getApiKey()` (sync or async, may return `undefined`), `isConnected()`, and `clearCreds()` (synchronous credential wipe invoked by the shared `confirmAndDisconnect` helper).

`defaultModelId` is required (not optional) so every provider declares its own curated fallback rather than depending on registry order. The agent module throws on boot if the declared default no longer resolves through `listModels()`, surfacing pi-ai registry drift loudly instead of silently relocating the user to an arbitrary model. `titleModelId` is optional because a provider can fall back to the active chat model; configured `sessionTitleModel` in `config.json` wins over the provider default.

Three providers ship today, all backed by credentials Inkstone owns (OAuth tokens or API keys in `~/.config/inkstone/auth.json`). Amazon Bedrock previously shipped as a fourth provider using the AWS SDK credential chain (env vars, `~/.aws/credentials`, SSO, IAM profiles) but was dropped — those sources live outside Inkstone's ownership, so a truthful Disconnect flow wasn't buildable against them. OpenRouter's catalog includes Anthropic's Claude Opus 4.7 + other flagships that covered Bedrock's primary use case.

| id | displayName | Default | Title model | Auth detection | Models |
|---|---|---|---|---|---|
| `kiro` | Amazon Kiro | `claude-opus-4-7` | `kimi-k2-5` (switch to K2.6 when pi-kiro exposes it) | Presence of saved OAuth creds in `~/.config/inkstone/auth.json` (mode 0600). Device-code login triggered from Connect dialog. | `kiroModels` from `pi-kiro/core`, region-filtered via `filterModelsByRegion` + `baseUrl` rewrite per `resolveApiRegion(creds.region)` |
| `openai-codex` | ChatGPT | `gpt-5.4` | `gpt-5.4-mini` | Presence of saved OAuth creds in `~/.config/inkstone/auth.json` (mode 0600) under the `openaiCodex` key. PKCE authorization-code login (browser callback on `127.0.0.1:1455`, falls back to paste prompt on port conflict) triggered from Connect dialog. Requires an active ChatGPT Plus / Pro subscription — the access-token JWT must carry a `chatgpt_account_id` claim or pi-ai's `loginOpenAICodex` throws. | `getModels("openai-codex")` from pi-ai (returns `[]` when signed out so `DialogModel` hides the entries) |
| `openrouter` | OpenRouter | `moonshotai/kimi-k2.6` | `moonshotai/kimi-k2.6` | Presence of saved API key in `~/.config/inkstone/auth.json` (mode 0600) under the `openrouter` key. Single-step key-paste dialog triggered from Connect dialog; no OAuth, no refresh cycle. | `getModels("openrouter")` from pi-ai — 251 models across 20+ upstream providers, all variants (`:free`, `:beta`, `:nitro`) exposed unfiltered (user filters via DialogSelect fuzzy search). Returns `[]` when signed out. |

`getApiKey()` semantics per provider: **Kiro** is async — checks `creds.expires`, calls `refreshKiroToken()` if past-due, persists the refreshed pair, and returns the fresh `access` token. On refresh failure it clears stored creds and throws a "run Connect again" error — pi-agent-core surfaces this via the existing error-bubble path. **OpenAI Codex** is async and delegates to pi-ai's own `getOAuthApiKey("openai-codex", credsMap)` which handles the expiry check + rotation; the provider shim wraps pi-ai's throw-on-refresh-failure contract so the no-throw invariant is honored (matches Kiro's posture). **OpenRouter** is synchronous and returns the stored key verbatim — no refresh, no expiry, no rotation. pi-ai's `openai-completions` stream (auto-registered) reads it on every turn.

First boot on a machine with no stored provider: `resolveInitialProviderModel` in `backend/agent/index.ts` throws with a "no provider connected, open Connect" message. The TUI surfaces the throw — the user must pick a provider and authenticate before the first prompt. Previously (while Bedrock shipped), a silent fallback to Bedrock's default model hid this case on machines with `aws configure` set up; the silent fallback is gone.

### Kiro provider — registration, region scoping, refresh

The `kiro.ts` module has three responsibilities on top of the shared `ProviderInfo` contract:

1. **API registration** — at module load it calls `registerApiProvider({ api: "kiro-api", stream: streamKiro, streamSimple: streamKiro })` with pi-ai so pi-agent-core's default `streamFn` (pi-ai's `streamSimple`) can dispatch to `pi-kiro/core`'s `streamKiro` whenever it sees `model.api === "kiro-api"`. `backend/providers/index.ts` imports `./kiro` so registration fires before the agent module resolves any model. We don't pass a custom `streamFn` to `new Agent(...)` — the registry is the canonical dispatch point.
2. **Region scoping** — pi-kiro ships one canonical `kiroModels` catalog; per-region availability is a runtime filter and the `baseUrl` has to be rewritten to point at the user's API region (`q.{region}.amazonaws.com`). `listModels()` reads the saved creds, computes `resolveApiRegion(creds.region)`, runs `filterModelsByRegion(kiroModels, apiRegion)`, and clones each model with the rewritten `baseUrl`. Returns `[]` when not signed in so `DialogModel` hides Kiro entries until the user authenticates. Mirrors pi-kiro's `modifyModels` hook in `extension.ts`, applied here because we consume pi-kiro through `/core` (not pi's extension runtime).
3. **Lazy refresh** — `getApiKey()` checks `Date.now() > creds.expires`, and on miss calls `refreshKiroToken()` and `saveKiroCreds()` before returning. No background scheduler — refresh happens at the single point that actually needs a fresh token. On refresh failure we `clearKiroCreds()` and throw, pushing the user back through Connect.

### Credential storage — `~/.config/inkstone/auth.json`

Kept separate from `config.json` because OAuth tokens are sensitive (pi-kiro's `oauth.ts` explicitly calls out the refresh token + `clientSecret` pair as credentials that can mint access tokens for the user's AWS identity). `config.json` is frequently screenshared (themes, model ids) so a split avoids accidental leaks. File mode is forced to `0600` (directory `0700`) on every write via `chmodSync`. Shape is keyed by provider id (`{ kiro?: KiroCredentials }`) so future interactive providers slot in without migration.

### Agent integration

`backend/agent/index.ts` resolves the active provider/model at session boot:

- Active state is `(currentProviderId, currentModelId)` loaded from `config.json`. Fresh installs with no stored config throw a "no provider connected, open Connect" error (the silent-fallback-to-Bedrock hop was removed when Bedrock was dropped — every shipped provider requires explicit user credentials).
- `getApiKey` hook dispatches to `getProvider(provider)?.getApiKey()`. Returns `undefined` for unregistered provider ids (e.g. a stale config row from a dropped provider) so pi-ai surfaces the downstream error cleanly.
- `setModel(model)` reads the incoming `Model<Api>`'s `.provider` + `.id` and persists both.
- `resolveModel(providerId, modelId)` looks up the live `Model<Api>` object through the registry at each access, so a provider implementation can mint custom models dynamically.
- `findFirstConnectedProvider(excluding?)` is the shared helper used by every `confirmAndDisconnect*` flow to pick the rehome target when the active provider is disconnected. Returns `undefined` when no other connected provider exists; the disconnect flow then emits a warning toast nudging `/models`.

### UI: three palette entries

| Palette entry | Dialog | Behavior |
|---|---|---|
| **Models** | `DialogModel` | Flat list of models from every connected provider, `description` = provider display name. Empty placeholder when zero providers connected, directing the user to Connect. Auto-closes on select (backend `setModel` also auto-restores the per-model stored effort). |
| **Effort** | `DialogVariant` | Standalone reasoning-effort picker for the currently-active model. Registered only when `store.modelReasoning === true` — non-reasoning models hide the entry to avoid palette noise. See "Effort variants" below. |
| **Connect** | `DialogProvider` | All providers, sorted connected-first. Connected row → Reconnect / Disconnect manage menu. Disconnected row → provider login flow resolved through the TUI-side `LOGIN_FLOWS` lookup table in `components/dialog/provider/login-registry.ts` (keeps `ProviderInfo` free of TUI dependencies). Every shipped provider has a login flow entry; a registry addition without a login flow is a programming error, not a user-facing path. |

#### Kiro device-code login flow

`startKiroLogin` in `components/dialog/provider/login-kiro.tsx` wires pi-kiro's `loginKiro` callbacks against the existing dialog stack:

- `onPrompt({ message, placeholder, allowEmpty })` → `DialogPrompt.show(...)` returns a promise. pi-kiro calls this up to twice (Builder ID vs IdC start URL, optional IdC region). Each call uses `dialog.replace`, so only one dialog is on the stack at any time — sidesteps pi-kiro's documented mirrored-cursor glitch (in `oauth.ts`), where two input widgets appended to the same container double-render typed characters.
- `onAuth({ url, instructions })` → replaces the prompt with `DialogAuthWait` showing the verification URL (primary color), user code + expiry note, and a live progress line fed by `onProgress`.
- `onProgress(msg)` → updates a signal consumed by `DialogAuthWait`.
- Cancellation: closing any dialog in the chain resolves the prompt promise to `null` (`DialogPrompt.show`) or invokes the wait dialog's `onClose`, which aborts the `AbortController` passed to `loginKiro`. pi-kiro throws "Login cancelled"; we swallow it silently and `dialog.clear()`.
- Success: `saveKiroCreds(creds)`, success toast, then `DialogModel.show(...)` scoped to `{ providerId: "kiro", modelId: "claude-opus-4-7" }` so the user lands on the freshly-available catalog. Mirrors OpenCode's chain in `component/dialog-provider.tsx`.
- Failure (non-cancel): error toast with the pi-kiro error message.

The Models dialog does not drill down through providers — with only connected providers in the list, flat is simpler. When a future provider adds an API-key auth flow, the two-step would land as: DialogProvider → api-key input → DialogModel scoped to the newly-connected provider. That scoped form can be re-added to `DialogModel` (via an optional `providerId` prop) when needed.

#### OpenAI Codex (ChatGPT) login flow

`startOpenAICodexLogin` in `components/dialog/provider/login-openai-codex.tsx` wires pi-ai's `loginOpenAICodex` callbacks against the dialog stack. The flow differs from Kiro's AWS SSO-OIDC device-code:

- pi-ai binds a local HTTP server on `127.0.0.1:1455` to receive the OAuth redirect, opens the authorize URL via `DialogAuthWait` (user clicks or presses Enter to hand off to the system browser, or presses `c` to copy the URL to the clipboard — see `DialogAuthWait` below).
- `onAuth({ url, instructions })` → `DialogAuthWait.show(...)` — primary-color URL, muted instructions, live progress line fed by `onProgress`.
- `onPrompt({ message, placeholder, allowEmpty })` → `DialogPrompt.show(...)` — invoked **only as a post-failure fallback** when the callback server couldn't bind to 1455 (port busy / firewall) or the callback never came through. User pastes the `?code=…&state=…` URL or the bare code; pi-ai's `parseAuthorizationInput` handles both shapes. Intentional choice over pi-ai's `onManualCodeInput` racer — the paste lane would otherwise hide the primary URL on the DialogAuthWait screen for the healthy-network case.
- Cancellation: ESC on either dialog triggers `onClose`, which closes the dialog stack. pi-ai's `loginOpenAICodex` does not take an `AbortSignal`; a cancelled `onPrompt` (user ESCd the paste fallback) throws a sentinel `"Login cancelled"` that the catch branch swallows silently.
- Success: `saveOpenAICodexCreds(creds)` → toast → `DialogModel.show(...)` scoped to `{ providerId: "openai-codex", modelId: "gpt-5.4" }` so the user lands on the freshly-available catalog. Same post-login chain as Kiro.
- Failure — subscription gating: pi-ai's `loginOpenAICodex` extracts `chatgpt_account_id` from the access JWT on both login and refresh, throwing `"Failed to extract accountId from token"` when the account lacks Codex entitlement. The catch branch detects this error substring (case-insensitive) and surfaces a targeted "ChatGPT Plus or Pro subscription required" toast instead of the raw message.

#### DialogAuthWait — shared OAuth wait screen

`src/tui/ui/dialog-auth-wait.tsx` owns the OAuth "waiting for authorization" screen both Kiro and Codex land on after `onAuth` fires. Trimmed port of OpenCode's `AutoMethod` block in `component/dialog-provider.tsx:157-207`:

- Primary-color clickable URL (mouse click or Enter → `open(url)` via the `open` npm package).
- Muted instructions (`onAuth({ instructions })` payload).
- Live progress line fed by an `Accessor<string>` signal the caller drives from `onProgress`.
- `c` copies the URL to the system clipboard via `src/tui/util/clipboard.ts`'s `copyToClipboardOSC52`. OSC 52 is the only clipboard path that works over SSH (terminal emulator writes to the local clipboard, not the remote host). Modern terminals (Alacritty, WezTerm, iTerm2, kitty, Windows Terminal, Ghostty, tmux with DCS passthrough) honor it; older terminals silently drop the sequence. Acceptable for a fallback path — the URL stays visible for manual retype.

`copyToClipboardOSC52` is a single ~15-line function; OpenCode's full `util/clipboard.ts` (native subprocess + `clipboardy` fallback) is deliberately NOT ported — when a second copy use case (copy-tool-output, copy-error-details) hits a terminal that doesn't honor OSC 52, port the rest.

#### Codex WebSocket transport

pi-ai 0.72.x's `openai-codex-responses` provider supports three transports via `SimpleStreamOptions.transport`: `"sse"`, `"websocket"`, `"websocket-cached"`, and `"auto"` (the default). `"auto"` tries WebSocket first, silently falls back to SSE on any connection failure (`providers/openai-codex-responses.js:92, :110-114`). Inkstone pins `transport: "auto"` explicitly at `Agent` construction (`src/backend/agent/index.ts`) so the choice is documented at the call site and insulated from future pi-ai default flips. Connectivity-over-cost — SSH / blocked-WebSocket networks silently degrade rather than erroring.

**Session-id plumbing.** pi-ai's Codex provider uses `SimpleStreamOptions.sessionId` as both (a) the `prompt_cache_key` on SSE requests (`:218`) and (b) the WebSocket connection cache key for `websocket-cached` continuation (`:761`). Same id across turns → one socket reused across the session, first turn sends full context, subsequent turns send only the delta (`:753-757, :833-853`). Inkstone threads its SQLite `sessions.id` through `Session.setSessionId(id)`, called from `ensureSession()` on the first prompt and from `resumeSession`'s batch after `restoreMessages`. `Session.setSessionId` assigns `agent.sessionId` on the underlying pi-agent-core `Agent`, which forwards the value on every stream call (`pi-agent-core/dist/agent.js:281`). Other providers ignore the field.

`/clear` nulls `currentSessionId` so the next prompt creates a fresh session row → fresh id → fresh WebSocket cache key. pi-ai's existing 5-minute idle TTL (`SESSION_WEBSOCKET_CACHE_TTL_MS`) reaps the old socket. No explicit teardown needed.

**Transport detection + indicator.** `getOpenAICodexWebSocketDebugStats(sessionId)` (exported from `@mariozechner/pi-ai/openai-codex-responses`) returns per-session counters: `connectionsCreated`, `connectionsReused`, etc. These mutate inside `processWebSocketStream` after body send (`:768-774`), so if `"auto"` transport aborts the WebSocket path before that point and falls back to SSE, the counters stay unchanged. `wrappedActions.prompt` in `tui/context/agent.tsx` snapshots the pre-turn total (`connectionsCreated + connectionsReused`) when `store.modelProvider === "openai-codex"`; `agent_end` reads the post-turn total and writes `"ws"` (diff advanced) or `"sse"` (diff unchanged) to `store.codexTransport`. The prompt statusline renders that field as a muted `· ws` / `· sse` suffix next to the model name — always-visible when Codex is active, hidden for other providers.

The indicator is **ephemeral**: `codexTransport` is a store-only-no-persist field (like `sidebarSections`), never written to SQLite or stamped onto `DisplayMessage`. Transport choice is a network-state signal that should reflect current reality, so each Codex turn overwrites the field and `/clear` + `resumeSession` reset it. An earlier iteration used a one-shot toast — pulled in favor of the always-visible badge because network state can change between turns (VPN toggles, port-busy resolves), and a once-per-session toast can't track the updated reality.

#### OpenRouter — API-key flat catalog

`src/backend/providers/openrouter.ts` is the simplest `ProviderInfo` shim shipped. No OAuth, no refresh cycle, no `registerApiProvider` — pi-ai's `openai-completions` stream handles all 251 OpenRouter entries in its generated catalog (`providers/openai-completions.js`), and `baseUrl: "https://openrouter.ai/api/v1"` is baked into each model's registry entry. `getApiKey()` is synchronous and returns the stored key verbatim; `isConnected()` = key presence; `listModels()` = `getModels("openrouter")` unfiltered when connected, `[]` when signed out (so `DialogModel` hides the entries until the user authenticates).

**Catalog surface.** All 251 models, all variants (`:free`, `:beta`, `:nitro`), exposed without curation. Users filter via DialogSelect's fuzzy search — 251 rows is a lot, but fuzzy-search on the model id typically narrows to the target in a few keystrokes. A curated subset (popular flagships, Anthropic/OpenAI/Google only, etc.) was considered and deferred: no principled curation line, and filtering surface already covers the UX gap. Future Work may grow a `recent-picks` memo if a real habit emerges.

**Key entry.** `src/tui/components/dialog/provider/set-openrouter-key.tsx` is a single `DialogPrompt.show` with a description linking to `https://openrouter.ai/keys` and a placeholder `sk-or-v1-…`. On submit → `saveOpenRouterKey(trimmed)` → success toast → `DialogModel` scoped to OpenRouter's `moonshotai/kimi-k2.6` default. Empty/whitespace key → warning toast + early return (no disk write). ESC at any point → `dialog.clear()`.

**Disconnect.** Handled uniformly by `confirmAndDisconnect` in `src/tui/components/dialog/provider/confirm-and-disconnect.ts`: DialogConfirm → `provider.clearCreds()` → active-session rehome via `findFirstConnectedProvider(provider.id)` (warning toast nudging `/models` when no fallback exists). OpenRouter-specific logic lives entirely in `openrouterProvider.clearCreds` (which calls `clearOpenRouterKey`) — the shared helper doesn't branch per provider.

**No refresh cycle.** OpenRouter API keys don't expire and aren't rotated. `getApiKey()` is sync; no in-flight dedup memo; no `reportPersistenceError` call in a refresh-failure catch branch because there isn't one. If OpenRouter ever grows per-key metadata (routing preferences, org hints), `AuthFile.openrouter` migrates from `string` → `{ apiKey: string, ...metadata }` at that point.

#### Disconnect / manage menu

Kiro, OpenAI Codex, and OpenRouter are all owned-creds providers — their credentials live in `~/.config/inkstone/auth.json` and Inkstone can honestly clear them via `ProviderInfo.clearCreds()`. `DialogProvider` opens the Reconnect / Disconnect manage menu for any connected row. The shared `confirmAndDisconnect` helper in `components/dialog/provider/confirm-and-disconnect.ts` owns the DialogConfirm → clearCreds → rehome → toast sequence; per-provider logic is confined to `clearCreds()` (credential wipe) and `displayName` (toast strings). Reconnect dispatches through the `LOGIN_FLOWS` lookup table in `login-registry.ts`.

### Effort variants (reasoning levels)

Reasoning-capable models expose a dedicated **Effort** palette entry that opens `DialogVariant` on the currently-active model and lets the user pick a pi-agent-core `ThinkingLevel`. Inkstone follows OpenCode's standalone-entry pattern (OpenCode's `variant.list` command + `/variants` slash, `dialog-variant.tsx`) trimmed to pi-ai's unified level enum — no per-SDK `variants()` switch is needed because pi-ai already owns the provider-specific mapping internally. Our implementation lives at `components/dialog/variant.tsx`.

The entry is **not** a cascade from the Models dialog. Picking a model via Models is a one-step action that sets the model and auto-restores its stored effort (see "setModel auto-restore" below); changing effort on the current model is a separate palette action. This mirrors how OpenCode separates model selection from variant selection in its palette and slash-command surface (see `opencode/src/cli/cmd/tui/app.tsx`).

**Entry visibility** — driven reactively by `store.modelReasoning`:

- `model.reasoning === false` → Effort entry hidden from Ctrl+P (OpenCode uses a `hidden` flag on the `variant.list` command with `local.model.variant.list().length === 0` — same intent, simpler shape since Inkstone is palette-only)
- `model.reasoning === true` → Effort entry shown between Models and Themes

**Level set per model** — computed by `availableThinkingLevels(model)` in `backend/agent/index.ts`:

- `model.reasoning === false` → `["off"]` (Effort entry hidden anyway)
- `model.reasoning === true` → `["off", "minimal", "low", "medium", "high"]`, plus `"xhigh"` iff pi-ai's `supportsXhigh(model)` returns true (Claude Opus 4.6/4.7, GPT-5.2+)

`"off"` is an explicit first-class option (not a synthetic "Default" row), matching pi-agent-core's `ThinkingLevel = "off" | ...` sentinel — picking "Off" literally sets `Agent.state.thinkingLevel = "off"`, which disables `reasoning:` on the next pi-ai stream call.

pi-ai internally collapses some levels to the same wire value on certain models (e.g. `"minimal"` → `effort: "low"` on adaptive Claude; `xhigh` budget → `high`'s 16384 tokens on non-adaptive Claude). That's a pi-ai design choice — the collapsed levels produce identical model behavior — so Inkstone surfaces the full pi-agent-core enum and lets pi-ai do the mapping. The only capability gate we apply is `supportsXhigh(model)`, which is pi-ai's own exported helper (not a mirror of internals).

**On the "max" wire value:** Anthropic renamed their top-tier adaptive-thinking effort between Opus 4.6 (wire name: `"max"`) and Opus 4.7 (wire name: `"xhigh"`). pi-ai maps the unified `ThinkingLevel = "xhigh"` to whichever wire value is top for the target model — so on Opus 4.6 it sends `output_config: { effort: "max" }`, on Opus 4.7 it sends `output_config: { effort: "xhigh" }` (see `pi-mono/packages/ai/src/providers/amazon-bedrock.ts` and its tests). OpenCode exposes separate `xhigh` + `max` rows for Opus 4.7, but under pi-mono's contract that's redundant — both land at the same "top tier". Inkstone follows pi-mono, so `xhigh` on Opus 4.7 IS the maximum reasoning tier reachable via the Anthropic API.

**Storage — per-model, keyed by `${providerId}/${modelId}`.** Stored in `config.json` under `thinkingLevels: Record<"${providerId}/${modelId}", ThinkingLevel>`. Missing key resolves to `"off"`. Schema: `src/backend/persistence/schema.ts`. Matches OpenCode's `local.model.variant` keying so a model remembers the effort the user last picked for it.

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

**Safety guard:** pi-ai/pi-agent-core already ignores `reasoning:` on non-reasoning models (see `pi-mono/packages/ai/src/providers/amazon-bedrock.ts`), so Inkstone doesn't re-guard capability in `resolveThinkingLevel`.

**Non-goals (deferred):**

- Mid-session effort cycle keybind (OpenCode uses `ctrl+t`). Palette-only access is consistent with Inkstone's current pattern (model switch is also palette-only).
- Per-message effort stamping beyond the turn-closing bubble. `DisplayMessage.thinkingLevel` is set only on the turn-closing bubble (same scope as `duration`) — intermediate tool-call bubbles stay clean. Extending to every assistant bubble would add visual noise without a paired value signal today.
- User-configurable per-model level lists (`config.provider[X].models[Y].variants`). pi-ai's `supportsXhigh` + `model.reasoning` already cover every model in the current registry; custom overrides are speculative.

### modelProvider in AgentStoreState

`AgentStoreState.modelProvider` holds the **provider id** (e.g. `"openrouter"`), not a display string. Frontends resolve to the display name through `getProvider(id)?.displayName` at render time (`components/prompt.tsx`). Keeping the store free of formatted strings means provider metadata changes propagate without a store update.

## Keybinds + Commands

Keyboard shortcuts are in two layers — a pure data map (actions → binding strings) plus a registry-based dispatcher — ported from OpenCode's `util/keybind.ts` + `component/dialog-command.tsx` pattern. Our dispatcher lives at `components/dialog/command.tsx`.

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
| `session_list` | CommandProvider — toggles the left session panel (registered in `app.tsx`) |
| `agent_cycle`, `agent_cycle_reverse` | CommandProvider — registered commands in `app.tsx` |
| `session_interrupt` | CommandProvider — registered by `prompt.tsx`, streaming-gated. ESC double-tap aborts the in-flight turn (see below) |
| `messages_*` | Top-level scroll handler in `app.tsx` (only mounted while the session view is rendered) |
| `dialog_close` | `ui/dialog.tsx` — dismisses the top-of-stack dialog |
| `panel_close` | `components/session-list.tsx` — closes the session panel (ESC or Ctrl+N) |
| `select_*` | `ui/dialog-select.tsx` — local nav (arrow keys + emacs `ctrl+n`/`ctrl+p`) |

`dialog-confirm.tsx` uses its own inline `y`/`n`/`left`/`right`/`return` checks — those keys are dialog-local and don't belong in the shared map.

### Session interrupt (double-tap ESC)

Ported from OpenCode (see `opencode/src/cli/cmd/tui/component/prompt/index.tsx`). The `session_interrupt` keybind (default `escape`) is registered by `Prompt()` in `src/tui/components/prompt.tsx` via `useCommand().register`, with the registration memo gated on `store.isStreaming` — so the binding is live only while a turn is in flight. When idle, the registration returns `[]` and ESC falls through (no global handler is listening).

Double-tap semantics live in a local signal inside `Prompt()` (`interrupt: number`, not in `AgentStoreState` — pure UI transient, no cross-frontend contract):

- **First ESC** → `interrupt` increments to 1; the prompt hint flips from `esc interrupt` (in `theme.text` + `theme.textMuted`) to `esc again to interrupt` (both spans in `theme.primary`); a 5 s timer is armed to reset `interrupt` to 0.
- **Second ESC within 5 s** → `actions.abort()` is called (pi-agent-core `Agent.abort()`), `interrupt` resets to 0, the pending timer is cleared.
- **5 s elapses without a second press** → `interrupt` resets to 0, the hint reverts to `esc interrupt`. The next press starts the sequence over — a single ESC after the timeout does **not** abort.

Inkstone additionally scopes the arm to the current turn via a `createEffect` on `store.isStreaming`: when streaming flips back to false, the pending 5 s timer is cleared and `interrupt` returns to 0. Without this reset, a single ESC press late in a turn that completes before the timer fires would leave `interrupt === 1`; the first ESC of the next turn would then satisfy the `next >= 2` branch in `handleInterrupt` and abort immediately instead of arming the double-tap. OpenCode's prompt carries the same latent bug (see `opencode/src/cli/cmd/tui/component/prompt/index.tsx`); this is an intentional Inkstone divergence.

`actions.abort()` is the existing `AgentActions.abort` (`backend/agent/index.ts`) that forwards to pi-agent-core's `Agent.abort()`. pi-agent-core fires `message_end` with `stopReason === "aborted"`, which is already surfaced by `AgentProvider`'s reducer onto the assistant bubble's `error` field (`tui/context/agent.tsx`) and rendered via the shared error panel in `AssistantMessage` (`message.tsx`). No new event-handling is required.

### Collision safety

`ctrl+p` is both `command_list` (global) and one alternate of `select_up` (dialog-local). This is safe because:

- CommandProvider's dispatcher is suspended while any dialog is open (driven by `DialogProvider` via `setSuspendHandler` — see `ui/dialog.tsx` + `components/dialog/command.tsx`).
- DialogSelect calls `evt.preventDefault()` on nav matches, so even if handler order were reversed, the downstream CommandProvider would skip via its `defaultPrevented` check.

`escape` is both `session_interrupt` (global, streaming-only) and `dialog_close` (dialog-local). Dialog's `useKeyboard` in `ui/dialog.tsx` returns early when `store.stack.length === 0`, and calls `preventDefault` + `stopPropagation` when closing. CommandProvider's dispatcher is additionally suspended while any dialog is open, for the same reason as `ctrl+p` above. So: dialog open ⇒ ESC closes the dialog, no interrupt; dialog closed + streaming ⇒ ESC runs the interrupt handler; dialog closed + idle ⇒ `session_interrupt` isn't registered, ESC is a no-op.

Ctrl+C follows the same scope rule: inside a dialog it's caught by `ui/dialog.tsx`'s `dialog_close`; at the session view it's caught by `app.tsx`'s `app_exit` (gated to `dialog.stack.length === 0`).

### Session list panel (Ctrl+N)

A left-side panel mirroring the right-side metadata `Sidebar` pattern, toggled by `Ctrl+N`. When open it lists all past sessions across every agent (newest first); each row shows the title on line 1 and `<agent> · <relativeTime>` on line 2, with the agent token tinted via `theme[getAgentInfo(row.agent).colorKey]` so cross-agent scanning is visual. Selecting a row calls `actions.resumeSession(id)`, which:

1. Guards on `store.isStreaming` with a toast (blocks resume mid-turn — the user must press ESC first).
2. `loadSession(id)` from SQLite.
3. Inside a `batch()`, in this order: `agentSession.clearSession()` to wipe the live Agent's state; if `loaded.session.agent !== agentSession.agentName`, `agentSession.selectAgent(loaded.session.agent)` to rebind the live Session onto the stored session's agent; `agentSession.restoreMessages(loaded.agentMessages)` to seed the Agent with the persisted conversation; then store resets (`currentAgent`, `messages`, `totalTokens`, `totalCost`, `lastTurnStartedAt`). `totalTokens` and `totalCost` are seeded from `loaded.totals` rather than zeroed — `loadSession` sums per-turn `AssistantMessage.usage` across every real assistant row on disk, so the resumed session's sidebar reflects accumulated usage across app restarts. Synthesized alternation-repair placeholders have no `usage` and contribute 0; aborted turns with partial `usage` contribute their real tokens (paid for, not a leak).

Ordering matters for the swap path: `Session.selectAgent` throws when the live Agent's `messages.length > 0`, so `clearSession` must precede it; `restoreMessages` must follow so the seeded history isn't wiped by the clear. The in-batch `currentAgent` write drives prompt accent color, sidebar header, and `CommandProvider`'s agent-scoped registrations to re-derive against the resumed agent.

Cross-agent resume is intentional. The "one agent per session" invariant (D13 in `docs/AGENT-DESIGN.md`) governs a session's **in-memory** lifetime; a stored session's bubbles retain their original `agentName` stamps at write time. Resume constructs a fresh in-memory lifetime bound to the stored session's agent, so the invariant is preserved rather than broken.

### Session titles

`sessions.title` is non-null. `createSession({ agent })` initializes it to a human-readable default (`"New session - <ISO timestamp>"`) so every session has a stable label immediately; after the first user display bubble commits, `AgentProvider` starts a background title task and continues to `agentSession.actions.prompt(text)` without awaiting it. The generated title is persisted through `updateSessionTitle(tx, sessionId, title)` first, then mirrored into `store.sessionTitle` only if `currentSessionId` still points at the same row.

Title generation lives in `backend/agent/session-title.ts`: resolve `config.sessionTitleModel` first, provider-local `titleModelId` second, active chat model last; pass the raw LLM-facing prompt text (what pi-agent-core would see) capped at 4000 chars; call `completeSimple()` with `transport: "sse"` so Codex title calls do not touch the WebSocket cache/debug counters, `reasoning: "minimal"` to suppress thinking tokens on reasoning models, and a structured system prompt (task/rules/examples blocks ported from OpenCode's `title.txt`, trimmed to Inkstone's scope); clean output by stripping `<think>...</think>`, taking the first non-empty line, removing wrapping quotes, and capping to 50 chars. Failures are non-fatal; persistence failures use the same toast path as other session writers.

The right `Sidebar` renders `store.sessionTitle` only, with pre-session fallback `"inkstone"`. `resumeSession` hydrates from `loaded.session.title`; `/clear` resets to the pre-session title. The session list also renders the stored title only — preview is still computed by `listSessions()` for data/debug use, but row labels no longer fall back to first-message text.

`Session.restoreMessages(messages: AgentMessage[])` is the minimal accessor for the load path. Implementation: `agent.state.messages = messages`. The backend `agent` instance is private to `createSession`'s closure, so the TUI needs an explicit entry point; naming it `restoreMessages` (rather than `setMessages`) signals "load-only, don't reach for it mid-turn."

Token/cost counters are seeded from `loaded.totals` on resume: `loadSession` sums `AssistantMessage.usage` across the stored `agent_messages` rows and returns `{ tokens, cost }`, so a reopened session displays its accumulated totals rather than starting from zero. Computed over the pre-repair list — synthesized alternation-repair placeholders have no `usage` and contribute 0. `clearSession` still zeroes both (a new in-memory session is unambiguously fresh).

When the session panel is open, the right `Sidebar` is hidden regardless of width (single rule replacing an earlier two-threshold design). The panel itself refuses to open when `dimensions().width < 80` and surfaces a toast hint.

`panel_close: "escape,ctrl+n"` is a second keybind that aliases ESC and Ctrl+N so the panel treats open-key and dismiss-key symmetrically. `ctrl+n` is also a `select_down` alternate inside dialogs and the panel checks `panel_close` **before** `select_down` in its key handler, so reopening-key-as-close wins. The global `session_list` dispatcher in `CommandProvider` is suspended while any dialog is open, so `ctrl+n` inside an open dialog still means "move selection down" and can't accidentally open a second panel layer.

**Load-time alternation repair.** `loadSession` inspects `agent_messages` after loading and fills every `user`→`user` gap in the stream — both the trailing case (session killed mid-turn on the last turn — Ctrl+C / process crash between `message_start` and `message_end`) AND the interior case (the orphaned turn was followed by a successful later turn after resume, leaving two adjacent `user` rows with no assistant between them). Both shapes are repaired by synthesizing a closing `assistant` `AgentMessage` with `stopReason: "aborted"` and `errorMessage: "[Interrupted by user]"` in the right slot so `agent.state.messages` alternates cleanly. Without this, the next prompt on the resumed session would hand the provider consecutive user turns: Anthropic's Messages API silently merges into one turn, other provider APIs reject with a 400. The repair is read-only — stored rows are never mutated. Placeholder metadata (`api`/`provider`/`model`) is sourced from the latest prior assistant in the same session; if the session was interrupted on its very first turn, bland defaults are used (never reach a provider — they only satisfy the `AssistantMessage` type contract so pi-agent-core can round-trip through `convertToLlm`). The display layer stamps `interrupted: true` on user `DisplayMessage`s that lack a real assistant reply — both at runtime (the reducer's `agent_end` handler) and at load time (a post-pass in `loadSession`). The `[Interrupted by user]` marker in `message.tsx` reads `msg.interrupted` directly, with no render-time derivation.

The backend also catches the common case *prevention-side*: pi-agent-core's `handleRunFailure` synthesizes a closing assistant and emits **only** `agent_end` (no `message_end`) on abort/error paths, so the reducer's `agent_end` handler in `tui/context/agent.tsx` appends any such synthesized `AgentMessage` to `agent_messages` at runtime. Between the `agent_end` catch-up write (prevention) and the load-time repair (backstop), both Ctrl+C-between-events and pi-agent-core-abort paths round-trip cleanly. Research notes and alternatives considered (Claude Code sentinel pattern, OpenCode eager-write, pi-agent-core prevention-only) captured in the TODO entry.

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

## Persistence

See **`docs/SQL.md`** for the authoritative persistence design — schema,
lifecycle, transactional boundary, migration strategy, invariants, and
recipes. Summary below for cross-referencing from other sections.

SQLite at `~/.local/state/inkstone/inkstone.db`, accessed via Drizzle ORM on
`bun:sqlite`. Four tables: `sessions`, `messages`, `parts`, `agent_messages`.
Ids are UUIDv7 (globally unique + time-ordered). Visibility is global —
`listSessions()` returns rows across every agent, each carrying its own
`agent` column so the Ctrl+N panel can render a cross-agent list. Sessions
are created lazily on first user prompt; `/clear` drops the in-memory
session id so the next prompt creates a fresh row (past rows stay on disk
for a future `/resume`). Boot does not auto-resume — the openpage always
greets the user. `message_end` commits meta + parts + raw AgentMessage in
a single transaction via `runInTransaction`, so crashes can't leave
half-written state. Config + auth stay in JSON under `~/.config/inkstone/`.

**Persist-first ordering (store/DB drift invariant).** Reducer branches
that mutate **already-persisted state** write to SQLite first; the Solid
store updates only on tx success. Implemented via a `persistThen(writes,
onSuccess)` helper in `tui/context/agent.tsx` at 5 sites: `message_end`
(assistant commit), `tool_execution_end` (tool-state flip), `agent_end`
(pending-tool sweep + duration stamp), `wrappedActions.prompt` (user
bubble). On tx failure the error toast already fired by
`reportPersistenceError` — deduplicated via a `__inkstoneReported`
sentinel on the error object — is the only user-visible signal; the
store stays at its pre-mutation value so what's on screen matches what
`/resume` reconstructs. Pre-stream appends (new bubble / new shell /
tool-result persist / synthesized-abort persist — 6 call sites) use
`safeRun(() => runInTransaction(…))` instead; they have no already-
persisted state to regress from, and two of them (tool-result persist on
line 538; synthesized-abort persist on line 760) have explicit rationale
comments marking them "do not harden into persistThen" because their
failure modes are handled elsewhere (resume is out of scope for tool-
result persist; load-time alternation repair absorbs synthesized-abort
persist failures).

## Testing

Tests live in `test/` and run via `bun test` (wired through `bun run ci`).
The backend tests (`test/permissions.test.ts`,
`test/persistence-failure.test.ts`, `test/resume-repair.test.ts`,
`test/display-file-part.test.ts`, `test/mentions.test.ts`) exercise the
shared tool pool, reader permissions, persistence repair, the display
chip round-trip, and the pure mention-payload builder.

TUI tests live in `test/tui/` and mount the full provider stack through
OpenTUI Solid's `testRender`:

- `test/tui/harness.tsx` — `renderApp({ session, width?, height? })`
  mounts Theme → Toast → Dialog → Command → ErrorBoundary → AgentProvider
  → Layout (mirrors the real `App` tree so the no-provider fallback is
  exercised end-to-end when a test injects a throwing factory).
  `waitForFrame(needle)` polls `renderOnce + captureCharFrame` because
  markdown rendering goes through a tree-sitter worker and isn't
  synchronous after store mutation.
- `test/tui/fake-session.ts` — `makeFakeSession()` returns a factory
  matching `SessionFactory` (exported from `tui/context/agent.tsx`) plus
  an `emit(AgentEvent)` hook and a `calls` record for asserting on
  `actions.*` invocations. Event builders (`ev_agentStart`,
  `ev_messageStart`, `ev_textDelta`, `ev_toolcallEnd`, etc.) compose a
  scripted turn without a real pi-agent-core loop.

Injection seam: `AgentProvider` accepts an optional `session?:
SessionFactory` prop — default is the real `createSession` from
`@backend/agent`. Tests pass `fake.factory`; production passes nothing.
One prop, one file, no reducer extraction.

Assertions use `captureCharFrame()` substrings (not snapshots) so a
theme-color tweak doesn't cascade into a suite rewrite. Tests cover:
empty-state open page, conversation rendering (text / thinking /
redacted-thinking / tool pending→completed / tool error / assistant error
panel), streaming flow (tool-use turn boundaries, agent_end pending-tool
sweep, duration stamp), prompt submission + slash dispatch, ESC
double-tap interrupt, slash + mention autocomplete dropdowns, command
palette (Ctrl+P), and session list panel (Ctrl+N). `bunfig.toml` preloads
both `@opentui/solid/preload` (JSX runtime) and `./test/preload.ts`
(isolated XDG + vault).
