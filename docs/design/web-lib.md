# web-lib design notes

Design rationale extracted from code comments during cleanup — keep in sync with the source.

## apps/web/src/lib/hooks/useLibraryItems.ts — toLibraryTodo

Maps a live `entity/list` row to the Library `Todo` view model. The view model
carries fields the preview fixture invented for richer rendering (`recency`,
`createdAt`, `dueInDays`, …) that the live entity store does not yet have; we
derive the few that matter and default the rest minimally:

- `title` / `done` / `due` come straight from `data`.
- `recency` = `created_at` (ms-epoch) so newest sorts first, matching the
  preview fixture's "higher = more recent" convention.
- `createdAt` = the localized date of `created_at` (a human label).
- `dueInDays`, `projectId`, `owner`, `note`, `needsReview`, `capturedFrom` are
  left undefined — derived relationship/recency metadata the live store does not
  produce this slice.

## apps/web/src/lib/hooks/useLibraryItems.ts — toLibraryPerson

Maps a live `entity/list` row to the Library `Person` view model. Mirrors
`toLibraryTodo`: `name` / `note` come straight from `data`; `recency` is
`created_at` (newest sorts first) and `createdAt` its localized date. The
preview-only relationship fields (`role`, `relationship`, `email`, `projectIds`,
`needsReview`, `capturedFrom`) are left undefined — the live store does not
produce them this slice (project↔person relations are out of scope).
