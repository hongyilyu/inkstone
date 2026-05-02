# Inkstone — SQL / Persistence Guide

Single-file reference for the SQLite persistence layer. Read this before
touching `src/backend/persistence/` — the rest of the codebase takes
these invariants for granted.

> **DANGER — pre-1.0 reset policy.** Until Inkstone has users beyond
> the maintainer, schema-incompatible changes regenerate `0000_init.sql`
> from scratch instead of chaining migrations. Running the app after
> such a change requires `rm ~/.local/state/inkstone/inkstone.db*`
> once. This loses all session history. Stop doing this the moment
> anyone else is running Inkstone.

## Contents

- [Stack](#stack)
- [File layout on disk](#file-layout-on-disk)
- [Schema overview](#schema-overview)
- [Identity model (UUIDv7)](#identity-model-uuidv7)
- [Visibility](#visibility)
- [Session lifecycle](#session-lifecycle)
- [Transactional boundary](#transactional-boundary)
- [Public API — `sessions.ts`](#public-api--sessionsts)
- [Migrations](#migrations)
- [Error surface](#error-surface)
- [Invariants and gotchas](#invariants-and-gotchas)
- [Known limitations](#known-limitations)
- [How-to recipes](#how-to-recipes)
- [Source map](#source-map)

---

## Stack

- **`bun:sqlite`** — SQLite shipped with Bun. No native dep.
- **`drizzle-orm`** — typed schema + query builder.
- **`drizzle-kit`** — schema-diff migration generator.
- **`Bun.randomUUIDv7()`** — stdlib UUIDv7 factory (Bun ≥ 1.1.25).

## File layout on disk

Paths are XDG-style with standard overrides. Resolved in `paths.ts`.

| File | Purpose |
|---|---|
| `~/.config/inkstone/config.json` | User preferences (JSON, Zod-validated) |
| `~/.config/inkstone/auth.json` | OAuth credentials (mode 0600, JSON) |
| `~/.local/state/inkstone/inkstone.db` | Session store |
| `~/.local/state/inkstone/inkstone.db-wal` / `-shm` | SQLite WAL artifacts |

JSON files for small, hand-editable, sometimes-screen-shared state.
SQLite for everything conversation-scoped.

## Schema overview

Four tables. FKs cascade from `sessions`, so tearing a session down
removes everything attached. See
[`src/backend/persistence/db/schema.ts`](../src/backend/persistence/db/schema.ts)
for the authoritative column definitions.

```
sessions ──┬── messages ── parts       (display-layer fanout)
           └── agent_messages          (raw pi-agent-core messages)
                   │
                   └── display_message_id (nullable FK back to messages)
```

| Table | Purpose |
|---|---|
| `sessions` | Conversation root. `agent` column scopes all reads. `/clear` ends the in-memory session; the row stays on disk untouched. |
| `messages` | One row per `DisplayMessage` (bubble). UUIDv7 `id`. Per-message metadata (agent/model/duration/error/interrupted) mirrors the bubble footer. `error` carries pi-ai's `AssistantMessage.errorMessage` only on `stopReason === "error"` (hard provider failures → red-bordered panel on render). `interrupted` (`INTEGER` boolean) is set on `stopReason === "aborted"` so resumed sessions render the ` · interrupted` footer suffix; the two columns are mutually exclusive at write time. |
| `parts` | `DisplayPart` fanout. Composite PK `(message_id, seq)` — parts have no cross-session identity. `type ∈ {text, thinking, file, tool}`; `text` is NOT NULL (stored as `""` on `file` / `tool` rows, whose display data lives in dedicated nullable columns). File parts use `mime` + `filename` (two flat columns instead of a JSON `meta` blob so `listSessions`'s preview fallback can read `filename` in SQL). Tool parts use `call_id` (pi-ai `ToolCall.id`, the join key between `toolcall_end` stream events and `tool_execution_end`) plus a JSON `tool_data` blob holding `{ name, args, state, error? }` — no SQL reader needs the inner fields. |
| `agent_messages` | Raw pi-agent-core `AgentMessage` as JSON, for LLM-context restore on resume. `display_message_id` links back to the bubble this message produced (NULL for tool-result / user / custom messages). |

### Why `agent_messages` is a separate table

- Tool-result messages exist here but have no display bubble.
- Shape is pi-agent-core's, not ours — evolves on pi's schedule.
- Resume is one query: `SELECT data FROM agent_messages WHERE
  session_id = ? ORDER BY id` → assign to `Agent.state.messages`.

### `$type<AgentMessage>` is TS-only

The JSON column uses Drizzle's `$type<AgentMessage>()` brand for type
inference at call sites, but the column itself is plain TEXT. There is
**no runtime validation** — if pi-agent-core widens `AgentMessage`
incompatibly, old rows will type-check fine but may fail at consumer
sites. Pin pi-agent-core versions and use Zod at the boundary if you
ever need a runtime guarantee.

### No tree column

There's no `parent_id` or `turn_id` today. Chronological order comes
from `ORDER BY messages.id` (UUIDv7 prefix). When branching or
summarization needs genuine parent/turn semantics, add the column then
with real requirements — don't speculate.

## Identity model (UUIDv7)

Top-level ids (`sessions`, `messages`, `agent_messages`) are UUIDv7:

1. **Globally unique** — cross-session collisions are impossible.
2. **Approximately chronological** — 48-bit ms timestamp prefix means
   `ORDER BY id` yields time-ordered results; tail bits break ms-level
   ties, so two rows written in the same millisecond can sort
   arbitrarily. For display messages this is academic; for
   `agent_messages` written in a tight message-end loop it's
   occasionally visible.
3. **Insert locality** — consecutive rows cluster in the same btree
   leaf pages.

`newId()` in `sessions.ts` wraps `Bun.randomUUIDv7()`. The TUI uses
the same function so ids flow frontend → backend with no mapping.

Parts skip UUIDs because they live inside a message and have no
identity beyond parent + position. `(message_id, seq)` is natural.

### Clock drift between `messages` and `agent_messages`

Both tables use UUIDv7 but each id is minted at its own call site
(`messages.id` in the reducer at `message_start`; `agent_messages.id`
in `appendAgentMessage` at `message_end`). The two streams are
independent clocks — interleaving by id across the two tables is
**unsupported** and will sort inconsistently. Use
`agent_messages.display_message_id` (the nullable FK) when you need to
correlate a raw message with its bubble; don't try to align them by id
order.

## Visibility

- `listSessions()` — returns every session on the store, newest first.
  Each `SessionSummary` carries its own `agent` field so callers can
  render a cross-agent list. The TUI's Ctrl+N panel uses this directly.
- `loadSession(id)` — scoped by session id, which is unique — no agent
  filter. A resume path that spans agents must swap the live `Session`
  via `selectAgent` before seeding the Agent with the loaded history;
  see `src/tui/context/agent.tsx::resumeSession`.

Mid-session agent switching on the live Session is still gated to the
empty-session open page (see `docs/ARCHITECTURE.md` "Agent Registry →
Switching rules" and `docs/AGENT-DESIGN.md` D13).

## Session lifecycle

```
boot ─▶ createSession(agentName)            [in-memory Agent; no DB read]
      ─▶ openpage                           [messages: [] — no auto-resume]

first user prompt ─▶ ensureSession()        [creates DB row if none]
                   ─▶ appendDisplayMessage(userMsg)

assistant turn    ─▶ message_start  ─▶ appendDisplayMessage(shell,
                                          { includeParts: false })
                   ─▶ message_update ─▶ [store-only; no DB writes]
                   ─▶ message_end    ─▶ runInTransaction(tx => {
                                          updateDisplayMessageMeta(…, { tx })
                                          finalizeDisplayMessageParts(…, { tx })
                                          appendAgentMessage(…, { tx })
                                        })
                   ─▶ agent_end      ─▶ updateDisplayMessageMeta (duration)

/clear           ─▶ drop in-memory sessionId (row stays on disk untouched)
```

### Lazy session creation

No row exists on disk until the first user prompt. Booting and quitting
without interacting leaves the DB clean.

### No auto-resume at boot

Boot always shows the openpage — Inkstone does not auto-resume the
previous session. Past session rows stay on disk as-is; a future
`/resume` or `/session` command will list and load them. See D13 in
`docs/AGENT-DESIGN.md`.

## Transactional boundary

`message_end` commits three artifacts — header meta update, parts
replace, and the raw `AgentMessage` — in one transaction:

```ts
runInTransaction((tx) => {
  updateDisplayMessageMeta(tx, sid, msg);
  finalizeDisplayMessageParts(tx, sid, msg);
  appendAgentMessage(tx, sid, rawMsg, { displayMessageId: msg.id });
});
```

A crash between writes rolls back. Before this, the three calls ran
as separate implicit transactions and a mid-trio kill left orphans.

### API shape: force-tx, no global-client write path

All writers (`appendDisplayMessage`, `updateDisplayMessageMeta`,
`finalizeDisplayMessageParts`, `appendAgentMessage`) take a **required**
`tx: Tx` parameter. There is no auto-wrap fallback — callers that only
need a single write wrap explicitly:

```ts
runInTransaction((tx) => appendDisplayMessage(tx, sid, userMsg));
```

This is intentional ergonomic friction:

- One code path — no dual-mode writers, no `opts?.tx` branching, no
  `as TxLike` casts.
- Every call site states atomicity intent locally. Readers don't have
  to trace out whether a write happens inside someone else's tx.
- New writers can't accidentally forget to participate in an outer tx
  — they physically can't run without one.

Reads (`loadSession`, `listSessions`) use the root client directly;
they don't take `tx`. The single session-row mutator
(`createSession`) also uses the root client — one statement, which
SQLite auto-commits atomically.

### Crash-repair boundary

The transactional boundary covers `message_end`, but not the shell
insert at `message_start`. A SIGKILL between `message_start`'s shell
write and `message_end` opening its transaction leaves a trailing
empty assistant row.

Two complementary repair paths keep `agent_messages` alternation-clean
across the crash window:

1. **Prevention — `agent_end` catch-up write.** pi-agent-core's
   `handleRunFailure` (see `agent.js`) synthesizes a closing
   `{ role: "assistant", stopReason: "aborted" | "error" }` and emits
   **only** `agent_end` (no matching `message_end`) on abort/error
   paths. The reducer's `agent_end` branch in
   `src/tui/context/agent.tsx` appends any such synthesized message
   to `agent_messages` directly, so disk never sees the bare-user
   tail for pi-agent-core-originated aborts.
2. **Backstop — load-time repair in `loadSession`.** For corruption
   that slipped past prevention (SIGKILL between events, older data
   predating the catch-up write), `loadSession` scans
   `agent_messages` post-read and fills every `user`→`user` gap —
   trailing OR interior — by synthesizing an aborted assistant
   between the adjacent user rows. Pure read-time transformation;
   stored rows are never mutated.

Empty assistant *display* shells (header row from `message_start`
with no `message_end` follow-up) are still on disk, but don't reach
the UI because `conversation.tsx`'s outer `<Show>` gate drops bubbles
with zero parts and no error. No repair runs for those today; the
git history holds a one-statement DELETE under `repairSession` if
the pass is ever needed.

## Public API — `sessions.ts`

See [`src/backend/persistence/sessions.ts`](../src/backend/persistence/sessions.ts)
for the authoritative signatures. Quick reference:

### Reads

- `loadSession(id)` — full hydration; pure read. Called by the
  session list panel's resume flow (see `ARCHITECTURE.md §Session list
  panel`). Performs **load-time alternation repair**: scans the
  returned `agent_messages` tail AND interior for any `user`→`user`
  gap (session killed mid-turn between `message_start` and
  `message_end` — Ctrl+C / process crash) and synthesizes an aborted
  `assistant` `AgentMessage` (`stopReason: "aborted"`,
  `errorMessage: "[Interrupted by user]"`) between each adjacent
  user pair so the returned list satisfies provider alternation
  invariants. Stored rows are **not** modified; repair is pure
  read-time transformation. Works in tandem with the `agent_end`
  catch-up write (see § Crash-repair boundary) which prevents the
  common pi-agent-core-abort corruption from ever landing on disk.
- `listSessions()` — newest-first summaries across every agent, with
  `messageCount` (single `GROUP BY` query, no N+1). Each row carries
  its own `agent` so the Ctrl+N panel can render a cross-agent list.

### Writes — require `tx`

All writers take a required `tx: Tx` parameter. Wrap single writes in
`runInTransaction` (see § Transactional boundary).

- `createSession({ agent })` — new row. (No tx; single
  statement.)
- `appendDisplayMessage(tx, id, msg, { includeParts? })` — insert
  header, optionally parts.
- `updateDisplayMessageMeta(tx, id, msg)` — header-only update.
- `finalizeDisplayMessageParts(tx, id, msg)` — DELETE+INSERT parts as
  a batch.
- `appendAgentMessage(tx, id, rawMsg, { displayMessageId? })` —
  insert raw message, optionally link to a bubble.

### Utility

- `runInTransaction(fn)` — wrap multiple writes in one tx. Wraps its
  body in a try/catch that reports pre-writer failures (db-acquire,
  SQLITE_BUSY, tx-open) as `action: "tx"` and rethrows. Writer-
  originated failures are reported by the writer first; the outer
  catch sees the same rethrown error and is a no-op thanks to the
  dedup sentinel in `reportPersistenceError`.
- `safeRun(fn)` — swallow after reporting. Wraps a `runInTransaction`
  call at the 6 pre-stream / best-effort persist sites in the reducer
  (`message_start` shell insert, `message_end` non-assistant branch,
  `agent_end` synthesized-abort loop, synthetic error bubble,
  `displayMessage` command helper) where there's no already-persisted
  state to roll back to. The toast has already fired; the body's
  throw is swallowed to preserve "log and continue" semantics.
- `newId()` — fresh UUIDv7.

### Writer error contract

Writers report-and-rethrow on failure (each `catch` calls
`reportPersistenceError` then re-throws). The `reportPersistenceError`
hook is idempotent via a `__inkstoneReported` sentinel attached to the
error object on first report, so re-reports of the same rethrown error
up the chain no-op — no duplicate toasts when a writer throws and
`runInTransaction`'s outer catch sees it.

Two caller-side shapes on top of the throw contract:

- **`safeRun(() => runInTransaction(…))`** — preserves the old
  log-and-continue behavior. Use at pre-stream appends and any site
  where persistence failure is benign at runtime (disk mismatch
  absorbed by resume-time repair or by being ephemeral).
- **`persistThen(writes, onSuccess)`** (defined in
  `tui/context/agent.tsx`) — gates a follow-up store mutation on tx
  success. Use at reducer sites that mutate already-persisted state,
  so that on tx throw the live view stays at its pre-mutation value
  and matches what `/resume` would reconstruct. Eliminates the
  store/DB drift window that let bubbles render `completed` while
  disk still had `pending`.

Recipe — reducer site (persist-first):

```ts
const updated: DisplayMessage = { ...store.messages[lastIdx]!, agentName, modelName };
persistThen(
  (tx) => {
    updateDisplayMessageMeta(tx, sid, updated);
    finalizeDisplayMessageParts(tx, sid, updated);
    appendAgentMessage(tx, sid, rawMsg, { displayMessageId: updated.id });
  },
  () => {
    setStore("messages", lastIdx, "agentName", agentName);
    setStore("messages", lastIdx, "modelName", modelName);
  },
);
```

Recipe — pre-stream / best-effort site:

```ts
safeRun(() => runInTransaction((tx) => appendDisplayMessage(tx, sid, shell, { includeParts: false })));
```

## Migrations

### Generating a migration

1. Edit `db/schema.ts`.
2. `bunx drizzle-kit generate --name <short-description>`.
3. Commit the new `.sql` under `db/migrations/`.
4. Restart — `getDb()` applies pending migrations on open.

### Runtime application

`getDb()` in `db/client.ts` calls `drizzle-orm/bun-sqlite/migrator`'s
`migrate(db, { migrationsFolder })` synchronously on first open.
PRAGMAs (`WAL`, `synchronous=NORMAL`, `foreign_keys=ON`,
`busy_timeout=5000`, `cache_size=-64000`) run before migrations so FKs
and WAL are live during DDL.

### Bundling

Today `migrate()` reads migration files from
`import.meta.dir/migrations`. Works for `bun run dev` and any
distribution that ships the folder alongside `client.js`. Packaging as
a single executable needs a bundler trick (opencode uses an
`OPENCODE_MIGRATIONS` global) — tracked in `docs/TODO.md`.

## Error surface

All persistence writes wrap their query in try/catch and route failures
through `reportPersistenceError` (see `src/backend/persistence/errors.ts`).
Each report carries `kind` (`"config" | "auth" | "session"`), a
grep-friendly `action` string (embeds `shortId(msg.id)` — last 8 hex
chars of the UUIDv7 random tail — plus the event type for appends),
and an `error: unknown`. Reports are deduplicated via a
`__inkstoneReported` sentinel attached to the error value on first
call, so writer-then-`runInTransaction`-outer-catch chains toast once
per failure, not twice.

`AgentProvider` installs a handler that turns these into toasts.
Load-path failures (which fire at module init, before any handler is
installed) land on `console.error` — TUI users always have a terminal
visible.

## Invariants and gotchas

1. **`messages.id` is a standalone PK**. Not `(session_id, id)`. UUIDv7
   makes cross-session collision impossible, and a standalone PK keeps
   `messages.id` FK'd from `agent_messages.display_message_id` simple.

2. **`currentSessionId` in the reducer is guaranteed non-null**.
   `ensureSession()` runs synchronously in `wrappedActions.prompt`
   before any assistant event can fire. If the defensive guards in the
   reducer ever go false, something is firing `AgentEvent`s without
   going through `prompt()`.

3. **Crash-repair is layered**. Prevention: pi-agent-core-originated
   aborts are caught via the `agent_end` reducer branch, which appends
   the synthesized closing assistant to `agent_messages` at runtime.
   Backstop: `loadSession` repairs any `user`→`user` gap in the raw
   stream at load time. Empty assistant display shells (header row
   from `message_start` with no `message_end` follow-up) remain on
   disk after a SIGKILL but don't reach the UI because
   `conversation.tsx`'s outer `<Show>` gate drops bubbles with zero
   parts and no error. Git history holds a one-statement DELETE
   under `repairSession` if a stripping pass becomes necessary.

4. **`$type<AgentMessage>` gives no runtime guarantee**. Column is
   TEXT; Drizzle does no validation. Pin pi versions.

5. **WAL files are normal**. `inkstone.db-wal` and `inkstone.db-shm`
   are SQLite's write-ahead log. Delete only when the DB is closed.

6. **`parts.seq` gaps are harmless**. Writer loops by index; if a part
   was popped mid-flush the resulting sequence may skip a number. The
   reader orders by `seq` without caring about contiguity.

7. **FK cascade**: deleting a session removes messages, parts
   (transitively), and agent_messages. `PRAGMA foreign_keys = ON` is
   set on every connection. `agent_messages.display_message_id` uses
   `ON DELETE SET NULL` so deleting a single bubble doesn't nuke its
   agent_message (used by future tree operations).

## Known limitations

- **No concurrency story.** `getDb()` is a per-process singleton. Two
  Inkstone processes (second terminal, accidental double-launch) each
  create their own session row on first prompt. SQLite's WAL means the
  file doesn't corrupt, but each process's session state is independent.
  No fix today — document and move on. Options when this becomes real:
  advisory flock on `DB_FILE`, or `sessions.owner_pid` checked on attach.
- **Migration bundling** — see Migrations § Bundling.
- **UUIDv7 sub-ms ordering** — rows written in the same millisecond
  may sort arbitrarily via tail bits. Rare in practice; add a
  `created_at` column if ever load-bearing.

## How-to recipes

### Inspect the DB

```sh
sqlite3 ~/.local/state/inkstone/inkstone.db
.headers on
.mode column
select id, agent, started_at, title from sessions order by id desc limit 10;
```

### Count messages per session

```sql
select s.id, s.agent, count(m.id) as n
from sessions s left join messages m on m.session_id = s.id
group by s.id order by s.id desc;
```

### Dump a session as JSON

```sh
sqlite3 ~/.local/state/inkstone/inkstone.db <<SQL
.mode json
select m.role, m.agent_name, m.model_name,
  (select json_group_array(json_object('type', p.type, 'text', p.text))
     from parts p where p.message_id = m.id order by p.seq)
from messages m where m.session_id = '<session-id>' order by m.id;
SQL
```

### Find the AgentMessage that produced a bubble

```sql
select a.data from agent_messages a
where a.display_message_id = '<message-id>';
```

### Reset everything (dev, destroys data)

```sh
rm ~/.local/state/inkstone/inkstone.db*
rm ~/.config/inkstone/config.json
# keep auth.json if you want to preserve OAuth creds
```

### Add a new column

1. Edit `db/schema.ts`.
2. `bunx drizzle-kit generate --name add-<column>`.
3. Review the generated SQL.
4. Restart.

### Add a new table

1. Export a `sqliteTable(...)` from `db/schema.ts`.
2. Add read/write helpers in `sessions.ts` (or a new module).
3. `bunx drizzle-kit generate --name add-<table>`.
4. Route all errors through `reportPersistenceError({ kind: "session", ... })`.

## Source map

| File | Responsibility |
|---|---|
| `src/backend/persistence/db/schema.ts` | Drizzle table definitions — source of truth for columns |
| `src/backend/persistence/db/client.ts` | Lazy `bun:sqlite` singleton, PRAGMAs, migrator |
| `src/backend/persistence/db/migrations/` | `drizzle-kit`-generated SQL |
| `src/backend/persistence/sessions.ts` | Public API (`newId`, reads, writes, `runInTransaction`, `safeRun`). `shortId` is an internal helper — not exported. |
| `src/backend/persistence/errors.ts` | `reportPersistenceError` hook + dedup sentinel |
| `src/backend/persistence/paths.ts` | XDG path resolution |
| `src/tui/context/agent.tsx` | Frontend consumer — reducer, `ensureSession`, wiring |
| `drizzle.config.ts` (repo root) | `drizzle-kit` CLI config |
