# Message full-text search: a trigram FTS projection over message text

/ builds on [ADR-0004](./0004-three-tier-storage-authority.md), [ADR-0009](./0009-protocol-strategy.md), [ADR-0014](./0014-client-core-wire-protocol.md), [ADR-0028](./0028-run-status-materialized-transitions.md), [ADR-0029](./0029-request-handler-seam.md)

PRODUCT.md's success criterion is that knowledge be "browsable **and findable**
rather than buried in conversation." The Library made Entities browsable, and the
⌘K palette searches Entity titles and Thread titles. But the conversations
themselves — what the user actually typed, and what the assistant replied — are
unsearchable: nothing indexes `message_parts.text`, and the palette matches Thread
*titles* only. You cannot find "the thread where I worked through the daycare
schedule" unless "daycare" happened to make it into the auto-generated title.

This ADR makes message text findable.

## Decision

A tier-3 FTS5 table, `message_fts`, indexes the text of every **completed**
Message (both `user` and `assistant` roles). A new `message/search` request runs a
case-insensitive substring query over it and returns ranked-by-recency hits, each
carrying enough context to navigate to the source Thread. The ⌘K command palette
gains a "Messages" group backed by this request.

```sql
CREATE VIRTUAL TABLE message_fts USING fts5(
  message_id UNINDEXED,
  thread_id  UNINDEXED,
  run_id     UNINDEXED,
  role       UNINDEXED,
  text,
  tokenize = 'trigram'
);
```

A search returns, per hit:
`{ message_id, thread_id, run_id, role, snippet, thread_title, created_at }`.

## Why trigram + LIKE, not the default tokenizer + MATCH

The match semantics are **substring**, not token-prefix: `mail` must find
`email`, `care` must find `daycare`. Only the `trigram` tokenizer supports
arbitrary substring matching in FTS5.

A trigram-indexed column accelerates `LIKE '%q%'` directly, so the query path is a
uniform `WHERE text LIKE '%' || ? || '%'` — **no `MATCH` query-syntax to
sanitize** (a user typing `AND`, `"`, `*`, or `NEAR(` is just literal text), and
**no separate branch for 1–2 character queries** (`LIKE` is correct at any length;
trigram merely accelerates queries of 3+ characters and falls back to a scan below
that, which is free at single-user scale). The table earns its keep purely as a
substring-search accelerator, and FTS-hostile input can never produce a query
error.

The cost, accepted: trigram carries **no relevance ranking** (bm25 requires
`MATCH`). Results order by `created_at DESC` — "find that recent conversation" is a
recency-ordered need anyway, so this is the right default, not a compromise. The
snippet is rendered in SQL with `substr`/`instr` around the first match, not the
FTS5 `snippet()` helper (which also requires `MATCH`).

## Why a separate table from the pre-existing `fts`

`0001_initial.sql` already defines an `fts(entity_id UNINDEXED, searchable_text)`
table — entity-shaped, never written or read. Message search is keyed on
`message_id` / `thread_id` / `run_id` and must round-trip a hit to a Thread, so it
needs its own table. The dead entity `fts` table is left untouched here; reviving
or removing it is separate work (entity search was found to be churn at
single-user scale — the data is already client-side — whereas message text is the
unbounded, large-per-row table where an index genuinely pays off).

## Why index at completion, synced at two seams, rebuilt on open

`message_fts` is a tier-3 Derived Projection (ADR-0004): authoritative for nothing,
re-derivable from `message_parts` at any time.

- **Completed-only.** The index holds only `completed` Messages — mirroring
  `history_for_run`'s existing "completed drops partial/errored assistant text"
  rule. Half-streamed and errored assistant text is never searchable.
- **Two sync seams.** User text is complete the moment a Run is created, so it is
  indexed in `persist_initial_run`. Assistant text accumulates via streaming
  `text_delta` appends and is finalized only when the Run completes, so it is
  indexed in the `RunStatus::complete` transition (ADR-0028), right after
  `mark_assistant_messages_completed`. No other transition produces a completed
  Message.
- **Rebuild on open.** Core rebuilds `message_fts` from `message_parts` (via the
  canonical `text_parts_by_message` assembly) on every workspace open. This
  backfills existing databases, self-heals drift, and keeps the projection
  honestly tier-3: delete it and it comes back. The rebuild is O(all completed
  messages) per boot — single-digit milliseconds at single-user scale, on a path
  the user never waits on.

## Why `message/search` on the existing socket

ADR-0014 carries reads and mutations over one loopback WebSocket as JSON-RPC; "there
is no second transport." `message/search` is a new method-string arm in the
`dispatch` match (next to `entity/list`), in a new `message/*` namespace consistent
with the existing `thread/*` / `entity/*` / `proposal/*` namespaces. It follows the
request-handler combinator seam (ADR-0029): decode params, run the body, frame the
outcome. New protocol types (`MessageSearchParams` / `MessageSearchResult` /
`MessageHit`) are manually mirrored in Rust and TypeScript with a contract test
(ADR-0009).

## Consequences

- **New capability, not a re-skin.** Finding a conversation by its body text is
  impossible today; this is the first surface that does it.
- **Recency, not relevance.** Hits order newest-first. If relevance ranking is ever
  wanted, it requires the default tokenizer + `MATCH` + bm25 — a different table
  and a different query path, i.e. a rebuild. The trigram choice is baked into the
  table at creation.
- **⌘K only.** The feature surfaces in the command palette's new "Messages" group;
  the existing Threads and recents groups are untouched and stay client-side. No
  chat-sidebar search surface in this feature.
- **Thread-level navigation.** Activating a hit focuses the source Thread
  (`setFocusedThread`). Scrolling to and highlighting the exact matched Message in
  scrollback is deferred (issue #138) — it needs a scroll-anchor seam the chat
  store does not expose yet. The hit already carries `message_id` / `run_id`, so
  that refinement is additive with no wire change.
- **Single-user scope (ADR-0007).** No live `message/changed` invalidation: the
  palette queries on demand each time it opens, so there is nothing to keep warm
  across clients.
