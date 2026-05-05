# Approval UI

Inkstone's `confirmDirs` permission flow renders as a bottom panel (`PermissionPrompt`) that replaces the `Prompt` cell while the agent awaits approval, with an inline diff preview rendered in the conversation scrollbox above it. Port of OpenCode's `PermissionPrompt` from `opencode/.../routes/session/permission.tsx`, trimmed to Inkstone's scope.

Files involved:
- `src/tui/context/agent/preview-registry.ts` — per-`callId` diff state (pending / archive / expanded).
- `src/tui/context/agent/provider.tsx` — injected `confirmFn` closure + `pendingApproval` signal + unmount resolver.
- `src/tui/context/agent/actions.ts` — wrapped `abort` + `clearSession` that resolve pending approvals before propagating.
- `src/tui/context/agent/reducer.ts` — `stampTurnClosingBubble` helper at `agent_end`.
- `src/tui/context/agent/types.ts` — `PendingApproval` payload + `previews` / `pendingApproval` / `respondApproval` on the agent context.
- `src/tui/components/permission-prompt.tsx` — the panel component.
- `src/tui/components/message.tsx` — `ToolPart` with chevron + inline diff rendering.
- `src/backend/agent/permissions.ts` — `ConfirmRequest` payload and backend-side unified-diff production.

## How it works

An agent tool call hits the `confirmDirs` permission rule. The backend dispatcher (`permissions.ts`) computes a unified-diff preview (for `write` and `edit` tools only, best-effort literal apply) and calls the injected `confirmFn` with a structured `ConfirmRequest`:

```ts
{ callId, title, message, preview?: { filepath, oldText, newText, unifiedDiff } }
```

The TUI provider (`provider.tsx`) closes over the closure, writes the preview into the registry keyed by `callId` (so `ToolPart` can render it alongside the tool call above), and sets a scoped `pendingApproval` signal carrying the resolver for pi-agent-core's awaiting Promise. The layout (`app.tsx`) reads the signal and swaps the `Prompt` cell for `PermissionPrompt`. The panel owns its own `useKeyboard`; the conversation scrollbox stays interactive (scroll keybinds don't suspend). Esc / Enter / arrows drive `respondApproval(ok)` which clears the signal and resolves the backend's Promise.

On resolve the preview stays in the archive (so the user can re-expand via chevron) until session boundaries (`clearSession` / `resumeSession` / provider unmount) wipe it. Aborting the session or running `/clear` while pending resolves the Promise to `false` first so pi-agent-core's `await confirmFn(...)` unwinds cleanly.

## State shapes

### Preview registry — three cells, single-read API

`createPreviewRegistry()` holds three independent `createSignal`s:

- **`pending`** — diffs actively awaiting approval. Set by the `confirmFn` closure; cleared when the approval resolves. Auto-expands in the renderer.
- **`archive`** — diffs retained after resolve so the user can re-expand via the chevron on the tool part. Populated alongside `pending` on `set`; never cleared on per-call resolve.
- **`expanded`** — user-toggled set of call ids. When a call id is in `expanded`, its archived diff renders even though the approval has resolved.

Single read for the renderer:

```ts
state(callId): { diff: PendingPreview | undefined; showChevron: boolean }
```

`diff` is the preview body to render (pending auto-expand OR user-toggled archive). `showChevron` is `true` whenever the archive has an entry. The two flags are independent: a completed tool call with an archived diff but no user toggle is `{ diff: undefined, showChevron: true }` — the collapsed-but-re-expandable state.

Reactivity: three separate signals so a mutation only re-triggers subscribers of the cell it actually changed. Copy-on-write per mutation (Solid signals identity-compare), so `set` / `toggle` / `clear` allocate a fresh Map or Set for the cells they touch. Inlining Map / Set mutations without the copy would not trigger Solid subscribers — the whole point of the wrapping.

Event ordering: pi-agent-core emits `toolcall_end` as an assistant stream event *before* `beforeToolCall` fires (the hook runs after argument validation during execution preflight). The reducer pushes the pending `tool` DisplayPart first; `ToolPart` mounts with `state(callId).diff === undefined`; then `confirmFn` writes the preview and the reactive `state()` read triggers a re-render that slots the `<diff>` in. The `callId` key is what makes the event order irrelevant — a swap to `confirmFn`-first would keep working without changes.

### `pendingApproval` signal

Standalone `createSignal<{ request: PendingApproval; resolve: (ok) => void } | null>(null)`, **not** a store field. This honors the view-model tripwire in `@bridge/view-model` (`AgentStoreState.isStreaming` docstring): don't gate approval UI on `!isStreaming` — that deadlocks because the turn is waiting on approval but the approval UI would be disabled because the turn is in flight. A per-action pending signal scoped to the provider closure is the correct primitive.

A direct ref (`inFlightResolver`) mirrors the signal for the `onCleanup` unmount path — reading signals during Solid owner disposal is fragile, and the direct ref lets the unmount resolver unwind without re-entering the signal system.

### `ConfirmRequest` payload (backend → TUI closure)

Produced by `dispatchBeforeToolCall` in `src/backend/agent/permissions.ts`. `callId` is pi-agent-core's `toolCall.id` — same id the reducer sees on `toolcall_end` / `tool_execution_end`. The TUI keys its preview registry by it.

`preview` is best-effort for `write` (uses `args.content` verbatim) and `edit` (literal-match apply of `edits[]`, rejects non-unique matches to mirror pi-coding-agent's own ambiguity rejection). Non-matching or ambiguous edits → preview omitted, approval panel still fires without a diff. Unified diff comes from the `diff` package's `createTwoFilesPatch`.

## Rendering

### `PermissionPrompt` (the panel)

Three-piece chrome ported from `Prompt` — outer `┃` bar + padded inner box filled with `theme.backgroundElement`, then a `╹`-cornered cap row with a `▀` fill, then the hints row. Color is `theme.warning`, pairing with the `△` affordance. The shared bubble chrome is what makes the panel read as "the same cell as Prompt, but warning-tinted" rather than floating disconnected.

Panel-local keyboard via `useKeyboard`:

- `← / h` and `→ / l` cycle between Allow and Reject.
- `Enter` commits the selected option via `respondApproval(store.active === "approve")`.
- `Esc` rejects unconditionally.

Conversation scroll keybinds stay live — the panel doesn't suspend the global dispatcher, so users can page the inline diff while the panel is on screen. A null-guard on `req()` inside the keyboard handler defends against the one-frame window between `setPendingApproval(null)` and `<Show>` unmounting the subtree.

Divergences from OpenCode's panel:

- **No "Allow always".** Tracked as Future Work; requires a policy-write path into the zone config.
- **No diff inside the panel.** `ToolPart` renders the diff in the conversation scrollbox above. OpenCode renders it inside the panel; we don't need to because the conversation already has it.
- **No `ctrl+f` fullscreen toggle.** Not useful for Inkstone — the diff lives in the always-scrollable conversation.

### `ToolPart` — chevron + inline diff

`ToolPart` reads `previews.state(props.callId)` once per render. The header row (icon + tool name + args summary) gains a `▸` / `▾` chevron prefix when `state().showChevron` is true. The whole header row is the mouse click target (via `onMouseUp` on the outer `<box>`) — not just the 1-cell glyph — so users don't have to aim at a single cell in the terminal. Click fires `previews.toggle(callId)`. When `showChevron` is false, the handler is `undefined` so non-toggleable rows don't absorb mouse events.

State-to-glyph mapping:

| Tool state | Archive | Expanded | Glyph rendered |
|---|---|---|---|
| `pending` | n/a (always current) | (auto) | `~` tool args + diff body |
| `completed` | yes | yes | `▾ ⚙ tool args` + diff body |
| `completed` | yes | no | `▸ ⚙ tool args` (no diff body) |
| `completed` | no | — | `⚙ tool args` (no chevron) |
| `error` | either | either | `⚙ tool args` in `theme.error` + error line below |

Diff body uses OpenTUI's `<diff>` renderable with the `diff*` theme tokens (phase-1 theme foundation).

### `stampTurnClosingBubble` — footer on the turn-closing bubble only

`AssistantFooter` gates its `▣ Reader · <model> · <duration>` footer on `modelName || interrupted`. Per-turn stamps (`agentName`, `modelName`, `duration`, `thinkingLevel`) land in `stampTurnClosingBubble` at `agent_end` time on `messages[length - 1]`. That index is always the turn-closing bubble because pi-agent-core fires `agent_end` immediately after the turn-closing assistant `message_end`, and tool results don't render as display bubbles.

Intermediate assistant bubbles (`stopReason: "toolUse"`) get their per-message meta (`error`, `interrupted`, usage / cost accumulators) stamped on `message_end` via `stampAssistantBubbleMeta`, but **not** the per-turn fields — so `AssistantFooter` hides for them.

Interrupted turns keep `agentName` + `modelName` so the bubble reads `▣ Reader · <model> · interrupted` rather than a bare `▣ Reader · interrupted`. `duration` + `thinkingLevel` are suppressed on interrupt — the reply didn't complete, so "what effort produced this turn" has no meaningful answer.

Historical sessions persisted before this split retain `modelName` on every intermediate bubble, so resumed sessions still render intermediate footers. No back-fill migration. Mirrors OpenCode's `MessageFooter` placement.

### Abort / clear ordering

Wrapped `actions.abort()` and `clearSessionAction` both check `pendingApproval()` and call `respondApproval(false)` **before** propagating to the backend. The ordering is load-bearing: pi-agent-core's run loop is parked on `await confirmFn(...)` inside `beforeToolCall`, and AbortController can't interrupt a Promise the loop isn't listening on. The resolver is the only primitive that wakes it. Resolve first → `beforeToolCall` returns `false` → pi-agent-core unwinds → the subsequent `abort()` then marks the run cancelled.

Provider `onCleanup` resolves any in-flight pending approval to `false` via `queueMicrotask` — direct resolution during Solid owner disposal tripped a Bun 1.3.4 segfault in OpenTUI's teardown path.

## Known limitations

- **Abort-unmount test gap.** The provider's `onCleanup` resolves any in-flight `confirmFn` to `false` (verified by code inspection + abort/clearSession test coverage). Direct end-to-end coverage via `renderer.destroy()` while pending triggers a Bun 1.3.4 segfault in OpenTUI's teardown path when a Promise-holding owner is disposed. Revisit when Bun / OpenTUI ship a fix.
- **`DialogConfirm` still used by provider-disconnect.** The `confirm-and-disconnect` flow in `src/tui/components/dialog/provider/` uses the old modal. Unifying onto `PermissionPrompt` is deferred.
- **"Allow always" not implemented.** OpenCode has a third option that persists a pattern into policy. Requires a policy-write path into zone config; deferred.
- **Resumed sessions have no diff archive.** Tool parts loaded from SQLite don't carry diffs (never persisted), so the chevron doesn't render for historical tool calls. Acceptable — the archive is a live-session overlay.
