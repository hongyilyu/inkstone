# web-lib design notes

Design rationale extracted from code comments during cleanup — keep in sync with the source.

## apps/web/src/lib/hooks/useLibraryItems.ts — toLibraryTodo

Maps a live `entity/list` row to the Library `Todo` view model (ADR-0031/0032).
The Library is live-only — there is no preview fixture in app code — so every
displayed field comes from Core:

- `title` / `note` / `status` and the date fields (`deferAt`, `dueAt`,
  `completedAt`, `droppedAt`) come straight from `data`.
- `projectId` and `personRefs` are the GTD relations Core materializes on the
  row (`person_refs` rides on the wire row, ADR-0032).
- `recency` = `created_at` (ms-epoch) so newest sorts first; `createdAt` = the
  localized date of `created_at` (a human label).

## apps/web/src/lib/hooks/useLibraryItems.ts — toLibraryPerson

Maps a live `entity/list` row to the Library `Person` view model. Mirrors
`toLibraryTodo`: `name` / `note` / `aliases` come straight from `data`;
`recency` is `created_at` (newest sorts first) and `createdAt` its localized
date. Person carries no descriptive relationship fields — Core's Person `data`
is `{name, note?, aliases?}` only (ADR-0031); Person↔Project relations are
derived client-side through Todos (ADR-0032), never stored on the Person.
