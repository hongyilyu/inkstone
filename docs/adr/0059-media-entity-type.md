# Media: a queue+log Entity Type, replacing Bookmark

/ supersedes [ADR-0036 (bookmark-entity-type)](./0036-bookmark-entity-type.md)

Bookmark (ADR-0036) is `{title, url?, note?, tags?}` — an outward-pointing thing
the user saved, with **no lifecycle**. The topic-navigation work (ADR-0054)
gives the Library a curated **Media** topic, but Core has no `media` type, and a
bookmark — a flat saved link — has no honest home in a "read/watch queue." Rather
than ship a fake Media surface or strand bookmarks beside it, we **replace the
Bookmark concept with a richer Media Entity Type**: a queue + log of things to
read and watch, carrying a `medium`, a lifecycle `state`, and an optional finish
`rating`. Bookmark's exact shape is a strict subset (a `link` in `done`-ish
states), so this is a clean widening of the same slot, not a parallel surface.

This is a **pre-release replacement** (CLAUDE.md §5): there is no bookmark data
to preserve, so Bookmark is removed outright rather than bridged.

## Decision

- **A new Entity Type `media`** (stored `entities.type = "media"`), replacing
  `EntityType::Bookmark`. Stored as polymorphic JSON in `entities.data`
  (ADR-0017) with `schema_version = 1`. No new table — it rides the generic
  create/update/delete + `list_by_type` machinery, exactly as Bookmark did. The
  name reuses the same noun as the ADR-0058 `media` binary-attachment table, but
  the two are **unrelated**: `entities.type` is a free-TEXT discriminator, not an
  FK, and a Media Entity carries no bytes (see §Relationship to ADR-0058).

- **Shape** (`media_core`, modeled on `bookmark_core`, `mutation.rs`):
  - `title` — required, non-empty.
  - `medium` — required enum: `link | article | book | tv | movie`.
  - `state` — required enum: `backlog | consuming | done | abandoned` (the
    queue→log lifecycle).
  - `rating` — optional positive integer (1–5), clearable.
  - `finished_at` — optional clearable local datetime (`YYYY-MM-DDTHH:MM:SS`),
    the log timestamp.
  - `url`, `note` — optional clearable strings (no URL-format validation — Core
    stores, it does not parse, per ADR-0036/0031).
  - `tags` — optional clearable non-empty-string array.

  Allow-listed keys; any other field rejected. `url`/`note`/`tags`/`rating`/
  `finished_at` are **clearable** under the ADR-0033 `null`-sentinel-clear
  contract (apply strips null keys so stored JSON never holds null).

- **State invariant** (a cross-field hook in `entities.rs`, mirroring the
  Todo/Project status↔timestamp invariant): `rating` and `finished_at` are
  meaningful **only when `state ∈ {done, abandoned}`**, and are rejected
  otherwise. A `backlog`/`consuming` Media has no finish data. The enum domains
  themselves are spec-walk validated; this one cross-field rule lives in the
  validator hook, not the spec.

- **Update is full-document replace** (like Person/Project/Bookmark, not Todo's
  partial-merge): the editor sends the complete `data`; Core validates and
  replaces.

- **User-CRUD-only**, inheriting Bookmark's stance verbatim (ADR-0036): Media
  lives in `entities::validate` + the `entity/mutate` path, is **absent from the
  agent's `propose_workspace_mutation` and `search_entities`**, and the three
  `MutationKind::{Create,Update,Delete}Media` kinds stay in the
  `Err(NotProposable)` arm of `TryFrom<MutationKind> for ProposableMutation`. The
  Worker does not author Media.

- **Not searchable, not referenceable.** `projection = None` (Bookmark's policy):
  Media is browsed only via its dedicated topic, not surfaced in `⌘K` entity
  search, and `is_referenceable() = false` — a Journal Entry body cannot point at
  a Media (the issue mandate). Referenceable target types stay
  `{person, project, todo}` (`mutation_target.rs`).

- **Web surface** (replaces Bookmark's slot, no parallel machinery): the
  `LibraryItemKind` literal `"bookmark"` → `"media"`; `KIND_META` gains the Media
  label/slug/icon; `entityCodec` parses/builds Media (`create_media`/
  `update_media`); `BookmarkEditor` → `MediaEditor` (adds the medium/state/rating/
  finished selects); the Media topic route (`/library/media`, an ADR-0054
  StubTopic today) renders the generic `EntityCollection` for the `media` kind.
  `libraryFacets` gains **medium** and **state** facet axes (Bookmark offered
  none); the bespoke "queue+log signature view" is deferred to a follow-up.

  - **Slug-collision routing.** `KIND_META.media.slug` is `"media"`, which collides
    with the **static** `/library/media` topic route (ADR-0054) — every other kind
    is browsed via the dynamic `/library/$kind` route. The static route wins
    resolution (the desired browse home), so Media uniquely departs from the
    uniform `/library/$kind` selection pattern: an entity selection rides `?id`
    **in place** on the current route (`navigate({to: ".", search: {id}})`,
    Today-style) rather than navigating to `/library/$kind`, and the shared rail in
    `route.tsx` resolves `kind = "media"` from the `/library/media` pathname (no
    `params.kind`) to mount the detail/editor. ⌘K activation still targets
    `/library/$kind` with `kind="media"`; TanStack interpolates that to the path
    `/library/media`, which the static route serves with `?id` intact — a
    regression-tested path (`CommandPalette.test.tsx`), since it is the one slug
    that shadows `$kind`.

- **Gate-free, like Bookmark** (ADR-0009): because Media is user-CRUD-only, it has
  no Rust `PayloadSpec` in `ProposableMutation`, no `schemas` registry entry, no
  `fixtures/<kind>.json`, and is absent from the 15-kind `WIRE_KINDS` parity list.
  Its create/update/delete + read schemas live in `packages/protocol/payloads.ts`
  purely for the Web codec, guarded only by the TS round-trip tests — the same
  ungated boundary Bookmark held. The one contract touch is the read-side struct
  fixture `entity_list_result.bare.json`, whose sample `EntityRow.type` flips
  `"bookmark"` → `"media"` (regenerated from `protocol.rs`).

## Migration

Edit `0001_initial.sql` in place (CLAUDE.md §5). `entities.type` is free TEXT
with no enum CHECK, so the type-string change needs **no DDL**: existing
`type='bookmark'` rows are updated to `type='media'` with `medium='link'` and
`state='done'` (the issue mandate). In practice the dev DB is nuked and recreated;
the in-place data UPDATE documents intent. The Web parser **default-tolerates** a
row lacking `medium`/`state` (defensive defaults, as `parseBookmark` did) so a
sparse row never crashes the inspector.

## Relationship to ADR-0058 (the media binary substrate)

ADR-0058 added `media` + `media_attachments` tables for **binary blobs**
(mime/byte_size/digest/storage_path on disk). That is orthogonal to this Media
*Entity*, which is a metadata queue+log row with zero bytes. The name collision
is cosmetic. A Media Entity **could** later attach a cover/poster image via
`media_attachments` (`target_kind='entity'`, already legal), but **v1 connects
them at zero points** — the issue never asks for binary attachments, and
`db/media.rs`'s "lands with #252" forward-pointer is satisfied by this Entity
existing, not by wiring the two together. A cover-image attachment is a clean
follow-up.

## Consequences

- **No `entity_source` row / no "Captured from" footer** on a Media create
  (`created_by='user'`, ADR-0033) — unchanged from Bookmark.
- **Chronological ordering** in the collection (`recency = created_at`), narrowed
  by the medium/state facets.
- **Dispatch-table fan-out.** Replacing Bookmark means renaming an arm in every
  `match` that names it — `validate`, `render_accept`, `entity_data_payload`, the
  apply create/update/delete arms, the `EntityType`/`MutationKind` taxonomy, and
  the non-total `matches!` in `mutation_target.rs` (the one site the compiler will
  **not** flag — it must be hand-checked, and the Core test suite, not `cargo
  check`, is what catches a stale wire string). Habit (#249) is the precedent for
  every user-CRUD Core site.

## Considered and rejected

- **One Entity Type per medium** (`Book`, `Movie`, …) — five types sharing one
  identical field set that differs only by an enum tag, for 5× the
  spec/validator/codec surface and zero behavioral gain. `medium` is data, not
  type. Rejected (CLAUDE.md §2).
- **Reuse the ADR-0058 `media` table as the Entity's store** — conflates a binary
  envelope with a metadata record; the queue+log row has no bytes, mime, or
  storage path. Rejected; they stay orthogonal.
- **Keep Bookmark and add Media beside it** — two near-identical outward-pointing
  types, with Bookmark the strict subset (a `link` with no lifecycle). Strands the
  simpler type and splits the topic. Rejected in favor of replacement (the issue
  decision).
- **Agent-proposable in v1** — roughly doubles the Core surface (PayloadSpec +
  fixture + registry + search) for no stated chat flow, and forces the parity
  gate. Deferred; promote later if a real flow needs the agent to author Media.
- **Bespoke queue+log view in v1** — the richer two-section layout is desirable
  but its design doc (`docs/plans/topics/media.md`) is not yet on master; shipping
  the entity behind the generic faceted collection unblocks #252 now and defers the
  signature view to a follow-up.
