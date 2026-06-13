# Mark-project-reviewed: a Core-owned review-advance write path

/ builds on [ADR-0031](./0031-gtd-todo-person-project-model.md), [ADR-0033](./0033-user-initiated-entity-crud-writes-directly.md)

ADR-0031 gave Projects a review ritual (`review_every`, `next_review_at`,
`last_reviewed_at`) and a Workspace review anchor (Sunday 20:00 local). The
Review view shipped read-only: it could surface what was due but had no way to
*close the loop* — "I reviewed this; schedule the next one." This ADR adds that
write.

## Decision

A user marking a Project reviewed sends one `entity/mutate` request with
`mutation_kind: "mark_project_reviewed"` and an `{entity_id}`-only payload. The
client sends **no review data**: Core reads the Project and recomputes the review
fields itself, in one transaction:

- stamp `last_reviewed_at = now` (local wall-clock at the review anchor offset);
- set `next_review_at` to the next Sunday 20:00 **strictly after now** (the
  Workspace anchor), via `entities::advance_review_at_local`;
- ensure `review_every = {interval: 1, unit: "week"}` when absent, materializing
  the default weekly cadence so a Project that had a bare `next_review_at` reads
  consistently with a freshly-seeded one; an existing cadence is preserved.

It rides the existing user write path (ADR-0033): `entity/mutate` → `validate` →
run-independent target check (`entity_id` must resolve to a Project) →
`db::apply_entity_mutation` with `created_by='user'`, `proposal_id = NULL`. It
joins `update_todo` and the reference kind as a **read-modify-write** branch that
computes its data inside the tx (it needs committed state + the in-tx anchor
offset), not at the pre-write payload seam.

## Why Core owns the date math, not the client

The review cadence is a domain rule Core already owns: it seeds `review_every` +
`next_review_at` at create time, the anchor offset is a Core setting
(`review_anchor_utc_offset_minutes`, never exposed to clients), and the calendar
helpers live in `entities.rs`. If the client computed `next_review_at` and sent a
plain `update_project`, every client (web, future TUI/mobile, the agent) would
reimplement Sunday-anchored, offset-aware date math — and the web client cannot
even see the offset. A client sending intent (`entity_id`) and Core owning the
advance keeps one authority for the rhythm and one place to evolve it.

## Seed vs. advance: two anchor helpers, not one

Create-time seeding and review-advance are NOT the same date computation, so they
use distinct helpers:

- `next_review_at_local` (seed, ADR-0031): the Sunday-20:00 anchor at or after
  now, where a Sunday *before* 20:00 resolves to that **same** evening — a new
  Project should get its first review this week, not wait up to seven days.
- `advance_review_at_local` (advance, this ADR): always the **strictly-future**
  Sunday — reviewing on a Sunday (any time of day) schedules the *following*
  Sunday. Reusing the seed helper here was a real bug: a Project reviewed on a
  Sunday afternoon would get `next_review_at` = that same evening, and the web due
  predicate (`next_review_at <= now`) would re-surface it in the Review view hours
  later. The advance must move the rhythm forward, never land on today.

## Why weekly-only advance (for now)

The advance snaps to a Sunday 20:00 — coherent for the weekly cadence, which is
the **only** cadence any Project can currently have: the UI can't set
`review_every`, and create-time seeding only ever writes weekly. A non-weekly
`review_every` (month/year) is reachable only if the agent sets it, which nothing
does today. So `mark_project_reviewed` always advances to the next Sunday and
ensures the weekly cadence, rather than building and testing arbitrary-interval
calendar math for a case that cannot occur (per the repo's simplicity-first /
early-stage principles). When a non-weekly Project becomes real, extend the
advance to branch on `review_every.unit`; this ADR is the seam.

## Why a dedicated `mutation_kind`, not `update_project`

`update_project` is a full-document **replace** (ADR-0033): the client must send
the complete intended document. A "mark reviewed" that went through it would make
the web client author the cadence math *and* round-trip every Project field,
risking a dropped field on every review. A bespoke `{entity_id}`-only kind makes
the wire minimal and the write authoritative — the same shape as the deletes,
sharing the `validate_entity_id_only` validator.

## Why user-path only (absent from the agent schema)

`mark_project_reviewed` is deliberately **not** in the `propose_workspace_mutation`
tool schema, so the agent cannot emit it. Marking a Project reviewed is a user's
deliberate GTD ritual, not something the Worker proposes; keeping it off the agent
surface keeps the slice tight. The shared `entities::validate` /
`apply_entity_mutation` plumbing still accepts it (the agent path simply never
constructs one), so re-exposing it to the agent later is additive.

## Consequences

- **Reviewability guard.** Core rejects `mark_project_reviewed` on a
  `completed`/`dropped` Project with `InvalidMutation` (-32602): only active and
  on-hold Projects are reviewable (ADR-0031), and the Review view never lists a
  terminal one, so such a request is a stale/buggy client. An absent status
  defaults to active (mirrors create-time).
- **Defense in depth.** The recomputed Project data is re-validated as a whole
  (`validate_project_data`) before the write, so a review can never persist an
  invalid Project even if the stored data drifted.
- **Target-gone is `TargetMissing`.** A `mark_project_reviewed` against a Project
  deleted concurrently surfaces `TargetMissing` (the same primary-target-gone case
  as `update_todo`/`update_project`), distinct from a DB fault.
- **No new wire surface.** `entity/mutate`'s payload is opaque at the protocol
  boundary (`{mutation_kind, payload}`); Core validates per kind. No protocol
  schema, SDK method, or migration changes — only a new `mutation_kind` value.
- **Cross-client refresh** stays as ADR-0033 left it: the mutating client
  self-invalidates (`["library-items"]`); `entity/changed` remains deferred under
  single-user (ADR-0007).
