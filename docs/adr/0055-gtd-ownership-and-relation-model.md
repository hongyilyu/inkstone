# GTD ownership boundaries and the canonical relation read

The GTD backend grew incrementally — Todo/Person/Project entities and Todo Person
References ([ADR-0031](./0031-gtd-todo-person-project-model.md)), the canonical
relation read ([ADR-0032](./0032-gtd-relations-on-entity-list.md)), recurrence
rules and successor generation (ADR-0037/0039), Project Review (ADR-0034),
sentinel-clear updates (ADR-0033), and the backlinks reverse seam
([ADR-0050](./0050-entity-backlinks-read-seam.md)). The pieces are correct but the
*ownership boundaries* — what is an identity table vs. what lives in entity `data`
JSON, which read is canonical, and which invariants each piece guarantees — are
scattered across those ADRs and the code that implements them. Issue #261 asks to
codify the as-built model so timeline/tracker integration has a clean substrate to
build on.

This is a **codifying / pointer ADR**. It changes no schema, no contract, and no
apply logic; it adds no migration. It does **not** supersede 0031/0032/0050 — those
remain the authorities for the model, the canonical list read, and the reverse
seam respectively. This ADR names them as the authorities and records the
ownership boundaries crisply in one place, pinning the load-bearing invariants with
unit tests so the boundaries cannot silently drift.

## Decision

### 1. Identity tables vs. JSON `data`

The `entities` row (`crates/core/migrations/0001_initial.sql:129`) owns Todo,
Project, and Person *identity*: `id`, `type`, `data`, and the create/update
timestamps. `todo_person_refs` (`0001_initial.sql:242`) is the **only** first-class
GTD relation table — at most one row per `(todo_id, person_id)`, with both
`todo_id` and `person_id` FKs declared `ON DELETE CASCADE`
(`0001_initial.sql:243-244`).

Everything else is a field inside the entity `data` JSON, not a column and not a
table:

- Todo: `project_id`, `defer_at`, `due_at`, `recurrence`, `status` and its
  `completed_at` / `dropped_at` timestamps — validated as a whole by
  `validate_todo_data` (`crates/core/src/entities.rs:774`).
- Project: `status` and its `completed_at` / `dropped_at`, plus
  `review_every` / `next_review_at` / `last_reviewed_at` — validated by
  `validate_project_data` (`crates/core/src/entities.rs:562`).

**Why `project_id` is JSON, not an FK column.** Because `project_id` is not a real
foreign key, no pool-level (pre-write) validation can guarantee the named Project
still exists at write time. The apply path therefore **re-checks** the link inside
the open transaction — `recheck_todo_project_link`
(`crates/core/src/db/apply.rs:268`; the WHY is documented at `apply.rs:254`) — and a
Project delete is a **hand-rolled JSON cascade** (`DeleteProject`,
`apply.rs:841`) rather than a database `ON DELETE`. This is the deliberate cost of
keeping the column in JSON. Promoting `project_id` to a real FK column is a
breaking migration, deferred to Follow-ups.

### 2. One canonical relation read

`entity/list` is the **canonical** GTD relation read. A Todo row carries its Person
References as the wire field `EntityRow.person_refs`
(`crates/core/src/protocol.rs:560`), hydrated from `todo_person_refs` by
`entity_row_to_wire` (`crates/core/src/runs/entity.rs:41`); the Todo's owning
Project rides in the same row's `data` as `project_id`. Clients **derive** the
transitive Project↔Person↔Todo relations locally from the single load-all batch
(ADR-0032). This pair — canonical list read plus client-side derivation — is the
single authoritative relation path.

`entity/backlinks` (`handle_backlinks`, `crates/core/src/runs/entity.rs:89`, calling
`db::backlinks_for_entity`) is **not** a competing canonical relation path. It is
explicitly the Inspector **reverse-read** seam ([ADR-0050](./0050-entity-backlinks-read-seam.md)),
fired on detail-open to return the two reverse sets (a Todo/Project/Person's
"Mentioned in" Journal Entries and its linked Todos). It reuses `EntityRow` but
answers a per-entity, on-open access pattern, not the collection read.

### 3. Lifecycle / relation invariants

The guarantees the model holds, each with its enforcing anchor:

- **Status↔timestamp.** A `completed` Project requires `completed_at` and forbids
  `dropped_at`; `dropped` is the mirror; `active`/`on_hold` forbid both —
  `project_status_timestamp_invariant` (`crates/core/src/entities.rs:578`). The
  parallel Todo invariant (`active` has no `on_hold`, otherwise the same shape)
  lives in `todo_status_timestamp_invariant` (`entities.rs:789`).
- **At most one ref per `(todo_id, person_id)`, with `waiting_on ⊇ related`.** A
  `related` ref never downgrades an existing `waiting_on`. De-dup is in
  `deduped_refs` (`apply.rs:216` — `waiting_on` wins; first-seen order preserved),
  applied across both `set` and `add` (`apply.rs:293`), and the persistence-level
  upsert keeps the same rule (`upsert_todo_person_ref` SQL: `role = CASE WHEN
  todo_person_refs.role = 'waiting_on' THEN 'waiting_on' ELSE excluded.role END`).
- **Recurrence successor fires once, carries refs.** A successor spawns ONLY on the
  `active → completed` transition (`apply.rs:386`), so a re-save of an
  already-completed Todo never re-spawns. The successor carries every Todo Person
  Reference forward, role preserved (`apply.rs:463`).

### 4. Proposal update/delete for GTD

- **`update_todo` ref-op precedence** is `set_person_refs` → `add_person_refs` →
  `remove_person_ids` (`apply.rs:363-378`, documented at `apply.rs:293`):
  `set_person_refs` is a wholesale full replace (delete-all, then insert the deduped
  set); `add_person_refs` upserts each ref (upgrade `related`→`waiting_on`, never the
  reverse); `remove_person_ids` deletes each named pair.
- **`delete_project`** unsets `project_id` on every owning Todo (the JSON cascade,
  `apply.rs:841`) and leaves each Todo's `title`/`note` and its `todo_person_refs`
  rows intact.
- **`delete_person`** removes the Person entity; its `todo_person_refs` rows
  cascade away via the FK `ON DELETE CASCADE` (`0001_initial.sql:243`), with no
  explicit ref-delete SQL in apply.

## Invariants pinned by tests

Five unit tests pin the boundaries above. Two already exist (already-passing pins,
not added by this ADR):

- `successor_carries_refs_and_inherits_proposal_authorship` (`apply.rs:1844`) — the
  active→completed successor carries refs forward, role preserved.
- `re_saving_completed_recurring_todo_spawns_no_second_successor` (`apply.rs:2038`)
  — re-saving an already-completed recurring Todo spawns no second successor.

Three are added by this ADR's slice:

- `delete_project_unsets_project_id_keeps_title_note_refs` (apply.rs tests) — the
  JSON cascade drops `project_id` but preserves Todo `title`/`note` and
  `todo_person_refs`, and deletes the Project row.
- `set_then_add_person_refs_replaces_then_upserts_no_downgrade` (apply.rs tests) —
  `set` replaces wholesale, then `add` upserts without downgrading `waiting_on`.
- `rejects_completed_project_with_both_timestamps` (entities.rs tests) — a
  `completed` Project carrying both `completed_at` and `dropped_at` is rejected.

## Follow-ups (deferred, not done here)

- **Promote `project_id` to a real FK.** Moving `project_id` from a Todo `data`
  field to a real `entities`-adjacent FK column (or a Todo↔Project join table) is a
  breaking migration. This ADR **files** it as a follow-up and does **not** perform
  it. Doing so would let the database enforce the cascade currently hand-rolled at
  `apply.rs:841` and drop the in-transaction recheck at `apply.rs:268`. This is
  issue #261's "Identified follow-up migrations" acceptance criterion.
- Generic Tags/Contexts (where/tool/energy) and subtasks/action groups remain
  deferred and are already tracked under ADR-0031's "Deferred" section.

## Related

- [ADR-0031](./0031-gtd-todo-person-project-model.md) — the GTD Todo/Person/Project
  model and the Todo Person Reference; the authority this ADR codifies, not supersedes.
- [ADR-0032](./0032-gtd-relations-on-entity-list.md) — the canonical `entity/list`
  relation read plus client-side Project↔Person↔Todo derivation this ADR names as
  the single authoritative relation path.
- [ADR-0050](./0050-entity-backlinks-read-seam.md) — the per-entity reverse-read
  seam this ADR reclassifies as the Inspector backlink path, not a competing
  canonical relation read.
- [ADR-0033](./0033-user-initiated-entity-crud-writes-directly.md) — the
  sentinel-clear (`null` removes a key) three-way merge `update_todo` uses.
- [ADR-0034](./0034-mark-project-reviewed-write-path.md) — `mark_project_reviewed`
  re-validates the recomputed Project whole through `validate_project_data`.
- [ADR-0037](./0037-todo-recurrence-rule.md) — the durable `recurrence` rule shape
  that lives in the Todo `data` JSON.
- [ADR-0039](./0039-recurring-todo-occurrence-generation.md) — successor generation
  on the active→completed transition, with refs carried forward.
- [#261](https://github.com/hongyilyu/inkstone/issues/261) — codify the GTD
  ownership boundaries; the "Identified follow-up migrations" criterion the
  `project_id`-FK promotion above files.
