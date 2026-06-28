# Habit tracker model (entity config + check-in observation stream)

Habit shipped as Inkstone's sixth Entity Type across [#249](https://github.com/hongyilyu/inkstone/issues/249),
[#250](https://github.com/hongyilyu/inkstone/issues/250), and
[#251](https://github.com/hongyilyu/inkstone/issues/251). This ADR **codifies the
as-built model** and guards it from drift — it is not a redesign. [ADR-0053](./0053-observation-records.md)
named Habit only in future/hypothetical tense ("rare future identity-bearing
objects such as a Habit definition"); that aside is now superseded by a shipped,
tested model whose design lived only in the phase ledger. Every decision below
has a live anchor and a regression test; the §2 simplicity rule means "decide the
model" must not license rebuilding code that already passes its tests.

## Decision

A **Habit is a hybrid**: a Library Entity carrying the durable **configuration**,
paired with a `habit.checkin` Observation stream carrying the per-event **facts**.
The two never share a field except the join key.

- **Habit the Entity** is the closed-enum sixth `EntityType`
  (`mutation.rs:170`), in `EntityType::ALL` (`mutation.rs:174-181`), stored as
  `entities.type = "habit"` via the generic `spec().stored_type` accessor
  (`mutation.rs:224-232`, `as_str` at `:238-239`). Its data JSON is
  `habit_core` (`mutation.rs:326-334`): required non-empty `name`, required
  `cadence`, clearable `target`, optional `status`, clearable `note`. Schema
  version 1 (`HABIT_SCHEMA_VERSION`, `mutation.rs:43`).
- **The check-in is an Observation**, not a row on the entity. The
  `habit.checkin` schema (`observations.rs:528-560`, version 1 at `:14`) carries
  `habit_id` (UUID), `state ∈ {done, skipped, missed}` (`:538-544`), and optional
  `quantity` (`:545-552`). Facts persist in `observations` / `observation_revisions`
  (`migrations/0001_initial.sql:179-216`), tables wholly distinct from `entities`.

No definition field (`cadence`/`target`/`status`/`note`) appears in the check-in
schema, and no fact field (`state`/`quantity`/`occurred_at`) appears in
`habit_core`. The **only** field common to both stores is `habit_id` — and it
lives *on the check-in* as the foreign key (`observations.rs:537`), never mirrored
onto the Habit.

### Questions settled (#262)

| #262 question | Answer | Anchor |
|---|---|---|
| Library entity, tracker config, recurrence schedule, or hybrid? | **Hybrid** — entity config + observation facts | `mutation.rs:170`, `observations.rs:528-560` |
| Which fields on the entity vs. observation values? | Definition (`name`/`cadence`/`target`/`status`/`note`) on entity; per-event `state`/`quantity` in `values_json`; `habit_id` is the join key on the check-in | `mutation.rs:326-334`, `observations.rs:537-552` |
| How do cadence/status/target differ from Project recurrence/review? | Same `{interval,unit}` shape, but advisory metadata only — no `next/last_reviewed_at`, no occurrence spawn | `mutation.rs:437-452` vs `:456-471` |
| Canonical query for current state / recent check-ins / streak / schedule? | Entity read (list-and-pick) for config + `observation/query{related_entity_id}` for check-ins; streak is a derived view, never stored | `queries.rs:1131-1137`, `protocol.rs:499` |
| How does deleting/editing a Habit affect historical check-ins? | Delete is **blocked** while any live or historical check-in references it; update is full-replace with an immutable id | `apply.rs:894-905`, `queries.rs:1197-1220` |

## Cadence is advisory metadata, not a scheduler

`habit_cadence_spec` (`mutation.rs:437-452`) is structurally identical to
`review_every_spec` (`mutation.rs:456-471`) — a positive `interval` plus a
`{day, week, month, year}` unit. The resemblance ends at the shape:

- A Habit carries **no scheduling timestamp**. `habit_core` has exactly five
  fields; there is no `next_review_at`/`last_reviewed_at` analog and no occurrence
  to materialize.
- **Nothing reads cadence to spawn rows.** Occurrence generation fires only on a
  Todo `active → completed` transition (`apply.rs` recurrence-successor path);
  Project review timestamps advance only on the user-triggered
  `mark_project_reviewed` mutation. Both are **event-driven materialization** — and
  Core has no time-driven scheduler at all (no cron/tick reads any cadence). A
  Habit has *neither*: cadence is write-validated, stored verbatim, and has zero
  read-side consumer in Core today.

So cadence is descriptive intent ("daily", "3× per week"), not a promise the
system will generate or chase. It also intentionally **omits the recurrence
end-condition** that the structurally-identical Todo recurrence rule carries
(`{until | after_count}`, [ADR-0037](./0037-todo-recurrence-rule.md)) — dead
structure today, since no generator drives habit occurrences.

## Linking and integrity

The Habit↔check-in link is **value-embedded, not a relation row**:

- The link is `$.habit_id` inside the observation's `values_json`. There is **no
  foreign key** and **no `observation_relations` table**.
- It is validated **only at write time**: `invalid_relation_reason`
  (`db/observations.rs:266-286`) calls `entity_is_type` (`queries.rs:1292`) to
  confirm `habit_id` names an existing Entity of type `habit`, on both record and
  observation-update (correction) paths. The pure values walk checks UUID shape
  only ([ADR-0053](./0053-observation-records.md) two-stage validation).
- It is queried via `json_extract`: the `related_entity_id` filter hard-codes
  `schema_key = 'habit.checkin'` and matches `json_extract(values_json, '$.habit_id')`
  (`queries.rs:1131-1137`), validated as a UUID in `validate_query`
  (`observations.rs:636-638`).
- **Streak is never stored.** No column, no aggregate table — it is a read-side
  derivation rebuildable from the check-in facts, authoritative for nothing.

Two as-built nuances this ADR records (neither is a defect to fix in scope):

- The write-time relation check is **status-blind**: `entity_is_type` checks id +
  type only, so a check-in may reference a `paused` or `archived` Habit.
- The `related_entity_id` read hits the base `observations` table, which has **no
  `$.habit_id` index** — the partial index
  `idx_observation_revisions_habit_checkin_habit_id`
  (`migrations/0001_initial.sql:214-216`) covers `observation_revisions` only.

## Lifecycle: delete blocks, update full-replaces

**Delete is block-not-cascade.** `delete_habit` rejects while *any* live
observation **or** historical revision references the Habit
(`apply.rs:894-905` → `habit_checkin_observations_exist`, which UNIONs
`observations` and `observation_revisions`, `queries.rs:1197-1220`). History is
preserved, not destroyed. Because there is no FK, a delete absent the guard would
*orphan* check-ins, not cascade them — so the guard makes deletion a **full
reject**, by design. This realizes ADR-0053's write-time relation rule as a
**delete-side invariant**, and generalizes: every future relation-bearing
observation schema must define delete behavior for its referenced Entity Type.

**Update is full-replace.** `update_habit` takes the generic `update_entity` arm
(`apply.rs:963-994`) that overwrites the data document and appends a revision —
unlike `update_todo`'s in-tx partial merge. The target `entity_id` is stripped
from stored data, so a Habit's id is immutable; an update can therefore never
orphan a check-in.

## Canonical read

- **Current config**: there is no Core get-by-id, so a single Habit is read via
  the `entity/list` path and picked client-side.
- **Recent check-ins**: `observation/query { related_entity_id }`
  (`protocol.rs:499`, `queries.rs:1131-1137`). `related_entity_id` alone pins the
  schema to `habit.checkin` server-side, so passing `schema_keys: ["habit.checkin"]`
  is redundant-but-supported.
- **Streak / schedule state**: a derived view over the check-in stream + cadence,
  computed on read, never persisted.

## Why this shape

The config-vs-fact separation is the dominant model for "recurring definition +
emitted occurrences." The local reference repos confirm it: `openclaw`'s cron
(job definition vs. run-log) and `opencode`'s session/message both split a durable
parent from its append-only event children. Neither has a habit/tracker feature,
so neither is a product precedent — only a structural one.

The one dimension Inkstone owns deliberately: **no-FK, value-embedded linking**.
`openclaw`'s cron run-log likewise omits the FK its sibling tables enforce;
`opencode` uses an `ON DELETE CASCADE` FK. We chose the no-FK ledger and reject the
cascade-FK for v1, because check-in facts are an append-only history that should
**outlive definition edits and never be cascade-deleted** — which is exactly what
the delete-block guard enforces.

## Scope and non-goals

- **Core-only in v1.** Habit-the-Entity has no Web editor, no browse row, and no
  protocol mirror — `packages/protocol` mirrors only the `habit.checkin`
  *observation* schema. Habits are authored through `entity/mutate` directly.
- **Direct-user-CRUD-only.** `create_habit` / `update_habit` / `delete_habit` are
  never agent-proposable: they return `NotProposable` (`mutation.rs:1424-1426`) and
  are absent from the `ProposableMutation` enum (`mutation.rs:1180`). (This ADR
  also fixes a stale citation: `mutation.rs:1174` credited ADR-0053 for the
  never-proposable policy, which ADR-0053 never stated — it states it here.)
- **One surprising edge**: `search_entities` advertises "Habits" to the agent
  (`search_entities.rs:16`) even though there is no agent or user-facing create
  path yet. Recorded as intentional.
- **Does not freeze the observation machinery.** This ADR codifies the Habit
  identity/check-in model only. The schema registry and relation-field path remain
  open: [#258](https://github.com/hongyilyu/inkstone/issues/258) adds sibling
  relation-bearing schemas (exercise, nutrition) via `record_observation_payload_variants`
  + a per-schema `relation_fields` slice (`observations.rs:562-587`), with the sole
  shared constraint that a relation target must be an existing `EntityType`. **This
  ADR does not block #258.**

## Known gaps (deferred, not in scope)

Codifying as-built must not trigger a rewrite. Three real gaps are filed as
follow-ups rather than fixed here:

- **`target` is a free string** (`mutation.rs:330`), where its meaning is a
  structured/numeric goal the check-in `quantity` would be measured against. Clean
  v2 candidate (`HABIT_SCHEMA_VERSION` is 1) —
  [#274](https://github.com/hongyilyu/inkstone/issues/274).
- **`quantity` has no `min: 0` floor** (`observations.rs:546`), so a negative
  quantity validates — unlike `bodyweight.kg`, which floors at 0 —
  [#275](https://github.com/hongyilyu/inkstone/issues/275).
- **The relation check is status-blind**, so a check-in can reference a
  `paused`/`archived` Habit —
  [#276](https://github.com/hongyilyu/inkstone/issues/276).

Deliberately left as-is: no "quantity required when `state = done`" invariant
(check-ins are state-first, quantity opt-in); the revision-only delete-block branch
is unambiguous in SQL though only the live-observation branch is independently
test-pinned.

## Regression gates

These pin the two load-bearing invariants and must stay green (zero behavioral
diff from this ADR):

- `delete_habit_rejects_historical_checkin_revision_reference` (`apply.rs:1283`) —
  a Habit referenced only by a corrected-away historical revision still blocks
  delete.
- `observations_record_habit_checkin_validates_relation_and_query_filter`
  (`observations_tests.rs:800`) — write-time relation validation + the
  `related_entity_id` query filter.

## Related

- [ADR-0053](./0053-observation-records.md) — the Observation family; this ADR
  supersedes its future-tense framing of Habit and extends its write-time relation
  rule into a delete-side invariant.
- [ADR-0031](./0031-gtd-todo-person-project-model.md) — the GTD entity model;
  `review_every` is the cadence shape Habit reuses without the scheduler.
- [ADR-0037](./0037-todo-recurrence-rule.md) / [ADR-0039](./0039-recurring-todo-occurrence-generation.md)
  — the recurrence rule + occurrence generation Habit cadence deliberately is *not*.
- [ADR-0033](./0033-user-initiated-entity-crud-writes-directly.md) — direct user
  CRUD; Habit is user-CRUD-only.
- [#258](https://github.com/hongyilyu/inkstone/issues/258) — next relation-bearing
  observation schemas, which this ADR explicitly does not block.
