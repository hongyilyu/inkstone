# Decided Proposal outcomes rehydrate via `thread/get`, like tool activity

> **Superseded in part by [ADR-0045](./0045-assistant-turn-segment-timeline.md).** The decided-outcome read is unchanged, but the *wire projection* moved: `MessageView.proposal` is folded into the ordered `MessageView.segments[]` timeline (a `proposal` segment positioned by its `run_steps` seq), so the decided card rehydrates at its true chronological slot rather than as a separate field. The decided-vs-pending rule below still holds.

A Proposal's settled outcome (the decided `ProposalCard` — e.g. the "Applied."
indicator) is made durable across a reload by folding it into the existing
`thread/get` rehydration read, as a new optional `MessageView.proposal` field.
This applies the **same read-path precedent as [ADR-0043](./0043-tool-activity-rehydration.md)**
(tool-call activity), for the decided-Proposal case.

## Context

A Proposal decision is already fully persisted: accepting/rejecting flips the
`proposals` row to `accepted`/`rejected`, stamps `decided_at`/`applied_at`, and
appends a `proposal_decided` Run Log milestone (ADR-0025, ADR-0028). But the only
path that ever showed the *decided card* to a Client was **live, in-memory** Web
Client state: the `chat` store's `proposals` map, keyed by `run_id`, populated by
the live `proposal/pending` notification and mutated by the live decide flow.

So the decided indicator **vanished on reload**. Rehydration runs through
`thread/get` → `MessageView`, which carried no proposal field; the `proposals`
map is plain in-memory zustand (no persistence). On a cold load the map starts
empty, `AssistantProposals` finds nothing for the run, and renders `null` — the
"Applied." box the user saw moments earlier is gone, even though the decision is
durably stored. This is exactly the gap ADR-0043 closed for tool-call activity,
which deliberately *excluded* Proposal tool calls ("they render as a
`ProposalCard`") and left the Proposal-outcome case to a sibling read.

## Decision

- **`MessageView` gains `proposal: Option<MessageProposalView>`.** A
  `MessageProposalView` is `{ proposal_id, mutation_kind, status }` — the minimum
  the decided card reads: `mutation_kind` drives the copy ("Applied." vs "Added
  Todo.") and the routing (`apply_intent_graph` vs single-entity), `status` the
  accepted-vs-rejected branch, `proposal_id` the card's stable identity. `thread/get`
  already assembles each Message; it now also reads that Message's Run's decided
  Proposal and attaches it. Omitted (not `null`) when absent.
- **Only DECIDED outcomes rehydrate.** The read filters to `status IN
  ('accepted','rejected')`. A still-`pending` Proposal renders its full
  *interactive* card, which needs the payload / `resolved_plan` /
  `review_context` — a heavier read, deferred (see below). A `cancelled`
  Proposal is cleared live (its parked Run was cancelled — nothing to review).
  So this is the *settled-outcome* reader, mirroring ADR-0043's settled-history
  rule for tool calls.
- **No payload on the wire.** The decided card reads only `status` +
  `mutation_kind`; every payload reader in `ProposalCard` already degrades a
  missing payload to empty, and the accepted/rejected early-return fires before
  any interactive branch. So the reconstructed `PendingProposal` carries
  `payload: null` / `rationale: null` — the decided card never reaches the code
  that would read them.
- **Reconstruction is skip-if-present.** On hydration the Web Client rebuilds a
  decided `PendingProposal` from `view.proposal` and merges it into the
  `proposals` map only when no Proposal is already attached for that `run_id`. A
  live pending/deciding Proposal (the became-live window, or a `proposal/pending`
  notification that beat hydration) must win over the settled-history view, so
  the merge never clobbers it — safe in both the normal and became-live paths.

## Consequences

- One read path restores text, tool activity (ADR-0043), **and** decided
  Proposal outcomes — no second round-trip, no client-side merge of two reads.
- `MessageView` stays outside the schema-fixture parity gate (which covers only
  the proposable mutation kinds); its Rust↔TS parity is held by the existing
  paired hand-written round-trip tests, which this ADR's change extends — the
  same arrangement ADR-0043 used for `tool_calls`.
- **Pending-Proposal rehydration stays unbuilt.** Restoring a still-pending
  Proposal's *interactive* review card on reload (so a user can decide it after a
  refresh) needs the full payload + `resolved_plan` + `review_context` on the
  wire — a strictly larger read shape. No consumer needs it yet (a parked Run
  resumes its review live), so it is deferred; this ADR does not preclude adding
  it (the `MessageView.proposal` field would gain the payload, gated on
  `status='pending'`).

## Considered and rejected

- **Persist the `proposals` map to `localStorage`.** Survives reload with no wire
  change, but makes the Client the source of truth for a decision the server
  already owns, and goes stale against server-side changes (idempotent re-decide,
  cancellation). Rejected: the durable record is server-side; the read path
  should surface it, not a client cache.
- **A dedicated `proposal/get_decided` (or `run/get_history`) read.** A second
  round-trip plus a client-side merge into the rehydrated messages, for data the
  one `thread/get` read can carry inline. Rejected for the same reason ADR-0043
  rejected the `run/get_history` coarse-event sketch: the one-round-trip
  `thread/get` extension is the strict subset that serves the observable behavior.

## Related

- [ADR-0043](./0043-tool-activity-rehydration.md) — the tool-activity read-path
  precedent this ADR applies; it excluded Proposal tool calls and left the
  decided-outcome case to this sibling read.
- [ADR-0025](./0025-proposal-park-and-resume.md) — a Proposal parks its Run and
  renders as a `ProposalCard`; this ADR makes the *decided* card durable.
- [ADR-0028](./0028-run-status-materialized-transitions.md) — the
  `proposal_decided` Run Log milestone and the `decided_at`/`applied_at` stamps
  this read reflects.
