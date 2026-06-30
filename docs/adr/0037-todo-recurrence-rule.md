# Todo recurrence rule: an OmniFocus-style repeat persisted in Todo data

/ builds on [ADR-0031](./0031-gtd-todo-person-project-model.md), [ADR-0016](./0016-proposal-application-policy.md), [ADR-0033](./0033-user-initiated-entity-crud-writes-directly.md), [ADR-0009](./0009-protocol-strategy.md)

ADR-0031 defined the V1 Todo model and explicitly deferred recurrence: "Do not
store `repeat` on Todo in immediate V1", tracking the design in
[#124](https://github.com/hongyilyu/inkstone/issues/124) and the execution
(generating the next occurrence) in
[#125](https://github.com/hongyilyu/inkstone/issues/125). This ADR resolves #124:
it defines the durable recurrence-rule shape, its validation, and where it lives.
It does **not** define occurrence generation — completing a recurring Todo does
not yet spawn a successor. That stays #125, and this shape is designed so #125 can
be built without redesigning it.

> **Amended by [ADR-0039](./0039-recurring-todo-occurrence-generation.md) (#125).**
> The original shape was modelled to full OmniFocus parity. Building the
> execution layer collapsed it: `only_on` (weekday/month-day snapping) had no
> generation support and would have produced silently wrong-day successors from
> validated data; `catch_up` and `schedule`/`from_completion` were dropped in
> favour of one anchor-based cadence ("next occurrence = old anchor + interval ×
> unit"). The shape below is the **current** slimmed rule. The "Supported,
> deferred, omitted" and "Considered and rejected" sections are updated to match;
> the original parity rationale is preserved as history where it still explains a
> live decision. Pre-release, with no stored production data, the removal edits
> validation/schema/codec in place rather than versioning the rule (CLAUDE.md §5).

## Decision

A Todo may carry an optional `recurrence` rule in its `data` JSON:

```ts
type RecurrenceUnit = "minute" | "hour" | "day" | "week" | "month" | "year";

type RecurrenceRule = {
  // How far apart occurrences are: `interval` units of `unit`. interval >= 1.
  interval: number;
  unit: RecurrenceUnit;

  // Which Todo date the rule recomputes — the date ADR-0039 advances on the
  // successor (next_anchor = old_anchor + interval × unit). Must name a field
  // that is present on the Todo (see invariants). The non-anchor date, if
  // present, advances by the same rule — an identical span for
  // minute/hour/day/week (preserving the gap), its own clamped day-of-month for
  // month/year (see ADR-0039).
  anchor: "defer_at" | "due_at";

  // Optional end condition. At most ONE of the two keys.
  //   until:       stop after this local wall-clock instant (inclusive bound).
  //   after_count: stop after this many occurrences. >= 1. ADR-0039 decrements
  //                this on each successor; a Todo with after_count == 1 is the
  //                last occurrence.
  // Absent `end` = repeats forever.
  end?: { until?: string; after_count?: number };
};
```

### Where it lives

The rule rides inside `entities.data` JSON on the Todo, exactly like every other
Todo field (`defer_at`, `status`, …) and like Project's `review_every`. No new
column, no migration, no new tier-2 table. Consequences:

- The client↔Core wire payload (`entity/mutate`) stays opaque (`S.Unknown`); no
  protocol change (ADR-0009). Core validates the rule on the way in.
- The Worker-facing `propose_workspace_mutation` tool schema, generated from the
  Rust `Input` type, gains a typed `recurrence` field on `TodoData` /
  `PartialTodoData` so the agent can propose a recurring Todo.

### Validation

Validation lives in Core's `entities::validate` (the single runtime authority;
the schemars structs only *describe* the tool schema, they do not validate the
opaque payload). A `validate_recurrence` hook (driven by `recurrence_spec()`, like
`review_every_spec()`) rejects unknown fields and enforces these invariants.

- `interval` is an integer `>= 1`; `unit` is one of the six units.
- `anchor` ∈ {defer_at, due_at}.
- **Anchor presence**: the Todo data must carry the date field named by `anchor`.
  A rule cannot recompute a date the Todo does not have. Enforced where the rule
  is validated against the whole Todo (create, and the apply-time re-validation
  of a merged `update_todo`), not in the standalone rule validator.
- `end`, if present, carries at most one of `until` (a parseable
  `YYYY-MM-DDTHH:MM:SS` wall clock) / `after_count` (integer `>= 1`); an empty
  `end` object is rejected.

`recurrence` is a clearable optional field on `update_todo`: a `null` value
clears it (ADR-0033 sentinel-null), handled by the existing apply-path
`retain(!is_null())` with no special-casing.

## Supported, deferred, omitted

**Supported now** (validated + persisted): interval + unit across all six units;
defer/due anchor; `until` / `after_count` end conditions.

**Delivered by #125** ([ADR-0039](./0039-recurring-todo-occurrence-generation.md),
the execution layer): computing the next occurrence date (`old_anchor + interval
× unit`, with month-end clamping), advancing the non-anchor date by the same
rule, decrementing `after_count`, honoring `until`, and creating the successor
Todo atomically on completion.

**Removed from the original shape** (ADR-0039 amendment, no stored data
pre-release): `schedule`/`from_completion` (every repeat is now anchor-based —
"based on the old entry date" — needing no completion clock); `catch_up` (the
late-completion catch-up/skip toggle, meaningless once cadence is a pure anchor
function); `only_on` weekday/month-day snapping (it had no generation support, so
keeping it would have spawned silently wrong-day successors from validated data —
removed rather than half-implemented). Each can return as an additive change if a
real need surfaces.

**Omitted** (never in the durable shape): planned dates as a third anchor
(ADR-0031 deliberately has only defer/due); "only on the Nth weekday of the
month" ordinal constraints; timezone/DST-aware scheduling (Core stores naive
local wall-clock per ADR-0031's review-anchor reasoning, and ADR-0039's math is
naive civil arithmetic).

## UI scope

The Library Todo editor and detail surface expose the **common path** —
interval, unit, and anchor — enough to create and read a recurring Todo in the
browser. `end` is validated and persisted by Core but not yet surfaced in the
editor; it round-trips untouched through edits. This mirrors the editor's
existing "minimal-but-real" stance (a single `waiting_on` person link, not the
full ref matrix). A recurring Todo created today persists its rule, shows it,
and — once #125 ([ADR-0039](./0039-recurring-todo-occurrence-generation.md))
landed — spawns its successor when completed.

## Considered and rejected

- **Full OmniFocus parity up front (the original #124 decision).** This ADR
  originally shipped `schedule`/`catch_up`/`only_on` to full parity, reasoning
  that #125 would need them and that re-designing stored data later would be
  breaking. Superseded by experience: when #125 ([ADR-0039](./0039-recurring-todo-occurrence-generation.md))
  built the execution layer, `schedule`/`catch_up` proved unnecessary for the
  chosen anchor-based semantics, and `only_on` had no generation support — so
  carrying it risked silently wrong-day successors. Pre-release with no stored
  data, slimming the shape in place (this amendment) was cheaper and cleaner than
  keeping validated-but-dead fields. The durable-shape instinct held for what
  survived (`anchor`, `end`); it over-reached on the parity surface.
- **A dedicated `recurrence_rules` table / columns.** Rejected: the rule is Todo
  state with no independent identity or query need; it belongs in `data` JSON
  like every other Todo field, and #125 reads it alongside the Todo. A table
  would add a migration and a join for no benefit at this scale.
- **Validate via the schemars `Input` structs.** Rejected: those generate the
  tool schema and are not the runtime authority; the opaque `entity/mutate`
  payload (user-initiated CRUD, ADR-0033) never deserializes through `Input`.
  Cross-field invariants (anchor presence, `end` cardinality) live in
  `entities::validate`, the one path both the agent and the user hit.

## Related

- [ADR-0031](./0031-gtd-todo-person-project-model.md) — the Todo model this
  extends; its "Deferred" section pointed here.
- [ADR-0016](./0016-proposal-application-policy.md) — agent-proposed recurring
  Todos go through Proposal policy.
- [ADR-0033](./0033-user-initiated-entity-crud-writes-directly.md) — user CRUD
  writes recurrence directly; `null` clears it.
- [ADR-0009](./0009-protocol-strategy.md) — opaque payload, no wire change.
- [#125](https://github.com/hongyilyu/inkstone/issues/125) — occurrence
  generation, the execution layer this shape feeds.
