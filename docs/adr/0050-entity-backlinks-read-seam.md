# ADR-0050: Entity backlinks read seam

Status: Accepted
Date: 2026-06-24
Issue: #182

## Context

The Entity Detail Inspector turns a selected Library item into a panel of its
relations. Today those relations are derived **client-side** by scanning the
already-loaded `allEntities` set: `journalEntriesMentioning` walks every Journal
Entry's body for an `entity_ref` targeting the entity ("Mentioned in");
`todosForPerson` / `todosForProject` filter todos by `person_refs` / `project_id`
("Waiting on" / "Tasks" / "Todos"). Two consequences:

- **A real bug.** `ProjectBody` never rendered "Mentioned in" — the section that
  Person and Todo bodies show — so a Project referenced by journal entries looked
  context-free.
- **The reverse data already lives in Core.** `journal_entry_refs_targeting`
  (the `entity_refs` reverse lookup) exists but is called only from the
  delete-cascade; `todos_by_project` / `todos_by_person_ref` exist for the
  derived Library views. The client scan re-derives, from a fanned-out
  `entity/list`, what Core can answer authoritatively in one read.

[ADR-0032](./0032-gtd-relations-on-entity-list.md) attached GTD relations
(`refs`, `person_refs`, `source`) **onto every `entity/list` row** so the Library
collections render without a second call. Backlinks are a different access
pattern: they are only needed when one entity's detail panel is open, and an
entity referenced by many journal entries/todos would bloat *every* list row with
data shown on one screen. [ADR-0042](./0042-intent-graph-journal-extraction.md)
already announced that "entity views move to backlinks … the Captured-from footer
is retired for graph-created entities (separate downstream work)" — this is that
work.

## Decision

Add a dedicated **`entity/backlinks { entity_id }`** client-surface read,
fired on detail-open, returning the two reverse sets Core resolves
authoritatively:

```rust
EntityBacklinksResult {
  mentioned_in: Vec<EntityRow>,   // distinct Journal Entries referencing this entity
  linked_todos: Vec<EntityRow>,   // Todos linked to this entity (project_id / person_refs reverse)
}
```

- **Dedicated RPC, not list-fattening.** Backlinks ride their own per-entity read
  rather than extending `entity/list` rows (ADR-0032's pattern). Detail-open is
  the only consumer; keeping list reads cheap matters more than saving a round
  trip on a panel the user explicitly opened. This is a deliberate departure from
  ADR-0032 for a relation set with a narrower access pattern.
- **Narrow scope.** Core resolves only the two reverse sets. The *joined*
  derivations the inspector also shows — Person→Projects, Project→People (both
  walk Todos), and Project Progress (an aggregate over Todos) — stay client-side
  over the `linked_todos` set plus `allEntities` (already loaded for editor
  pickers). Core does the reverse lookups; the client does the cheap joins it
  already had.
- **Reuse `EntityRow`.** Each section is `Vec<EntityRow>` — the wire shape already
  in the parity gate (ADR-0032) — so the Web client parses rows through the
  existing `entityCodec` and renders them through the existing `RelatedRow`.
  `person_refs` ride along on Todo rows, so the Person "Waiting on" vs "Tasks"
  GTD split (ADR-0031) survives off the Core set with no new field.
- **`mentioned_in` is distinct.** `journal_entry_refs_targeting` returns one row
  per `entity_ref`; a Journal Entry that names an entity twice would otherwise
  list twice. The read collapses to distinct Journal Entries, newest-occurred
  first; `linked_todos` is newest-first.
- **Which kinds.** Only Person, Project, and Todo are `entity_ref` targets (the
  schema CHECK), so only those three fire the read. Journal Entry is the *source*
  of mentions (it keeps its body + ref-chips); Bookmark is a read-only leaf.
- **Footer narrowing.** The Inspector's "Captured from" footer drops its
  `journal_entry`-source branch (the legacy JE-anchored create's origin link — its
  relationship now surfaces canonically under "Mentioned in"). It keeps the
  `thread`-source branch, which [DESIGN.md](../../DESIGN.md) pins as an Inspector
  signature (the chat→knowledge origin link). This is a **display change only**:
  the `entity_sources` row is never deleted. That row is the sole input to the
  cross-thread write guard `journal_entry_target_is_valid` (ADR-0030/0042), which
  reads the JE→user-Message link untouched by any footer-display change.

## Consequences

- A Project referenced by journal entries now shows "Mentioned in", uniform with
  Person and Todo. The client `journalEntriesMentioning` scan is removed (dead
  once Mentioned-in is Core-sourced).
- The inspector's backlink-derived sections become async. Sync fields render
  immediately; backlink sections appear on arrival (sub-perceptible on a local
  WebSocket). On a **fetch error**, the inspector degrades gracefully — it falls
  back to the existing `todosForPerson`/`todosForProject` client derivations for
  Waiting/Tasks/Todos/People/Progress, so relations are never lost; only the
  canonical "Mentioned in" (which has no client equivalent on Project) is omitted.
  Those two client helpers are therefore retained as the documented fallback.
- A new wire result joins the parity gate (`EntityBacklinksResult`); `EntityRow`
  is reused, so only the wrapper is added (Rust + TS + fixture, atomically).
- Backlink freshness piggybacks on the existing `["library-items"]` invalidation:
  the two sites that already invalidate it on a write (`useEntityMutation`,
  `AssistantProposals` accept) also invalidate `["entity-backlinks"]`. Live
  `entity/changed` push is out of scope.

## Alternatives considered

- **Fatten `entity/list` rows with backlinks (extend ADR-0032).** Rejected: every
  list row would carry data shown only on detail-open; a high-degree entity bloats
  the whole collection read. The access pattern is per-entity-on-open.
- **Have Core resolve the full inspector body (Person→Projects, Progress, …).**
  Rejected (narrow scope above): pulls transitive joins and an aggregate into Core
  SQL for no authority gain — the client already holds `allEntities` for pickers
  and can do the joins. Bigger blast radius and parity surface.
- **Slim display rows / id-only returns.** Rejected: slim rows duplicate
  title/subtitle formatting that lives in TS; id-only keeps display dependent on
  `allEntities`, so it wouldn't actually retire the scan. `EntityRow` reuse keeps
  one currency and one codec.
- **Retire the whole Captured-from footer.** Rejected: DESIGN.md pins the
  `thread` branch as an Inspector signature and it is the only chat→knowledge
  origin affordance.

## Related

- [ADR-0030](./0030-journal-entry-anchored-capture.md) — provenance / the
  cross-thread guard input that the footer never deletes.
- [ADR-0032](./0032-gtd-relations-on-entity-list.md) — the list-fattening read
  this RPC deliberately departs from for a narrower access pattern.
- [ADR-0042](./0042-intent-graph-journal-extraction.md) — announced the
  backlink move and the graph-entity footer retirement this implements.
- #216 — "close the entity read seam"; this read joins that surface.
