# GTD relations ride on entity/list; clients derive Project↔Person↔Todo

ADR-0031 defines the GTD data model: a Todo owns an optional `project_id`, and
Todo Person References (`todo_person_refs`, role `waiting_on`/`related`) record
Person involvement. Project↔Person is *derived* through a Project's Todos, never
stored directly. The V1 product surface (Inbox, Waiting, Review, and the
Person/Project/Todo detail pages) needs to read these relations. This ADR fixes
*how* the read surface gets them.

## Decision

GTD relations are delivered to Clients **on the existing `entity/list` read**,
not through new relation RPCs. Clients **derive** the transitive
Project↔Person↔Todo relations locally.

Concretely:

1. **`person_refs` rides on Todo rows.** Each `entity/list` row of type `todo`
   carries an optional `person_refs: [{ person_id, role }]`, populated by Core
   from `todo_person_refs`. This mirrors the precedent already in the wire shape:
   resolved `refs` ride on `journal_entry` rows (`ResolvedEntityRef` /
   `EntityRow.refs`, ADR-0031's Entity Reference model). `person_refs` is the
   task-relationship analogue for Todos.

2. **`project_id` is already on the row.** It lives in the Todo's `data` JSON
   (ADR-0031: "at most one owning Project"), so no contract change is needed for
   Todo→Project.

3. **Clients derive the rest.** Given the full set of Todos (each with
   `project_id` + `person_refs`), Projects, and People — all already loaded by
   the Library's single read — a Client computes:
   - Project → People: union of `person_refs` across the Project's Todos.
   - Person → Projects: the `project_id`s of the Todos that reference the Person.
   - Person → Todos / Project → Todos: direct filters.

   These are the symmetric derivations ADR-0031 specifies
   (`Project people = Project → Todos → TodoPersonRef → Person`).

4. **No dedicated relation RPCs in V1.** The client derivation above is
   authoritative; no `person/todos`-style RPC is exposed. The speculative
   Core-internal reserve helpers (`project_people`, `person_projects`,
   `projects_due_for_review`) were removed once they had no caller; `todos_by_person`
   / `todos_by_project` survive only because the entity-backlink read (ADR-0050)
   uses them. If a future need (server-side pagination, a non-load-all Client)
   makes derivation untenable, the reserve helpers are re-added then — a small,
   reversible change — superseding this ADR.

## Rationale

- **The Library already loads everything.** `useLibraryItems` fetches all Todos,
  People, Projects, and Journal Entries in one batch and derives relations
  client-side today (`todosForProject`, `projectsForPerson`). Adding `person_refs`
  to the Todo row completes the picture with **one optional field** rather than a
  family of endpoints. The data volume is a single user's entities — small enough
  that load-all-derive is the simpler correct design (ADR-0007, local-first
  single-user).

- **Consistency with the journal-refs precedent.** Resolved references already
  ride on `entity/list` rows for Journal Entries. Putting Todo `person_refs` on
  the same read keeps one read path, not two.

- **Avoids premature RPC surface.** A `person→todos` / `project→people` RPC set
  would be N round-trips per detail page and a wider contract to maintain, for no
  capability the derivation lacks. The client derivation is authoritative; if a
  future need (server-side pagination, a non-load-all Client) makes it untenable,
  the reserve helpers are re-added and promoted to RPCs then — superseding this ADR.

## Consequences

- The protocol's Todo row shape gains optional `person_refs`. Absent/empty means
  "no Person involvement"; consumers must treat it as optional (older rows, the
  preview path, and Projects/People rows never carry it).
- Relationship logic lives in the web view-model layer (`libraryItems.ts`), not
  duplicated across Core and web. Core owns the *storage* invariants
  (one ref per `(todo_id, person_id)`, `waiting_on` ⊇ `related`); the web owns the
  *derivation* for display.
- Project↔Person is never a stored or wire-level direct link — only a derivation,
  preserving ADR-0031's "no direct Project-Person references" decision.

## Amendment: topic-grouped client presentation (ADR-0054, 2026-06-27)

[ADR-0054](./0054-topic-navigation-browse-axis.md) (the v1 "Today home base"
hub-and-spoke shell) replaces the flat Library sidebar with a Topic browse axis
(Today / GTD / Timeline / Health / Media). This changes only how the client
*presents* the derived relations this ADR delivers — the derived
Project↔Person↔Todo views (Inbox, Waiting, Scheduled, Review) become in-view
filters under the **GTD** topic rather than flat sidebar entries.

The read contract is **unchanged**: GTD relations still ride on the single
`entity/list` batch (`person_refs` on Todo rows, `project_id` in Todo `data`),
and clients still derive the transitive relations locally per the Decision above —
one load-all-derive read, no relation RPCs, no new storage. The topic grouping is
a pure web view-model concern layered over the same rows.

This annotation does **not** supersede this ADR; ADR-0054 is presentation-only and
adds no contract delta. See ADR-0054 for the topic model.

## Considered and rejected

- **Dedicated relation RPCs** (`person/todos`, `project/people`,
  `person/projects`). Rejected for V1: more round-trips, wider contract, and the
  Client already holds every row needed to derive the same answer. A reserve
  helper is re-added behind the seam if a Client ever can't load everything.
- **A standalone `todo_person_ref/list` RPC.** Rejected: it splits one logical
  read (a Todo and its refs) into two calls and re-introduces the N+1 the
  on-row `person_refs` avoids.
- **Resolving `person_refs` to embedded Person snapshots on the row** (name, etc.,
  like journal `refs` carry `target_title`). Rejected for V1: the Client already
  loads all People, so it joins by `person_id` locally; shipping only
  `{person_id, role}` keeps the Todo row lean and the Person the single source of
  its own display data.

## Related

- [ADR-0031](./0031-gtd-todo-person-project-model.md) — the GTD Todo/Person/Project
  model and the Todo Person Reference these relations read from.
- [ADR-0004](./0004-three-tier-storage-authority.md) — `entity/list` reads tier-2
  canonical state; derivations are tier-3 concerns computable by any reader.
- [ADR-0007](./0007-local-first-single-user.md) — single-user local-first scale is
  why load-all-derive beats a relation-RPC surface.
- [ADR-0014](./0014-client-core-wire-protocol.md) — the Client↔Core wire protocol
  `person_refs` extends.
- [ADR-0055](./0055-gtd-ownership-and-relation-model.md) — names this `entity/list`
  read (plus client derivation) as the single canonical GTD relation path and
  reclassifies `entity/backlinks` as the reverse-read seam, not a competing path.
