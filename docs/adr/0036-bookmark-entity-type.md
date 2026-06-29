# Bookmark: a small user-curated Entity Type, replacing the `recipe` placeholder

/ superseded by [ADR-0059 (media-entity-type)](./0059-media-entity-type.md) — Bookmark is replaced outright by the richer Media queue+log type (#252). The decisions below (user-CRUD-only, ungated parity, full-document replace, not journal-referenceable, the dispatch-table fan-out) carry forward to Media verbatim; only the field shape and the lifecycle state machine are new.

The Library's `recipe` kind was visual-only scaffolding — a mock fixture with no
Core schema, validator, or `mutation_kind`, and the one Library kind never read
live (`useLibraryItems` fetches `journal_entry`/`todo`/`person`/`project` only),
which is why issue #119's preview mocks could not be deleted without blanking the
Recipes collection. We replace it with **Bookmark**: a real, persisted Core-backed
Entity Type for an outward-pointing thing the user saved to return to. Bookmark
data stays small — required `title`, optional `url`, `note`, `tags` — mirroring
Person's minimal shape, and rides the same Entity path People/Projects/Todos use.

## Decision

- **A new Entity Type `bookmark`**, stored as polymorphic JSON in `entities.data`
  (ADR-0017) with `schema_version = 1`. No new table; it rides the generic
  create/update/delete + `list_by_type` machinery.
- **Shape** (validator modeled on `validate_person`, entities.rs): `title`
  required-non-empty; `url`, `note`, `tags` optional and **clearable** (the
  ADR-0033 `null`-sentinel-clear contract; apply strips null keys so stored JSON
  never holds null). Allow-listed keys; any other field rejected. **No URL-format
  validation** — a present `url` need only be a non-empty string, matching the
  domain's documented restraint (ADR-0031): Core stores, it does not parse.
- **Update is full-document replace** (like Person/Project, not Todo's
  partial-merge): the editor sends the complete `data`; Core validates and replaces.
- **User-CRUD-only**, following the `mark_project_reviewed` precedent (entities.rs):
  Bookmark lives in `entities::validate` + the `entity/mutate` path but is
  deliberately **absent from the agent's `propose_workspace_mutation` and
  `search_entities`**. The Worker does not author Bookmarks in the first model.
- **Manually creatable from the Library** (`BookmarkEditor` modeled on
  `PersonEditor`; added to `CREATABLE_KINDS`). Since the agent can't author them and
  the mocks are deleted, the manual create is the *only* path a Bookmark can exist —
  without it the collection would be permanently empty.
- **Goes live** end-to-end: `useLibraryItems` adds `client.listEntities("bookmark")`
  and a `toLibraryBookmark` adapter (defensively defaulting fields so a live row with
  missing `data` cannot crash the inspector, the trap the old non-optional
  `recipe.ingredients` array masked), plus a `hasLiveBookmarks` gate in the per-kind
  preview-replace merge.

## Why Bookmark, and why this shape

The documented domain sorts stored things into capture-derived event records
(Journal Entry), user-curated standalone Entities with their own state
(Person/Project/Todo), and derived non-Entity views (Daily Note, Inbox). A
replacement belongs in the middle bucket, and Person is its proven minimal
template. "Recipe" was only ever an `etc.` illustration in the glossary, not a
committed type; a literal Recipe (`ingredients[]`, `servings`) is a niche schema
with no stated product need for a local-first LLM/system-design thinking surface.
A Bookmark is the most general *defensible* "thing worth returning to": it earns
its own kind by being outward-pointing (the `url`), which is what distinguishes it
from a hypothetical free-text Note and from a Journal Entry's inward event record.

## Naming

The kind is **Bookmark**, not Reference/Source/Link. Those words are taken or
banned by the existing glossary: **Entity Reference** is a Journal Entry's inline
pointer at a Canonical Entity, **Entity Source** is the provenance relation, and
both already list `source`/`reference`/`link` in their *Avoid* lines. Reusing any
of them would make one word mean two things in the same glossary — the exact
ambiguity the domain language exists to prevent.

## Consequences

- **No `entity_source` row** on a plain Library create (`created_by='user'` is the
  origin marker, per ADR-0033) — a user-saved Bookmark has no Message or
  Journal-Entry anchor.
- **No `capturedFrom` footer** in the inspector for Bookmarks: `entity/list`
  returns only `id/type/data/created_at/updated_at`, with no thread-capture wire
  field. Acceptable — a user-created Bookmark was not captured from a Thread.
- **Chronological ordering.** The collection sorts by `recency = created_at`, not
  the authored ordering the mock fixtures encoded.
- **Not journal-referenceable in V1.** Referenceable target types stay
  `{person, project, todo}` (mutation_target.rs). Bookmark is not added to that
  set, nor to the Web `targetKind` union — speculative until a real "Journal Entry
  points at a Bookmark" flow exists, and the agent (which authors references)
  doesn't touch Bookmarks anyway.
- **Dispatch-table risk.** Core has no central Entity-type enum; identity is a
  `mutation_kind` string threaded through several `match` tables in entities.rs
  (and db/), most ending in `unreachable!()` that **panics at apply time** on a
  missing arm. Wiring `bookmark` means adding an arm to *every* such table —
  `validate`, `render_accept`, `schema_version`, `entity_type`,
  `source_relation_from_user_message`, `target_entity_id` — plus mutate.rs,
  mutation_target.rs, and db/apply.rs.

## Considered and rejected

- **Keep `recipe` literally** (make the mock shape real) — zero UI churn, but a
  niche `ingredients`/`servings` schema with no generality and no product need;
  contradicts the restraint that kept Person small (ADR-0031). Rejected.
- **A free-text Note** (title + body, no url) — more general but less defensible as
  its *own* kind: without the outward `url` it is hard to distinguish from a
  Journal Entry or a Todo's note, and risks becoming a junk-drawer "any object".
  Rejected in favor of the url-bearing Bookmark.
- **Name it Reference / Source / Clipping / Resource** — Reference/Source collide
  with core provenance vocabulary; Resource is vague and off-brand. Rejected.
- **Agent-proposable in V1** — roughly doubles the Core surface (two compile-checked
  enums + Create/Update/Delete payload structs + search) for no stated chat flow.
  Deferred; promote later if a real flow needs the agent to author Bookmarks.
