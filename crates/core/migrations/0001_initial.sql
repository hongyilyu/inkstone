-- Threads --------------------------------------------------------------
CREATE TABLE threads (
  id                TEXT PRIMARY KEY,            -- UUIDv7
  title             TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  last_activity_at  INTEGER NOT NULL,
  archived_at       INTEGER                      -- ms-epoch; NULL = active, a number = archived-at (ADR-0052)
);

-- Runs -----------------------------------------------------------------
CREATE TABLE runs (
  id                       TEXT PRIMARY KEY,
  thread_id                TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  workflow_name            TEXT NOT NULL,
  workflow_version         TEXT NOT NULL,
  provider                 TEXT NOT NULL,             -- LLM provider snapshotted at Run start
  model                    TEXT NOT NULL,             -- specific model id snapshotted at Run start
  thinking_level           TEXT NOT NULL,             -- resolved effort snapshotted at Run start (ADR-0024); resume reads this, not live settings
  user_message_id          TEXT NOT NULL REFERENCES messages(id) DEFERRABLE INITIALLY DEFERRED,
  idempotency_key          TEXT UNIQUE,
  awaiting_tool_call_id    TEXT REFERENCES tool_calls(id),  -- waitpoint when status='parked'
  status                   TEXT NOT NULL CHECK (status IN
                            ('running','parked','completed','errored','cancelled')),
  terminal_reason          TEXT CHECK (terminal_reason IS NULL OR terminal_reason IN
                            ('completed','cancelled','worker_disconnected','core_restarted','errored')),
  error_code               TEXT,                      -- enumerated wire error per ADR-0014, NULL unless status='errored'
  error_message            TEXT,                      -- human-readable detail
  started_at               INTEGER,
  ended_at                 INTEGER
);
CREATE INDEX idx_runs_thread_started ON runs(thread_id, started_at);
CREATE INDEX idx_runs_status         ON runs(status) WHERE status IN ('running','parked');

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
  type        TEXT NOT NULL CHECK (type IN ('text','attachment','reasoning')),
  text        TEXT NOT NULL DEFAULT '',           -- mutated during streaming for text/reasoning parts (UPSERT)
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
-- per Run, so the timeline is one ordered query (ADR-0017). A `message` step
-- resolves to a SPECIFIC text part via `(message_id, part_seq)`, not just the
-- message: each contiguous run of assistant text is its own `message_parts`
-- row + `run_steps` row, so post-tool text sequences AFTER the tool (ADR-0045).
CREATE TABLE run_steps (
  run_id         TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('message','tool_call')),
  message_id     TEXT REFERENCES messages(id),
  part_seq       INTEGER,                          -- the message_parts.seq this step resolves to (kind='message')
  tool_call_id   TEXT REFERENCES tool_calls(id),
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq),
  -- A `message` step's `(message_id, part_seq)` resolves a SPECIFIC text part, so
  -- enforce that pointer: a message step can never reference a missing part. The
  -- composite FK is skipped (MATCH SIMPLE) for `tool_call` steps, whose
  -- message_id/part_seq are both NULL per the CHECK below.
  FOREIGN KEY (message_id, part_seq) REFERENCES message_parts(message_id, seq),
  CHECK (
    (kind = 'message'   AND message_id   IS NOT NULL AND part_seq IS NOT NULL AND tool_call_id IS NULL) OR
    (kind = 'tool_call' AND tool_call_id IS NOT NULL AND part_seq IS NULL     AND message_id   IS NULL)
  )
);

-- Run Log (durable per ADR-0014/0028) ----------------------------------
-- Core's durable record of a Run's lifecycle milestones (CONTEXT.md: Run
-- Log). Append-only; pre-pays a future `run/get_history` (no reader yet).
-- Distinct from the wire Run Event (Worker-emitted, never persisted).
-- Per-token text deltas are NOT here — those are projected onto
-- message_parts.text via the streaming UPSERT. Tool history lives in
-- tool_calls/run_steps, not here.
CREATE TABLE run_log (
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  run_seq     INTEGER NOT NULL,                    -- monotonic per Run
  kind        TEXT NOT NULL CHECK (kind IN
                ('running','parked','done','error','cancelled',
                 'proposal_pending','proposal_decided')),
  payload     TEXT,                                -- JSON; shape depends on kind
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (run_id, run_seq)
);

-- Proposals (sidecar of tool_calls) ------------------------------------
CREATE TABLE proposals (
  id                       TEXT PRIMARY KEY,
  tool_call_id             TEXT NOT NULL UNIQUE REFERENCES tool_calls(id) ON DELETE CASCADE,
  mutation_kind            TEXT NOT NULL,
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

CREATE TABLE entity_sources (
  id                 TEXT PRIMARY KEY,
  entity_id          TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  source_entity_id   TEXT REFERENCES entities(id) ON DELETE CASCADE,
  source_message_id  TEXT REFERENCES messages(id) ON DELETE CASCADE,
  relation           TEXT NOT NULL CHECK (relation IN ('created_from','updated_from','evidenced_by')),
  created_at         INTEGER NOT NULL,
  CHECK (
    (source_entity_id IS NOT NULL AND source_message_id IS NULL) OR
    (source_entity_id IS NULL AND source_message_id IS NOT NULL)
  )
);
CREATE INDEX idx_entity_sources_entity ON entity_sources(entity_id);
CREATE INDEX idx_entity_sources_message ON entity_sources(source_message_id);
CREATE INDEX idx_entity_sources_source_entity ON entity_sources(source_entity_id);

CREATE TABLE entity_refs (
  id                 TEXT PRIMARY KEY,
  source_entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  label_snapshot     TEXT,
  created_at         INTEGER NOT NULL,
  UNIQUE (source_entity_id, target_entity_id)
);
CREATE INDEX idx_entity_refs_target_entity ON entity_refs(target_entity_id);

-- Observations (ADR-0053) ---------------------------------------------
-- Timestamped tracker facts, kept separate from identity-bearing Entities.
CREATE TABLE observations (
  id                       TEXT PRIMARY KEY,
  schema_key               TEXT NOT NULL,
  schema_version           INTEGER NOT NULL,
  occurred_at              TEXT NOT NULL,             -- local wall-clock YYYY-MM-DDTHH:MM:SS
  ended_at                 TEXT,                      -- same shape; NULL for point-in-time facts
  values_json              TEXT NOT NULL,             -- schema-validated JSON object
  note                     TEXT,
  created_by               TEXT NOT NULL CHECK (created_by IN ('user','proposal')),
  created_via_proposal_id  TEXT REFERENCES proposals(id),
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  -- Stricter than entities: direct user observations must not carry a
  -- proposal id, while proposal-born observations must carry one.
  CHECK (
    (created_by = 'user' AND created_via_proposal_id IS NULL) OR
    (created_by = 'proposal' AND created_via_proposal_id IS NOT NULL)
  )
);
CREATE INDEX idx_observations_schema_time ON observations(schema_key, occurred_at);
CREATE INDEX idx_observations_time        ON observations(occurred_at);

CREATE TABLE observation_revisions (
  observation_id  TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL CHECK (seq >= 1),
  schema_key      TEXT NOT NULL,
  schema_version  INTEGER NOT NULL,
  occurred_at     TEXT NOT NULL,
  ended_at        TEXT,
  values_json     TEXT NOT NULL,
  note            TEXT,
  proposal_id     TEXT REFERENCES proposals(id),
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (observation_id, seq)
);
CREATE INDEX idx_observation_revisions_habit_checkin_habit_id
  ON observation_revisions(json_extract(values_json, '$.habit_id'))
  WHERE schema_key = 'habit.checkin';

CREATE TABLE observation_sources (
  id                 TEXT PRIMARY KEY,
  observation_id     TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  source_entity_id   TEXT REFERENCES entities(id) ON DELETE CASCADE,
  source_message_id  TEXT REFERENCES messages(id) ON DELETE CASCADE,
  -- Source rows are original provenance; corrections live in observation_revisions.
  relation           TEXT NOT NULL CHECK (relation IN ('created_from','evidenced_by')),
  created_at         INTEGER NOT NULL,
  CHECK (
    (source_entity_id IS NOT NULL AND source_message_id IS NULL AND relation = 'created_from') OR
    (source_entity_id IS NULL AND source_message_id IS NOT NULL AND relation = 'evidenced_by')
  ),
  UNIQUE (observation_id)
);
CREATE INDEX idx_observation_sources_observation ON observation_sources(observation_id);
CREATE INDEX idx_observation_sources_entity      ON observation_sources(source_entity_id);
CREATE INDEX idx_observation_sources_message     ON observation_sources(source_message_id);

-- Media substrate (ADR-0058) -------------------------------------------
-- Metadata envelope for a binary whose bytes live on disk under the media
-- root; SQLite stores only the relative `storage_path`, never the bytes.
-- `digest` is the sha-256 hex of the content for integrity, NOT identity
-- (non-unique, no dedup). Provenance reuses the observations XOR. The
-- `media_attachments` polymorphic-link table is defined immediately below.
CREATE TABLE media (
  id                       TEXT PRIMARY KEY,          -- random UUID
  mime                     TEXT NOT NULL,
  byte_size                INTEGER NOT NULL,
  digest                   TEXT NOT NULL,             -- sha-256 hex, non-unique (integrity, not dedup)
  storage_path             TEXT NOT NULL,             -- relative to the media root
  width                    INTEGER,
  height                   INTEGER,
  duration_ms              INTEGER,
  capture_time             INTEGER,                   -- ms-epoch, nullable
  thumbnail_path           TEXT,                      -- nullable; nothing writes it this issue
  created_by               TEXT NOT NULL CHECK (created_by IN ('user','proposal')),
  created_via_proposal_id  TEXT REFERENCES proposals(id),
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  -- Same stricter XOR as observations: direct user media must not carry a
  -- proposal id, while proposal-born media must carry one.
  CHECK (
    (created_by = 'user' AND created_via_proposal_id IS NULL) OR
    (created_by = 'proposal' AND created_via_proposal_id IS NOT NULL)
  )
);

-- Polymorphic link from one `media` row to exactly one target — an Entity,
-- Message, Observation, or Proposal — via one nullable FK per target kind plus a
-- `target_kind` discriminator. The CHECK is the entity_sources XOR generalized
-- to four targets and tied to the discriminator. Both FK directions cascade:
-- dropping the media row drops its links (media_id ON DELETE CASCADE), and
-- dropping a target drops the link to it (each target FK ON DELETE CASCADE).
-- Deleting the last link does NOT delete the media row — no orphan GC.
CREATE TABLE media_attachments (
  id                     TEXT PRIMARY KEY,          -- random UUID
  media_id               TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  target_kind            TEXT NOT NULL CHECK (target_kind IN ('entity','message','observation','proposal')),
  target_entity_id       TEXT REFERENCES entities(id) ON DELETE CASCADE,
  target_message_id      TEXT REFERENCES messages(id) ON DELETE CASCADE,
  target_observation_id  TEXT REFERENCES observations(id) ON DELETE CASCADE,
  target_proposal_id     TEXT REFERENCES proposals(id) ON DELETE CASCADE,
  created_at             INTEGER NOT NULL,
  CHECK (
    (target_kind='entity'      AND target_entity_id      IS NOT NULL AND target_message_id IS NULL AND target_observation_id IS NULL AND target_proposal_id IS NULL) OR
    (target_kind='message'     AND target_message_id     IS NOT NULL AND target_entity_id  IS NULL AND target_observation_id IS NULL AND target_proposal_id IS NULL) OR
    (target_kind='observation' AND target_observation_id IS NOT NULL AND target_entity_id  IS NULL AND target_message_id     IS NULL AND target_proposal_id IS NULL) OR
    (target_kind='proposal'    AND target_proposal_id    IS NOT NULL AND target_entity_id  IS NULL AND target_message_id     IS NULL AND target_observation_id IS NULL)
  )
);
CREATE INDEX idx_media_attachments_media       ON media_attachments(media_id);
CREATE INDEX idx_media_attachments_entity      ON media_attachments(target_entity_id)      WHERE target_entity_id      IS NOT NULL;
CREATE INDEX idx_media_attachments_message     ON media_attachments(target_message_id)     WHERE target_message_id     IS NOT NULL;
CREATE INDEX idx_media_attachments_observation ON media_attachments(target_observation_id) WHERE target_observation_id IS NOT NULL;
CREATE INDEX idx_media_attachments_proposal    ON media_attachments(target_proposal_id)    WHERE target_proposal_id    IS NOT NULL;

-- Todo Person References (ADR-0031) ------------------------------------
-- A task-specific Person association on a Todo (not a generic relationship
-- graph, not an Entity Reference). At most one row per (todo_id, person_id);
-- `waiting_on` includes related semantics so no second `related` row is stored
-- for the same Person. Both FKs cascade so deleting a Todo or a Person frees
-- its refs.
CREATE TABLE todo_person_refs (
  todo_id    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  person_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('waiting_on','related')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (todo_id, person_id)
);
CREATE INDEX idx_todo_person_refs_person ON todo_person_refs(person_id);
CREATE INDEX idx_todo_person_refs_role   ON todo_person_refs(role);

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
