# Recurring Todo occurrence generation: completing a recurring Todo spawns its successor

/ builds on [ADR-0037](./0037-todo-recurrence-rule.md), [ADR-0031](./0031-gtd-todo-person-project-model.md), [ADR-0033](./0033-user-initiated-entity-crud-writes-directly.md), [ADR-0034](./0034-mark-project-reviewed-write-path.md), [ADR-0016](./0016-proposal-application-policy.md)

ADR-0037 defined the durable Recurrence Rule and explicitly deferred *execution*
to [#125](https://github.com/hongyilyu/inkstone/issues/125): "completing a
recurring Todo does not yet spawn a successor." This ADR resolves #125. When a
recurring Todo transitions into `completed`, Core computes the next occurrence
from the rule and creates a successor Todo **atomically in the same
transaction** as the completion.

It also records the slimmed rule shape this execution layer computes against —
the amendment to ADR-0037 (`only_on`, `catch_up`, and `schedule`/`from_completion`
removed) was driven by this work and is documented there.

## Decision

### Trigger: the active→completed transition, once

Completion is not a distinct verb. A Todo is completed by an `update_todo`
mutation that merges `status: "completed"` (+ `completed_at`) onto the current
Todo — through `apply_update_todo` (the same read-modify-write path for every
Todo edit). Successor generation fires from inside that path, iff **all three**
hold:

1. the **pre-merge** stored status was **not** `completed`, and
2. the **merged** status **is** `completed`, and
3. the merged Todo carries a `recurrence` rule.

Guard (1) makes generation fire **exactly once per completion**: re-saving an
already-completed Todo (editing its note, clearing a field) never spawns a
second occurrence. `status → dropped` ends the series and spawns nothing
(dropping a repeat stops it, OmniFocus parity). A non-recurring Todo, or one
whose rule's end condition is reached, spawns nothing.

### Date math: a pure function, no clock

With `schedule`/`from_completion` removed (ADR-0037 amendment), every recurrence
is anchored to the stored date. The successor's anchor date is

```text
next_anchor = old_anchor + interval × unit
```

computed as **naive wall-clock civil arithmetic** on the parsed
`YYYY-MM-DDTHH:MM:SS` tuple — no timezone, no DST, consistent with ADR-0031's
naive-local-wall-clock stance and ADR-0037's explicit omission of TZ-aware
scheduling. The math is a **pure function of `(rule, anchor strings)`** — it
reads no `now_ms` and no UTC offset. It lives in its own module
(`crates/core/src/recurrence.rs`), reusing the existing
`civil_from_days`/`days_from_civil` helpers.

- **minute / hour / day / week**: add the corresponding seconds/days; never
  overflows a calendar month.
- **month / year**: advance the civil month/year, then **clamp the day to the
  target month's last valid day** (Jan 31 + 1 month → Feb 28/29; Mar 31 + 1
  month → Apr 30; Feb 29 + 1 year → Feb 28). Matches OmniFocus / RFC 5545 /
  chrono `checked_add_months`. Time-of-day is always preserved.

**Both dates advance by the same rule.** The rule names one `anchor` (`defer_at`
*or* `due_at`), but a Todo may carry both. Each present date is advanced by the
same `interval × unit`. For the fixed-duration units (minute/hour/day/week) this
adds an identical span to both, so the defer→due gap is preserved exactly — a
"defer two days before it's due" repeat keeps its two-day lead. For month/year,
each date keeps its **own** day-of-month (clamped independently), which is the
natural calendar behavior: a defer-on-the-1st / due-on-the-15th monthly repeat
stays on the 1st and the 15th. The `anchor` the rule names is the date the
`until` end-bound is measured against.

### End conditions

- **`until`**: if `next_anchor` is strictly after the `until` wall-clock
  instant, the series has ended — spawn nothing. (Inclusive bound: an occurrence
  landing exactly on `until` is still generated.)
- **`after_count`**: tracked by **decrementing in place**. The original carries
  `after_count: N` (N occurrences total, this is #1); its successor carries
  `after_count: N-1`, and so on. Completing a Todo whose **current**
  `after_count == 1` is the last occurrence → spawn nothing. This stays within
  the validated shape (`after_count >= 1` at every step), needs no counter
  column, and is self-contained in the copied rule.

### What the successor carries

The successor is a fresh Todo built from the completed one's merged data:

- `title`, `note`, `project_id`, and the `recurrence` rule (with `after_count`
  decremented if present) carry forward verbatim.
- the new `defer_at` / `due_at` per the math above.
- `status` resets to `active`; `completed_at` / `dropped_at` are dropped (a new
  occurrence is freshly active).
- **All Todo Person References carry forward**, role preserved — every
  `todo_person_refs` row on the original is copied to the successor (both
  `waiting_on` and `related`). The rule is a repeating template; its People are
  part of it. The user can edit the successor if a reference no longer applies.

### Authorship and provenance

The successor **inherits the completing mutation's authorship** —
`created_by` and `created_via_proposal_id` are copied from the `update_todo`
that completed the original. An agent-accepted completion (`created_by =
'proposal'`, carrying that `proposal_id`) yields a `'proposal'` successor; a
direct user completion (`created_by = 'user'`) yields a `'user'` successor. Both
satisfy the `entities` CHECK (`created_by IN ('user','proposal')`, and
`'proposal'` requires a `proposal_id`) with values already in scope at the call
site, and read truthfully: the occurrence exists because of that completion.

**No `entity_sources` row** is written for the successor. This mirrors
`mark_project_reviewed` (ADR-0034), whose recompute writes no new source row;
the Recurrence Rule is the logical link between occurrences, and inventing a
Todo→Todo `created_from` provenance edge is deferred until a lineage query needs
it.

### Where it lives

A dedicated `spawn_recurrence_successor` helper in `db/apply.rs`, sibling to
`apply_mark_project_reviewed`, called from `apply_update_todo` after the merged
write + revision + ref-ops succeed. The successor insert (entity row + seq-1
revision + copied refs) runs in the **same transaction** as the completion, so a
completed recurring Todo and its successor are atomic: both land or neither
does. The pure date math stays in `recurrence.rs`; the apply helper owns the DB
writes. This follows the established `apply_*` read-modify-write recompute
pattern, not an inline expansion of `apply_update_todo`.

## Amendment: a read-side next-occurrence preview (#227)

The Recurrence Rule's *write* side (this ADR) and its end conditions (ADR-0037)
were complete in Core but only partly surfaced: the Todo editor could set
interval / unit / anchor but **not the `end` condition**, and nothing showed a
user *when the next occurrence would land*. #227 surfaces both. The editor gains
an **End** control (`Never` / `On date` → `until` / `After N` → `after_count`),
and — for a bounded series — a read-only **"Dates for next occurrence"** preview
of the successor's `defer_at` / `due_at`.

Computing those dates is exactly the math this ADR defines. Rather than mirror
the civil-arithmetic + month/year clamping in TypeScript (a drift risk: the
clamp, overflow guards, and inclusive-`until` semantics are subtle), the preview
**reuses `recurrence::next_occurrence` verbatim** through a new read seam.

- **New read RPC `recurrence/preview`** (request→response via the ADR-0029
  handler combinator). Params: a draft `recurrence` rule + the current
  `defer_at` / `due_at` (the dates the editor already holds). Result: the
  successor's `defer_at` / `due_at`, or a flag that the series has ended. It is a
  **pure, read-only** call — no DB read, no write — so it carries the
  single-user log's read-seam shape (sibling to ADR-0050's backlinks read), not a
  mutation.
- **`next_occurrence` stays the one source of truth.** The handler calls it
  directly (same crate; widen nothing the dispatch can't already reach) and maps
  its `Option<Occurrence>` to the wire result. `None` (series ended: the merged
  Todo would be the last occurrence — `after_count == 1`, or `next_anchor`
  strictly past `until`, or a partial in-flight draft) becomes an explicit
  **"no next occurrence"** result, never an error. The web renders that as "this
  is the last occurrence".
- **The wire pair joins the contract-parity gate (ADR-0009).** The request param
  is hand-authored (client→Core) and the result is Core-emitted, so the slice is
  atomic across Rust serde mirrors, the `@inkstone/protocol` Effect schemas, the
  `authored/` + `emitted/` struct fixtures, the `structs.registry.ts` entries,
  and the `CANONICAL_MESSAGES` completeness lock — the gate reds otherwise. This
  is the one parity-gate slice in the otherwise web-only #225–#227 set; it is
  sequenced alone.
- **Date-only preview.** The editor edits days, not times, and every unit
  advances by whole days/months/years, so the successor's *date* is invariant to
  the stored time-of-day — the preview shows the date, matching Core exactly with
  no time-preservation logic. The preview block shows only when **End ≠ Never**
  (a bounded series is where "when does it stop / what's next" is meaningful).
- **`until` granularity.** A freshly chosen or day-changed `On date` writes
  `until` at day granularity (`YYYY-MM-DDT00:00:00`), consistent with the
  date-only `due_at` / `defer_at` it sits beside. But a Todo whose stored `until`
  carries a non-midnight time (an agent/proposal can author one — Core's
  `until` compare is a full wall-clock string, so the time-of-day is
  significant) **round-trips that bound verbatim** through an edit that doesn't
  touch the day: the editor holds the full stored string and only re-folds to
  `T00:00:00` when the user actually changes the day, so an unrelated edit can't
  silently move the bound back to midnight (and, since `until` is inclusive, drop
  the final occurrence). Core's inclusive-`until` bound and string compare
  (above) are unchanged.

No change to the write path, the rule shape, or `next_occurrence` itself — this
is purely an additive read seam over the existing pure function.

## Considered and rejected

- **Generate from completion time (`from_completion`).** The stored shape once
  carried a `schedule` allowing occurrences measured from when the Todo was
  completed. Removed in the ADR-0037 amendment: the chosen semantics anchor
  every repeat to the stored date ("based on the old entry date"), which needs
  no completion clock and collapses the math to a pure function. Re-adding a
  completion-relative schedule later is an additive change.
- **A separate occurrence-counter column for `after_count`.** Rejected:
  decrementing the copied rule in place needs no schema and stays within the
  validated `>= 1` invariant. A column would add migration + join for no benefit.
- **Writing an `entity_sources` `created_from` edge to the original Todo.**
  Rejected for this slice: no Todo→Todo source precedent exists, and
  `mark_project_reviewed` sets the parity (recompute writes no source). The rule
  links the occurrences; lineage can be added if a query needs it.
- **A distinct `complete_todo` mutation kind.** Rejected: completion is already
  `update_todo` setting `status`, and ADR-0033's three-way merge handles it.
  Generation keys off the *transition* the merge produces, not a new verb.
- **Generating inline in `apply_update_todo`.** Rejected: the function is already
  dense (merge + project recheck + ref-op precedence). The successor-create is a
  separable read-modify-write that belongs in its own helper, like
  `apply_mark_project_reviewed`.

## Related

- [ADR-0037](./0037-todo-recurrence-rule.md) — the durable rule this executes
  against; its amendment slimmed the shape this generation computes on.
- [ADR-0031](./0031-gtd-todo-person-project-model.md) — the Todo model, the
  naive-local-wall-clock stance, and Todo Person References carried forward.
- [ADR-0033](./0033-user-initiated-entity-crud-writes-directly.md) — completion
  arrives as an `update_todo` three-way merge on either the agent or user path.
- [ADR-0034](./0034-mark-project-reviewed-write-path.md) — the sibling
  in-transaction recompute helper this mirrors (no new source row on recompute).
- [#125](https://github.com/hongyilyu/inkstone/issues/125) — the issue this
  resolves.
- [ADR-0050](./0050-entity-backlinks-read-seam.md) — the read-seam precedent the
  `recurrence/preview` amendment mirrors (a pure read over existing Core state).
- [#227](https://github.com/hongyilyu/inkstone/issues/227) — the End-condition
  editor + next-occurrence preview the amendment records.
