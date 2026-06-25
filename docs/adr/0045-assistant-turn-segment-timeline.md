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

### Amendment: the `proposal` segment carries `entity_id` (decided card names what changed)

The original [ADR-0044](./0044-decided-proposal-rehydration.md) amendment added
`entity_id` to the (since-superseded) `MessageProposalView` so the decided card could
name the created/updated entity and deep-link to the Library, surviving reload (this
closed the impeccable-critique "Applied." context-free hole). Since this ADR folds
`MessageProposalView` into the `proposal` Segment, that field re-lands here:

- **The `proposal` segment gains `entity_id: Option<String>`** — `{ kind:"proposal",
  proposal_id, mutation_kind, status, entity_id }`. Core resolves it at segment
  assembly (`segment_rows_for_run`) for the one rehydrated decided proposal, via the
  existing `entity_id_for_proposal` resolver. `None` for a `rejected` proposal
  (nothing created) or when no entity resolves; omitted (not null) on the wire to
  match the TS `S.optional`.
- **`entity_id_for_proposal` resolves the live decide anchor deterministically.** For
  a single-entity create/update it is the one row; for a multi-entity
  `apply_intent_graph` apply (whose mints share one `created_at`), it prefers the
  `journal_entry` row (the graph's anchor — see `intent_graph.rs`), then newest
  `created_at`, then `entity_id DESC` as a stable final tiebreaker — so the reloaded
  card names the SAME entity the live decide reported, and never flips between
  reloads. (This carries forward a deep-review finding from the pre-segment-timeline
  build of the feature.)
- **The web `proposals` map carries `entity_id`** onto the live `PendingProposal`
  (from the `proposal/decide` result) and the rehydrated one (from the segment), and
  the decided `DecidedLibraryLink` resolves it → `{kind,title}` from the warm
  `library-items` cache, degrading to the generic copy on a cache miss. The View-in-
  Library link is the "record + a way back" after commit; a true reversal verb stays
  deferred.

### Amendment: the reasoning segment (#202)

The union's reserved `reasoning` kind is now realized — the model's thinking renders as
a fourth segment kind, default-collapsed, so the user can inspect *why* before approving
a Proposal without the trace ever competing with the reply or the approval.

- **`Segment` gains `Reasoning { text, duration_ms: Option<i64> }`** — `{ kind:"reasoning",
  text, duration_ms? }`. `text` is the streamed thinking; `duration_ms` is how long the
  model thought (omitted, not null, when unknown). It rides transitively in the
  `thread_get_result.json` parity fixture, so the Rust serde mirror, the Effect schema, and
  the fixture move as one atomic slice — the gate reds otherwise.

- **Reasoning is a typed `message_parts` row on the EXISTING `message` step.** A new
  `message_parts.type='reasoning'` (the one widened CHECK) opened/appended/sealed by the
  same open-on-first-delta machine as text, sequenced by `run_steps.kind='message'` →
  `(message_id, part_seq)`. **No new `run_steps` kind**, no change to the three-branch
  exclusivity CHECK: reasoning is "a contiguous run of assistant content" exactly like text,
  so the sequencer already orders it by `seq`. `segment_timeline` selects `mp.type` and the
  read assembly switches the message branch on it (text vs reasoning). An empty/whitespace
  reasoning part emits no segment, mirroring the empty-text-part skip.

- **The run loop tracks two open part-slots.** pi gives NO delta-contiguity guarantee
  (a provider may interleave `text_delta, thinking_delta, text_delta` with no tool
  boundary), so `open_part` splits into `open_text_part` + `open_reasoning_part`: a delta
  opens/appends its own-type slot; a delta of the *other* type seals the prior slot first; a
  tool request / park seals **both**. Each `message_parts` row stays a contiguous run of one
  type.

- **The Worker maps pi's `thinking_delta` → `WorkerStdout::ReasoningDelta` → Core; Core
  republishes `RunEvent::ReasoningDelta`.** Start is derived from the first reasoning delta
  after a boundary (like text — no `thinking_start`/`_end` wire variants). `thinking_level=
  "off"` already omits pi's reasoning param and pi emits zero thinking events when off, so
  "off" yields no reasoning segment **by construction** — nothing to gate. Redacted/encrypted
  reasoning (Anthropic's `[Reasoning redacted]` placeholder) is **dropped at the Worker
  seam**: the real content is in a signature we don't persist (v1), so a collapsed "Thought"
  that expands to a placeholder string is noise.

- **Duration is Core-computed at read, never on the delta stream.** `segment_rows_for_run`
  derives `duration_ms` from the reasoning step's `created_at` to the next step's `created_at`
  (or `run.ended_at` when reasoning is the last step). Live, the Web Client clocks its own
  (open→seal); both round to whole seconds with the same `<1s → "Thought"` / `≥1s → "Thought
  for Ns"` rule, so the reloaded label matches the live one. No Worker timing, no new column.

- **Display-only: reasoning is NEVER replayed into the worker transcript (v1).** Replaying
  thinking *without its provider signature* is a live correctness hazard — Anthropic
  downgrades a signature-less thinking block to plain text, OpenAI Responses and DeepSeek
  return replay `400`s. Since v1 does not persist the signature, `read_run_timeline` /
  `run_timeline` **must exclude `type='reasoning'` parts** (a correctness-critical change:
  reasoning is now a `message` step, so without the exclusion it would silently replay as
  assistant text). The model re-derives reasoning fresh on a resumed turn; nothing
  user-visible is lost (the prior turn's reasoning still renders from the read path). The
  signature column + same-model signed round-trip (and cross-model drop-to-text per pi's
  `transform-messages` rule) are **deferred to #201**.

- **The Web Client renders it default-collapsed and stays collapsed while streaming.** A
  muted disclosure (live "Thinking…" → done "Thought for Ns"), one click to expand, visually
  subordinate to the reply. This deliberately diverges from the stream-then-collapse default
  (AI SDK Elements / ChatGPT / Claude.ai): auto-expanding mid-stream reflows the layout and
  pushes the approval down at the decision moment — the opposite of a calm, approval-sacred
  surface. `concatText` stays text-only **by construction** (reasoning is a new kind it does
  not match), so the trace never leaks into the copy button, ⌘K search, or typing indicator;
  the existing `type='text'` filter on the subscribe-snapshot / `read_thread` SQL excludes it
  for free. The expand transition gates behind `motion-safe:` (the repo's reduced-motion
  convention — instant toggle by default).

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
- #202 (reasoning as a fourth segment kind) — **realized** in the reasoning-segment
  amendment above. Deferred: #201 (resume transcript text-interleaving fidelity, and the
  reasoning-signature round-trip the amendment's display-only posture leaves open).
