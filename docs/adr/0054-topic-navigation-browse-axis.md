# Topic navigation replaces the flat entity-type Library as the browse axis

/ builds on [ADR-0031](./0031-gtd-todo-person-project-model.md), [ADR-0032](./0032-gtd-relations-on-entity-list.md), [ADR-0030](./0030-journal-entry-anchored-capture.md), [ADR-0050](./0050-entity-backlinks-read-seam.md), [ADR-0053](./0053-observation-records.md), [ADR-0042](./0042-url-addressable-threads.md), [ADR-0021](./0021-web-client-styling.md), [ADR-0007](./0007-local-first-single-user.md), [ADR-0004](./0004-three-tier-storage-authority.md)

Inkstone has two independent axes (see `docs/plans/topics/MODEL.md`). The **capture
axis** — `Chat → Journal → proposals → { entities, observations }` — is unchanged:
the Journal is the load-bearing spine and an observation (bodyweight, intake…) is a
derivative of that flow exactly as a Todo is. The **browse axis** is how you navigate
what accrued, and until now it mirrored the *system* model rather than the *user's*
intent: the left nav was a flat list of entity types (`KIND_ORDER` —
Journal · People · Projects · Todos · Bookmarks as equal rows), with the GTD
processing views (Inbox · Waiting · Scheduled · Review) bolted on as additional
top-level rows under `/library/*`. That surface was labelled "Library."

"Library" was never a domain term — there is no Library Entity, no Library table, no
Library in any other ADR. It was a UI container that leaked the closed
`EntityType` enum (ADR-0031: Journal Entry · Person · Project · Todo · Bookmark · Habit)
straight onto the screen as navigation. As Inkstone grows into tracker domains
(ADR-0053 Observations: bodyweight, nutrition, exercise, …) the flat-row model breaks:
every new tier-2 family would demand a new nav row, and the model already double-counts
(Person and Project are equally "GTD collaborators" and "Timeline interaction history,"
but a flat list can only file each entity under one row).

This ADR fixes the **browse axis**: navigation is organized around a curated set of
**topics**, and the flat entity-type Library is retired as a UI concept. It changes no
storage, no Core verb, and no wire contract — it is a presentation decision over the
reads that already exist.

## Decision

**Topic navigation replaces the flat entity-type Library as the primary browse axis.**

1. **Topics are a fixed, curated set: `{ Today, GTD, Timeline, Health, Media }`.**
   Not extensible by configuration; there is no topic-builder and no per-item tagging.
   Adding or removing a topic is a deliberate design act in code — the topic set is
   closed the same way the `EntityType` enum is closed (ADR-0031). Openness lives
   *inside* a topic (e.g. Health holds open-ended observation streams), never in the
   topic set itself. Membership is automatic by type; a topic is "show me these types,
   rendered this one way."

   - **Today** is a global daily landing *above* the topics — a real aggregate over the
     existing reads (live counts, a cross-topic glance, and the day's Todos). It spans
     every topic; it is not itself a type-filter.
   - **GTD** — Todo · Project · Person (via `todo_person_refs`). Action board / lists.
   - **Timeline** — Journal Entry · Person · Project, rendered chronologically.
   - **Health** — observation streams (ADR-0053). Placeholder until #253; its
     interior IA (the deferred questions below) is resolved in
     `docs/plans/observation-ui/NAV.md`.
   - **Media** — read/watch queue. Placeholder until #252.

2. **A topic is a client-side presentation/projection over the existing reads — NO
   backend or contract change.** Every topic view is computed in the web view-model
   layer from the single `entity/list` batch and observation reads the client already
   loads, plus the client-side derivations that already exist in `libraryItems.ts`
   (`inboxTodos`, `waitingTodos`, `scheduledTodos`, `projectsForReview`,
   `todosForProject`, `projectsForPerson`, …). This is the load-all-derive stance of
   ADR-0007 and ADR-0004 applied to navigation. **The read contract from ADR-0032
   stands unchanged**: GTD relations still ride on `entity/list` rows (`person_refs` on
   Todos, `project_id` in Todo `data`) and clients still derive Project↔Person↔Todo
   locally. The only thing that changes is that the presentation is now *explicitly
   topic-grouped* instead of type-grouped. (This is the key relationship to ADR-0032:
   it is annotated, not superseded — see Related.)

3. **The derived GTD views (Inbox · Waiting · Scheduled · Review) remain
   client-derived per ADR-0031/0032, now surfaced as in-view filters inside GTD.** They
   stop being separate top-level nav rows. The predicates are unchanged
   (`is_inbox_todo`, the `waiting_on` view, the availability-gate complement for
   Scheduled, `next_review_at <= now` for Review); only their *placement* moves — from
   four sibling rows to four filter affordances within the GTD signature view. There is
   no new state and no new derivation: Inbox/Waiting/Scheduled/Review are exactly the
   functions that exist today, re-homed.

4. **Timeline is a derived chronological read projection — no new storage.** It is a
   client-side ordering of Journal Entries (and the Person/Project entities they touch)
   by their existing time fields (`occurred_at`, `created_at`) plus the existing
   provenance reads (Entity Source / Entity Reference, ADR-0030; entity backlinks,
   ADR-0050). No timeline table, no timeline verb, no new wire field. Timeline proves
   the "same entity, different lens" claim: a Person under GTD is a task collaborator;
   the same Person under Timeline is an interaction history — one entity, two
   projections.

5. **Health and Media are honest placeholders until their backing surfaces land.**
   They ship as thin "coming soon" panels that link to their tracking issues — Health →
   [#253](https://github.com/hongyilyu/inkstone/issues/253) (the Observations read
   surface, ADR-0053, deferred) and Media → [#252](https://github.com/hongyilyu/inkstone/issues/252)
   (the Bookmark→Media replacement, deferred). They render **no fake data**; an empty,
   labelled stub that names its issue is more honest than a mocked dashboard, and it
   reserves the topic's place in the nav so its arrival is additive, not a re-layout.

6. **"Library" is retired as a UI concept.** It was never a domain term — only a
   container that exposed the entity-type enum as navigation. The shell, the nav rows,
   and the user-facing vocabulary drop "Library"; the word does not survive as a label.
   (The `/library/*` route *segment* is kept as the layout-route mount point to avoid
   gratuitous route churn and preserve URL-addressable deep links — see Consequences;
   it is an implementation path, not a user-facing concept.) The entity *types* are
   unchanged (ADR-0031); only the screen that listed them flatly is gone.

The final nav, top to bottom (from the locked `MODEL.md`):

```text
Chat · Search (Cmd-K)
--------
Today                         <- global daily landing (spans all topics)
---- Topics ----
GTD        Timeline
Health     Media
--------
account · Settings · theme toggle
```

## The real trade-off

The flat Library navigated the **system model** (entity types — what the data *is*).
Topics navigate **user intent** (workflows and collections — what the user is *doing*).
These genuinely differ, and the choice has a cost: an entity that the system models as
one type (a Person) appears under multiple topics (GTD *and* Timeline), and a flat
"People" row — a single, obvious home for every Person — is lost. We accept that loss.
A type-keyed nav is honest about storage but dishonest about use: it forces the user to
know which *type* an item is before they can find it, and it cannot express that the
same Person matters in two different workflows.

The second axis of the trade-off is **depth vs breadth**. A topic opens straight into
one bespoke signature view (depth) rather than a breadth-first index of every member
type's cards. You reach a member type as an in-view filter, not as a separate
drill-down page. This is deliberate (MODEL.md decision 9): five equal type panels is the
SaaS-dashboard anti-pattern the whole topic model exists to avoid. The cost is that
"show me literally every Bookmark, ungrouped" is no longer a first-class destination —
which is acceptable because that was a developer's view of the data, not a user's task.

## Consequences

- **Future tier-2 families get a topic home, not a flat row.** When Observations
  (ADR-0053) land, exercise/intake/bodyweight surface *inside* Health, not as five new
  sidebar rows. The nav does not grow with the type/schema count — it grows only when a
  genuinely new *workflow* is added, which is rare and deliberate. This is the property
  the flat model lacked.
- **The read contract is untouched, so this feature is purely additive to Core.** No
  migration, no protocol struct, no parity-gate slice, no ui-sdk change. If any slice is
  found to need a contract change, that is a signal the slice has drifted from this ADR
  and must be re-scoped. (Verified: every topic view is computable from existing reads +
  existing `libraryItems.ts` derivations.)
- **The route segment `/library/*` is kept; only the four derived workflow routes are
  retired.** New topic routes (`/library/gtd`, `/library/timeline`, `/library/health`,
  `/library/media`) are children of the existing `/library` layout route, which already
  owns `WorkspaceShell` + the rail-on-selection machinery. Home stays `/library` (Today).
  The `$kind` entity collections (`/library/people|projects|todos|bookmarks|journal`) are
  kept verbatim — they are the canonical entity browser the detail rail, `CommandPalette`,
  and `library.spec.ts` depend on. `/library/{inbox,waiting,scheduled,review}` redirect to
  `/library/gtd?filt=…`. Relocating to a fresh `/today`,`/gtd`,… top-level tree was
  rejected: it breaks `library.spec.ts` + `CommandPalette` + `_chat` wiring for zero
  contract benefit — the mock's route *names* were never a contract.
- **e2e nav selectors are rewritten where the nav changed.** `apps/web/e2e/library.spec.ts`
  is the one real web e2e spec (the prompt's `gtd-views`/`scheduled-view`/`project-review`
  specs do not exist). It keeps `/library` + the "Today" heading + `/library/people|projects|todos`;
  the nav-row rename touches its `navigation` link premises, fixed in the cutover slice. e2e
  is not the CI gate (smoke.spec fails at base) — the gate is vitest — but a slice that
  breaks a pinned spec owns the fix.
- **`routeTree.gen.ts` is regenerated by vite, never hand-edited.** New topic route files
  drive the regeneration.
- **The styling system is unchanged (ADR-0021).** Topics render through the existing
  Lamplit Desk tokens and the `NavShell` / `WorkspaceShell` shells; this ADR replaces a
  *nav model*, not a design system. No new primitive kit, no token churn.
- **"Library" leaves the user-facing vocabulary.** Labels that said "Library" now say the
  topic name. The entity-type enum is unaffected.

## Considered and rejected

- **Keep the flat type list and add topics alongside it.** Rejected: this double-lists
  GTD content (a Todos row *and* a GTD topic), which is exactly the ambiguity the unify
  session resolved against (MODEL.md, decision B). One axis owns navigation; the topic
  axis wins because it expresses user intent.
- **Make topics user-configurable (a topic-builder / tagging).** Rejected: openness
  belongs *inside* a topic, not in the topic set. A curated closed set keeps each topic's
  signature view bespoke and meaningful; an arbitrary user-defined topic would collapse
  back into the generic "show me a filtered list" surface topics exist to replace.
- **A backend "topic membership" field or topic-scoped read RPCs.** Rejected: membership
  is automatic by type and fully derivable client-side from reads that already load
  everything (ADR-0004/0007/0032). Storing or serving topic membership would add a
  contract surface for zero capability the derivation lacks — the same reasoning ADR-0032
  used to reject dedicated relation RPCs.
- **Relocate routes to a fresh `/today`,`/gtd`,… top-level tree.** Rejected: needlessly
  breaks `library.spec.ts` + `CommandPalette`/`_chat` wiring for no contract benefit. The
  topic routes mount under the existing `/library` layout instead.
- **Ship Health/Media with mocked data so the nav "looks complete."** Rejected: fake
  data is dishonest and creates a false impression of a working surface. A labelled stub
  that names its tracking issue is the honest placeholder, and it makes the real
  surface's arrival additive rather than a teardown of a mock.
- **A single global firehose Timeline instead of a topic.** Rejected: Timeline is a
  curated projection (Journal Entry · Person · Project rendered chronologically), one of
  the closed topic set — not an undifferentiated event stream (MODEL.md, decision 7).

## Related

- [ADR-0031](./0031-gtd-todo-person-project-model.md) — the GTD Todo/Person/Project
  model and the derived Inbox/Waiting/Review views that GTD's in-view filters surface.
- [ADR-0032](./0032-gtd-relations-on-entity-list.md) — GTD relations ride on
  `entity/list`; clients derive Project↔Person↔Todo. **This ADR annotates, and does not
  supersede, 0032**: the read contract stands; only the presentation becomes
  topic-grouped instead of type-grouped.
- [ADR-0030](./0030-journal-entry-anchored-capture.md) — Journal Entry provenance
  (Entity Source / Entity Reference) that Timeline's chronological projection reads.
- [ADR-0050](./0050-entity-backlinks-read-seam.md) — entity-backlink read seam Timeline
  draws on for "mentioned in" history.
- [ADR-0053](./0053-observation-records.md) — Observation records (the Health topic's
  eventual backing; UI navigation is decoupled from both entity types and observation
  schemas, which is precisely what topics deliver). Tracked: [#253](https://github.com/hongyilyu/inkstone/issues/253).
  Health's interior IA (one schema-grouped surface, no per-schema nav) is resolved in
  `docs/plans/observation-ui/NAV.md`.
- [ADR-0042](./0042-url-addressable-threads.md) — the `_chat` / `library` layout-route
  pattern (`WorkspaceShell` + `<Outlet/>`, children read params/search) the topic routes
  follow.
- [ADR-0021](./0021-web-client-styling.md) — Lamplit Desk styling system topics render
  through, unchanged.
- [ADR-0007](./0007-local-first-single-user.md) / [ADR-0004](./0004-three-tier-storage-authority.md)
  — single-user local-first load-all-derive scale is why topic projection is a
  client-side concern, no new read surface.
- Media replacement (Bookmark→Media): [#252](https://github.com/hongyilyu/inkstone/issues/252).
- Frozen topic model: `docs/plans/topics/MODEL.md`.
