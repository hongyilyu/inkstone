# Thread archive lifecycle (archive-not-delete, rename)

A Thread gains a reversible **archived** state and an owner-editable **title**.
Archiving stamps a nullable `threads.archived_at` (ms-epoch; `NULL` = active, a
number = archived-at) and hides the Thread from the default sidebar list without
destroying its messages, runs, or provenance. Rename overwrites the title.
Both are exposed as dedicated wire verbs (`thread/rename`, `thread/archive`,
`thread/unarchive`) that **reject an unknown Thread** rather than silently
no-op-ing, plus a separate read verb (`thread/list_archived`) that backs an
Archived view. There is **no hard-delete of a Thread** in v1.

## Context

A returning owner accumulates Threads forever with no way to prune the sidebar
or fix a bad auto-generated title. The auto-title work (ADR-0046/0048) *generates*
titles but never lets the owner override one, and the sidebar's only per-row
control today is `CopyThreadIdButton`
([`apps/web/src/components/Sidebar.tsx`](../../apps/web/src/components/Sidebar.tsx)).
PRODUCT.md's "return to a prior Thread" and the local-first "owner curates"
principle ([ADR-0007](./0007-local-first-single-user.md)) both want a curation
affordance.

**Why archive, not delete.** Entities have no `thread_id`, but
`entity_sources.source_message_id` cascades off `messages`
(`ON DELETE CASCADE`, [migration `0001_initial.sql:150-163`](../../crates/core/migrations/0001_initial.sql)).
Hard-deleting a Thread that sourced surviving Entities would cascade away the
Message its "Captured from" provenance ([ADR-0030](./0030-journal-entry-anchored-capture.md))
points at, dangling the link. Archiving keeps the Thread (and its messages, runs,
and provenance) intact and merely hides it — zero provenance loss, fully
reversible. This matches **opencode** (`sst/opencode`), which makes archive the
sole user-facing pruning path (`time_archived` nullable timestamp,
`packages/core/src/session/sql.ts:59`; list filters `isNull(time_archived)`,
`session.ts:560`) and leaves hard-delete reachable only through the core API. A
single-user local tool rarely wants true destruction; the reversible path is the
right default.

The wire protocol is the contract-parity gate ([ADR-0009](./0009-protocol-strategy.md)):
every new message is hand-mirrored in `protocol.rs` + `packages/protocol/src/index.ts`
and fixtured in `tests/contract`. The verbs route through the request-handler
combinator ([ADR-0029](./0029-request-handler-seam.md)), which already owns the
`UnknownThread` → `-32001` mapping.

## Decision

- **`archived_at INTEGER` nullable column on `threads`** (edited into
  `0001_initial.sql` in place, pre-release). `NULL` = active; a ms-epoch number =
  the instant it was archived. A nullable timestamp (not a boolean, not a
  `status` enum) matches the existing `created_at` / `last_activity_at`
  convention, records *when* for free, and filters with one predicate
  (`WHERE archived_at IS NULL`). No CHECK constraint, no second table.

- **Three mutating verbs, each rejecting an unknown Thread.** `thread/rename
  {thread_id, title}`, `thread/archive {thread_id}`, `thread/unarchive
  {thread_id}` each verify the row exists (`thread_exists`) and return
  `HandlerError::UnknownThread(-32001)` if not — these are user-initiated RPCs on
  a Thread the UI just listed, so a missing row is a genuine desync, not an
  expected state. This deliberately diverges from the private
  `db::update_thread_title` SQL helper, which stays a silent no-op on a missing
  row (it backs the fire-and-forget generated-title write, ADR-0046, where a
  vanished Thread is benign); the *verb* wraps it with a check-then-act guard.
  Rename does **not** bump `last_activity_at` (titling is not activity — same
  rule as the generated-title write), so renaming never reorders the feed.

- **A shared ack result, `ThreadMutateResult { thread_id }`.** All three mutating
  verbs echo the affected `thread_id`, mirroring `EntityMutateResult { entity_id }`
  ([`protocol.rs`](../../crates/core/src/protocol.rs)). The Web reconciles by
  invalidating its `["threads"]` TanStack Query and re-reading
  ([ADR-0020](./0020-effect-across-typescript.md)), so returning the full updated
  row (opencode's choice — it has event-sync that makes the echo useful) buys
  inkstone nothing; a minimal ack is enough.

- **A separate read verb, `thread/list_archived`, default list filters archived
  out.** `thread/list` stays **params-less** (it decodes `serde_json::Value` and
  ignores it today); adding an `include_archived` param would mutate a
  gated request shape and risk the `from_value(Null)` decode trap. The default
  `list_threads` query gains `WHERE archived_at IS NULL`; `thread/list_archived`
  is the inverse, `ORDER BY archived_at DESC` (most-recently-archived first), and
  **reuses `ThreadListResult`** — purely additive to the parity gate, no new
  result type, and the Archived view gets its own TanStack query key.

- **Inline sidebar rename; hover-reveal archive control.** Rename is a
  double-click-to-edit inline `<input>` (Enter commits, Escape cancels/restores,
  blur commits, no-op on empty/unchanged) — there is no menu/dropdown/popover
  primitive in `components/ui`, and building one is unjustified surface. Archive
  is a hover-reveal `IconButton` in the same row slot as `CopyThreadIdButton`
  (`opacity-0 … group-hover:opacity-100 focus-visible:opacity-100`); no confirm
  dialog, since archive is reversible. The Archived view's per-row control is
  restore (unarchive). This is opencode's split (inline contenteditable rename on
  the tab, hover archive button on the row) adapted to inkstone's existing row
  idiom.

- **Archiving the focused Thread reselects to the welcome route.** The focused
  Thread *is* the route `/thread/$threadId` ([ADR-0042](./0042-url-addressable-threads.md)),
  so archiving the current Thread would strand the owner on a row that just left
  the sidebar. The archive mutation's `onSuccess` reads the focused `threadId`
  from the router and, iff it matches the archived id, navigates to `/` (the
  `_chat` index). Archiving any other Thread just refetches the list. No neighbor-
  picking (opencode's behavior) and no `CustomEvent` indirection (opencode is
  multi-window; inkstone is single-window — a direct navigate is enough).

- **The Archived view lives in the `_chat` shell, reached from a sidebar nav row.**
  Archived *Threads* are not Library *entities* (Todos/JEs/People), so the
  Archived view is a route under the `_chat` shell (alongside `/thread/$id`), not
  under the Library shell. An "Archived" nav row in the chat Sidebar (near
  Library/Search) is the entry point.

- **Scope is the sidebar Thread list only.** Archiving hides a Thread from the
  default sidebar list. It does **not** filter the Thread's Runs out of the
  recent-Runs rail (`run/get_history`, [ADR-0028](./0028-run-status-materialized-transitions.md)),
  cancel or pause in-flight/parked Runs, or touch message-search results — those
  stay reachable. Narrowing the blast radius to the one list the issue names
  keeps this off the `run/get_history` and `message/search` parity surfaces.

## Considered and rejected

- **Hard-delete a Thread.** Rejected for v1: the `entity_sources` cascade dangles
  surviving Entities' "Captured from" provenance (above). Archive is reversible
  and lossless; if true destruction is ever wanted it is a later, separate
  decision (and would need to null the provenance links first, opencode-style
  recursive delete).

- **`include_archived` flag on `thread/list`** (opencode's one-endpoint shape).
  Rejected: mutating a today-params-less gated request costs a parity-gate change
  and reintroduces the `from_value(Null)` null-params decode hazard, and the
  Archived view wants its own query key regardless. A second additive read verb
  reusing `ThreadListResult` is the cheaper, cleaner split for inkstone's gate.

- **A `status` enum (`active | archived`) column.** Rejected: a boolean-shaped
  2-state toggle dressed as an enum adds a CHECK constraint and a parity surface
  while throwing away the archived-at instant a nullable timestamp records for
  free.

- **Silent no-op on an unknown Thread** (matching the `update_thread_title`
  helper). Rejected for the *verbs*: a user-initiated mutation on a just-listed
  Thread that finds no row is a real desync that should surface, not a fake
  success. The helper stays no-op internally (its fire-and-forget caller wants
  that); the verb guards.

- **Full updated-row return** (opencode returns the whole `Session`). Rejected:
  inkstone has no event-sync to make the echo authoritative; the client re-reads
  via query invalidation, so a `{thread_id}` ack is sufficient and keeps the
  result type minimal.

- **A context-menu / kebab for the row controls.** Rejected: no menu primitive
  exists in `components/ui`; inline rename + a hover icon reuse the established
  row-control idiom without speculative new UI infrastructure.

## Related

- [ADR-0009](./0009-protocol-strategy.md) — the manually-mirrored-types +
  contract-parity discipline every new verb here obeys (new `*Params` +
  `ThreadMutateResult` join the non-payload struct registry).
- [ADR-0029](./0029-request-handler-seam.md) — the request-handler combinator and
  its `UnknownThread` → `-32001` mapping the mutating verbs reuse.
- [ADR-0042](./0042-url-addressable-threads.md) — the focused Thread is the route;
  why archiving the focused Thread must reselect.
- [ADR-0030](./0030-journal-entry-anchored-capture.md) — "Captured from"
  provenance; the cascade archive is designed to preserve.
- [ADR-0046](./0046-generated-thread-title.md) / [ADR-0048](./0048-thread-title-fallback-slug.md)
  — the generated/fallback title rename now lets the owner override; the
  `update_thread_title` helper rename wraps.
- [ADR-0020](./0020-effect-across-typescript.md) — the `WsClient` Layer + TanStack
  query-invalidation the Web reconciles through.
