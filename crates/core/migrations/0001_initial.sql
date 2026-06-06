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
  kind                     TEXT NOT NULL,
  change_kind              TEXT NOT NULL CHECK (change_kind IN ('create','update','delete')),
  status                   TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected','cancelled')),
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
  type                     TEXT NOT NULL,            -- person / todo / project / …
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

-- Tier 3 ---------------------------------------------------------------
CREATE VIRTUAL TABLE fts USING fts5(
  entity_id UNINDEXED,
  searchable_text
);

-- Settings (ADR-0024) --------------------------------------------------
-- The user's preferred model per Workflow and the global effort (thinking)
-- level, persisted as tier-2 key-value rows. The keys and their defaults are
-- defined once in `crate::settings` (the registry) — see there for the
-- authoritative list. Read at Run creation to resolve the effective Workflow
-- (model/effort override the Workflow TOML; see `resolve_effective_workflow`).
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
