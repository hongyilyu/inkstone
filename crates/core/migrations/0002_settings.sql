-- User settings (ADR-0024): the user's preferred model per Workflow and the
-- global effort (thinking) level, persisted as tier-2 key-value rows. Keys:
--   `model:<workflow_name>` — the preferred model id for that Workflow
--   `effort`                — the global thinking level (default `off`)
-- Read at Run creation to resolve the effective Workflow (model/effort
-- override the Workflow TOML; see `resolve_effective_workflow`).
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
