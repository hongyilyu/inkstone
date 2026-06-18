# Tool-Activity Preservation Plan

## Goal

Tool-call activity shown live during an assistant turn must **survive a reload**.
Today the `ToolActivity` rows appear while a Run streams and then vanish when the
thread is re-hydrated — the durable data exists, but no client-facing read
exposes it.

Success criterion: an e2e that runs searches, **reloads the page**, and asserts
the grouped tool-activity rows survive with their search targets.

## Root cause

This is a **read-path + render gap**, not a persistence gap.

- Tool calls are already fully persisted in `tool_calls` (`name`,
  `request_payload`, `status`, `requested_at`/`resolved_at`), interleaved
  chronologically via `run_steps`, keyed by `run_id`
  (`crates/core/migrations/0001_initial.sql:55-84`).
- Live UI rows are built from the **ephemeral** `RunEvent::ToolCall`
  (`{ tool_call_id, name, status }`) in the store reducer
  (`apps/web/src/store/chat.ts` `applyEvent` `tool_call` branch) and rendered by
  `apps/web/src/components/ToolActivity.tsx`.
- Re-hydration goes through `thread/get` → `MessageView`
  (`{ id, role, status, run_id, text }`) which has **no tool-call field**
  (`crates/core/src/runs/thread_get.rs`, `apps/web/src/store/hydrate.ts`
  `toMessage`). So the rows are dropped on reload.

No migration, no new writes.

## Agreed behavior

- **Every tool call becomes a row.** Humanized name + status. Tools with a
  meaningful argument also show `· arg`:
  - `search_entities` → `query`
  - `load_skill` → `name`
  - `read_thread` → argless (label only)
- **Grouping — all tools, by name.** Repeated calls to one tool in a turn
  collapse into a single row, args joined. Overflow cap: first 3 args + `+N`.
  Per-arg truncation at the row edge.
- **Live aggregate state.** One row that grows as calls start. `Searching…`
  (spinner) while *any* call is in flight; flips to `Searched ✓` once all settle.

  ```text
  t1:  🔍 Searching entities · Lev            ⟳
  t2:  🔍 Searching entities · Lev, Lead Ads  ⟳
  t3:  🔍 Searched entities  · Lev, Lead Ads  ✓
  ```

- **Errors break out.** Any errored call becomes its own dedicated row showing
  the failed arg; the surviving calls still group.

  ```text
  🔍 Searched entities · Lev, Acme   ✓
  🔍 Searched entities · Lead Ads    ⚠ failed
  ```

- **Live ≡ reloaded.** One shared grouping function feeds both paths, so the
  reloaded view reconstructs the exact row the live stream ended on.
- **Proposal tool calls are excluded.** `propose_workspace_mutation` parks the
  Run and renders as a `ProposalCard`; it emits no live tool row today, so
  excluding it on the read path keeps live ≡ reload.

## Decisions fixed by the codebase (not asked)

- **Web owns presentation.** It already has `humanize`, `TOOL_PRESENTATION`, and
  active/done tense in `ToolActivity.tsx`. Core ships data; web decides looks.
- **Core extracts the display arg** (per-tool, colocated with each typed
  `Input`). Rationale: the repo has a Rust↔TS schema-parity gate; if web parsed
  raw `request_payload` instead, a Rust field rename would silently drop the arg
  with no compiler catch. Core extraction is rename-safe and keeps the
  data/presentation split clean.
- **Row order = first occurrence**, matching `run_steps.seq`.
- **One Run = one assistant Message** (`SELECT id FROM messages WHERE
  run_id=? AND role='assistant'`), so tool calls attach to a Message by
  `run_id` — the same wiring `AssistantProposals` already uses.

## Implementation

### Rust core

1. `tools/search_entities.rs`, `tools/load_skill.rs`: add
   `display_arg(params) -> Option<String>` next to each `Input`
   (search → `query`, load_skill → `name`).
2. `tools/mod.rs`: add a `display_arg` fn-pointer to `ToolEntry` and a
   `tools::display_arg(name, &params)` dispatcher.
3. `protocol.rs`:
   - `RunEvent::ToolCall` gains `arg: Option<String>`.
   - `MessageView` gains `tool_calls: Vec<ToolCallView>`, where
     `ToolCallView { name: String, status: ToolCallStatus, arg: Option<String> }`.
   - Update the round-trip / encode tests.
4. `worker/run.rs`: compute `arg` once via the dispatcher; include it in the
   `Started` and terminal `ToolCall` events.
5. `db` + `runs/thread_get.rs`: read each assistant Run's `tool_calls` ordered by
   `run_steps.seq`; **skip proposal-kind**; run `display_arg` on the stored
   `request_payload`; attach as `ToolCallView`s. Map persisted
   `pending|completed|errored` → wire `running|completed|error`.

### TS protocol (`packages/protocol/src/index.ts`)

1. Mirror `RunEvent.arg` and `MessageView.tool_calls` / `ToolCallView`.
   Update paired parity / round-trip tests. Confirm whether the bridges fixture
   gate covers `MessageView`/`RunEvent`; regen fixtures if so.

### Web

1. `store/chat.ts`: `ToolCall` gains `arg?: string`; live reducer sets it from
   the event.
2. `store/hydrate.ts`: `toMessage` populates `toolCalls` from `view.tool_calls`
   (the one-line fix for the actual reload bug).
3. `components/ToolActivity.tsx`:
   - Add `TOOL_PRESENTATION` entries + active/done tense for `search_entities`
     and `load_skill`.
   - Add `groupToolCalls(calls)`: errored calls → their own rows; non-errored →
     per-name groups (dedupe identical args, aggregate status running-if-any,
     join + cap at 3 with `+N`, per-arg truncation). Render groups in
     first-occurrence order.

## Tests

- **Rust:** `thread/get` returns grouped-ready tool calls with proposal kinds
  excluded; `RunEvent` / `MessageView` round-trip with `arg` / `tool_calls`.
- **TS:** protocol parity for the new fields.
- **Web unit:** `groupToolCalls` — single, multi-group, overflow `+N`, mixed
  running → aggregate spinner, error breakout, argless tool.
- **E2E (regression guard):** run searches → **reload** → assert grouped rows +
  args survive.

## Gate

`pnpm format` (changed files only) · `pnpm lint` · `pnpm check` ·
`pnpm -r test` · `cargo test -p` core.
