# Run and Proposal status are materialized, changed only through guarded transition verbs

`runs.status` and `proposals.status` stay **materialized** — a stored, authoritative column on the row — and are mutated **only** through typed *transition verbs* (`RunStatus::complete`, `park`, `resume`, `cancel`; `ProposalStatus::accept`, `reject`, `cancel`). Each verb (a) guards on its expected `from` state with a `WHERE status = <from>` clause that is simultaneously the legality check and the concurrency choke, (b) owns the fields that must move with the status (`terminal_reason`/`error_*`/`ended_at`, `awaiting_tool_call_id`, `decided_by`/`decided_at`/`applied_at`/`edited_payload`/`decision_idempotency_key`), (c) returns `Moved::{Won, Lost}` so a lost race is a value the caller handles, (d) takes a `&mut Transaction` so it composes inside the existing atomic orchestrations (`apply_proposal`, `cancel_parked_run`, `park_on_proposal`), and (e) appends the matching `run_events` row in the **same** transaction — the lone exception is `resume` (`parked → running`), which performs only the guarded status flip and writes no event of its own, since the resumption is already captured by the preceding `proposal_decided` and the status returning to `running`. Legality lives in the verb set plus the SQL guard — **not** in a separate state-machine abstraction.

Status is **not** event-sourced: the `runs.status` / `proposals.status` cell remains the source of truth, and `run_events` is a durable record written alongside it, not the thing status is projected from.

## Scope

Two columns — the only tier-2 status columns with a real state machine (guarded flips, co-moving fields, transactional coupling):

- **`runs.status`**: `Running`, `Parked`, `Completed`, `Errored`, `Cancelled`. The dead `pending` value (in the CHECK and the recovery sweep, but never written) is removed so the type is the exact live-state set.
- **`proposals.status`**: `Pending`, `Accepted`, `Rejected`, `Cancelled`.

The flat enums (`messages.status`, `tool_calls.status`, `run_steps.kind`, …) are **out of scope** — they have no transition logic, so a typed-enum sweep there would be type-tidying, not a state machine.

## Why materialized, not event-sourced

The intuition "status should be derived from what happened, not set by hand" is right, and the run loop already *derives* the outcome from the Worker event stream. But deriving and recording are different steps, and the recording must be durable because a Run outlives the process that produced it (a `parked` Run waits days with no live Worker; Core can crash mid-Run). Event-sourcing the status — storing only events and projecting status on read — was considered and rejected for this project:

- **The event log is not a foundation today.** `run_events` declares 8 `kind`s but only 3 are ever written (`status` at creation, `done`, `error`); nothing reads the log back; the `run/get_history` replay it was built for does not exist. Event-sourcing would mean building the complete writer **and** the projection **and** the reader — for a capability no current code needs.
- **The guard is the concurrency mechanism.** `WHERE status = 'parked'` is what makes a Decision apply exactly once and stops a double-resume ([ADR-0025](./0025-proposal-park-and-resume.md) review M1/M2). With no materialized cell to race on, conflicting events (a `cancel` and a `done` for the same Run) both append successfully and the conflict moves into a precedence rule every reader's fold must apply — re-inventing, with more moving parts, what the guarded `UPDATE` already does synchronously.
- **The hardest future case favours the guard.** Live-cancel (`running → cancelled` racing the loop's terminal transition) is a transition-guard problem: both transitions guard on the run still being live, the first commit wins, the loser matches 0 rows and backs off. `run/cancel` may return `accepted` only after the `running → cancelled` transition wins; if a terminal Worker transition wins first, the cancel command returns `already_terminal`. When cancellation wins after partial assistant output, the same transition marks streaming Messages `incomplete`, preserving the text without treating it as a clean answer. The genuinely hard part — aborting the live Worker — is a process-lifecycle concern ([ADR-0026](./0026-worker-transport-seam.md)) that is identical under either model.
- **Local-first, single-user ([ADR-0007](./0007-local-first-single-user.md)).** Event-sourcing's payoffs — audit at scale, many independent read models, high write concurrency across a mutable cell — are not needed by a one-user tool, so its complexity tax is not repaid.
- **It fits [ADR-0026](./0026-worker-transport-seam.md).** The DB is local-substitutable: the verbs are tested against `:memory:` SQLite, which exercises the real CHECK constraints and the real guard races. No `trait Db` indirection.

## Why legality lives in the guard (not a separate state-machine core)

For a five-state machine the `WHERE status = <from>` clause does double duty — it rejects an illegal move *and* resolves the race. A pure `transition(from, event) -> Result<to, Illegal>` layer checked before the `UPDATE` is redundant: the in-memory `from` can be stale by the time the statement runs, so the guard is needed regardless, and the verb set already makes illegal moves uncallable. The branchy legality logic is small enough to read at a glance; a second representation of it would be indirection without leverage. Revisit only if the machine grows large and branchy.

## Why complete the event log now

The verbs are the single natural place to append the lifecycle event, so completing the currently-missing rows (`parked`, `proposal_pending`, `proposal_decided`, `cancelled`) is nearly free once status changes funnel through them. This makes the durable record trustworthy and pre-pays a future `run/get_history` without building the reader. Completing a half-built durable record is not speculative; building a consumer for it would be, and the reader stays out of scope.

## Consequences

- The dead `pending` run status is removed from the `RunStatus` enum, the `runs.status` CHECK, the boot-recovery sweep, and the `idx_runs_status` partial index.
- `run_events.kind` gains `'cancelled'` (no such kind exists today). Migrations are edited in place (pre-release; AGENTS.md early-stage).
- Park becomes atomic — the three writes (tool_call, proposal, run-parked) run in one transaction, closing the "half-parked is recoverable" gap, and emit `parked` + `proposal_pending`.
- The initial status-materialization work readied live-cancel (`running → cancelled`) through the uniform `from`-guard. Live cancellation now uses that guard: `accepted` means Core won the transition to `cancelled`, not merely received the request, and any still-`streaming` Messages for the Run become `incomplete`.
- No raw status-string `UPDATE` remains in Core outside the lifecycle module and the SQL primitives it owns. Status changes are grep-ably funnelled through the verbs.
- Reversal cost is the re-scattering of those `UPDATE`s across the handlers and the loop; recorded as load-bearing rather than provisional.
- This ADR's status-materialization change did not require a `packages/protocol` change: `run_events` is internal tier-2, not on the wire. Live cancellation's terminal wire event is covered by [ADR-0014](./0014-client-core-wire-protocol.md).

## As-built amendment — Run Log: one writer (run-log-one-writer)

A later refactor sharpened this area; the decisions above stand, with these deltas:

- **`run_events` is renamed `run_log`** and named as a first-class concept — the **Run Log**, Core's durable record of a Run's lifecycle milestones — to end the collision with the wire **Run Event** (Worker-emitted, observational, never persisted). See CONTEXT.md *Run Log* / *Run Event*.
- **The `kind` CHECK drops the never-written `tool_request`/`tool_result`.** Tool history lives in `tool_calls` + `run_steps` (surfaced by `read_run_timeline`), not the Run Log; those two kinds were anticipation reality routed elsewhere (ADR-0017 §"`run_events` is the durable backing"). The live set is exactly the seven written kinds: `running`, `parked`, `done`, `error`, `cancelled`, `proposal_pending`, `proposal_decided`.
- **The run-creation event's kind is `running`, not `status`** (empty payload), so every entry names its moment directly like its siblings; `RunLogKind`'s members are the five Run-status moments plus the two proposal milestones.
- **Sequence allocation + insert funnel through one verb, `run_log::append`.** The transition verbs (point (e) above) and the two non-transition writers (run creation; `park_on_proposal`'s `proposal_pending`) all call it; it owns `next_run_seq` + insert, removing the per-site boilerplate and the lone hardcoded `run_seq = 0` at creation. This refines (e): the verbs still decide *when* and *which kind*; `run_log` owns *how to append* and *what kinds exist*. It is not a state-machine/legality layer — the guard stays in the verbs — so it does not reopen "legality lives in the guard".
- **Core uses a single SQLite pool connection in WAL mode.** Concurrent async Run tasks still race at the lifecycle guards, but their actual SQLite statements serialize inside the process instead of surfacing transient `SQLITE_BUSY` as user-visible lifecycle failures. This matches the local-first, single-user write profile; revisit if Inkstone grows multi-user or high-throughput workloads.
- Migration edited in place (pre-release).

## Considered and rejected

- **Event-sourced status (project from `run_events`).** Closest to the "auto-derive" intuition, but requires completing the writer + a projection + a reader, re-inventing the guard's concurrency role, and pays event-sourcing's complexity for benefits a single-user tool does not collect. Rejected.
- **Pure FSM core + thin db applier.** A DB-free `transition(from, event)` returning a field-change descriptor, applied by a thin db layer. Rejected: a descriptor layer for a five-state machine is the indirection [ADR-0026](./0026-worker-transport-seam.md) is wary of, and it still cannot test the guard races without `:memory:`.
- **Hybrid: pure legality predicate + SQL transitions.** A `can_transition(from, to)` predicate consulted before each guarded `UPDATE`. Rejected: the predicate partly duplicates the guard's job for little gain at this size.
- **Sweep every tier-2 status column into a typed enum.** Rejected: the flat enums have no transition logic; typing them is tidying, not a state machine, and expands the change for little leverage.
- **Drop materialized status entirely.** Subsumed by the event-sourced rejection.

## Related

- [ADR-0025](./0025-proposal-park-and-resume.md) — the park/resume lifecycle and the M1/M2 self-guards the verbs preserve and generalise.
- [ADR-0026](./0026-worker-transport-seam.md) — DB is local-substitutable; `:memory:` is the test substrate; no `trait Db`. The verbs follow that stance.
- [ADR-0007](./0007-local-first-single-user.md) — single-user local-first, the reason event-sourcing's payoffs do not apply.
- [ADR-0014](./0014-client-core-wire-protocol.md) — the enumerated `error_code` vocabulary a terminal `fail()` carries.
- [ADR-0017](./0017-tier-2-schema-slice-1.md) — the recovery invariant the terminal transitions uphold.
