# External Task Views — TickTick owns tasks; inkstone reads, twice

Date: 2026-08-15 · rev 33 · Status: S1+S1a GO — **S2 and S3 implemented (hidden); S4 cutover pending**

## Decision ledger (read first)

**Agreed** (user-directed, settled):
- TickTick is the sole task authority; inkstone is read-only over it; writes are a
  separate future feature.
- Two independent read paths: Web → TanStack Query → Core → TickTick OpenAPI;
  Worker → TickTick MCP directly.
- Core holds **no task state, no task cache, no shared snapshot**; no canonical task
  rows or task-cache rows in SQLite.
- Native Todo retirement is total and destructive (entity, schema, recurrence,
  references, editors, extraction, fixtures, prompts, vocabulary).
- Chat task capture dies at cutover (until a future write feature) — accepted.
- Project Review is owned by Project, not the retired Todo subsystem.
- No generic connector framework, provider abstraction, shared task model, or
  second-provider speculation.
- Web and Worker may observe TickTick at different times (no same-fetched-data
  claim).
- The Web lane accepts TickTick's 200-open-entry response ceiling. It makes no
  completeness guarantee when the API returns 200 rows; accounts should keep
  fewer than 200 unfinished entries. NOTE rows are discarded by `kind`.
- **MCP results are visible on demand in the Run transcript**: a collapsed
  name + status row by default; expanding reveals the normalized
  `TranscriptToolResult.content` the model received. Errors behave identically
  (collapsed error row → expand shows error content). Never exposed: credentials,
  raw MCP metadata, runtime `details`/`terminate`.

**Proposed** (this plan's recommendations — reviewable, not yet user-approved):
- **Core owns TickTick connection configuration and credentials for both lanes**
  (manually provisioned 0600 files; Worker receives MCP auth via the spawn
  manifest).
- **The cross-lane invariant is the same configured TickTick account**, established
  by S1's credential-compatibility check.
- **Build hidden, then retire + expose in one cutover** (S4); contract spike first
  with a go/no-go gate (S1) — the slice ordering itself.
- Web refetch policy: `staleTime: 60_000`, refetch on focus + reconnect, no polling,
  manual refresh (per-query override of the global `staleTime: Infinity`).
- Worker read-safety mechanics: static exact allowlist applied at discovery AND
  before execution; `ticktick_*` namespacing.
- External-tool lifecycle frames (started ← pi `tool_execution_start`; finished ←
  finalized `tool_execution_end`, carrying only `{result: TranscriptToolResult}` —
  the error flag lives once, inside the result) as the transcript-integration
  mechanism; `executionMode: "sequential"` in v1; **`TranscriptToolResult`
  {content, is_error} as the single transcript result type for ALL tools** — no
  union, no runtime `terminate`/`details` leak (see A4).
- Credential lifecycle: **read once at boot; changes require a Core restart** (no
  runtime re-read — see A5).
- A concrete **`ticktick/status`** read (S2) as the Web's source for connection
  state + connection ID, and the **reconnect protocol** that gates task reads on it
  (see A2).
- The six demo proofs.

**Resolved by S1/S1a:**
- **S1a date shape: COLLAPSED.** Staged distinct start 09:30 / due 10:30 collapse
  to the due instant identically through create, explicit update, and the filter
  read; OpenAPI never round-trips a distinct start. `TickTickTaskRow` carries ONE
  due tuple (`dueDate`, `isAllDay`, `timeZone`); the distinct-start/due claim is
  dropped.
- **S1a Inbox: outcome 1, literal sentinel.** The Inbox projectId is
  `inbox`-prefixed (account suffix redacted); `GET /project` never lists it and it
  is the aggregate filter's only unmatched projectId across a multi-list account.
  Normalization maps `^inbox` ids to a synthetic **"Inbox"** list — an Inbox task
  never renders as an unnamed list. The outcome-3 user decision is moot.
- One `tasks:read tasks:write` token authorizes both lanes; MCP rejects
  `tasks:read` even for initialize.
- OpenAPI accepts a server-enforced read-only credential, but official MCP requires
  write scope. Worker safety can only be stated as Inkstone's dual exact allowlist,
  not a server-enforced guarantee.
- The fixed OpenAPI task filter has a silent 200-entry ceiling. This is an accepted
  product limit, not a reason to add per-list fan-out.
- OpenAPI rows carry `kind`; Web normalization keeps `TEXT` and `CHECKLIST` and
  discards `NOTE`.

**Unresolved** (owned by a slice or by user decision, not assumed):
- Exact `TickTickTaskRow` fields (S2, derived from the first Tasks UI).
- Final refetch timing (start with the proposed policy, tune on real use).

## The feature in one paragraph

**Inkstone does not own or model Todos — as a product.** TickTick is the sole task
authority; inkstone reads it through two independent paths: the **Web** renders tasks
via TanStack Query over a Core verb backed by a concrete `TickTickClient` (OpenAPI,
two reads, normalize by `kind`, no Core cache), and the
**Worker** queries TickTick's official MCP server directly (streamable HTTP,
read-only tool allowlist, namespaced tools) so
the agent gets TickTick's real filtering instead of a local reimplementation. Core
owns connection credentials for both lanes and no task state. Web and Worker may
observe TickTick at different times; the invariant is the same configured account.
Native Todo retirement is committed and lands as one cutover after both hidden lanes
are proven.

```text
Web ──► TanStack Query ──► Core (TickTickClient: reqwest, 2 reads, normalize) ──► TickTick OpenAPI
                            │  owns credentials (boot-read) · no task state/cache
Worker ──────────────────────► TickTick MCP (official, streamable HTTP)
        read-only allowlist · namespaced tools · lifecycle frames → Core transcript
```

## Assumptions

**A1 — Authority.** TickTick owns the complete task lifecycle. The Tasks surface
carries an app-level "open TickTick" action. After the cutover there is no native
task fallback and no dual surface.

**A2 — Web lane: TanStack Query → Core verbs → OpenAPI, no Core cache.**
- **One concrete `TickTickClient` module in Core** (`crates/core/src/ticktick/`) —
  no provider interface. Two reads (`GET /open/v1/project`,
  `POST /open/v1/task/filter` `{"status":[0]}`) against a compile-time-const base
  URL (test-only override). TickTick JSON decodes into **private Core transport
  types**, then normalizes into **`TickTickTaskRow`** — fields limited to what the
  first Tasks UI displays or filters (S2 derives them); TickTick ids preserved
  verbatim; TickTick's "project" exposed as **`list`** (Project is an inkstone
  outcome Entity); dates carried as **one due tuple — `dueDate` + `isAllDay` +
  `timeZone` — never collapsed into a bare UTC instant**. There is no `startDate`
  field: **S1a proved the collapse** (staged start 09:30 / due 10:30 came back as
  the due instant through create, explicit update, and the filter read alike), so
  a distinct start would be a fiction.
- **Kind boundary:** normalize only `TEXT` and `CHECKLIST`; discard `NOTE`. The
  server applies its 200-entry ceiling before this local filtering, so NOTE rows
  can consume result slots.
- **Inbox naming — resolved by S1a as outcome 1 (literal sentinel):** the Inbox
  projectId is `inbox`-prefixed (account-identifying suffix, redacted as
  `inbox<redacted-suffix>`); `GET /project` never lists it, and it is the aggregate
  filter's only unmatched projectId across a multi-list account. Normalization
  maps `^inbox`-prefixed projectIds to a synthetic **"Inbox"** list. S2's test
  asserts an Inbox task renders as "Inbox" and never "unnamed list".
- **Accepted coverage limit — surfaced, not silent:** the task filter has no
  cursor/offset and silently truncates at 200. Inkstone does not add per-list
  fan-out and makes no completeness guarantee when exactly 200 rows are returned.
  **The truncation signal must survive NOTE filtering** (a 200-row response can
  normalize to 199 visible tasks), so
  `ticktick/tasks/list` returns an envelope:
  `{ tasks: TickTickTaskRow[], sourceLimitReached: boolean }` with the flag
  computed **on the raw row count, before kind filtering**. When it is true the
  Tasks UI shows: **"TickTick returned its 200-item limit; this view may be
  incomplete."** (S2; tested with a 200-raw/199-visible case.) The server
  truncates silently; inkstone does not.
- **Two TickTick-named verbs:**
  - **`ticktick/status`** — connection state (`connected | not_connected`) + the
    opaque connection ID (A5). The Web calls it first; the ID keys every task
    query. Required S2 infrastructure (the Web cannot construct a query key
    without it), not polish.
  - **`ticktick/tasks/list`** — the task read, backed by the two OpenAPI calls.
- **Reconnect protocol (account-key safety across Core restarts):** a Core restart
  is exactly when the credential — and so the account — may have changed, and the
  browser tab survives it with cached query data. On **every WebSocket
  (re)connection** the Web: (1) resolves `ticktick/status` **first**; (2) **suspends
  task reads** until it answers (task queries are `enabled:` only once the current
  connection ID is known); (3) if the connection ID differs from the one in cache —
  or the status is `not_connected` — **removes all task query data keyed by the old
  ID** before any read resumes. Account B's rows can never land under account A's
  key, and A's cached rows never render against B's connection. S2 tests the
  restart-with-swapped-credential sequence end-to-end.
- **TanStack Query owns Web caching, dedup, stale rendering, refetching.** The
  Core read is fixed (`{"status":[0]}` followed by kind filtering), so there is
  **one task query per connection ID** — the query key is the connection ID alone,
  never the token;
  any list/tag/date filtering the Tasks UI offers is **display-only, applied
  locally** over that one result. (If a Core-side filter parameter ever becomes
  real, it gets defined on the verb first and only then joins the key.) Proposed
  policy:
  `staleTime: 60_000`, refetch on focus + reconnect, no polling, manual refresh
  (per-query override of the global `staleTime: Infinity` in
  `apps/web/src/main.tsx`, the pattern `useProviderStatus` already uses).
- **Failure semantics are the browser's:** a failed background refetch keeps
  existing rows with an error/stale indication; a reload during an outage has no
  rows and shows the fetch error (no local snapshot — accepted consequence).

**A3 — Worker lane: direct MCP, read tools at two Inkstone gates.**
- The Worker connects to **TickTick's official MCP endpoint** (`mcp.ticktick.com`,
  streamable HTTP — verified 2026-08-12: 401 Bearer challenge, RFC 9728 resource
  metadata, scopes `tasks:read`/`tasks:write`) via a maintained MCP client library
  (official TypeScript SDK).
- **A static, exact allowlist of read tools** (task-query + the list/tag read tools
  the Workflow needs: `list_projects`, `list_tags`, `filter_tasks`, `search_task`,
  `get_task_by_id`; names pinned by S1 from `tools/list`), applied **twice**:
  filtering discovered tools before the model sees them, and again immediately
  before executing any call. MCP annotations and schema-hiding are never the safety
  mechanism. No create/update/complete/move/assign/comment-write/delete tool is
  exposed or executed.
- **Credential limitation proven by S1:** the official MCP service requires
  `tasks:write` even to initialize. There is no server-enforced read-only MCP
  credential; the two exact Inkstone allowlist checks are the only write barrier.
- **Model-facing names are namespaced** (`ticktick_search_task`, …) against Core
  registry collisions. **Discovery cost noted by S1:** the raw `tools/list` body is
  ~171 KB per connection; the Worker performs discovery once per spawn and the
  five-tool allowlist filter runs **before** anything reaches the model, so the
  model-facing surface stays five small schemas — the 171 KB is a per-spawn network
  cost only, never prompt content.
- **No local reimplementation of TickTick's filtering/ranking/query semantics.**
  One S1 blind spot recorded: the advanced-query capture returned a small result,
  so **`filter_tasks`'s own result ceiling was not probed**; if the MCP lane shows
  truncation in practice it is the same accepted-limit class as the OpenAPI 200 cap
  (the agent narrows its query), not a reason for fan-out.
- Workers stay ephemeral: Core passes the MCP endpoint + auth material in the spawn
  manifest; Workers persist nothing.

**A4 — Transcript integration: Core observes Worker-executed tools; fidelity is
specified end-to-end.**
Direct MCP execution bypasses the Tool Protocol, so the Worker emits **lifecycle
frames** on the existing outbound union, each sourced from its own pi event — not
hand-assembled state:
- `external_tool_started {tool_call_id, name (namespaced), arguments}` — from pi's
  **`tool_execution_start`** event.
- `external_tool_finished {tool_call_id, result: TranscriptToolResult}` — one
  terminal frame, from pi's **finalized `tool_execution_end`** event. **No outer
  `is_error`**: the error flag lives once, inside `TranscriptToolResult`, and the
  `tool_calls.status` column derives from `result.is_error` — a failed MCP call
  persists as an error, not a success-shaped result, with one source of truth.
**Ordering:** pi executes a turn's tool calls in parallel and emits completions in
**completion order**, while the model-facing transcript keeps **source order**.
v1 sets **`executionMode: "sequential"`** explicitly — pi then runs the *entire
batch* sequentially, so frame order == source order **through the shipped
interface, by contract, not by luck**. Consequently there is no reverse-completion
case to test (it cannot occur under this mode); S3 instead tests **a multi-call
mixed Core + MCP batch arriving in source order** end-to-end (frames → `run_steps`
sequence → rendered timeline). Parallel-order handling is deferred until
parallelism is actually introduced. Core persists the call + result (+ error
status) into the existing `tool_calls` table (+ `run_steps` ordering), publishes
the existing live `tool_call` Run Events, and preserves ordering with assistant
text (ADR-0045 segment sealing).
**Resume fidelity — ONE transcript result type, no union, no runtime leak:** the
manifest's `tool_result.content` is a bare `S.String` today
(`packages/protocol/src/worker.ts` `ManifestMessage`), and `AgentToolResult` is
the wrong donor — its `terminate` is Worker-runtime control flow (and `details` a
runtime sidecar) that must not leak into a durable transcript. S3 defines the
protocol-owned

```text
TranscriptToolResult {
  content:  [{type:"text", text} ...],   // model-visible content blocks
  is_error: bool,
}
```

as **the single currency of the transcript interface, for all tools**: the
`external_tool_finished` frame carries `{result: TranscriptToolResult}`;
`tool_calls.result_payload` persists it (with `tool_calls.status` derived from
`result.is_error`); and the resume manifest's `tool_result` block carries it —
**Core tool errors, Proposal Decisions, the not-executed placeholder, and MCP
results all migrate to this one shape** (replacing the string-reduction +
`is_error: None` in `crates/core/src/resume.rs` `render_result_content`).
`AgentToolResult` remains what it is — the live Worker-runtime shape — and the
Worker maps it to `TranscriptToolResult` at the frame boundary (drop
`terminate`/`details`, keep content + error). **Resume also restores the tool
NAME for external calls**: pi needs each replayed tool_result associated with its
call's name; resume derives it from the preceding persisted tool-call row (the
`tool_calls` row already pairs id + name) — carried explicitly in the manifest
block if pairing-by-position ever proves fragile.
**S1's job here is the MCP adapter mapping only** — how TickTick MCP result
payloads (text? structured content blocks?) map into `TranscriptToolResult.content`
— the wire shape itself is fixed by this plan, not by the spike.
**What chat shows (agreed):** external rows render as a **collapsed name + status
row** by default; **expanding reveals the normalized `TranscriptToolResult.content`
the model received** — errors identically (collapsed error row → expanded error
content). Live and after reload the row and its expansion are identical, which
requires BOTH paths to carry the result:
- **Live:** the `tool_call` Run Event today carries only
  `{tool_call_id, name, status, arg?}` (`crates/core/src/protocol/run.rs`
  `RunEvent::ToolCall`, mirrored in `packages/protocol/src/run.ts`) — **terminal
  `tool_call` events gain an optional `result: TranscriptToolResult`**; started
  events omit it. The Web store's merge (`apps/web/src/store/chat.ts` — today it
  merges only `status` into an existing call) **merges the result too**.
- **Reload:** the Client-facing `Segment.tool_call` gains the same optional
  `result` field, served from `tool_calls.result_payload`.
- **No grouping for result-bearing external calls:** `groupToolCalls`
  (`apps/web/src/components/ToolActivity.tsx`) merges non-errored same-name calls
  into one row, which would collapse two `ticktick_search_task` calls into one
  ambiguous expandable — losing per-call identity. v1 rule: **external calls never
  group; one expandable row per call**, keyed by `tool_call_id` (Core-tool grouping
  is untouched).
- **Durable per-call identity:** the persisted `Segment.tool_call` carries no id
  today (`crates/core/src/protocol/thread.rs`; hydration invents position-based
  ids in `apps/web/src/store/hydrate.ts`) — **`Segment.tool_call` gains
  `tool_call_id`**, served from the `tool_calls` row, so the reload row keys and
  expands identically to the live one.
- **What marks a call external:** the **reserved `ticktick_` name prefix** — the
  Core registry rejects registering any tool whose name starts with it (a
  one-line guard + test), so the prefix is unambiguous at every consumer: the
  Web's no-grouping rule, the frame handler, and resume all key off the name.
  No parallel boolean to keep in sync while a call is still running.
- **Interrupted calls settle as errors, in both paths:** cancellation kills the
  Worker (`crates/core/src/worker/run.rs`) and Worker death can land after
  `external_tool_started` but before the finished frame — today the live path
  settles the row (without a result) while reload *skips* pending calls
  (`crates/core/src/db/threads.rs`), so the two would diverge. Contract, both
  halves:
  1. **Persist:** when a Run terminates (cancelled, errored, Worker EOF), Core
     settles every still-pending external `tool_calls` row with an explicit
     interrupted result — `TranscriptToolResult {content: [{type:"text",
     text:"interrupted"}], is_error: true}` — in the same transition that settles
     the Run.
  2. **Publish:** the terminal paths emit only `cancelled`/`error`/`done` today
     (`crates/core/src/cancel.rs`, `crates/core/src/worker/run.rs`) — the live tab
     would settle the row without the result and diverge from reload. So **after
     that transaction commits and before the terminal Run Event (and hub closure),
     Core publishes a `tool_call {status: error, result: <interrupted>}` event for
     each settled row.** For cancellation the order is pinned: **cancel verb
     response → interrupted `tool_call` event(s) → `cancelled` Run Event**; for
     Worker EOF: interrupted `tool_call` event(s) → the terminal event.
  Note the content's provenance: **"interrupted" is Core-generated** — the one
  case where an expansion shows Core-synthesized text rather than content the
  model received (the model saw nothing; the Run died first). Every other
  expansion remains exactly the model-received `TranscriptToolResult.content`.
  Live and reload then agree by construction: the row renders as an error
  ("interrupted") and expands to that content in both. **Verification is
  `thread/get` rehydration, not Resume** — Resume applies only to parked Runs
  (CONTEXT.md), and interrupted rows exist only on cancelled/errored Runs; Retry
  deliberately drops unproposed tool calls, so the interrupted row is a rendered
  record, never a replayed one. S3 tests both triggers: user cancellation after
  `started`, and Worker EOF after `started` — asserting the live event arrives
  before the terminal event, and the reloaded thread renders identically.
Never exposed: credentials, raw MCP metadata, runtime `details`/`terminate`
(already stripped at the frame boundary). No display argument in v1 (the reload
path derives `arg` via per-tool extractors that exist only for Core registry
tools).
**Storage claim, precisely:** Core persists no authoritative task state and no task
cache; task content appears incidentally inside the durable Run transcript
(`tool_calls.result_payload`), retained with the Run (cascade delete).

**A5 — Credentials: manual provisioning, boot-read, restart to change.**
- The user provisions credential file(s) once (0600, under
  `<data-dir>/inkstone/credentials/`).
- **Core reads credentials exactly once, at boot** (and hands the Worker its MCP
  auth at spawn from that boot-read state). **There is no runtime re-read**: a 401
  from TickTick maps to the error state, and **credential changes require a Core
  restart**. This closes the account-mixing hole (a 401-triggered re-read could
  load a *different account's* token and fetch it under the old connection ID /
  query key) and the silent-swap hole (replacing a still-valid token never 401s, so a
  re-read path would never notice it anyway). Restart-to-change is the honest,
  simple contract for a manually provisioned personal install.
- **Connection identity** = an **opaque, boot-scoped connection ID** (random,
  generated at boot when a credential loads) — *not* a token-derived hash, so
  nothing about the secret leaks into keys and no cross-boot equality is implied
  (account alignment is proven separately, in S1). One boot, one credential, one
  ID, so a query key can never span two accounts; a restart mints a new ID, and
  the A2 reconnect protocol clears stale query data. Served by `ticktick/status`;
  the token itself never appears in keys, transcripts, or logs.
- **"Disconnect" is a manual act:** delete/replace the file, restart. The Web's
  not-connected state comes from `ticktick/status` after the restart.
- **One account, both lanes:** one `tasks:read tasks:write` token spans OpenAPI +
  MCP, so one 0600 file establishes account alignment. TickTick reports an
  approximately 180-day lifetime and no refresh token; reprovision manually at
  expiry. The credential file records `obtained_at`; expiry lands as a hard 401
  → error state on both lanes at once, so **an "token likely expiring soon"
  hint on `ticktick/status` (obtained_at + observed ~180d) is the named S5
  candidate** — polish, only if the first usable flow wants it.

**A6 — No shared task model.** The two lanes share only Core's credential custody
and the same configured account. Web staleness is TanStack's; Worker errors are MCP
results the model reads. No snapshot type, no Core task cache, no generation, no
cross-lane consistency contract.

**A7 — Config.** No task-source config file. Base URL and MCP endpoint are
compile-time constants (test-only overrides via the established env-seam pattern);
request timeouts follow the existing `parse_timeout_ms` env-knob pattern. No TTL —
there is no Core cache to tune.

**A8 — S1 spike and the S1a addendum are complete.** The contract investigation
established:
- **OpenAPI:** the aggregate `{"status":[0]}` filter returns at most 200 entries and
  may include NOTE rows. The product accepts that ceiling; normalization filters by
  `kind`. Diagnostic project-data reads proved the staged account contained 208
  open tasks. Recurrence/checklist, all-day/timed semantics, and per-kind
  nullability were observed.
- **MCP:** connection over streamable HTTP; the selected allowlist + namespacing;
  the task-query tool answers a representative advanced question; error shapes.
- **Credentials:** one full-scope token authorizes both lanes; lifetime is about
  180 days without refresh; only OpenAPI accepts read-only scope, while MCP
  requires write scope.
- **Payload reality:** representative response sizes (informs UI + prompt budgets).
- **S1a addendum:** the date-shape collapse (one due tuple) and the literal Inbox
  sentinel (→ synthetic "Inbox" list).
The observed limits are accepted; **S2 and S3 are implemented under these
contracts** (both hidden until the S4 cutover).
Real TickTick responses and account data are not committed. Deterministic tests
use small hand-authored wire values; live service validation runs in the
credentialed `ticktick-live-smoke` workflow (scheduled + manually dispatched),
not the required PR gate.

**A9 — Vocabulary.** **TickTick connection** — the configured account + credentials
+ endpoints. **`TickTickTaskRow`** — the Web lane's normalized wire row. **External
tool** — a model-facing MCP tool the Worker executes directly (`ticktick_*`),
observed by Core via lifecycle frames. **Tasks Topic** — the renamed GTD nav slot.
Avoid: Todo (retired at cutover), GTD Topic (renamed), Task Source / TaskSnapshot /
external read cache / projection / generation (deleted concepts), Connector, sync,
consolidated.

## The product decision (retirement — the cutover slice)

**What retires (S4):** the Todo Entity Type (mutation kinds, payload specs,
extraction prompts, proposal descriptor variants), Recurrence Rule + occurrence
generation (ADR-0037/0039), Todo Person References, the GTD todo processing views
(Inbox / Waiting / Scheduled / Today todo section), TodoEditor / DerivedTodoView /
GtdView web components, todo seeds/fixtures, and the CONTEXT.md task vocabulary.
Schema: tables dropped by editing migrations in place (AGENTS.md §5). Same slice:
GTD Topic → **Tasks** with the S2 surface linked; **Project Review relocates to the
Project surface**; the Worker's `ticktick_*` tools become reachable by the default
Workflow. No intermediate commit leaves the product task-less.

**What survives:** Project (outcome Entity + review cadence, minus todo-ownership),
Person (minus Todo Person References), Journal/extraction for non-task entities.

**Consequence (agreed):** chat task capture dies at cutover — "remind me to buy
milk" produces no tracked task anywhere; the agent's honest move is "add it in
TickTick" until a future write feature. ADRs 0037/0039/0055 get superseded-by notes.

## Design (what changes where)

```text
Browser ── ws verbs ──► Core ◄── stdio/manifest ──► Worker ──► LLM provider
   │                     │                            │
   │ TanStack Query      ├─ NEW crates/core/src/ticktick/        │ NEW: MCP client (official
   │ (proposed: 60s      │    client.rs   reqwest: 2 reads,      │ TS SDK) → mcp.ticktick.com
   │  staleTime, focus/  │                const URL, timeouts    │ · dual read-allowlist
   │  reconnect refetch) │    wire.rs     private transport      │ · ticktick_* namespacing
   │                     │                types → TickTickTaskRow│ · endpoint+auth from manifest
   │                     │    token.rs    0600 file(s), read ONCE│
   │                     │                at boot + opaque conn ID│ NEW: external-tool lifecycle
   │                     │                (restart to change)    │ frames (pi finalized event)
   │                     │
   │                     ├─ seam 1: ticktick/status + ticktick/tasks/list verbs (Web lane)
   │                     ├─ seam 2: manifest carries MCP endpoint + auth (Worker lane)
   │                     ├─ seam 3: lifecycle-frame handler → tool_calls (call + result) +
   │                     │   run_steps + live tool_call Run Events (terminal events carry
   │                     │   result) + resume reconstruction; chat renders collapsed rows
   │                     │   that expand to the model-received content (A4)
   │                     └─ S4 CUTOVER: retirement + GTD→Tasks + Project Review→Project
```

## Slices (each independently landable, gate-green)

| # | Slice | Contents | Verify |
|---|-------|----------|--------|
| S1 | Contract spike (both lanes) — **complete for its original scope (GO with accepted limits)** | Manual probes covered the accepted 200-entry cap, kind-based NOTE exclusion, MCP `tools/list` + advanced query, one-token compatibility, scope limits, date/nullability/result/error shapes; the decision ledger retains the resulting adapter mapping, exact allowlist, and row candidates | rev 28 records accepted limits; raw responses and one-time capture tooling are not committed |
| S1a | Addendum probes — **COMPLETE (2026-08-15)** | A staged task with distinct start 09:30 / due 10:30 **collapsed to the due instant** through create, update, and filter read. The Inbox probe found a literal `inbox`-prefixed sentinel → synthetic "Inbox" list | `TickTickTaskRow` date shape is frozen to one due tuple; focused normalization tests pin both decisions |
| S2 | Hidden Web lane | `crates/core/src/ticktick/` (client, wire, token boot-read + opaque connection ID); **`ticktick/status`** + **`ticktick/tasks/list`** verbs; fixed 200-entry task read returning `{tasks, sourceLimitReached}` (flag computed pre-filter) with `TEXT`/`CHECKLIST` normalization; **date shape and Inbox labeling follow the resolved S1a contract** (one due tuple; `^inbox` sentinel → "Inbox"); TanStack Query integration (one task query per connection ID, display filtering local, reconnect protocol); Tasks UI built, **not linked in nav** | unit tests on small hand-authored wire values (kind-based NOTE exclusion, accepted cap behavior, all-day/timezone tuple normalization, absent-list-id → unnamed list); **date-shape tests assert the single due tuple** (S1a: collapse proven — no distinct start); **Inbox tests assert an Inbox task renders "Inbox", never "unnamed list"** (S1a outcome 1); **200-raw/199-visible case → `sourceLimitReached` true → "TickTick returned its 200-item limit; this view may be incomplete." renders**; fake-HTTP-server lifecycle (timeout, 401, stale/error behavior); account-swap reconnect e2e; no task/cache SQLite rows |
| S3 | Hidden Worker lane | Worker MCP client (official SDK) behind manifest-passed endpoint+auth; dual allowlist (discovery filter + pre-execution gate); `ticktick_*` namespacing; **`executionMode: "sequential"`** (whole batch — frame order == source order by contract); lifecycle frames (started ← `tool_execution_start`, finished ← finalized `tool_execution_end`) carrying **`{result: TranscriptToolResult}`** (no outer is_error; `tool_calls.status` derives from `result.is_error`); Worker maps AgentToolResult → TranscriptToolResult at the frame boundary (drops `terminate`/`details`); Core persists it; **resume migrates Core errors, Proposal Decisions, the not-executed placeholder, and MCP results to the same TranscriptToolResult AND restores each external call's tool name** (from the paired tool-call row); **expandable result UI: terminal `tool_call` Run Events AND `Segment.tool_call` gain optional `result: TranscriptToolResult` + `Segment.tool_call` gains `tool_call_id` (started events omit result); the Web store merges result into the existing call; collapsed name+status → expand shows content, errors identical; external calls NEVER group — one expandable row per call (Core-tool grouping untouched); `ticktick_` prefix reserved in the Core registry; Run termination settles pending external rows with the interrupted error result AND publishes `tool_call {status:error, result}` events after the tx, before the terminal Run Event** | fake-MCP-server e2e: advanced query → answer; **write tool absent from discovery AND rejected at the execution gate**; **failed MCP call persists as error, not success**; **a multi-call mixed Core/MCP batch lands in source order** (frames → run_steps → timeline); collapsed row + **expanded content identical live (pre-reload) and after reload**; **error expansion shows error content**; **two successful same-name external calls render as two rows with distinct results, live and reloaded**; **cancel-after-started AND Worker-EOF-after-started both settle the row as "interrupted" (is_error, Core-generated content): cancellation order pinned cancel-response → interrupted `tool_call` → `cancelled`; EOF: interrupted `tool_call` → terminal; `thread/get` rehydration renders identically (Resume is parked-only; Retry drops unproposed calls)**; no credentials/raw MCP metadata in any rendering; parked→resume replays a provider-valid transcript with the MCP call as TranscriptToolResult + its tool name — Core and external results decode through the one schema |
| S4 | Cutover: retire + expose | The retirement list; GTD Topic → Tasks with the S2 surface linked; Project Review → Project surface; `ticktick_*` tools reachable by the default Workflow; CONTEXT.md + ADR supersede notes | gate green; no `todo` mutation kind or tool surface; extraction e2e proposes no Todos; Project Review reachable + markable on Project; Tasks Topic live end-to-end; **no intermediate commit leaves the product task-less** |
| S5 | Polish (only if required) | Only what the first usable flow demands — named candidates: provisioning-guidance refinement; the `ticktick/status` expiry-proximity hint (A5); no snapshot/generation concepts return | web e2e for whatever ships; nothing else |

ADR to open with S4 (drafted during S2–S3): **ADR-0064 "Task ownership moves to
TickTick: native Todo retirement + two external read paths"** — records the Agreed
ledger, the retirement list, A2/A3 (two lanes and why), A4 (lifecycle-frame seam +
the transcript-fidelity spec + the agreed expand-on-demand visibility), A5 (boot-read
credentials, restart-to-change, opaque connection ID), and the absence of writes. CONTEXT.md rewrites land
with S4.

Definition of done per slice: `pnpm format && pnpm lint && pnpm check && pnpm -r test`
green, plus the Rust legs explicitly: `cargo check` and
`cargo test --manifest-path crates/core/Cargo.toml`.

## The demo that proves it (post-S4)

1. **No native Todo** model, table, recurrence code, editor, extraction behavior, or
   task mutation remains.
2. **Web renders OpenAPI-backed TickTick rows** and follows the proposed
   query/refetch behavior (stale indicator on failed background refetch;
   reload-during-outage shows the fetch error).
3. **Worker answers an advanced task question through TickTick MCP**; the call
   renders as a collapsed name + status row that **expands to the exact
   `TranscriptToolResult.content` the model received** — identically live and
   after transcript reload; errors expand the same way; the request + result +
   tool name persist for provider-valid resume.
4. **Write tools are not exposed to the model, and the execution gate rejects
   them.** This is an Inkstone-enforced guarantee only; S1 proved MCP requires a
   write-scoped credential.
5. **SQLite contains no task authority or cache rows**; only ordinary Run transcript
   records may contain returned task content.
6. **Web and Worker are demonstrably configured for the same TickTick account**
   without requiring identical fetch timing.
