# Learned rules — Performance (`performance`)

_12 rules. Loaded by the `dr-performance` specialist. Generated from rules.json — do not edit by hand; run build_kb.py._

## Stream or cap large content instead of buffering it fully in memory  ·  `avoid-buffering-large-content-in-memory`
- **Severity:** important  ·  **Support:** 4  ·  **Seen in:** #5076, #26262, #27890, #28907
- **Rule:** Avoid materializing entire files/archives/streams as a single in-memory buffer when output can be streamed, and avoid building an accumulator that some branch never reads. When injecting file contents into a prompt/string, truncate to first N chars/lines (with an explicit 'truncated' note) or summarize and link, rather than inlining the full contents. Enforce a total size cap so peak memory stays bounded regardless of input size.
- **Detect:** Look for: (a) per-entry readFileSync followed by .arrayBuffer()/Buffer.from on a whole archive before writeFileSync; (b) `acc += chunk` / push-to-array inside a stream loop where the accumulator is unused under some branch/config; (c) template strings or prompt fields interpolating full file contents (Bun.file().text(), readFileSync) with no length cap. Ask: is the full content buffered/embedded with no streaming or truncation?

## Derive cache/query keys from exactly the inputs the query reads, and don't embed large content  ·  `query-key-must-match-inputs-actually-read`
- **Severity:** important  ·  **Support:** 3  ·  **Seen in:** #25939, #28938, #31309
- **Rule:** A cache/query key must reflect exactly the inputs the query function actually consumes — no more, no less. Do not include extra inputs the function ignores (which fragments the cache and triggers redundant refetches when those unused inputs change), and do not interpolate large field contents (file/diff text) into the key (use a small checksum/hash instead to avoid memory bloat). When the goal is cache reuse, use cache-aware reads (ensureQueryData, or set an appropriate staleTime) rather than unconditional fetches (fetchQuery) on a zero-staleTime query.
- **Detect:** Compare the queryKey's inputs against the variables actually used in queryFn — flag keys that spread values the function ignores (e.g. full list when only [0] is read). Flag cache-key strings that interpolate multi-KB content (`${before}${after}`) rather than a hash. Flag diffs replacing `ensureQueryData(` with `fetchQuery(` on a query with no staleTime.

## Memoize expensive synchronous/aggregate work keyed on input when invoked on hot paths  ·  `memoize-expensive-keyed-work-on-hot-paths`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #26949, #29641
- **Rule:** When an expensive operation (synchronous FS I/O like realpathSync/statSync/readFileSync, or an aggregate that scans an entire collection) is reachable from a per-request, per-render, or per-row path and is called repeatedly with identical inputs, cache/memoize the result keyed on the input. In virtualized/list renders, compute per-key aggregates once into a memoized map and reuse them instead of rescanning all items per row.
- **Detect:** Flag a helper invoked per-request/per-render/per-row that (a) calls synchronous FS APIs with no cache around identical inputs, or (b) iterates the full collection of items/parts to derive a per-key value. Ask: is this O(n) work repeated O(n) times because it isn't memoized by key?

## Replace nested full-collection scans / correlated subqueries with an index or window function  ·  `avoid-quadratic-use-index-or-window-function`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #30672, #30705
- **Rule:** Avoid O(n^2) patterns where, for each item, you scan the entire collection to match/rank/count by a key. In code, build a parent->children (or key->items) Map index once before traversing so traversal stays linear. In SQL, replace a per-row correlated subquery that COUNT(*)s or ranks rows of the same table partitioned by a key with a window function (ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ...)). This is especially critical inside migrations/backfills run on full tables.
- **Detect:** Flag a nested loop whose inner loop iterates the full collection and filters by matching a key from the outer item. Flag SQL with a correlated subquery (COUNT(*) or rank) whose WHERE references the outer row's partition column. Ask: can this be a single Map index or a window function instead?

## Dedup and short-circuit redundant async lookups before doing the I/O  ·  `cache-and-dedup-in-flight-async-lookups`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #26751, #30722
- **Rule:** When async lookups keyed by an identifier can fire repeatedly (per re-render, per rediscovery), cache in-flight/resolved promises by a stable key so identical I/O isn't repeated, and place the already-seen short-circuit (seen-set of normalized keys) BEFORE the expensive read/parse rather than after. Flag only when the duplicate I/O or post-read dedup is evident in the diff.
- **Detect:** Look for: (a) a loop calling an async fetch/read per element each render with no memo/cache keyed by identity (and where the guard isn't set until the async resolves); (b) an early-return dedup check placed after a file read/parse of the same input. Ask: is identical I/O re-fired without an in-flight cache, or could the dedup move before the I/O?

## Cache keys must include every input the computation depends on  ·  `include-all-cache-key-inputs-and-pool-only-reusable`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #3244, #5162
- **Rule:** A memoization cache key must include every input that affects the computed value; when refactoring a key, do not drop a factor (resolved command + args) that the cached computation still depends on, or runtime config changes will return stale results. Relatedly, skip connection pooling entirely (pass undefined sessionId) for requests known to be non-reusable rather than dropping and immediately re-adding to the pool.
- **Detect:** Cache-key construction that removes a previously-included field (getNpmCommand() command+args) while the cached computation still depends on it; or logic that drops a pooled connection for a non-continuation request but still passes the same sessionId to acquire.

## Bound per-entity concurrency and fetch limits that scale with the number of entities  ·  `bound-concurrency-and-fetch-limits-that-scale-with-entities`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #31157
- **Rule:** When a numeric per-item fetch/page limit feeding a concurrent or per-entity query is raised, flag it: ask whether total work scales with entity count and whether concurrency is throttled/queued and the fetched window bounded to what's visible. Flag only changes that increase a limit on an unbounded concurrent/per-entity path.
- **Detect:** Flag a newly increased numeric fetch/page-limit constant that feeds a concurrent or per-entity query. Ask: how does total work scale with the number of entities, and is concurrency throttled or the window bounded?

## Batch-resolve related data on list paths instead of one query per row  ·  `batch-resolve-related-data-no-n-plus-one-on-list-paths`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #130
- **Rule:** Don't issue one awaited sub-query per row inside a loop (1+N queries) on a list/read hot path, especially against a SQLite pool with max_connections(1) where reads are serialized. Batch-resolve related data for all returned rows in a single query keyed by the set of source ids, then group in memory and assign to rows.
- **Detect:** `for row in &mut rows { ... = some_query(pool, &row.id).await? }` or any awaited DB call inside a loop over result rows. Flag N+1; recommend a single batch query over the collected ids plus in-memory grouping.

## Hoist computations derived only from static/invariant inputs out of hot paths and loops  ·  `hoist-invariant-computation-out-of-repeated-calls`
- **Severity:** nit  ·  **Support:** 4  ·  **Seen in:** #4636, #28701, #29208, #29635
- **Rule:** If a constructed value or pure-function result inside a loop or frequently-called function depends only on imports/module constants (not on any argument or the loop variable), hoist it to module/loop-outer scope and reuse it (e.g. `new Set(CONST)`, regex built from constants, `await import()` in a hot helper -> cached module-scope promise). Flag only when invariance is clear from the diff.
- **Detect:** For each constructed value or pure function call inside a function body or loop, ask: does it depend on any function argument or the loop variable? If it depends only on imports/module constants (e.g. `new Set(SOME_CONST.map(...))`, `formatOptions(config)` inside `.map`, `await import(...)` inside a repeatedly-called function), flag it as hoistable.

## Avoid heavy imports or eager store/subscription creation just to read a small value  ·  `avoid-heavy-imports-and-eager-io-just-to-read`
- **Severity:** nit  ·  **Support:** 3  ·  **Seen in:** #160, #26535, #28788
- **Rule:** Don't import a known-heavy module just to use one small pure helper (extract the helper to a lightweight module), and don't get-or-create a store/subscription/query that triggers network I/O merely to read a value for previewing — use a read-only/existing accessor and instantiate only after explicit selection. Flag only when the imported module is plausibly heavy or the created instance clearly triggers I/O.
- **Detect:** Flag a new import of a known-heavy module where only one small/pure helper is used. Flag get-or-create of a store/subscription/query inside a memo or render path used for previewing options. Ask: does this drag in a large dependency tree, or trigger I/O, for something that should be lightweight/read-only?

## Refresh recency on cache hit when an LRU eviction policy is intended  ·  `lru-cache-must-refresh-recency-on-hit`
- **Severity:** nit  ·  **Support:** 2  ·  **Seen in:** #369, #30722
- **Rule:** If a Map-based cache is meant to be LRU, refresh the key on a hit (delete then re-set) or use a real LRU implementation, so eviction order reflects access rather than insertion. Evicting via keys().next().value while never re-inserting on a get hit is FIFO masquerading as LRU and evicts hot entries.
- **Detect:** Find Map-based caches that evict via keys().next().value but whose get/hit branch reads the cache without delete+re-set. Ask: does a cache hit refresh recency, or is eviction purely insertion-ordered?

## Run independent async fetches concurrently, not sequentially  ·  `run-independent-async-fetches-concurrently`
- **Severity:** nit  ·  **Support:** 1  ·  **Seen in:** #112
- **Rule:** Run independent async fetches concurrently (Effect.all / Promise.all) rather than awaiting them sequentially when neither depends on the other's result — sequential `yield*`/await of two independent list calls doubles latency.
- **Detect:** Consecutive `yield* client.x(...)` / `await client.x(...)` statements where the second does not use the first's result. Ask: are these two independent fetches awaited sequentially when they could be batched with Effect.all/Promise.all?
