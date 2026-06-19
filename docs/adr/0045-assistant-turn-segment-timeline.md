# Assistant turn is an ordered segment timeline, sequenced by `run_steps`

A `thread/get` assistant Message carries an **ordered `segments[]` timeline** —
`text | tool_call | proposal` items in chronological order — instead of the three
independent buckets (`text`, `tool_calls`, `proposal`) it carried before. Order is
captured at write time in `run_steps` (the sole sequencer) and replayed verbatim on
read. This **supersedes the read-path shapes** of [ADR-0043](./0043-tool-activity-rehydration.md)
(separate `tool_calls`) and [ADR-0044](./0044-decided-proposal-rehydration.md)
(separate `proposal`): both fold into `segments`.

## Context

A Run is N Turns (CONTEXT.md): one user prompt can drive `search → propose(park) →
resume-reply`. The UI must render that turn's pieces in the order they happened —
tool-activity row, then the decided Proposal card, then the reply text.

It did not. Two compounding defects:

- **Render order was faked by JSX.** `AssistantBubble` laid out `{tool_calls}{text}{proposal}`
  in fixed source order (`apps/web/src/components/ChatColumn.tsx`), because the wire
  `MessageView` exposed three buckets with no cross-bucket sequence. The decided
  "Applied." card therefore rendered *below* the reply text, though the Proposal was
  created *before* the reply.
- **The write path destroyed the order.** Every assistant `text_delta` across *all*
  Turns of a Run was UPSERTed into one `message_parts(seq=0)` blob
  (`append_assistant_text`), and the assistant `run_steps` entry was stamped at
  `seq=1` at Run *start* — before any content. So even the durable timeline put the
  whole reply *ahead* of the tool calls it followed. Core observed the text/tool
  interleaving at the `TextDelta` vs `ToolRequest` seam in the run loop and discarded
  it.

[ADR-0017](./0017-tier-2-schema-slice-1.md) already specified the fix in the schema
("tool calls are not parts of the assistant message — display interleaves messages
and tool_calls via `run_steps`") and reserved `message_parts` for "inline display
markers in seq order." The write path never honored it; this ADR does.

## Decision

- **One assistant Message per Run, with an ordered `segments[]`.** The Message stays
  the per-Run container (not one row per Turn — that would ripple "what is a message"
  through resume, snapshots, and the live `assistant_message_id` every `text_delta`
  targets). It gains an ordered segment list; each segment is one of:
  - `text` — a contiguous run of assistant text,
  - `tool_call` — `{ name, status, arg? }` (the ADR-0043 shape),
  - `proposal` — `{ proposal_id, mutation_kind, status }` (the ADR-0044 shape).
  The union is left **open** for a future `reasoning` kind (#202) without reshaping.

- **`run_steps` is the sole sequencer.** Text segments become first-class
  `run_steps` rows (a `run_steps` row now resolves to a specific `message_parts`
  row, not just a `message_id`), interleaved with `tool_call` rows by the one
  per-Run `seq`. The proposal needs no new positioning: `park_on_proposal` already
  writes the Proposal as a `tool_call` `run_steps` row, so walking `run_steps` in
  `seq` order places it for free. The standalone `decided_at`-DESC fetch
  (`decided_proposal_for_run`) is **removed** — the proposal's position and its
  decided status are joined onto its existing step.

- **Open-on-first-delta.** Run-start inserts the assistant `messages` row only — no
  eager empty `seq=0` part, no `seq=1` message step. The first `text_delta` after
  start / a tool / a park / a resume opens a *new* `message_parts` row plus its
  `run_steps` entry at the **live** seq; subsequent deltas UPSERT into that open
  part (the [ADR-0022](./0022-run-event-delivery-hub-snapshot-tail.md) exactly-once
  gate is unchanged — only *which* part is "open" advances). A `tool_request` / park
  **seals** the open part; the next delta opens a fresh one. This deletes the
  empty-`seq=0` artifact that resume reconstruction used to skip.

- **`segments[]` replaces the three buckets on the wire.** `MessageView` becomes
  `{ id, role, status, run_id, segments[] }`. The non-render consumers that read the
  flat reply text — the copy button, the ⌘K search-match, the streaming
  typing-indicator — derive it through one `concatText(segments)` helper. There is no
  denormalized `text` field alongside `segments`: a single source of truth, no
  dual-write consistency hazard.

- **Live builds the same shape.** The Web Client's live store builds `segments[]`
  incrementally from the already-ordered Run Event stream (`text_delta` opens/extends
  the open text segment; `tool_call` appends a tool segment; `proposal_pending`
  appends a proposal segment) — so the live render and the reloaded render are byte-
  for-byte the same component path. `RunEvent::TextDelta` needs **no** position field:
  the segment boundary is inferable from the interleaved `tool_call` / `proposal_pending`
  events. The `proposals` map **stays** — it holds the interactive draft payload /
  edit state that does not belong on the wire; the `proposal` segment carries only
  `proposal_id` + `status` and looks the live payload up by id.

- **The decided "Applied." pill matches the tool-call row.** Now that the decided
  Proposal sits inline in the timeline next to tool rows, it adopts the `ToolCallRow`
  pill chrome (`inline-flex w-fit rounded-lg px-2.5 py-1.5 text-sm font-medium
  text-muted-foreground` + a `Check` glyph) rather than the bordered `Card`.

## Consequences

- The screenshot scenario (`search → propose → accept → reply`) renders as
  search-row → "Applied." pill → reply text, **both live and across reload** — order
  is the stored order, not a JSX accident.
- `MessageView` is in the contract-parity gate (`ThreadGetResult` ∈ `CANONICAL_MESSAGES`,
  PR #198): the reshape is a **single atomic slice** — Rust struct + Effect schema +
  emitted fixture move together or the gate reds. (This corrects ADR-0044's
  "MessageView stays outside the parity gate" note, true when 0044 shipped, made
  stale by PR #198.)
- Resume stays correct under multi-segment `run_steps`: reconstruction reads per-part
  text in `seq` order, and the parked-Run transcript stays provider-valid. Whether the
  worker-facing transcript preserves fine text-interleaving or concatenates text per
  turn is a **fidelity** question deferred to #201 — both are provider-valid and
  invisible to the UI.
- Pre-release, the schema migration is edited **in place** (CLAUDE.md §5); no patch
  migration, local dev DBs are recreated.

## Considered and rejected

- **Message-per-Turn** (Anthropic/OpenAI transcript shape: each LLM call its own row).
  Matches the Turn definition most literally, but detonates "one assistant row per Run"
  across resume (`assistant_message_id_for_run`), snapshot reconstruction, the live
  `text_delta` target, and `MessageView`'s 1:1-with-turn assumption — all for the same
  on-screen result. Rejected: same pixels, far wider blast radius.
- **A parallel ordering key on `message_parts`, merge-sorted at read.** Invents a
  second ordering authority beside the `run_steps` seq that already correctly sequences
  tool calls and the proposal — two things to keep consistent forever. Rejected:
  `run_steps` is *the* timeline by design (ADR-0017).
- **Keep a denormalized `text` field beside `segments`.** Less web churn, but Core
  would populate `text` *and* `segments` redundantly — the exact dual-source-of-truth
  hazard the single-source field-schema work removed elsewhere. Rejected for one
  `concatText(segments)` helper instead.
- **Reuse the proposal's `tool_call` segment** (stop filtering it out, render a card
  off the tool name). Couples the Web render to a tool-name string and still needs the
  decided status joined separately. Rejected for an explicit `proposal` segment kind,
  honoring ADR-0044's "a Proposal is not a tool-activity row" intent.

## Related

- [ADR-0017](./0017-tier-2-schema-slice-1.md) — specified `run_steps` interleaving and
  reserved `message_parts` for inline ordered markers; this ADR honors it in the write
  path.
- [ADR-0043](./0043-tool-activity-rehydration.md) / [ADR-0044](./0044-decided-proposal-rehydration.md)
  — the separate-field read-path shapes this ADR supersedes by folding both into
  `segments`. The persistence both rely on is unchanged; only the wire projection and
  the read assembly change.
- [ADR-0022](./0022-run-event-delivery-hub-snapshot-tail.md) — the exactly-once
  `text_delta` gate, preserved: open-on-first-delta advances which part is open without
  changing the per-delta critical section.
- [ADR-0025](./0025-proposal-park-and-resume.md) — park writes the Proposal as a
  `tool_call` `run_steps` row, which is what gives the `proposal` segment its position
  for free; resume reconstruction now reads per-part text.
- Deferred: #201 (resume transcript text-interleaving fidelity), #202 (reasoning as a
  fourth segment kind).
