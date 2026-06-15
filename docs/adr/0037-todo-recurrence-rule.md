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

## Decision

A Todo may carry an optional `recurrence` rule in its `data` JSON. The rule
follows OmniFocus recurrence semantics, modelled to full parity now so #125's
execution layer has a stable shape to compute against:

```ts
type RecurrenceUnit = "minute" | "hour" | "day" | "week" | "month" | "year";

type RecurrenceWeekday =
  "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

type RecurrenceRule = {
  // How far apart occurrences are: `interval` units of `unit`. interval >= 1.
  interval: number;
  unit: RecurrenceUnit;

  // "regular": fixed calendar cadence from the anchor date.
  // "from_completion": next occurrence measured from when the Todo is completed.
  schedule: "regular" | "from_completion";

  // Which Todo date the rule recomputes — the date #125 advances on the
  // successor. Must name a field that is present on the Todo (see invariants).
  anchor: "defer_at" | "due_at";

  // Regular schedules only. true = fire every missed occurrence ("catch up");
  // false/absent = skip straight to the next future occurrence. Meaningless for
  // "from_completion" (there are no missed occurrences), so rejected there.
  catch_up?: boolean;

  // Constrain regular occurrences to specific weekdays / month days.
  // `weekdays` only with unit "week"; `month_days` only with unit "month".
  only_on?: {
    weekdays?: RecurrenceWeekday[];   // non-empty, deduped, no repeats
    month_days?: number[];            // 1..31, non-empty, deduped, no repeats
  };

  // Optional end condition. At most ONE of the two keys.
  //   until:       stop after this local wall-clock instant (inclusive bound).
  //   after_count: stop after this many occurrences. >= 1.
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
opaque payload). A new `validate_recurrence` mirrors `validate_review_every`:
it rejects unknown fields and enforces these invariants.

- `interval` is an integer `>= 1`; `unit` is one of the six units.
- `schedule` ∈ {regular, from_completion}; `anchor` ∈ {defer_at, due_at}.
- **Anchor presence**: the Todo data must carry the date field named by `anchor`.
  A rule cannot recompute a date the Todo does not have. Enforced where the rule
  is validated against the whole Todo (create, and the apply-time re-validation
  of a merged `update_todo`), not in the standalone rule validator.
- `catch_up` is only valid with `schedule: "regular"`.
- `only_on.weekdays` is only valid with `unit: "week"`; `only_on.month_days` only
  with `unit: "month"`. Each, if present, is a non-empty array of valid,
  non-duplicate values (weekday enum; month day 1..31). An empty `only_on` object
  is rejected.
- `end`, if present, carries at most one of `until` (a parseable
  `YYYY-MM-DDTHH:MM:SS` wall clock) / `after_count` (integer `>= 1`); an empty
  `end` object is rejected.

`recurrence` is a clearable optional field on `update_todo`: a `null` value
clears it (ADR-0033 sentinel-null), handled by the existing apply-path
`retain(!is_null())` with no special-casing.

## Supported, deferred, omitted

**Supported now** (validated + persisted): interval + unit across all six units;
regular vs from-completion schedule; defer/due anchor; catch-up toggle;
weekday/month-day `only_on` constraints; `until` / `after_count` end conditions.

**Deferred to #125** (the execution layer): computing the next occurrence date,
preserving the completed occurrence as history, copying stable context to the
successor, honoring catch-up and end conditions at fire time. This ADR stores the
inputs; #125 acts on them.

**Omitted** (not in the durable shape): planned dates as a third anchor (ADR-0031
deliberately has only defer/due — no planned date until separately designed);
"only on the Nth weekday of the month" ordinal constraints (OmniFocus has them;
Inkstone's `month_days` covers the common case and ordinals can extend `only_on`
later without breaking the shape); timezone/DST-aware scheduling (Core stores
naive local wall-clock per ADR-0031's review-anchor reasoning).

## UI scope

The Library Todo editor and detail surface expose the **common path** —
interval, unit, schedule, and anchor — enough to create and read a recurring
Todo in the browser. `only_on` and `end` are validated and persisted by Core but
not yet surfaced in the editor; they round-trip untouched through edits. This
mirrors the editor's existing "minimal-but-real" stance (a single `waiting_on`
person link, not the full ref matrix). A recurring Todo created today persists
its rule and shows it; it does not yet generate a successor (that is #125).

## Considered and rejected

- **A minimal `{interval, unit}` rule now, parity later.** Rejected: #125 needs
  `schedule`/`anchor` to compute a next date and `end` to stop; shipping the
  minimal shape would force a breaking re-design of stored data the moment #125
  starts. #124's whole purpose is a durable shape, so the parity surface is
  designed up front even though the editor only drives part of it.
- **A dedicated `recurrence_rules` table / columns.** Rejected: the rule is Todo
  state with no independent identity or query need; it belongs in `data` JSON
  like every other Todo field, and #125 reads it alongside the Todo. A table
  would add a migration and a join for no benefit at this scale.
- **Validate via the schemars `Input` structs.** Rejected: those generate the
  tool schema and are not the runtime authority; the opaque `entity/mutate`
  payload (user-initiated CRUD, ADR-0033) never deserializes through `Input`.
  Cross-field invariants (anchor presence, catch-up↔schedule) live in
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
