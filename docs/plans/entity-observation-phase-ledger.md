# Entity and Observation Phase Ledger

This ledger keeps the architecture plan from losing deferred topics while the
implementation ships in small proof slices.

Source plan: `docs/plans/entity-observation-architecture-plan.md`.
ADR anchor: `docs/adr/0053-observation-records.md`.

## Phase Map

| Phase | Primary proof | Status | Does not prove yet |
|---|---|---|---|
| Phase 1 | Separate Observation substrate with relation-free `bodyweight` records. | Landed | Relation fields, Habit check-ins, proposals, UI, correction history. |
| Phase 2 | Closed `EntityTypeSpec` policy table for canonical Entity Types. | Landed | New tracker schemas, Observation relation validation, UI grouping. |
| Phase 2b | Habit earns Canonical Entity identity as a definition, not as check-ins. | Landed | Habit check-in stream, Habit proposal support, Habit UI. |
| Phase 3 | First relation-bearing Observation schema using `habit.checkin` as the POC. | Landed | All remaining tracker schemas, generic proposal capture, correction history, UI/Health views. |
| Phase 4 | One generic `record_observations` proposal kind for agent-reviewed capture. | Landed | Per-schema UI, edit/revision history, charts. |
| Phase 5 | Observation correction history when delete-and-re-record is insufficient. | Landed | Health UI, aggregate UX, sidebar/navigation policy. |
| Phase 6 | Observation read views such as Health/Tracking without sidebar bloat. | Planned | Runtime plugins, generic relationship graph, every possible tracker schema. |

## Topic Coverage

| Topic | First covered | Current rule | Remaining work |
|---|---|---|---|
| Storage substrate | Phase 1 | Observations live in separate `observations` tables, not `entities`. | Keep future tracker streams on this substrate unless a real identity-bearing noun emerges. |
| Entity policy | Phase 2 | Entity Types stay closed and compile-checked through specs. | Avoid turning every tracker into an Entity Type. |
| Habit definition | Phase 2b | Habit is a Canonical Entity because it has durable identity: name, cadence, target, status. | UI can come later; proposal support remains undecided. |
| Relation-bearing observations | Phase 3 | `habit.checkin.values.habit_id` proves schema-specific relation validation. | Future relation fields must be added per schema, not through a generic graph by default. |
| Delete behavior | Phase 3 | Block deleting a Habit while `habit.checkin` rows reference it. | Every future relation-bearing schema must define delete behavior for its referenced Entity Type. |
| Query surface | Phase 1, expanded in Phase 3 | `observation/query` supports schema/time/source/limit; Phase 3 adds `related_entity_id`. | Aggregates, buckets, cursors, and richer filters wait for real UI pressure. |
| Direct user capture | Phase 1 | `observation/record` records direct user observations without proposals. | Keep direct capture separate from agent-reviewed proposal capture. |
| Agent capture | Phase 4 | One generic `record_observations` proposal kind. | Do not add `create_calorie`, `create_exercise`, `create_habit_checkin`, etc. |
| Correction model | Phase 5 | `observation/update` appends `observation_revisions`; queries read the current row. | Revision-history UI and undo remain future product work. |
| UI/navigation | Phase 6 | Views read observations; schema registration does not add sidebar rows. | Decide Health/Today/Tracking layout later. |
| Global search/reference | Later | Observations are not Journal Entry inline-reference targets by default. | Add opt-in search/reference policy per schema only when there is a product use case. |
| Tracker schema growth | Ongoing | Add closed Core-owned schemas one at a time. | Nutrition, exercise, sleep, mood, etc. remain schema work, not architecture work. |

## Phase 3 Scope Note

Phase 3 uses Habit only because it is the smallest real relation-bearing case.
It proves the pattern:

```text
Observation schema declares relation field
-> pure validation checks JSON shape and UUID shape
-> write transaction checks referenced Entity exists and has the right type
-> query can filter by related_entity_id
-> referenced Entity delete has explicit behavior
```

This is not the full Habit product and not the full tracker roadmap. It is the
relation POC that future relation-bearing schemas must follow.

## Deferred Tracker Schemas

These should be added as Observation schemas when product work needs them:

| Schema | Likely first shape | Entity dependency |
|---|---|---|
| `nutrition.intake` | `kcal`, optional macros, optional label/note. | None initially. |
| `exercise.session` | kind, duration, optional distance/load fields. | None initially; add a relation only if Program/Workout earns identity. |
| `sleep.session` | time range, duration/quality fields. | None initially. |
| `mood.checkin` | score/label plus note. | None initially. |

## Guardrails

- Do not add one Entity Type per tracker stream.
- Do not add one proposal kind per tracker stream.
- Do not add one sidebar/nav row per tracker stream.
- Do not add a generic relationship graph until repeated schema-specific
  relations create real pressure.
- Do not add correction history before an edit surface exists.
- Keep Journal Entry as evidence, not mandatory ownership.
