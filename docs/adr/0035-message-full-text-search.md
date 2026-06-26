# Message search: a substring scan over completed message text

/ builds on [ADR-0004](./0004-three-tier-storage-authority.md), [ADR-0009](./0009-protocol-strategy.md), [ADR-0014](./0014-client-core-wire-protocol.md), [ADR-0028](./0028-run-status-materialized-transitions.md), [ADR-0029](./0029-request-handler-seam.md)

PRODUCT.md's success criterion is that knowledge be "browsable **and findable**
rather than buried in conversation." The Library made Entities browsable, and the
⌘K palette searches Entity titles and Thread titles. But the conversations
themselves — what the user actually typed, and what the assistant replied — were
unsearchable: the palette matched Thread *titles* only. You could not find "the
thread where I worked through the daycare schedule" unless "daycare" happened to
make it into the auto-generated title.

This ADR makes message text findable.

## Decision

A `message/search` request runs a case-insensitive substring query over the text
of every **completed** Message (both `user` and `assistant` roles), assembled live
from tier-2 `message_parts`, and returns recency-ordered hits each carrying enough
context to navigate to the source Thread. The ⌘K command palette gains a
"Messages" group backed by this request.

The query is a plain `LIKE`, scanned directly over the canonical assembled text —
there is **no derived index**:

```sql
WHERE <assembled message_parts text> LIKE '%' || ? || '%'
```

where the assembled text is the `group_concat` of each Message's `type='text'`
parts in `seq` order (the same `text_parts_by_message` concat `history_for_run`
uses), filtered to `messages.status = 'completed'`.

A search returns, per hit:
`{ message_id, thread_id, run_id, role, snippet, thread_title, created_at }`.

## Why a plain LIKE scan, no index

The match semantics are **substring**, not token-prefix: `mail` must find `email`,
`care` must find `daycare`. A uniform `WHERE text LIKE '%' || ? || '%'` delivers
that at any query length with **no `MATCH` query-syntax to sanitize** (a user
typing `AND`, `"`, `*`, or `NEAR(` is just literal text) — `%`/`_` are escaped so
they match literally, and a blank query short-circuits to no hits (an empty needle
would otherwise `LIKE '%%'` the whole corpus). FTS-hostile input can never produce
a query error.

At single-user scale a full scan is free — the message corpus is small and the
palette queries on demand, off any path the user waits on — so a standing index
earns nothing. (An earlier slice did build a tier-3 `message_fts` FTS5 trigram
projection for exactly this query; because the query was always `LIKE` and never
`MATCH`, the trigram column was a pure substring *accelerator* over a mirror of
`message_parts`. The pre-1.0 feature-cut sweep removed it — the table, its two
indexing write-seams, and the on-open rebuild — for the live scan, with
byte-identical results.) If a real corpus-scale problem ever appears, a trigram
(or default-tokenizer + `MATCH` + bm25) index is a fresh, additive table behind
this unchanged `message/search` seam.

The cost, accepted: a substring scan carries **no relevance ranking**. Results
order by `created_at DESC` — "find that recent conversation" is a recency-ordered
need anyway, so this is the right default, not a compromise. The snippet is
rendered in SQL with `substr`/`instr` around the first match.

## Completed-only

The search sees only `completed` Messages — mirroring `history_for_run`'s existing
"completed drops partial/errored assistant text" rule. User text is `completed`
the moment a Run is created (searchable immediately); assistant text accumulates
via streaming `text_delta` appends and becomes `completed` only at the
`RunStatus::complete` transition (ADR-0028). Half-streamed and errored assistant
text is never searchable. Because the scan reads `message_parts` live, there is no
projection to sync or rebuild — the canonical text *is* the search corpus.

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

- **New capability, not a re-skin.** Finding a conversation by its body text was
  impossible before this; this is the first surface that does it.
- **Recency, not relevance.** Hits order newest-first. If relevance ranking is ever
  wanted, it requires a default-tokenizer FTS index + `MATCH` + bm25 — a new table
  and a different query path, added behind the unchanged `message/search` seam.
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
