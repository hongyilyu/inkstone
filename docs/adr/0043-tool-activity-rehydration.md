# Tool-call activity rehydrates via `thread/get`, not a coarse-event replay

> **Superseded in part by [ADR-0045](./0045-assistant-turn-segment-timeline.md).** The persistence and the read are unchanged, but the *wire projection* moved: `MessageView.tool_calls` is folded into the ordered `MessageView.segments[]` timeline (a `tool_call` segment), so tool activity now rehydrates in chronological order interleaved with text and the decided Proposal, rather than as a separate bucket.

Tool-call activity rows that surface live inside an assistant turn (the
`tool_call` Run Event, ADR-0006) are made durable across a reload by folding the
persisted tool calls into the existing `thread/get` rehydration read, as a new
`MessageView.tool_calls` field. This **supersedes the deferred `run/get_history`
+ `since_run_seq` coarse-event-replay sketch** in [ADR-0022](./0022-run-event-delivery-hub-snapshot-tail.md)
for the tool-boundary case.

## Context

Tool calls are already fully persisted: every non-Proposal Tool Request writes a
`tool_calls` row (`name`, `request_payload`, `status`, `result_payload`, timings)
plus a `run_steps` interleave row, keyed by `run_id` (ADR-0017 schema). But the
only path that ever showed them to a Client was the **ephemeral** `tool_call`
Run Event (ADR-0006): `{ tool_call_id, name, status }`, synthesized live by the
Worker run loop, never replayed. The store builds `Message.toolCalls` from that
live stream alone.

So a row that appeared while a Run streamed **vanished on reload**: rehydration
runs through `thread/get` → `MessageView` (`{ id, role, status, run_id, text }`),
which carries no tool-call field, and `hydrate.toMessage` leaves `toolCalls`
empty. The durable data existed in tier 2; no client-facing read exposed it.

ADR-0022 foresaw exactly this. Its consequences deferred durable coarse-event
replay until "a consumer needs sub-Turn coarse-event replay (e.g. **surfacing
tool boundaries across a reconnect**), add `run/get_history` then." This feature
is that consumer — but the mechanism ADR-0022 sketched (`run/get_history(run_id,
since_run_seq)` + a cursor + client-side interleave) is heavier than the need.

## Decision

- **`MessageView` gains `tool_calls: Vec<ToolCallView>`.** A `ToolCallView` is
  `{ name: String, status: ToolCallStatus, arg: Option<String> }` — the same
  three fields the live row renders, no payloads. `thread/get` already assembles
  each Message; it now also reads that Message's Run's `tool_calls` (ordered by
  `run_steps.seq`) and attaches them.
- **Proposal tool calls are excluded** from `tool_calls`. `propose_workspace_mutation`
  parks the Run and renders as a `ProposalCard` (ADR-0025); it never emits a live
  tool row, so excluding it on the read path keeps the reloaded view identical to
  the live one.
- **The live `RunEvent::ToolCall` gains `arg: Option<String>`** so the live row
  and the reloaded row show the same target (e.g. `· Lev`). Both paths source the
  arg from one Core-side per-tool extractor (`display_arg`), colocated with each
  tool's typed `Input` — rename-safe under the Rust compiler, and consistent with
  the existing data/presentation split (Core ships data, the Web Client decides
  presentation).
- **Only settled tool calls rehydrate.** The read excludes `pending` rows
  (`AND tc.status <> 'pending'`) and maps the surviving persisted status to the
  wire spelling (`completed` → `completed`, `errored` → `error`). A `pending`
  call is either in flight (owned by the live resubscribe tail, which delivers
  its terminal boundary) or orphaned by an interrupted Run; rehydrating it would
  render a false-settled row, since the wire status vocabulary has no in-progress
  member. So rehydration is the *settled-history* reader; the live stream owns
  in-flight rows.
- **`run/get_history` and `since_run_seq` stay unbuilt.** We need full
  rehydration on focus (the same read that already restores text and proposals),
  not incremental cursor replay. The one-round-trip `thread/get` extension is the
  strict subset that serves the observable behavior; the cursor machinery remains
  deferred exactly as ADR-0022 left it.

## Consequences

- One read path restores text, proposals, **and** tool activity — no second
  round-trip, no client-side merge of two reads.
- `MessageView` / `RunEvent` stay outside the schema-fixture parity gate (which
  covers only the proposable mutation kinds); their Rust↔TS parity is held by the
  existing paired hand-written round-trip tests, which this ADR's slices extend.
- Tool **inputs/outputs/timing** remain unexposed. The `ToolCallView` deliberately
  carries only `{ name, status, arg }`; a richer inspector view (full
  `request_payload` / `result_payload`) is a separate future feature with its own
  read shape, not blocked by this decision.
- Grouping (repeated calls collapse to one row; errored calls break out) is a
  pure Web Client render concern over the `toolCalls` array — no wire or storage
  change. Live and reloaded use one shared grouping function, so they render
  identically.

## Considered and rejected

- **`run/get_history(run_id, since_run_seq)` coarse-event replay** (ADR-0022's
  literal sketch). Decoupled from thread rehydration and supports incremental
  cursor replay — but it is machinery no consumer needs yet (the very reason
  ADR-0022 deferred it) and adds a second read plus a client-side interleave
  step. Rejected for this feature; if true incremental replay is ever needed,
  this ADR does not preclude adding it then.
- **Parse `request_payload` on the Web Client** to extract the arg. Keeps all
  presentation in one file, but couples the Client to Rust param field names — a
  rename would silently drop the arg with no compiler catch. Rejected in favor of
  Core-side `display_arg`.

## Related

- [ADR-0006](./0006-run-events-vs-tool-protocol.md) — the live `tool_call` Run
  Event whose data this ADR makes durable; the ephemeral channel is unchanged.
- [ADR-0022](./0022-run-event-delivery-hub-snapshot-tail.md) — deferred
  tool-boundary replay and named this feature as its trigger; this ADR supersedes
  its `run/get_history` sketch for the tool-boundary case.
- [ADR-0017](./0017-tier-2-schema-slice-1.md) — the `tool_calls` / `run_steps`
  schema this read consumes.
- [ADR-0025](./0025-proposal-park-and-resume.md) — Proposal tool calls park and
  render as a `ProposalCard`; this ADR excludes them from `tool_calls`.
