# Tier-2 SQLite schema for slice 1

This ADR pins the canonical SQLite schema (tier 2 per [ADR-0004](./0004-three-tier-storage-authority.md)) for the chat-driven MVP slice. The schema is the smallest set of tables that supports the slice 1 flows end-to-end (post a user message → spawn Run → stream text → submit Proposal → park → user approves → apply atomically → render history). It was revised after four independent reviews against agentic frameworks, AI chat tools, local-first PKM apps, and the existing t3code event-sourced reference.

## The schema

Eleven tables, all tier-2. All primary keys are **UUIDv7** (time-ordered; `ORDER BY id` yields chronological iteration without a separate index).

```sql
-- Threads --------------------------------------------------------------
CREATE TABLE threads (
  id                TEXT PRIMARY KEY,            -- UUIDv7
  title             TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  last_activity_at  INTEGER NOT NULL
);

-- Runs -----------------------------------------------------------------
CREATE TABLE runs (
  id                       TEXT PRIMARY KEY,
  thread_id                TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  workflow_name            TEXT NOT NULL,
  workflow_version         TEXT NOT NULL,
  provider                 TEXT NOT NULL,             -- LLM provider snapshotted at Run start
  model                    TEXT NOT NULL,             -- specific model id snapshotted at Run start
  user_message_id          TEXT NOT NULL REFERENCES messages(id) DEFERRABLE INITIALLY DEFERRED,
  idempotency_key          TEXT UNIQUE,
  awaiting_tool_call_id    TEXT REFERENCES tool_calls(id),  -- waitpoint when status='parked'
  status                   TEXT NOT NULL CHECK (status IN
                            ('pending','running','parked','completed','errored','cancelled')),
  terminal_reason          TEXT CHECK (terminal_reason IS NULL OR terminal_reason IN
                            ('completed','cancelled','worker_disconnected','core_restarted','errored')),
  error_code               TEXT,                      -- enumerated wire error per ADR-0014, NULL unless status='errored'
  error_message            TEXT,                      -- human-readable detail
  started_at               INTEGER,
  ended_at                 INTEGER
);
CREATE INDEX idx_runs_thread_started ON runs(thread_id, started_at);
CREATE INDEX idx_runs_status         ON runs(status) WHERE status IN ('pending','running','parked');

-- Messages and parts ---------------------------------------------------
CREATE TABLE messages (
  id            TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  run_id        TEXT NOT NULL REFERENCES runs(id) DEFERRABLE INITIALLY DEFERRED,
  role          TEXT NOT NULL CHECK (role IN ('user','assistant')),
  status        TEXT NOT NULL CHECK (status IN ('streaming','completed','incomplete')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_messages_thread_created ON messages(thread_id, created_at);
CREATE INDEX idx_messages_run            ON messages(run_id);

CREATE TABLE message_parts (
  message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('text','attachment')),
  text        TEXT NOT NULL DEFAULT '',           -- mutated during streaming for text parts (UPSERT)
  data        TEXT,                                -- JSON sidecar (attachment metadata, …)
  PRIMARY KEY (message_id, seq)
);

-- Tool calls + Run Steps -----------------------------------------------
-- tool_calls is the authoritative tool I/O record (OpenAI run_steps style).
-- A Proposal is a specialised tool call (sidecar table below).
CREATE TABLE tool_calls (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,                   -- read_file, search, propose_create_entities, …
  request_payload TEXT NOT NULL,                   -- JSON
  status          TEXT NOT NULL CHECK (status IN ('pending','completed','errored')),
  result_payload  TEXT,                            -- JSON; NULL while pending
  requested_at    INTEGER NOT NULL,
  resolved_at     INTEGER
);
CREATE INDEX idx_tool_calls_run ON tool_calls(run_id);

-- run_steps interleaves messages and tool_calls in chronological order
-- per Run, so the timeline is one ordered query.
CREATE TABLE run_steps (
  run_id         TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('message','tool_call')),
  message_id     TEXT REFERENCES messages(id),
  tool_call_id   TEXT REFERENCES tool_calls(id),
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq),
  CHECK (
    (kind = 'message'   AND message_id   IS NOT NULL AND tool_call_id IS NULL) OR
    (kind = 'tool_call' AND tool_call_id IS NOT NULL AND message_id   IS NULL)
  )
);

-- Run Events (durable per ADR-0014) ------------------------------------
-- Append-only. Backs `run/get_history(run_id, since_run_seq)` for
-- reconnect replay. Per-token text deltas are NOT in this table — those
-- are projected onto message_parts.text via the streaming UPSERT pattern.
-- This table holds coarser events: status transitions, tool boundaries,
-- proposal lifecycle markers, errors, completion.
CREATE TABLE run_events (
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  run_seq     INTEGER NOT NULL,                    -- monotonic per Run
  kind        TEXT NOT NULL CHECK (kind IN
                ('status','tool_request','tool_result',
                 'proposal_pending','proposal_decided',
                 'parked','done','error')),
  payload     TEXT,                                -- JSON; shape depends on kind
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (run_id, run_seq)
);

-- Proposals (sidecar of tool_calls) ------------------------------------
CREATE TABLE proposals (
  id                       TEXT PRIMARY KEY,
  tool_call_id             TEXT NOT NULL UNIQUE REFERENCES tool_calls(id) ON DELETE CASCADE,
  mutation_kind            TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected')),
  decided_by               TEXT CHECK (decided_by IN ('user','auto')),
  decided_at               INTEGER,
  edited_payload           TEXT,                    -- JSON; NULL means accepted unedited; populated means user edited before accepting
  applied_at               INTEGER,
  decision_idempotency_key TEXT UNIQUE              -- per ADR-0014 retry-safety for proposal/decide
);
CREATE INDEX idx_proposals_status ON proposals(status) WHERE status = 'pending';

-- Entities and revisions -----------------------------------------------
CREATE TABLE entities (
  id                       TEXT PRIMARY KEY,
  type                     TEXT NOT NULL,            -- journal_entry / person / todo / project / …
  schema_version           INTEGER NOT NULL,
  data                     TEXT NOT NULL,            -- JSON; current state (= revisions.data of latest seq)
  created_by               TEXT NOT NULL CHECK (created_by IN ('user','proposal')),
  created_via_proposal_id  TEXT REFERENCES proposals(id),
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  CHECK (created_by = 'user' OR created_via_proposal_id IS NOT NULL)
);
CREATE INDEX idx_entities_type ON entities(type);

CREATE TABLE entity_revisions (
  entity_id    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  data         TEXT NOT NULL,                       -- JSON snapshot at this revision
  proposal_id  TEXT REFERENCES proposals(id),       -- NULL only for direct user edits (none in slice 1)
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (entity_id, seq)
);
```

There is no `turns` table. Slice 1 also defined an entity `fts` FTS5 virtual table (tier 3), but it was never written or read and was removed pre-1.0; the schema carries no tier-3 table here. (Message search, added later, scans `message_parts` live with no index — [ADR-0035](./0035-message-full-text-search.md).)

## Invariants beyond the schema

Some constraints are not (cleanly) expressible in SQLite DDL but Core enforces them inside transactions:

- **Atomic Worker-failure recovery.** When a Run transitions to `errored` (Worker disconnect, Core restart), Core in the same transaction flips every `messages.status='streaming'` row for that Run to `incomplete`. Without this rule, a stale `streaming` row outlives the dead Run and a reconnecting Client cannot tell a clean message from a truncated one.
- **Atomic Proposal application.** When `proposals.status` flips from `pending` to `accepted`, every entity insert / update / delete the Proposal describes lands in the same transaction, with `entity_revisions` rows written for each, and `tool_calls.status='completed'` with the Tool Result payload set. Either the whole apply commits or none does.
- **Run timeline write ordering.** Every `messages` row of an assistant Turn is followed by zero or more `tool_calls` rows; each gets a corresponding `run_steps` row. Core writes message + tool_call + run_steps in one transaction so the timeline never has a gap between a tool_call existing and being addressable via run_steps.

## Why each shape

### `run_events` is the durable backing for `run/get_history`

[ADR-0014](./0014-client-core-wire-protocol.md) commits Run Events to durable storage so a Client that disconnected mid-Run can call `run/get_history(run_id, since_run_seq)` and receive the events emitted while it was offline. The `run_events` table is that backing store.

What lands in this table is the **coarse** event log — status transitions, tool boundaries, parking, completion, errors. Per-token `text_delta` events do *not* land here; those are projected onto `message_parts.text` via the streaming UPSERT pattern (see *Live text streaming* below). The split keeps two questions clean:

- "What happened during this Run, in order, observable to the UI?" → `run_events`.
- "What text did the assistant produce?" → `message_parts.text`.

Per-Run monotonic `run_seq` is the cursor; `UNIQUE(run_id, run_seq)` is enforced by the composite primary key.

**Amended (ADR-0028):** this table is the **Run Log**, renamed `run_log`; the never-written `tool_request`/`tool_result` kinds were dropped (tool boundaries live in `tool_calls`/`run_steps`, surfaced by `read_run_timeline`, not here), and the creation event's kind is `running`, not `status`. See CONTEXT.md *Run Log*.

### No `turns` table

Three of four reviewers (and t3code, and the inkstone-poc, and the OpenAI Assistants API, and LangGraph, and Temporal) confirmed: Turn boundaries are agent-loop implementation detail, not durable identity. The user thinks in terms of "I asked X, the agent did stuff and said Y" — that is one Run, with one or more `messages` + `tool_calls` interleaved by `run_steps`. A row-per-Turn would be addressable but unused.

### `messages` + `message_parts` instead of one column

A user message and an assistant message are bubbles in the UI. They both belong to a Run. They both can carry attachments alongside text. Splitting `message_parts` lets the assistant message represent text + (later) attachments + (later) inline display markers in `seq` order. For slice 1 the only `type` is `text` (and reserved `attachment`); slice 2's needs (file mentions, image embeds) extend `type` without schema change.

`messages.id` is FK'd from many places (`runs.user_message_id`, `run_steps.message_id`); per-bubble identity stays clean.

### `tool_calls` is OpenAI-style, independent of messages

Following OpenAI's `run_steps` separation: tool calls are not parts of the assistant message — they are first-class Run-scoped records with their own status, request payload, and result payload. Display interleaves messages and tool_calls via `run_steps`.

This matters most when a Run produces interleaved output: text, tool call, text, tool call, text — `run_steps` orders the eight events as one query; `messages` only stores the three text bubbles.

A **Proposal is a specialised tool call** with `name='propose_*'` and a sidecar `proposals` row. The `proposals` table carries the decision lifecycle (`pending/accepted/rejected/cancelled` — see "`proposals.status`" below; an *edit* is a decision, not a status), `decided_by` (user vs auto per [ADR-0016](./0016-proposal-application-policy.md)), `edited_payload`, and `applied_at`. The `tool_call.result_payload` carries the decision back to the Worker on resume — invisible to the Worker whether it came from a human or auto-approve.

### Live text streaming via `messages.status` + UPSERT (t3code pattern)

The Worker emits `text_delta` Run Events on the wire. Core, on each delta, **upserts the assembled text** into the matching `message_parts.text` (where `messages.status='streaming'`). When the Turn's text completes, `messages.status` flips to `'completed'`.

A Client reconnecting mid-Turn:
1. Reads `messages` for the open Thread → sees the partial assistant message with `status='streaming'` and current `text`.
2. Calls `run/get_history(run_id, since_run_seq)` for any coarse Run Events (status transitions, tool boundaries) it missed.
3. Subscribes to live Run Events (`run/subscribe(run_id)`) → receives subsequent deltas freshly.

This is t3code's streaming-text pattern, adapted: t3code persists the deltas as orchestration events because their architecture is event-sourced; Inkstone is not event-sourced (per [ADR-0004](./0004-three-tier-storage-authority.md)) so the partial-text-as-current-state column is the analogous primitive. Coarse Run Events still land durably (in `run_events`) for the reconnect-replay contract; only per-token deltas are spared.

Core may batch UPSERTs (e.g. one write per ~200ms or per N tokens) to avoid hot-path write amplification.

### `messages.status` tri-state and the `incomplete` invariant

The `messages.status` column has three values:

- `'streaming'` — Worker is actively producing text into `message_parts.text`.
- `'completed'` — Worker finished this assistant Turn cleanly; text is final.
- `'incomplete'` — Run errored or was cancelled mid-Turn; the partial text in `message_parts.text` is whatever the Worker had emitted before death.

Per [ADR-0012](./0012-run-lifecycle-ownership.md), Worker death mid-Turn produces an `errored` Run. The same Core transaction that flips `runs.status='errored'` flips every `messages.status='streaming'` row for that Run to `'incomplete'`. Without this invariant, a reconnecting Client cannot distinguish a half-written truncated message from a clean completed one. The invariant is enforced by Core, not by SQL trigger — see *Invariants beyond the schema* above.

### `runs.awaiting_tool_call_id` is the waitpoint

When the Worker submits a Proposal (or any blocking Tool Request) and Core parks the Run, `runs.status='parked'` and `runs.awaiting_tool_call_id` points at the unresolved row. A fresh Worker spawned to resume reads this directly — no scan of `message_parts` to find what's pending.

OpenAI Assistants does the same with `runs.required_action`; Trigger.dev does it with first-class waitpoint tokens. Both reviewers (R1, R3) flagged its absence.

### `entity_revisions` is append-only

Every Proposal application writes both the current state (`entities.data`) **and** a new revision row. Without revisions:
- [ADR-0016](./0016-proposal-application-policy.md)'s "reversal is uniform" claim is aspirational — there is nothing to revert to.
- Adding undo later means migrating every existing row and changing every write site.

Append-only revisions cost one extra INSERT per Proposal application. Slice 1 doesn't expose undo, but the data is there when it does.

The `entities.data` column is the denormalised "latest" copy for fast reads — equivalent to `entity_revisions.data` of the row with the highest `seq`. Reconciliation between the two is a Core invariant, enforced by always writing both inside one transaction.

### `created_by` + CHECK enforces ADR-0004

[ADR-0004](./0004-three-tier-storage-authority.md): agent-originated Entities **must** pass through a Proposal. The CHECK constraint `created_by = 'user' OR created_via_proposal_id IS NOT NULL` makes this a database invariant — a coding bug that tries to insert an agent-created Entity without a Proposal FK fails at the SQLite layer.

### Idempotency keys on `runs` and `proposals`

If the Web Client retries `run/post_message` after a network blip, `runs.idempotency_key UNIQUE` rejects the duplicate.

The same risk exists for `proposal/decide` per [ADR-0014](./0014-client-core-wire-protocol.md) — a retried decide should be safe to apply at most once. `proposals.decision_idempotency_key UNIQUE` provides the equivalent guarantee on the decision side.

Without idempotency keys: two Runs spawn for one user message, or one Proposal applies twice (or worse, an "accept" retry races a "reject" retry).

### `runs.provider` and `runs.model` snapshotted at Run start

A Workflow declares its model choice (CONTEXT.md). When a Run starts, Core resolves the Workflow's model declaration to a concrete `(provider, model)` pair and snapshots both onto `runs`. Without this snapshot, a Run that parks for hours and resumes after a default-model rotation or a Workflow manifest edit is non-reproducible — the resumed Worker would silently use a different model than the one that produced the prior Turns. Cheap to capture, prevents a class of "it worked yesterday" bugs.

OpenAI's Assistants Runs persist `model` for the same reason. Inkstone owns the Workflow set, but the same hazard exists.

### Terminal-state metadata on `runs`

[ADR-0012](./0012-run-lifecycle-ownership.md) enumerates four terminal reasons: `completed`, `cancelled`, `worker_disconnected`, `core_restarted`. [ADR-0014](./0014-client-core-wire-protocol.md) defines a reserved error-code namespace (`unknown_thread`, `proposal_not_pending`, `protocol_version_mismatch`, …). The schema captures both:

- `terminal_reason` records *why* the Run ended (one of the four ADR-0012 reasons, or `errored` for code-defect cases).
- `error_code` and `error_message` carry the wire-level error taxonomy when `status='errored'`.

A single freeform `error TEXT` column would conflate these. Splitting them keeps the wire taxonomy queryable and matches OpenAI's `last_error: {code, message}` shape.

### `proposals.mutation_kind` names the Workspace mutation

[ADR-0025](./0025-proposal-park-and-resume.md) amends the first entity-only Proposal shape for journal capture: the Proposal row stores a closed `mutation_kind` such as `create_journal_entry`, not an Entity Type `kind` plus a separate `change_kind`. The mutation kind names the operation Core will apply without requiring payload introspection.

### `proposals.status` is `pending / accepted / rejected / cancelled`

A user can edit a Proposal before accepting (per [ADR-0016](./0016-proposal-application-policy.md)). The earlier draft modelled this as a separate `status='edited'` value, but that's not a terminal state — an edit followed by an accept *is* an `accepted` Proposal, just with the user's modified payload. The schema reflects this:

- `status='accepted'` covers both unedited and edited acceptances.
- `edited_payload IS NULL` means accepted unedited; populated means edited.
- The `decided_by` column records who decided (user or auto).

Drop the separate `'edited'` status; it created a state-machine dead-end. `cancelled` was added later for `run/cancel` on a parked Run: the pending Proposal is cancelled in the same transaction as the Run, and cannot be decided afterward.

### Deferred FK on `runs.user_message_id` ↔ `messages.run_id`

A new Thread + Run + user-message + message_part is created in one Core transaction. `runs.user_message_id NOT NULL → messages` and `messages.run_id NOT NULL → runs` form a circular foreign-key dependency: neither row can be inserted first under default (immediate) FK enforcement. Both FKs are declared `DEFERRABLE INITIALLY DEFERRED` so SQLite checks them at commit time, after both rows exist. The constraints stay strict; only the check timing relaxes.

The alternative — making one side nullable — was rejected because both directions are real invariants: a Run *must* have a user message that triggered it, and an in-Workflow message *must* belong to a Run.

### Tier-2 vs tier-3 separation

[ADR-0004](./0004-three-tier-storage-authority.md) §"Schema separation" calls for tier-2 and tier-3 tables to be mechanically distinguishable. Slice 1 originally shipped one tier-3 table (the entity `fts` FTS5 table), since removed; the schema is now all tier-2. The boundary stays documented here, to revisit when tier 3 returns.

## Identity model

**UUIDv7 for all primary keys.** Time-ordered IDs that:
- Yield chronological iteration via `ORDER BY id` (no extra `created_at` index needed for chronology).
- Cluster recent rows in the same B-tree leaf pages (insert locality).
- Stay globally unique without coordination.

The inkstone-poc's `messages` table uses Bun's `randomUUIDv7()`. We follow the same convention. Core's Rust side will use the equivalent (e.g. `uuid::Uuid::now_v7()`).

`message_parts`, `run_steps`, and `entity_revisions` use composite primary keys `(parent_id, seq)` — no cross-parent identity needed.

## What this ADR does not decide

- **Migration tooling** (Drizzle, sqlx-migrate, Diesel). Decided at code-write time.
- **Specific shapes for `entities.data` per `type`.** Each Entity type's JSON schema is defined in code, not in this ADR. `entities.schema_version` lets shapes evolve.
- **What tier 3 holds** (backlinks, extraction candidates, dashboards, a search index). Out of scope; the slice-1 entity `fts` table was the only tier-3 table and has since been removed, leaving tier 3 empty for now.
- **External-ingestion bookkeeping** (file-tracking, `snapshots`, `ingestion_log` tables). Removed: there is no external authoring path to ingest. SQLite is the single source of truth per [ADR-0004](./0004-three-tier-storage-authority.md). The canonical content table(s) for non-chat content are left open pending use-case exploration; `proposals.mutation_kind` plus tool-call payload JSON can carry future content-creation Proposals when their shape is decided.
- **A Workflows table.** Workflows are pure code in slice 1 per [ADR-0011](./0011-per-run-workflow-dispatch.md); `runs.workflow_name + workflow_version` is a string identifier resolved against in-process code.
- **Parallel Proposals in one Turn.** `runs.awaiting_tool_call_id` is singular: a Run can park on at most one Proposal at a time. CONTEXT.md allows a Turn to emit multiple tool calls, but slice 1 Workflows submit at most one Proposal per Turn. When a Workflow needs parallel Proposals, generalise to `awaiting_tool_call_ids JSON` and adjust the resume logic to track per-call decisions.
- **Token / cost accounting** (`runs.usage`). Slice 1 has no billing or quotas. Deferred until needed.

## Considered and rejected

- **A `turns` table**. Rejected: every comparable system models the loop as steps/events; Turn boundaries are Worker-loop implementation detail. Future branching/summarization may force this — add then.
- **Persisting per-token `text_delta` events in `run_events`.** Rejected: no consumer needs sub-Turn replay fidelity. `run_events` holds *coarse* events (status, tool boundaries, completion); per-token deltas are projected onto `message_parts.text` via UPSERT (t3code pattern). t3code persists deltas as orchestration events because their entire architecture is event-sourced; Inkstone is not.
- **`message_parts` carrying `tool_use`/`tool_result` part types.** Rejected in favor of OpenAI-style `tool_calls` + `run_steps`. Tool I/O has lifecycle (`pending → completed | errored`) that doesn't fit a passive content block.
- **Per-type entity tables** (`people`, `todos`, …). Rejected: Anytype, Standard Notes, Tana, Anthropic, OpenAI all converge on polymorphic JSON for domain-shaped state at this scale. Per-type rigor is premature without query patterns proving the cost.
- **Per-kind proposal tables**. Rejected: same reasoning. The Proposal review UI reads one table.
- **Folding `proposals` into `tool_calls`.** Rejected: Proposal-specific lifecycle columns (`status`, `decided_by`, `edited_payload`, `applied_at`) would be NULL on every non-Proposal `tool_calls` row; `tool_calls` shape stays uniform with sidecar.
- **`messages.is_streaming` boolean.** Earlier draft used a binary flag. Rejected after review: a Worker crash mid-stream would leave `is_streaming=1` rows that Core never flips back, and a reconnecting Client cannot distinguish a clean message from a truncated one. The tri-state `messages.status ∈ {streaming, completed, incomplete}` carries the missing information.
- **Single freeform `runs.error TEXT`.** Earlier draft. Rejected: conflates the four enumerated terminal reasons from [ADR-0012](./0012-run-lifecycle-ownership.md) and the wire-level error codes from [ADR-0014](./0014-client-core-wire-protocol.md). Split into `terminal_reason`, `error_code`, `error_message`.
- **`proposals.status='edited'` as a fourth state.** Rejected: an edit is a *decision*, not a final state. An edited-and-accepted Proposal is `status='accepted'` with `edited_payload` populated.
- **`messages.run_id NULLABLE` to break the FK cycle.** Rejected in favor of `DEFERRABLE INITIALLY DEFERRED` on both sides — keeps invariants strict, just defers enforcement to commit.
- **Plural `awaiting_tool_call_ids JSON` for parallel Proposals.** Rejected for slice 1: no Workflow exercises it, and parallel-Proposal resume semantics (which subset accepted before resuming?) is non-trivial. Singular FK is documented as the slice-1 constraint; revisit when needed.
- **Workspace-global `seq` cursor on a single events table.** Rejected at [ADR-0014](./0014-client-core-wire-protocol.md). Per-Run sequencing only, scoped to active streams.
- **Persisting per-token text deltas as rows.** Rejected: no consumer needs sub-Turn replay fidelity. t3code persists deltas as events because their entire architecture is event-sourced; Inkstone is not.
- **Drop `entity_revisions`, defer to slice 2.** Rejected: cheap to add now (one INSERT per Proposal application), expensive to retrofit (every existing entity row needs a synthetic revision and every write site changes).

## Related

- [ADR-0004](./0004-three-tier-storage-authority.md) — three-tier authority rule that this schema implements; the CHECK on `entities.created_by` enforces the rule at the SQLite layer.
- [ADR-0010](./0010-mvp-slice-chat-driven-web-client.md) — the slice this schema serves.
- [ADR-0012](./0012-run-lifecycle-ownership.md) — `runs.status` state machine and Turn-boundary persistence; `tool_calls.status` and `proposals.status` carry the rest.
- [ADR-0013](./0013-worker-process-lifecycle-and-transport.md) — `runs.awaiting_tool_call_id` is the waitpoint a fresh Worker reads on resume.
- [ADR-0014](./0014-client-core-wire-protocol.md) — wire shape; this ADR is what the wire reads from and writes to.
- [ADR-0016](./0016-proposal-application-policy.md) — Proposal application flow; `proposals.decided_by`, `edited_payload`, and `entity_revisions` together fulfill the audit/uniformity claims.
- CONTEXT.md — adds `Message` and `Message Part` as tier-2 storage vocabulary.
- [ADR-0022](./0022-run-event-delivery-hub-snapshot-tail.md) — `run/subscribe` reads this ADR's streaming-text model (append-in-place into the `text` part; coarse events in `run_events`) to build the snapshot it sends on subscribe.
- inkstone-poc, t3code — both informed live-text streaming and the no-Turn-table call.
