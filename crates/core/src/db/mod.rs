//! SQLite tier-2 storage (ADR-0017): resolves the DB path, opens a pool, runs
//! migrations. SQL lives in [`queries`]; this module owns the high-level
//! operations and transaction boundaries.

mod apply;
mod lifecycle;
mod message_fts;
mod queries;
mod run_log;

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use uuid::Uuid;

use crate::workflow::Workflow;

pub use lifecycle::Moved;
use lifecycle::{ProposalStatus, RunStatus, TerminalReason};
// `search_messages` is the message-search read surface (ADR-0035), consumed by
// the `message/search` handler (slice 3); it returns `message_fts::MessageHit`,
// which the handler maps field-for-field to the wire `protocol::MessageHit`
// without naming the db type. `rebuild_message_fts` runs on open.
pub use message_fts::{rebuild_message_fts, search_messages};

/// Current wall-clock time as ms since UNIX_EPOCH (the `*_at` columns).
pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time before epoch")
        .as_millis() as i64
}

/// Resolve the DB path: `INKSTONE_DB_PATH` env override wins, else
/// `<OS data dir>/inkstone/db.sqlite`.
pub(crate) fn resolve_db_path() -> Result<PathBuf> {
    if let Some(env) = std::env::var_os("INKSTONE_DB_PATH") {
        return Ok(PathBuf::from(env));
    }
    Ok(os_data_dir()?.join("inkstone").join("db.sqlite"))
}

/// Per-OS application-data directory (hand-rolled to avoid a crate dep).
/// `pub(crate)` so the skills tool can place its dir beside the DB (ADR-0036).
#[cfg(target_os = "macos")]
pub(crate) fn os_data_dir() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").context("$HOME not set")?;
    Ok(PathBuf::from(home)
        .join("Library")
        .join("Application Support"))
}

#[cfg(all(unix, not(target_os = "macos")))]
pub(crate) fn os_data_dir() -> Result<PathBuf> {
    if let Some(xdg) = std::env::var_os("XDG_DATA_HOME").filter(|s| !s.is_empty()) {
        return Ok(PathBuf::from(xdg));
    }
    let home = std::env::var_os("HOME").context("$HOME not set")?;
    Ok(PathBuf::from(home).join(".local").join("share"))
}

#[cfg(target_os = "windows")]
pub(crate) fn os_data_dir() -> Result<PathBuf> {
    let appdata = std::env::var_os("APPDATA").context("%APPDATA% not set")?;
    Ok(PathBuf::from(appdata))
}

/// Open the SQLite pool (creating file + parent dir if missing) and run
/// the bundled migrations.
pub async fn open() -> Result<SqlitePool> {
    let path = resolve_db_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create parent dir {}", parent.display()))?;
    }

    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal);

    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .with_context(|| format!("open SQLite pool at {}", path.display()))?;

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .context("run SQLite migrations")?;

    Ok(pool)
}

/// Whether a Thread row exists. `run/post_message` is existing-thread-only
/// (ADR-0022); an unknown `thread_id` is rejected with `unknown_thread`.
pub async fn thread_exists(pool: &SqlitePool, thread_id: Uuid) -> sqlx::Result<bool> {
    queries::thread_exists(pool, thread_id).await
}

/// Read all Threads for `thread/list` (ADR-0022), most-recent-activity-first,
/// as `(id, title, last_activity_at)` rows.
pub async fn list_threads(pool: &SqlitePool) -> sqlx::Result<Vec<(String, String, i64)>> {
    queries::list_threads(pool).await
}

/// One accepted Entity for `entity/list`. `data` is parsed from the stored
/// JSON; a malformed row degrades to `null` rather than failing the read.
pub struct EntityRow {
    pub id: String,
    pub r#type: String,
    pub data: serde_json::Value,
    pub created_at: i64,
    pub updated_at: i64,
    pub refs: Vec<ResolvedEntityRef>,
    /// `(person_id, role)` pairs for a Todo row's Person References (ADR-0032).
    /// Empty for non-Todo rows and Todos with no references.
    pub person_refs: Vec<(String, String)>,
}

pub struct ResolvedEntityRef {
    pub id: String,
    pub source_entity_id: String,
    pub target_entity_id: String,
    pub target_entity_type: String,
    pub target_title: Option<String>,
    pub label_snapshot: Option<String>,
}

/// Read every accepted Entity of `entity_type` for `entity/list`, newest-first.
pub async fn list_by_type(pool: &SqlitePool, entity_type: &str) -> sqlx::Result<Vec<EntityRow>> {
    let rows = queries::list_by_type(pool, entity_type).await?;
    let mut rows = rows
        .into_iter()
        .map(|(id, r#type, data, created_at, updated_at)| EntityRow {
            id,
            r#type,
            data: serde_json::from_str(&data).unwrap_or(serde_json::Value::Null),
            created_at,
            updated_at,
            refs: Vec::new(),
            person_refs: Vec::new(),
        })
        .collect::<Vec<_>>();

    if entity_type == "journal_entry" {
        let source_entity_ids = rows.iter().map(|row| row.id.clone()).collect::<Vec<_>>();
        let refs = resolved_entity_refs_for_sources(pool, &source_entity_ids).await?;
        let mut refs_by_source = HashMap::<String, Vec<ResolvedEntityRef>>::new();
        for entity_ref in refs {
            refs_by_source
                .entry(entity_ref.source_entity_id.clone())
                .or_default()
                .push(entity_ref);
        }
        for row in &mut rows {
            row.refs = refs_by_source.remove(&row.id).unwrap_or_default();
        }
    }

    // Attach each Todo's Person References (ADR-0032), batched like journal refs
    // above to avoid an N+1 over the listed Todos.
    if entity_type == "todo" {
        let todo_ids = rows.iter().map(|row| row.id.clone()).collect::<Vec<_>>();
        let refs = queries::person_refs_for_todos(pool, &todo_ids).await?;
        let mut refs_by_todo = HashMap::<String, Vec<(String, String)>>::new();
        for (todo_id, person_id, role) in refs {
            refs_by_todo
                .entry(todo_id)
                .or_default()
                .push((person_id, role));
        }
        for row in &mut rows {
            row.person_refs = refs_by_todo.remove(&row.id).unwrap_or_default();
        }
    }

    Ok(rows)
}

async fn resolved_entity_refs_for_sources(
    pool: &SqlitePool,
    source_entity_ids: &[String],
) -> sqlx::Result<Vec<ResolvedEntityRef>> {
    let rows = queries::entity_refs_for_sources(pool, source_entity_ids).await?;
    Ok(rows
        .into_iter()
        .map(
            |(
                id,
                source_entity_id,
                target_entity_id,
                target_entity_type,
                target_data,
                label_snapshot,
            )| {
                let data = serde_json::from_str(&target_data).unwrap_or(serde_json::Value::Null);
                ResolvedEntityRef {
                    id,
                    source_entity_id,
                    target_entity_id,
                    target_title: entity_title(&target_entity_type, &data),
                    target_entity_type,
                    label_snapshot,
                }
            },
        )
        .collect())
}

fn entity_title(entity_type: &str, data: &serde_json::Value) -> Option<String> {
    let field = match entity_type {
        "person" | "project" => "name",
        "todo" => "title",
        // Bookmark is deliberately absent: it is not journal-referenceable in V1
        // (ADR-0036), so it never reaches this reference-target title lookup.
        _ => return None,
    };
    data.get(field)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// One Journal Entry returned to the Worker for same-Thread correction context.
/// `data` is the latest accepted revision snapshot.
pub struct CurrentThreadJournalEntryRow {
    pub entity_id: String,
    pub data: serde_json::Value,
}

/// One accepted Journal Entry for `proposal/get` review context. `data` is the
/// current `entities.data` snapshot.
pub struct CurrentJournalEntryRow {
    pub entity_id: String,
    pub data: serde_json::Value,
}

/// Read one accepted Journal Entry by id. `None` when it does not exist or is
/// not a journal entry.
pub async fn current_journal_entry_by_id(
    pool: &SqlitePool,
    entity_id: &str,
) -> sqlx::Result<Option<CurrentJournalEntryRow>> {
    let Some((entity_id, data)) = queries::current_journal_entry_by_id(pool, entity_id).await?
    else {
        return Ok(None);
    };
    Ok(Some(CurrentJournalEntryRow {
        entity_id,
        data: serde_json::from_str(&data).unwrap_or(serde_json::Value::Null),
    }))
}

/// Read accepted Journal Entries originally created from `run_id`'s Thread,
/// ordered newest-first by each Entity's latest revision time.
pub async fn current_thread_journal_entries(
    pool: &SqlitePool,
    run_id: Uuid,
) -> sqlx::Result<Vec<CurrentThreadJournalEntryRow>> {
    let rows = queries::current_thread_journal_entries(pool, run_id).await?;
    Ok(rows
        .into_iter()
        .map(|(entity_id, data)| CurrentThreadJournalEntryRow {
            entity_id,
            data: serde_json::from_str(&data).unwrap_or(serde_json::Value::Null),
        })
        .collect())
}

/// One Message in a `thread/get` read, with `text` already assembled (text
/// parts concatenated in `seq` order). Flat-text-no-parts per ADR-0017.
pub struct MessageRow {
    pub id: String,
    pub role: String,
    pub status: String,
    pub run_id: String,
    pub text: String,
}

/// Read a Thread plus its Messages for `thread/get` (ADR-0022). `None` when the
/// Thread does not exist (handler maps to `unknown_thread`). Messages are
/// chronological by `(created_at, rowid)` — the rowid tiebreaker keeps the user
/// Message ahead of the assistant Message on a same-ms insert.
pub async fn get_thread_with_messages(
    pool: &SqlitePool,
    thread_id: Uuid,
) -> sqlx::Result<Option<(String, Vec<MessageRow>)>> {
    let Some(title) = queries::thread_title(pool, thread_id).await? else {
        return Ok(None);
    };

    let rows = queries::messages_by_thread(pool, thread_id).await?;
    let mut messages = Vec::with_capacity(rows.len());
    for (id, role, status, run_id) in rows {
        let text = queries::text_parts_by_message(pool, &id).await?.concat();
        messages.push(MessageRow {
            id,
            role,
            status,
            run_id,
            text,
        });
    }

    Ok(Some((title, messages)))
}

/// Assemble prior-Run conversation history for a Run's manifest (ADR-0018).
/// `(role, text)` pairs for every `completed` Message in `thread_id` belonging
/// to a Run other than `exclude_run_id`, oldest-first. Excluding the current
/// Run keeps history to the prior exchange; `completed`-only drops
/// partial/errored assistant text.
pub async fn history_for_run(
    pool: &SqlitePool,
    thread_id: Uuid,
    exclude_run_id: Uuid,
) -> sqlx::Result<Vec<(String, String)>> {
    let rows = queries::history_messages_for_run(pool, thread_id, exclude_run_id).await?;
    let mut history = Vec::with_capacity(rows.len());
    for (id, role) in rows {
        let text = queries::text_parts_by_message(pool, &id).await?.concat();
        history.push((role, text));
    }
    Ok(history)
}

/// Persist a Run's initial rows in one deferred-FK transaction: the FK cycle
/// between `runs.user_message_id` and `messages.run_id` resolves only at COMMIT.
/// Pre-inserts the assistant `messages` row (`streaming`) + an empty `seq=0`
/// text part for [`append_assistant_text`] to append into.
pub async fn persist_initial_run(
    pool: &SqlitePool,
    run_id: Uuid,
    thread_id: Uuid,
    user_message_id: Uuid,
    assistant_message_id: Uuid,
    workflow: &Workflow,
    prompt: &str,
    now_ms: i64,
) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;

    insert_initial_run_rows(
        &mut tx,
        run_id,
        thread_id,
        user_message_id,
        assistant_message_id,
        workflow,
        prompt,
        now_ms,
    )
    .await?;

    tx.commit().await
}

/// Message-first thread creation (ADR-0022): mint a new Thread row then the
/// same initial-run rows as [`persist_initial_run`], all in one transaction, so
/// `thread/create` births the Thread and its first message atomically.
#[allow(clippy::too_many_arguments)]
pub async fn persist_thread_with_first_run(
    pool: &SqlitePool,
    thread_id: Uuid,
    run_id: Uuid,
    user_message_id: Uuid,
    assistant_message_id: Uuid,
    workflow: &Workflow,
    prompt: &str,
    title: &str,
    now_ms: i64,
) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;

    queries::insert_thread(&mut *tx, thread_id, title, now_ms).await?;

    insert_initial_run_rows(
        &mut tx,
        run_id,
        thread_id,
        user_message_id,
        assistant_message_id,
        workflow,
        prompt,
        now_ms,
    )
    .await?;

    tx.commit().await
}

/// Shared initial-run inserts inside the caller's open transaction (caller owns
/// begin/commit): the Run row, user Message + `seq=0` text part, assistant
/// Message (`streaming`) + empty `seq=0` text part, the two run steps, the
/// `running` run-log row, and the Thread activity touch.
#[allow(clippy::too_many_arguments)]
async fn insert_initial_run_rows(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    run_id: Uuid,
    thread_id: Uuid,
    user_message_id: Uuid,
    assistant_message_id: Uuid,
    workflow: &Workflow,
    prompt: &str,
    now_ms: i64,
) -> sqlx::Result<()> {
    queries::insert_run(
        &mut **tx,
        run_id,
        thread_id,
        &workflow.name,
        &workflow.version,
        &workflow.provider,
        workflow.model.as_deref().unwrap_or_default(),
        user_message_id,
        now_ms,
    )
    .await?;

    queries::insert_message(
        &mut **tx,
        user_message_id,
        thread_id,
        run_id,
        "user",
        "completed",
        now_ms,
    )
    .await?;
    queries::insert_text_part(&mut **tx, user_message_id, 0, prompt).await?;
    // Index the completed user Message into the tier-3 search projection
    // (ADR-0035), atomic with the Message in this tx. The assistant Message is
    // `streaming`/empty here — it is indexed at Run completion (slice 2).
    message_fts::index_message(
        &mut **tx,
        &user_message_id.to_string(),
        &thread_id.to_string(),
        &run_id.to_string(),
        "user",
        prompt,
    )
    .await?;

    queries::insert_message(
        &mut **tx,
        assistant_message_id,
        thread_id,
        run_id,
        "assistant",
        "streaming",
        now_ms,
    )
    .await?;
    queries::insert_text_part(&mut **tx, assistant_message_id, 0, "").await?;

    queries::insert_message_run_step(&mut **tx, run_id, 0, user_message_id, now_ms).await?;
    queries::insert_message_run_step(&mut **tx, run_id, 1, assistant_message_id, now_ms).await?;

    run_log::append(
        &mut **tx,
        run_id,
        run_log::RunLogKind::Running,
        None,
        now_ms,
    )
    .await?;

    queries::touch_thread_activity(&mut **tx, thread_id, now_ms).await
}

/// Append a streaming `text_delta` to the assistant's pre-inserted `seq=0`
/// text part. Single statement; SQLite serializes writes.
pub async fn append_assistant_text(
    pool: &SqlitePool,
    assistant_message_id: Uuid,
    delta: &str,
) -> sqlx::Result<bool> {
    queries::append_text_part(pool, assistant_message_id, 0, delta)
        .await
        .map(|rows| rows == 1)
}

/// Persist an incoming Tool Request (ADR-0017/0018): a `pending` `tool_calls`
/// row plus its `run_steps` timeline entry in one transaction, so the timeline
/// never holds a tool call unaddressable via `run_steps`. `tool_call_id` is the
/// Worker-assigned wire correlation key; `request_payload` is the serialized args.
pub async fn persist_tool_call(
    pool: &SqlitePool,
    run_id: Uuid,
    tool_call_id: &str,
    name: &str,
    request_payload: &str,
    now_ms: i64,
) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;
    persist_tool_call_rows(&mut tx, run_id, tool_call_id, name, request_payload, now_ms).await?;
    tx.commit().await
}

async fn persist_tool_call_rows(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    run_id: Uuid,
    tool_call_id: &str,
    name: &str,
    request_payload: &str,
    now_ms: i64,
) -> sqlx::Result<()> {
    let seq = queries::next_run_step_seq(&mut **tx, run_id).await?;
    queries::insert_tool_call(
        &mut **tx,
        tool_call_id,
        run_id,
        name,
        request_payload,
        now_ms,
    )
    .await?;
    queries::insert_tool_call_run_step(&mut **tx, run_id, seq, tool_call_id, now_ms).await
}

/// Resolve a persisted Tool Request with its outcome (ADR-0017): flip the
/// `tool_calls` row to `status` (`completed`/`errored`) and store the
/// serialized `result_payload`.
pub async fn resolve_tool_call(
    pool: &SqlitePool,
    tool_call_id: &str,
    status: &str,
    result_payload: &str,
    now_ms: i64,
) -> sqlx::Result<()> {
    queries::resolve_tool_call(pool, tool_call_id, status, result_payload, now_ms).await
}

/// Park a Run on a Proposal tool request (ADR-0025): persist the tool call +
/// timeline step + pending Proposal, then move the Run `running -> parked` with
/// the waitpoint and lifecycle events (`parked`, `proposal_pending`), all in one
/// transaction. If the Run is no longer `running` the guarded park loses and the
/// transaction rolls back.
#[allow(clippy::too_many_arguments)]
pub async fn park_on_proposal(
    pool: &SqlitePool,
    run_id: Uuid,
    proposal_id: &str,
    tool_call_id: &str,
    name: &str,
    request_payload: &str,
    mutation_kind: &str,
    now_ms: i64,
) -> sqlx::Result<Moved> {
    let mut tx = pool.begin().await?;

    persist_tool_call_rows(&mut tx, run_id, tool_call_id, name, request_payload, now_ms).await?;
    queries::insert_proposal(&mut *tx, proposal_id, tool_call_id, mutation_kind).await?;

    let moved = RunStatus::park(&mut *tx, run_id, tool_call_id, now_ms).await?;
    if !moved.won() {
        return Ok(moved);
    }

    let payload = serde_json::json!({
        "proposal_id": proposal_id,
        "tool_call_id": tool_call_id,
        "mutation_kind": mutation_kind,
    })
    .to_string();
    run_log::append(
        &mut *tx,
        run_id,
        run_log::RunLogKind::ProposalPending,
        Some(&payload),
        now_ms,
    )
    .await?;

    tx.commit().await?;
    Ok(moved)
}

/// Read a Run's `status` (ADR-0025); `None` when the Run does not exist. Backs
/// `run/subscribe`'s parked branch and the forwarder's no-false-done check.
pub async fn run_status(pool: &SqlitePool, run_id: Uuid) -> sqlx::Result<Option<String>> {
    queries::run_status(pool, run_id).await
}

/// A Run's pending Proposal for `proposal/get` (ADR-0025). `payload` and
/// `rationale` come from the tool call's stored `request_payload`;
/// `mutation_kind` and `status` from the `proposals` row.
pub struct ProposalRow {
    pub proposal_id: String,
    pub mutation_kind: String,
    pub status: String,
    pub payload: serde_json::Value,
    pub rationale: Option<String>,
}

/// Read the Run's pending Proposal, or `None`. A malformed `request_payload`
/// degrades to `payload: null` / `rationale: None` rather than failing the read.
pub async fn get_pending_proposal_for_run(
    pool: &SqlitePool,
    run_id: Uuid,
) -> sqlx::Result<Option<ProposalRow>> {
    let Some((proposal_id, mutation_kind, status, request_payload)) =
        queries::pending_proposal_for_run(pool, run_id).await?
    else {
        return Ok(None);
    };
    let payload: serde_json::Value =
        serde_json::from_str(&request_payload).unwrap_or(serde_json::Value::Null);
    let proposal_payload = payload
        .get("payload")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let rationale = payload
        .get("rationale")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    Ok(Some(ProposalRow {
        proposal_id,
        mutation_kind,
        status,
        payload: proposal_payload,
        rationale,
    }))
}

/// Auto-approve seam (ADR-0025, ADR-0016). Always `false` for now — every
/// Proposal is manual, so every `propose_workspace_mutation` parks the Run.
pub fn should_auto_approve() -> bool {
    false
}

/// A Proposal loaded by id for `proposal/decide` (ADR-0025): owning Run, awaited
/// `tool_call_id`, lifecycle columns, the proposed `payload` (from the tool
/// call's `request_payload`), and any recorded `decision_idempotency_key`.
pub struct DecidableProposal {
    pub run_id: Uuid,
    pub tool_call_id: String,
    pub mutation_kind: String,
    pub status: String,
    pub payload: serde_json::Value,
    pub decision_idempotency_key: Option<String>,
}

/// Load a Proposal by id for `proposal/decide`; `None` when it does not exist.
/// A malformed `request_payload` degrades the proposed `payload` to `null`.
pub async fn load_proposal_for_decide(
    pool: &SqlitePool,
    proposal_id: &str,
) -> sqlx::Result<Option<DecidableProposal>> {
    let Some((run_id, tool_call_id, mutation_kind, status, request_payload, idem)) =
        queries::proposal_by_id(pool, proposal_id).await?
    else {
        return Ok(None);
    };
    let Ok(run_id) = Uuid::parse_str(&run_id) else {
        return Ok(None);
    };
    let payload: serde_json::Value =
        serde_json::from_str(&request_payload).unwrap_or(serde_json::Value::Null);
    let proposal_payload = payload
        .get("payload")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    Ok(Some(DecidableProposal {
        run_id,
        tool_call_id,
        mutation_kind,
        status,
        payload: proposal_payload,
        decision_idempotency_key: idem,
    }))
}

/// The `entities.id` already created via `proposal_id`, or `None`. Backs the
/// idempotent-decide check: a repeated accept returns the prior `entity_id`
/// instead of re-applying.
pub async fn entity_id_for_proposal(
    pool: &SqlitePool,
    proposal_id: &str,
) -> sqlx::Result<Option<String>> {
    queries::entity_id_for_proposal(pool, proposal_id).await
}

pub async fn journal_entry_target_is_valid(
    pool: &SqlitePool,
    run_id: Uuid,
    entity_id: &str,
) -> sqlx::Result<bool> {
    queries::journal_entry_target_is_valid(pool, run_id, entity_id).await
}

pub async fn entity_type_by_id(pool: &SqlitePool, entity_id: &str) -> sqlx::Result<Option<String>> {
    queries::entity_type_by_id(pool, entity_id).await
}

/// Whether an accepted Entity with `entity_id` exists and is of `entity_type`.
/// Backs decide-time target-type checks (e.g. a Todo's `project_id` must point at
/// a `project`).
pub async fn entity_is_type(
    pool: &SqlitePool,
    entity_id: &str,
    entity_type: &str,
) -> sqlx::Result<bool> {
    queries::entity_is_type(pool, entity_id, entity_type).await
}

/// Failure modes of [`apply_proposal`] the caller must distinguish (review M1).
#[derive(Debug)]
pub enum ApplyError {
    /// An impossible mutation contract, e.g. an update without a target id.
    InvalidMutation(String),
    /// The guarded `proposals` flip found the row non-`pending` (a concurrent
    /// decide won); the tx rolled back, nothing applied. Maps to
    /// `proposal_not_pending`.
    NotPending,
    /// An update/delete found its target Entity row already gone (the
    /// affected-0-rows case): a user deleted the Entity out from under a parked
    /// Proposal (ADR-0033). Distinct from a genuine DB fault so the caller can
    /// resolve the parked Run cleanly (decide maps it to `NotDecidable`).
    TargetMissing,
    /// Any other SQL error inside the apply transaction.
    Sql(sqlx::Error),
}

impl From<sqlx::Error> for ApplyError {
    fn from(e: sqlx::Error) -> Self {
        ApplyError::Sql(e)
    }
}

impl std::fmt::Display for ApplyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApplyError::InvalidMutation(reason) => write!(f, "{reason}"),
            ApplyError::NotPending => write!(f, "proposal is not pending (lost the apply race)"),
            ApplyError::TargetMissing => write!(f, "proposal target entity no longer exists"),
            ApplyError::Sql(e) => write!(f, "{e}"),
        }
    }
}

/// Apply an accepted Proposal in one atomic transaction (ADR-0016, ADR-0025):
/// flip the `proposals` row to `accepted` under the `status='pending'` guard,
/// run the shared [`apply::apply_entity_mutation`] core, and resolve the awaited
/// `tool_calls` row to `completed` with the Decision the model reads on resume.
/// Returns the new `entity_id`. `entity_type`/`schema_version` are
/// caller-resolved, so this layer names no specific Entity Type.
///
/// This function owns the run-coupled work the shared core deliberately does not:
/// the guarded accept flip, resolving the Entity Source (the JE anchor from the
/// payload for a `created_from` create, else the user Message from `run_id`), the
/// trailing tool-call resolve, and the commit. Everything else — the per-kind
/// entity data/revision/ref/source writes — lives in `apply_entity_mutation`,
/// shared with the user path (ADR-0033).
///
/// EDIT (ADR-0025): when `edited_payload` is `Some`, the entity `data` is the
/// edited payload (Core-validated by the caller) and `proposals.edited_payload`
/// records the edit; an unedited accept passes `None` and writes the proposed
/// `data`.
///
/// Self-guarding (review M1): the `proposals` flip is guarded on
/// `status='pending'`. On 0 rows a racing decide already won, so the tx rolls
/// back and [`ApplyError::NotPending`] is returned — exactly one concurrent
/// decide applies.
#[allow(clippy::too_many_arguments)]
pub async fn apply_proposal(
    pool: &SqlitePool,
    run_id: Uuid,
    proposal_id: &str,
    tool_call_id: &str,
    mutation_kind: &str,
    entity_type: &str,
    schema_version: i64,
    target_entity_id: Option<&str>,
    payload: &serde_json::Value,
    edited_payload: Option<&serde_json::Value>,
    source_relation_from_user_message: Option<&str>,
    decision_idempotency_key: Option<&str>,
    decision_result_payload: &str,
    now_ms: i64,
) -> Result<String, ApplyError> {
    let edited_str = edited_payload.map(|v| v.to_string());
    let effective_payload = edited_payload.unwrap_or(payload);

    let mut tx = pool.begin().await?;

    // Flip the Proposal first under the `status='pending'` guard (the single
    // concurrency choke); on 0 rows a racing decide won, so bail before applying.
    let accepted = ProposalStatus::accept(
        &mut *tx,
        run_id,
        proposal_id,
        edited_str.as_deref(),
        decision_idempotency_key,
        now_ms,
    )
    .await?;
    if !accepted.won() {
        // tx drops without commit → rollback; no entity inserted.
        return Err(ApplyError::NotPending);
    }

    // Resolve the run-coupled Entity Source descriptor for the shared core. A
    // create carrying `source_journal_entry_id` is sourced `created_from` that
    // Journal Entry (source_entity_id), not the user Message. Absent the field,
    // the Message-sourcing path is unchanged: read the Run's immutable
    // `user_message_id` here (inside this tx). JournalEntry provenance is
    // `created_from` only (ADR-0030/0031): an `updated_from` source always points
    // at the user Message, so the field is honored solely for creates.
    let source = match source_relation_from_user_message {
        Some(relation) => {
            let je_id = (relation == "created_from")
                .then(|| crate::entities::source_journal_entry_id(effective_payload))
                .flatten();
            Some(match je_id {
                Some(journal_entry_id) => apply::EntitySource::FromJournalEntry {
                    journal_entry_id: journal_entry_id.to_string(),
                    relation: relation.to_string(),
                },
                None => apply::EntitySource::FromMessage {
                    message_id: queries::user_message_id_for_run(&mut *tx, run_id).await?,
                    relation: relation.to_string(),
                },
            })
        }
        None => None,
    };

    let entity_id = apply::apply_entity_mutation(
        &mut tx,
        apply::EntityMutationSpec {
            mutation_kind,
            entity_type,
            schema_version,
            target_entity_id,
            payload,
            edited_payload,
            created_by: "proposal",
            proposal_id: Some(proposal_id),
            source,
            now_ms,
        },
    )
    .await?;

    queries::resolve_tool_call(
        &mut *tx,
        tool_call_id,
        "completed",
        decision_result_payload,
        now_ms,
    )
    .await?;

    tx.commit().await?;
    Ok(entity_id)
}

/// Apply a user-initiated Entity mutation in one atomic transaction (ADR-0033):
/// the user write-path's `begin → apply_entity_mutation → commit`, with no
/// Proposal flip and no tool-call resolve (there is no Run). The shared core is
/// driven with `created_by='user'`, `proposal_id=None`, and `source=None` — a
/// plain Library write has no Run, user Message, or Journal-Entry anchor, so it
/// writes no Entity Source row (ADR-0033 "source row iff a real source").
/// `entity_type`/`schema_version`/`target_entity_id` are caller-resolved, so this
/// layer names no specific Entity Type, mirroring [`apply_proposal`].
pub async fn apply_user_mutation(
    pool: &SqlitePool,
    mutation_kind: &str,
    entity_type: &str,
    schema_version: i64,
    target_entity_id: Option<&str>,
    payload: &serde_json::Value,
    now_ms: i64,
) -> Result<String, ApplyError> {
    let mut tx = pool.begin().await?;
    let entity_id = apply::apply_entity_mutation(
        &mut tx,
        apply::EntityMutationSpec {
            mutation_kind,
            entity_type,
            schema_version,
            target_entity_id,
            payload,
            edited_payload: None,
            created_by: "user",
            proposal_id: None,
            source: None,
            now_ms,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(entity_id)
}

/// Reject a Proposal in one atomic transaction (ADR-0025), touching no entity
/// store: flip the `proposals` row to `rejected` and resolve the awaited
/// `tool_calls` row to `completed` with the Decision the model reads on resume —
/// a normal (non-error) decline so it continues conversationally. Self-guarding
/// on `status='pending'` like [`apply_proposal`]: 0 rows → rollback +
/// [`ApplyError::NotPending`].
pub async fn reject_proposal(
    pool: &SqlitePool,
    run_id: Uuid,
    proposal_id: &str,
    tool_call_id: &str,
    decision_idempotency_key: Option<&str>,
    decision_result_payload: &str,
    now_ms: i64,
) -> Result<(), ApplyError> {
    let mut tx = pool.begin().await?;

    // Flip the Proposal first under the `status='pending'` guard; on 0 rows a
    // racing decide won, so bail before resolving the tool call.
    let rejected = ProposalStatus::reject(
        &mut *tx,
        run_id,
        proposal_id,
        decision_idempotency_key,
        now_ms,
    )
    .await?;
    if !rejected.won() {
        // tx drops without commit → rollback; nothing changed.
        return Err(ApplyError::NotPending);
    }

    queries::resolve_tool_call(
        &mut *tx,
        tool_call_id,
        "completed",
        decision_result_payload,
        now_ms,
    )
    .await?;

    tx.commit().await?;
    Ok(())
}

/// Flip a parked Run back to `running` on resume (ADR-0025), clearing the
/// waitpoint, between `apply_proposal`'s commit and the resume Worker spawn.
/// Guarded (review M2): on a lost race the caller bails rather than spawning a
/// duplicate resume Worker.
pub async fn mark_run_running(pool: &SqlitePool, run_id: Uuid) -> sqlx::Result<Moved> {
    let mut tx = pool.begin().await?;
    let moved = RunStatus::resume(&mut *tx, run_id).await?;
    tx.commit().await?;
    Ok(moved)
}

/// Cancel a parked Run and its pending Proposal in one transaction (ADR-0014,
/// ADR-0028), funneling both status changes through guarded verbs
/// (`ProposalStatus::cancel` on `status='pending'`, `RunStatus::cancel` on
/// `status='parked'`), each appending its own `cancelled` `run_log` row.
/// Returns whether the Run was cancelled — `false` (rollback) when there is no
/// pending Proposal or a concurrent decide/cancel already won; the caller maps
/// that to `already_terminal`.
pub async fn cancel_parked_run(pool: &SqlitePool, run_id: Uuid, now_ms: i64) -> sqlx::Result<bool> {
    let mut tx = pool.begin().await?;

    let Some((proposal_id, _, _, _)) = queries::pending_proposal_for_run(&mut *tx, run_id).await?
    else {
        // No pending Proposal → a concurrent decide/cancel likely won. Rollback.
        return Ok(false);
    };

    let proposal_cancelled = ProposalStatus::cancel(&mut *tx, run_id, &proposal_id, now_ms).await?;
    if !proposal_cancelled.won() {
        // Proposal no longer pending. Rollback.
        return Ok(false);
    }

    let run_cancelled = RunStatus::cancel(&mut *tx, run_id, now_ms).await?;
    if !run_cancelled.won() {
        // Run no longer parked. Rollback.
        return Ok(false);
    }

    tx.commit().await?;
    Ok(true)
}

/// Cancel a running Run in one guarded transition. Returns `Won` only if the
/// Run was still `running`; a lost race means a Worker terminal transition got
/// there first and the caller maps the cancel request to `already_terminal`.
pub async fn cancel_running_run(
    pool: &SqlitePool,
    run_id: Uuid,
    now_ms: i64,
) -> sqlx::Result<Moved> {
    let mut tx = pool.begin().await?;
    let moved = RunStatus::cancel_running(&mut *tx, run_id, now_ms).await?;
    tx.commit().await?;
    Ok(moved)
}

/// The run's assistant Message id (the seq-0 streaming row resume continues
/// appending into). `None` when the Run has no assistant message.
pub async fn assistant_message_id_for_run(
    pool: &SqlitePool,
    run_id: Uuid,
) -> sqlx::Result<Option<Uuid>> {
    let id = queries::assistant_message_id_for_run(pool, run_id).await?;
    Ok(id.and_then(|s| Uuid::parse_str(&s).ok()))
}

/// One element of a Run's timeline for resume reconstruction (ADR-0025).
/// `ToolCall.result` is the persisted `result_payload`, `None` while pending
/// (reconstruction synthesizes a "not executed" result).
pub enum TimelineStep {
    Message {
        role: String,
        text: String,
    },
    ToolCall {
        id: String,
        name: String,
        request: serde_json::Value,
        result: Option<String>,
    },
}

/// Read a Run's ordered timeline for resume transcript reconstruction
/// (ADR-0025): each `run_steps` row, resolving message text from parts and
/// the tool call's name/request/result. Ordered by `run_steps.seq`.
pub async fn read_run_timeline(pool: &SqlitePool, run_id: Uuid) -> sqlx::Result<Vec<TimelineStep>> {
    let rows = queries::run_timeline(pool, run_id).await?;
    let mut steps = Vec::with_capacity(rows.len());
    for (kind, message_id, role, tool_call_id, tc_name, request_payload, result_payload) in rows {
        match kind.as_str() {
            "message" => {
                let Some(mid) = message_id else { continue };
                let text = queries::text_parts_by_message(pool, &mid).await?.concat();
                steps.push(TimelineStep::Message {
                    role: role.unwrap_or_default(),
                    text,
                });
            }
            "tool_call" => {
                let Some(id) = tool_call_id else { continue };
                let request = request_payload
                    .as_deref()
                    .and_then(|p| serde_json::from_str(p).ok())
                    .unwrap_or(serde_json::Value::Null);
                steps.push(TimelineStep::ToolCall {
                    id,
                    name: tc_name.unwrap_or_default(),
                    request,
                    result: result_payload,
                });
            }
            _ => {}
        }
    }
    Ok(steps)
}

/// A Run's snapshot for `run/subscribe` (ADR-0022): the assistant message's
/// cumulative text at the subscribe instant plus the Run's status. `text` is
/// empty for a Run that has streamed no delta yet.
pub struct RunSnapshot {
    pub text: String,
    /// The Run's `runs.status`. Part of the ADR-0022 snapshot shape, consumed by
    /// the `thread/get` rehydration read in a later slice.
    #[allow(dead_code)]
    pub status: String,
}

/// Read the snapshot-then-tail starting point: the assistant message's
/// cumulative `seq=0` text and the Run status. `None` when the Run does not
/// exist (subscribe handler stays defensible against unknown run ids).
pub async fn select_run_snapshot(
    pool: &SqlitePool,
    run_id: Uuid,
) -> sqlx::Result<Option<RunSnapshot>> {
    Ok(queries::select_run_snapshot(pool, run_id)
        .await?
        .map(|(text, status)| RunSnapshot {
            text: text.unwrap_or_default(),
            status,
        }))
}

/// Clean termination on the Worker's `done`: flip `runs` and the assistant
/// `messages` row to `completed` and append a `done` `run_log` row, in one
/// transaction so a reader never sees an in-between mix.
pub async fn complete_run(pool: &SqlitePool, run_id: Uuid, now_ms: i64) -> sqlx::Result<Moved> {
    let mut tx = pool.begin().await?;
    let moved = RunStatus::complete(&mut *tx, run_id, now_ms).await?;
    tx.commit().await?;
    Ok(moved)
}

/// Worker stdout EOF without a `done` event (worker died/killed/hung up). Flip
/// `runs` to `errored` (`terminal_reason='worker_disconnected'`), every
/// `streaming` Message to `incomplete` (ADR-0017 invariant), and append an
/// `error` `run_log` row. One transaction.
pub async fn error_run(pool: &SqlitePool, run_id: Uuid, now_ms: i64) -> sqlx::Result<Moved> {
    error_run_with_message(
        pool,
        run_id,
        "worker_disconnected",
        "worker_disconnected",
        "worker exited without emitting done event",
        now_ms,
    )
    .await
}

/// Worker emitted an explicit `error` Run Event (ADR-0006). Same terminal shape
/// as [`error_run`] but with caller-supplied `terminal_reason`, `error_code`,
/// and `error_message` carried into the `runs` row and `run_log` payload.
/// `terminal_reason` must satisfy the `runs` CHECK constraint. One transaction.
pub async fn error_run_with_message(
    pool: &SqlitePool,
    run_id: Uuid,
    terminal_reason: &str,
    error_code: &str,
    error_message: &str,
    now_ms: i64,
) -> sqlx::Result<Moved> {
    let mut tx = pool.begin().await?;
    let reason = match terminal_reason {
        "worker_disconnected" => TerminalReason::WorkerDisconnected,
        "core_restarted" => TerminalReason::CoreRestarted,
        "errored" => TerminalReason::Errored,
        _ => TerminalReason::Errored,
    };
    let moved =
        RunStatus::fail(&mut *tx, run_id, reason, error_code, error_message, now_ms).await?;
    tx.commit().await?;
    Ok(moved)
}

/// Boot recovery sweep (ADR-0012): on Core start, force-error every `running`
/// Run (no live Worker survives a restart) to `errored` with
/// `terminal_reason='core_restarted'`, flipping its `streaming` Message to
/// `incomplete` (ADR-0017) in the same transaction. Preserves `parked` Runs
/// (ADR-0025) — they stay durable and decidable across a restart. Returns the
/// swept count for boot logging.
pub async fn recover_interrupted_runs(pool: &SqlitePool, now_ms: i64) -> sqlx::Result<u64> {
    let mut tx = pool.begin().await?;
    let swept =
        queries::recover_interrupted_runs(&mut *tx, "core restarted while run in flight", now_ms)
            .await?;
    queries::mark_recovered_streaming_messages_incomplete(&mut *tx, now_ms).await?;
    tx.commit().await?;
    Ok(swept)
}

/// Read a user setting value by key (ADR-0024), or `None` if unset. Backs
/// `settings/get` and the Run-creation resolver that overrides the Workflow's
/// model/effort from persisted user choices.
pub async fn get_setting(pool: &SqlitePool, key: &str) -> sqlx::Result<Option<String>> {
    queries::get_setting(pool, key).await
}

/// Upsert a user setting (ADR-0024). Single statement; backs `settings/set`.
pub async fn set_setting(pool: &SqlitePool, key: &str, value: &str) -> sqlx::Result<()> {
    queries::set_setting(pool, key, value).await
}

// ─── GTD relationship read layer (Slice 11, ADR-0031) ──────────────────────
//
// Core-internal in V0 — exposed to client APIs in V1, so currently uncalled
// (`#[allow(dead_code)]`). Entity-returning helpers map raw rows into
// [`EntityRow`] like [`list_by_type`]: a malformed `data` JSON degrades to
// `null` rather than failing the read.

/// Map a raw `(id, type, data, created_at, updated_at)` row to an [`EntityRow`].
fn entity_row(row: (String, String, String, i64, i64)) -> EntityRow {
    let (id, r#type, data, created_at, updated_at) = row;
    EntityRow {
        id,
        r#type,
        data: serde_json::from_str(&data).unwrap_or(serde_json::Value::Null),
        created_at,
        updated_at,
        refs: Vec::new(),
        person_refs: Vec::new(),
    }
}

/// Read every Todo owning `project_id` (its `data.project_id` matches), reusing
/// the `json_extract` project match. Returns full [`EntityRow`]s with real
/// `created_at`/`updated_at`, newest-first.
#[allow(dead_code)]
pub async fn todos_by_project(pool: &SqlitePool, project_id: &str) -> sqlx::Result<Vec<EntityRow>> {
    let rows = queries::todos_by_project(pool, project_id).await?;
    Ok(rows
        .into_iter()
        .map(|(id, data, created_at, updated_at)| {
            entity_row((id, "todo".to_string(), data, created_at, updated_at))
        })
        .collect())
}

/// Read every Todo linked to `person_id` via `todo_person_refs`, optionally
/// filtered to `role` (ADR-0031). Returns full [`EntityRow`]s, newest-first.
#[allow(dead_code)]
pub async fn todos_by_person(
    pool: &SqlitePool,
    person_id: &str,
    role: Option<&str>,
) -> sqlx::Result<Vec<EntityRow>> {
    let rows = queries::todos_by_person(pool, person_id, role).await?;
    Ok(rows.into_iter().map(entity_row).collect())
}

/// Read every Todo Person Reference on `todo_id` as `(person_id, role)` pairs
/// (ADR-0031).
#[allow(dead_code)]
pub async fn person_refs_by_todo(
    pool: &SqlitePool,
    todo_id: &str,
) -> sqlx::Result<Vec<(String, String)>> {
    queries::person_refs_by_todo(pool, todo_id).await
}

/// Distinct People linked to `project_id` through that Project's Todos (ADR-0031).
#[allow(dead_code)]
pub async fn project_people(pool: &SqlitePool, project_id: &str) -> sqlx::Result<Vec<String>> {
    queries::project_people(pool, project_id).await
}

/// Distinct Projects linked to `person_id` through their Todos (ADR-0031).
#[allow(dead_code)]
pub async fn person_projects(pool: &SqlitePool, person_id: &str) -> sqlx::Result<Vec<String>> {
    queries::person_projects(pool, person_id).await
}

/// Read reviewable Projects due for review: active/on_hold with a non-null
/// `next_review_at` at-or-before `now` (ADR-0031). Returns full [`EntityRow`]s.
#[allow(dead_code)]
pub async fn projects_due_for_review(pool: &SqlitePool, now: &str) -> sqlx::Result<Vec<EntityRow>> {
    let rows = queries::projects_due_for_review(pool, now).await?;
    Ok(rows.into_iter().map(entity_row).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A migrated in-memory pool so the `runs` CHECK constraints are in force.
    async fn memory_pool() -> SqlitePool {
        let options = SqliteConnectOptions::new()
            .filename(":memory:")
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("open in-memory sqlite");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        pool
    }

    /// Insert a Thread + a bare Run row in `status` directly (no Worker), to
    /// hand-craft `running`/`parked` Runs for the tests.
    async fn insert_bare_run(pool: &SqlitePool, run_id: &str, status: &str) {
        let mut tx = pool.begin().await.expect("begin");
        sqlx::query(
            "INSERT INTO threads (id, title, created_at, last_activity_at) VALUES (?, ?, ?, ?)",
        )
        .bind(format!("thr-{run_id}"))
        .bind("t")
        .bind(1_i64)
        .bind(1_i64)
        .execute(&mut *tx)
        .await
        .expect("insert thread");
        // user_message_id FK is DEFERRABLE (resolved at COMMIT), so the run can
        // reference a message inserted later in the same tx.
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, \
              user_message_id, status, started_at) \
             VALUES (?, ?, 'w', '1', 'p', 'm', ?, ?, ?)",
        )
        .bind(run_id)
        .bind(format!("thr-{run_id}"))
        .bind(format!("msg-{run_id}"))
        .bind(status)
        .bind(1_i64)
        .execute(&mut *tx)
        .await
        .expect("insert run");
        sqlx::query(
            "INSERT INTO messages (id, thread_id, run_id, role, status, created_at, updated_at) \
             VALUES (?, ?, ?, 'assistant', 'streaming', ?, ?)",
        )
        .bind(format!("msg-{run_id}"))
        .bind(format!("thr-{run_id}"))
        .bind(run_id)
        .bind(1_i64)
        .bind(1_i64)
        .execute(&mut *tx)
        .await
        .expect("insert message");
        tx.commit().await.expect("commit bare run");
    }

    async fn run_status_of(pool: &SqlitePool, run_id: &str) -> String {
        sqlx::query_scalar("SELECT status FROM runs WHERE id = ?1")
            .bind(run_id)
            .fetch_one(pool)
            .await
            .expect("run row")
    }

    /// The boot recovery sweep (ADR-0012) errors a `running` Run but preserves a
    /// `parked` one (ADR-0025), flipping only the swept Run's `streaming` Message
    /// to `incomplete` (ADR-0017).
    #[tokio::test]
    async fn recover_errors_running_preserves_parked() {
        let pool = memory_pool().await;
        insert_bare_run(&pool, "run-running", "running").await;
        insert_bare_run(&pool, "run-parked", "parked").await;

        let swept = recover_interrupted_runs(&pool, 42).await.expect("sweep ok");
        assert_eq!(swept, 1, "swept exactly the running Run");

        assert_eq!(run_status_of(&pool, "run-running").await, "errored");
        assert_eq!(
            run_status_of(&pool, "run-parked").await,
            "parked",
            "parked Run preserved across the sweep"
        );

        // Swept Runs carry the core_restarted terminal_reason + error fields.
        let reason: Option<String> =
            sqlx::query_scalar("SELECT terminal_reason FROM runs WHERE id = 'run-running'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(reason.as_deref(), Some("core_restarted"));
        let ended_at: Option<i64> =
            sqlx::query_scalar("SELECT ended_at FROM runs WHERE id = 'run-running'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(ended_at, Some(42), "ended_at stamped with the boot now");

        // The swept Run's streaming Message is flipped to incomplete; the parked
        // Run's stays streaming (it is not terminal).
        let swept_msg: String =
            sqlx::query_scalar("SELECT status FROM messages WHERE run_id = 'run-running'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            swept_msg, "incomplete",
            "swept Run's streaming message → incomplete"
        );
        let parked_msg: String =
            sqlx::query_scalar("SELECT status FROM messages WHERE run_id = 'run-parked'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(parked_msg, "streaming", "parked Run's message untouched");
    }

    async fn run_event_count(pool: &SqlitePool, run_id: &str, kind: &str) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM run_log WHERE run_id = ?1 AND kind = ?2")
            .bind(run_id)
            .bind(kind)
            .fetch_one(pool)
            .await
            .expect("count run events")
    }

    #[tokio::test]
    async fn complete_loses_on_parked_and_writes_no_done_event() {
        let pool = memory_pool().await;
        let run_id = Uuid::parse_str("33333333-3333-4333-8333-333333333333").unwrap();
        insert_bare_run(&pool, &run_id.to_string(), "parked").await;

        let moved = complete_run(&pool, run_id, 42).await.expect("complete");

        assert_eq!(moved, Moved::Lost);
        assert_eq!(run_status_of(&pool, &run_id.to_string()).await, "parked");
        assert_eq!(run_event_count(&pool, &run_id.to_string(), "done").await, 0);
    }

    #[tokio::test]
    async fn fail_loses_on_parked_and_writes_no_error_event() {
        let pool = memory_pool().await;
        let run_id = Uuid::parse_str("44444444-4444-4444-8444-444444444444").unwrap();
        insert_bare_run(&pool, &run_id.to_string(), "parked").await;

        let moved = error_run(&pool, run_id, 42).await.expect("error");

        assert_eq!(moved, Moved::Lost);
        assert_eq!(run_status_of(&pool, &run_id.to_string()).await, "parked");
        assert_eq!(
            run_event_count(&pool, &run_id.to_string(), "error").await,
            0
        );
    }

    #[tokio::test]
    async fn park_on_proposal_is_atomic_and_records_events() {
        let pool = memory_pool().await;
        let run_id = Uuid::parse_str("55555555-5555-4555-8555-555555555555").unwrap();
        insert_bare_run(&pool, &run_id.to_string(), "running").await;

        let moved = park_on_proposal(
            &pool,
            run_id,
            "proposal-1",
            "tool-1",
            "propose_workspace_mutation",
            r#"{"mutation_kind":"create_journal_entry","payload":{"occurred_at":"2026-06-10T10:30:00","body":[{"type":"text","text":"Bought milk."}]}}"#,
            "create_journal_entry",
            42,
        )
        .await
        .expect("park");

        assert_eq!(moved, Moved::Won);
        assert_eq!(run_status_of(&pool, &run_id.to_string()).await, "parked");
        assert_eq!(
            run_event_count(&pool, &run_id.to_string(), "parked").await,
            1
        );
        assert_eq!(
            run_event_count(&pool, &run_id.to_string(), "proposal_pending").await,
            1
        );

        let second = park_on_proposal(
            &pool,
            run_id,
            "proposal-2",
            "tool-2",
            "propose_workspace_mutation",
            r#"{"mutation_kind":"create_journal_entry","payload":{"occurred_at":"2026-06-10T10:31:00","body":[{"type":"text","text":"Bought eggs."}]}}"#,
            "create_journal_entry",
            43,
        )
        .await
        .expect("second park");
        assert_eq!(second, Moved::Lost);
        let proposal_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM proposals")
            .fetch_one(&pool)
            .await
            .expect("count proposals");
        assert_eq!(proposal_count, 1, "lost park rolled back its proposal row");
    }

    async fn seed_pending_proposal(pool: &SqlitePool, run_id: Uuid, tool_call_id: &str) -> String {
        let proposal_id = Uuid::now_v7().to_string();
        let mut tx = pool.begin().await.expect("begin proposal seed");
        queries::insert_tool_call(
            &mut *tx,
            tool_call_id,
            run_id,
            "propose_workspace_mutation",
            r#"{"mutation_kind":"create_journal_entry","payload":{"occurred_at":"2026-06-10T10:30:00","body":[{"type":"text","text":"Bought milk."}]}}"#,
            2,
        )
        .await
        .expect("insert tool call");
        queries::insert_tool_call_run_step(&mut *tx, run_id, 2, tool_call_id, 2)
            .await
            .expect("insert tool step");
        queries::insert_proposal(&mut *tx, &proposal_id, tool_call_id, "create_journal_entry")
            .await
            .expect("insert proposal");
        tx.commit().await.expect("commit proposal seed");
        proposal_id
    }

    #[tokio::test]
    async fn accept_records_proposal_decided_and_resume_is_guarded() {
        let pool = memory_pool().await;
        let run_id = Uuid::parse_str("66666666-6666-4666-8666-666666666666").unwrap();
        insert_bare_run(&pool, &run_id.to_string(), "parked").await;
        let proposal_id = seed_pending_proposal(&pool, run_id, "tool-accept").await;

        let entity_id = apply_proposal(
            &pool,
            run_id,
            &proposal_id,
            "tool-accept",
            "create_journal_entry",
            "journal_entry",
            99,
            None,
            &serde_json::json!({
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "text", "text": "Bought milk." }]
            }),
            None,
            Some("created_from"),
            Some("idem-accept"),
            r#"{"decision":"accept","content":"Accepted."}"#,
            42,
        )
        .await
        .expect("apply");
        assert!(!entity_id.is_empty());
        let source_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM entity_sources es \
             JOIN runs r ON r.user_message_id = es.source_message_id \
             WHERE es.entity_id = ?1 AND es.relation = 'created_from' AND r.id = ?2",
        )
        .bind(&entity_id)
        .bind(run_id.to_string())
        .fetch_one(&pool)
        .await
        .expect("count entity_sources");
        assert_eq!(
            source_count, 1,
            "accepted entity records its source Message"
        );
        // The caller-supplied schema_version is persisted verbatim (a sentinel,
        // not the default), so this catches apply_proposal re-hardcoding it.
        let stored_schema_version: i64 =
            sqlx::query_scalar("SELECT schema_version FROM entities WHERE id = ?1")
                .bind(&entity_id)
                .fetch_one(&pool)
                .await
                .expect("entity schema_version");
        assert_eq!(stored_schema_version, 99);
        assert_eq!(
            run_event_count(&pool, &run_id.to_string(), "proposal_decided").await,
            1
        );

        let first_resume = mark_run_running(&pool, run_id).await.expect("resume");
        assert_eq!(first_resume, Moved::Won);
        let second_resume = mark_run_running(&pool, run_id).await.expect("resume again");
        assert_eq!(second_resume, Moved::Lost);

        let duplicate = apply_proposal(
            &pool,
            run_id,
            &proposal_id,
            "tool-accept",
            "create_journal_entry",
            "journal_entry",
            crate::entities::JOURNAL_ENTRY_SCHEMA_VERSION,
            None,
            &serde_json::json!({
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "text", "text": "Bought milk." }]
            }),
            None,
            Some("created_from"),
            Some("idem-accept-2"),
            r#"{"decision":"accept","content":"Accepted."}"#,
            43,
        )
        .await;
        assert!(matches!(duplicate, Err(ApplyError::NotPending)));
        assert_eq!(
            run_event_count(&pool, &run_id.to_string(), "proposal_decided").await,
            1,
            "lost apply wrote no duplicate event"
        );
    }

    /// Defense-in-depth (ADR-0030/0031): `source_journal_entry_id` is honored
    /// only for `created_from` (creates). An `updated_from` apply that somehow
    /// carries the field still sources from the user Message — never from a
    /// Journal Entry. (Update validators already reject the field at decide; this
    /// guards the apply layer directly so a future allowlist relaxation can't
    /// mis-source an update or FK-fail on a stray JE id.)
    #[tokio::test]
    async fn update_ignores_source_journal_entry_id_and_stays_message_sourced() {
        let pool = memory_pool().await;
        let run_id = Uuid::parse_str("99999999-9999-4999-8999-999999999999").unwrap();
        insert_bare_run(&pool, &run_id.to_string(), "parked").await;

        // An existing Person to update (created_by='user', no proposal needed).
        let person_id = Uuid::now_v7().to_string();
        sqlx::query(
            "INSERT INTO entities \
             (id, type, schema_version, data, created_by, created_via_proposal_id, \
              created_at, updated_at) \
             VALUES (?, 'person', ?, ?, 'user', NULL, ?, ?)",
        )
        .bind(&person_id)
        .bind(crate::entities::PERSON_SCHEMA_VERSION)
        .bind(r#"{"name":"Alice"}"#)
        .bind(1_i64)
        .bind(1_i64)
        .execute(&pool)
        .await
        .expect("seed person");

        let proposal_id = seed_pending_proposal(&pool, run_id, "tool-update-src").await;

        // The update payload smuggles a source_journal_entry_id pointing at a
        // NON-existent entity. The buggy (pre-gate) path would route to
        // insert_entity_source_from_entity and FK-fail; the gate keeps it on the
        // Message path because relation == "updated_from".
        let bogus_journal_entry_id = Uuid::now_v7().to_string();
        let entity_id = apply_proposal(
            &pool,
            run_id,
            &proposal_id,
            "tool-update-src",
            "update_person",
            "person",
            crate::entities::PERSON_SCHEMA_VERSION,
            Some(&person_id),
            &serde_json::json!({
                "entity_id": person_id,
                "name": "Alice Updated",
                "source_journal_entry_id": bogus_journal_entry_id,
            }),
            None,
            Some("updated_from"),
            Some("idem-update-src"),
            r#"{"decision":"accept","content":"Accepted."}"#,
            42,
        )
        .await
        .expect("update applies (must not FK-fail on the stray JE id)");
        assert_eq!(entity_id, person_id);

        // The updated_from source points at the user Message, NOT the Journal Entry.
        let (msg_count, ent_count): (i64, i64) = sqlx::query_as(
            "SELECT \
               COUNT(*) FILTER (WHERE source_message_id IS NOT NULL AND source_entity_id IS NULL), \
               COUNT(*) FILTER (WHERE source_entity_id IS NOT NULL) \
             FROM entity_sources WHERE entity_id = ?1 AND relation = 'updated_from'",
        )
        .bind(&person_id)
        .fetch_one(&pool)
        .await
        .expect("count updated_from sources");
        assert_eq!(msg_count, 1, "update is sourced from the user Message");
        assert_eq!(
            ent_count, 0,
            "update is never sourced from a Journal Entry (source_journal_entry_id ignored on update)"
        );
    }

    /// A parked Proposal whose target Entity was deleted out from under it
    /// (ADR-0033's user-delete-vs-parked-agent-proposal race): `apply_proposal`'s
    /// update/delete affected-0-rows path surfaces a distinct
    /// [`ApplyError::TargetMissing`], NOT an opaque [`ApplyError::Sql`], so the
    /// caller can resolve the parked Run cleanly (decide maps it to
    /// `NotDecidable` → `-32002`). Nothing is written and the Proposal's flip
    /// rolls back with the tx.
    #[tokio::test]
    async fn apply_delete_with_vanished_target_is_target_missing() {
        let pool = memory_pool().await;
        let run_id = Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
        insert_bare_run(&pool, &run_id.to_string(), "parked").await;
        let proposal_id = seed_pending_proposal(&pool, run_id, "tool-vanished").await;

        // A delete_journal_entry whose `entity_id` names an Entity that does not
        // exist — modeling the target deleted after the Proposal parked. The
        // delete's affected-0-rows check fires.
        let missing_entity_id = Uuid::now_v7().to_string();
        let result = apply_proposal(
            &pool,
            run_id,
            &proposal_id,
            "tool-vanished",
            "delete_journal_entry",
            "journal_entry",
            crate::entities::JOURNAL_ENTRY_SCHEMA_VERSION,
            Some(&missing_entity_id),
            &serde_json::json!({ "entity_id": missing_entity_id }),
            None,
            None,
            Some("idem-vanished"),
            r#"{"decision":"accept","content":"Accepted."}"#,
            42,
        )
        .await;

        assert!(
            matches!(result, Err(ApplyError::TargetMissing)),
            "a vanished delete target surfaces TargetMissing, not opaque Sql: {result:?}"
        );
        let entity_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM entities")
            .fetch_one(&pool)
            .await
            .expect("count entities");
        assert_eq!(entity_count, 0, "nothing is written on a vanished target");
        // The guarded Proposal flip rolled back with the tx — still pending.
        let proposal_status: String =
            sqlx::query_scalar("SELECT status FROM proposals WHERE id = ?1")
                .bind(&proposal_id)
                .fetch_one(&pool)
                .await
                .expect("proposal status");
        assert_eq!(
            proposal_status, "pending",
            "the apply tx rolled back, leaving the Proposal pending"
        );
    }

    /// The update affected-0-rows path also surfaces [`ApplyError::TargetMissing`]
    /// (not opaque `Sql`): an `update_person` whose target Entity was deleted out
    /// from under the parked Proposal. Covers the generic update arm alongside the
    /// delete arm above.
    #[tokio::test]
    async fn apply_update_with_vanished_target_is_target_missing() {
        let pool = memory_pool().await;
        let run_id = Uuid::parse_str("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").unwrap();
        insert_bare_run(&pool, &run_id.to_string(), "parked").await;
        let proposal_id = seed_pending_proposal(&pool, run_id, "tool-vanished-upd").await;

        let missing_entity_id = Uuid::now_v7().to_string();
        let result = apply_proposal(
            &pool,
            run_id,
            &proposal_id,
            "tool-vanished-upd",
            "update_person",
            "person",
            crate::entities::PERSON_SCHEMA_VERSION,
            Some(&missing_entity_id),
            &serde_json::json!({ "entity_id": missing_entity_id, "name": "Ghost" }),
            None,
            Some("updated_from"),
            Some("idem-vanished-upd"),
            r#"{"decision":"accept","content":"Accepted."}"#,
            42,
        )
        .await;

        assert!(
            matches!(result, Err(ApplyError::TargetMissing)),
            "a vanished update target surfaces TargetMissing: {result:?}"
        );
        let entity_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM entities")
            .fetch_one(&pool)
            .await
            .expect("count entities");
        assert_eq!(entity_count, 0, "nothing is written on a vanished target");
    }

    #[tokio::test]
    async fn reject_records_proposal_decided_and_is_guarded() {
        let pool = memory_pool().await;
        let run_id = Uuid::parse_str("88888888-8888-4888-8888-888888888888").unwrap();
        insert_bare_run(&pool, &run_id.to_string(), "parked").await;
        let proposal_id = seed_pending_proposal(&pool, run_id, "tool-reject").await;

        reject_proposal(
            &pool,
            run_id,
            &proposal_id,
            "tool-reject",
            Some("idem-reject"),
            r#"{"decision":"reject","content":"Rejected."}"#,
            42,
        )
        .await
        .expect("reject");

        let proposal_status: String =
            sqlx::query_scalar("SELECT status FROM proposals WHERE id = ?1")
                .bind(&proposal_id)
                .fetch_one(&pool)
                .await
                .expect("proposal status");
        assert_eq!(proposal_status, "rejected");
        let tool_status: String =
            sqlx::query_scalar("SELECT status FROM tool_calls WHERE id = 'tool-reject'")
                .fetch_one(&pool)
                .await
                .expect("tool status");
        assert_eq!(tool_status, "completed");
        let entity_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM entities")
            .fetch_one(&pool)
            .await
            .expect("count entities");
        assert_eq!(entity_count, 0, "reject applies no entity");
        assert_eq!(
            run_event_count(&pool, &run_id.to_string(), "proposal_decided").await,
            1
        );

        let duplicate = reject_proposal(
            &pool,
            run_id,
            &proposal_id,
            "tool-reject",
            Some("idem-reject-2"),
            r#"{"decision":"reject","content":"Rejected."}"#,
            43,
        )
        .await;
        assert!(matches!(duplicate, Err(ApplyError::NotPending)));
        assert_eq!(
            run_event_count(&pool, &run_id.to_string(), "proposal_decided").await,
            1,
            "lost reject wrote no duplicate event"
        );
    }

    #[tokio::test]
    async fn cancel_parked_run_records_run_and_proposal_cancel_events() {
        let pool = memory_pool().await;
        let run_id = Uuid::parse_str("77777777-7777-4777-8777-777777777777").unwrap();
        insert_bare_run(&pool, &run_id.to_string(), "parked").await;
        seed_pending_proposal(&pool, run_id, "tool-cancel").await;

        let cancelled = cancel_parked_run(&pool, run_id, 42).await.expect("cancel");

        assert!(cancelled);
        assert_eq!(run_status_of(&pool, &run_id.to_string()).await, "cancelled");
        let proposal_status: String = sqlx::query_scalar(
            "SELECT p.status FROM proposals p \
             JOIN tool_calls tc ON tc.id = p.tool_call_id WHERE tc.run_id = ?1",
        )
        .bind(run_id.to_string())
        .fetch_one(&pool)
        .await
        .expect("proposal status");
        assert_eq!(proposal_status, "cancelled");
        assert_eq!(
            run_event_count(&pool, &run_id.to_string(), "cancelled").await,
            2,
            "one cancelled event for the Proposal and one for the Run"
        );

        let second = cancel_parked_run(&pool, run_id, 43)
            .await
            .expect("second cancel");
        assert!(!second);
        assert_eq!(
            run_event_count(&pool, &run_id.to_string(), "cancelled").await,
            2,
            "lost cancel wrote no duplicate event"
        );
    }

    /// `mark_run_running` is self-guarding on `status='parked'` (review M2): the
    /// first flip wins (1 row); a second flip and a never-parked Run are both
    /// 0-row no-ops, so the caller bails and exactly one resume Worker spawns.
    #[tokio::test]
    async fn mark_run_running_guards_on_parked() {
        let pool = memory_pool().await;
        let parked = Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap();
        let running = Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap();
        insert_bare_run(&pool, &parked.to_string(), "parked").await;
        insert_bare_run(&pool, &running.to_string(), "running").await;

        // First flip of the parked Run wins (1 row).
        let first = mark_run_running(&pool, parked).await.expect("first flip");
        assert_eq!(first, Moved::Won, "parked → running flips exactly one row");
        assert_eq!(run_status_of(&pool, &parked.to_string()).await, "running");

        // Second flip is a no-op — the Run already left `parked`.
        let second = mark_run_running(&pool, parked).await.expect("second flip");
        assert_eq!(
            second,
            Moved::Lost,
            "a second flip on an already-running Run is a no-op"
        );

        // A flip of a Run that was never parked is likewise 0 rows.
        let non_parked = mark_run_running(&pool, running)
            .await
            .expect("non-parked flip");
        assert_eq!(
            non_parked,
            Moved::Lost,
            "flipping a non-parked Run affects no rows"
        );
    }

    // ─── relationship read helpers (Slice 11, ADR-0031) ────────────────────

    /// Insert an Entity row directly with the given `type` + `data` JSON, so the
    /// relationship-read tests can seed Todos/Persons/Projects without a Proposal.
    async fn seed_entity(pool: &SqlitePool, id: &str, entity_type: &str, data: &str) {
        sqlx::query(
            "INSERT INTO entities \
             (id, type, schema_version, data, created_by, created_via_proposal_id, \
              created_at, updated_at) \
             VALUES (?, ?, 1, ?, 'user', NULL, 1, 1)",
        )
        .bind(id)
        .bind(entity_type)
        .bind(data)
        .execute(pool)
        .await
        .expect("insert entity");
    }

    /// Insert one `todo_person_refs` row directly.
    async fn seed_ref(pool: &SqlitePool, todo_id: &str, person_id: &str, role: &str) {
        sqlx::query(
            "INSERT INTO todo_person_refs \
             (todo_id, person_id, role, created_at, updated_at) VALUES (?, ?, ?, 1, 1)",
        )
        .bind(todo_id)
        .bind(person_id)
        .bind(role)
        .execute(pool)
        .await
        .expect("insert ref");
    }

    #[tokio::test]
    async fn todos_by_project_returns_only_that_projects_todos() {
        let pool = memory_pool().await;
        seed_entity(&pool, "proj-a", "project", r#"{"name":"A"}"#).await;
        seed_entity(&pool, "proj-b", "project", r#"{"name":"B"}"#).await;
        seed_entity(
            &pool,
            "t1",
            "todo",
            r#"{"title":"t1","project_id":"proj-a"}"#,
        )
        .await;
        seed_entity(
            &pool,
            "t2",
            "todo",
            r#"{"title":"t2","project_id":"proj-a"}"#,
        )
        .await;
        seed_entity(
            &pool,
            "t3",
            "todo",
            r#"{"title":"t3","project_id":"proj-b"}"#,
        )
        .await;
        seed_entity(&pool, "t4", "todo", r#"{"title":"t4"}"#).await;

        let mut ids: Vec<String> = todos_by_project(&pool, "proj-a")
            .await
            .expect("todos_by_project")
            .into_iter()
            .map(|row| row.id)
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["t1".to_string(), "t2".to_string()]);
    }

    #[tokio::test]
    async fn todos_by_person_optionally_filters_by_role() {
        let pool = memory_pool().await;
        seed_entity(&pool, "alice", "person", r#"{"name":"Alice"}"#).await;
        seed_entity(&pool, "t1", "todo", r#"{"title":"t1"}"#).await;
        seed_entity(&pool, "t2", "todo", r#"{"title":"t2"}"#).await;
        seed_ref(&pool, "t1", "alice", "waiting_on").await;
        seed_ref(&pool, "t2", "alice", "related").await;

        let mut all: Vec<String> = todos_by_person(&pool, "alice", None)
            .await
            .expect("all roles")
            .into_iter()
            .map(|row| row.id)
            .collect();
        all.sort();
        assert_eq!(all, vec!["t1".to_string(), "t2".to_string()]);

        let waiting: Vec<String> = todos_by_person(&pool, "alice", Some("waiting_on"))
            .await
            .expect("waiting only")
            .into_iter()
            .map(|row| row.id)
            .collect();
        assert_eq!(
            waiting,
            vec!["t1".to_string()],
            "role filter keeps only waiting_on"
        );
    }

    #[tokio::test]
    async fn person_refs_by_todo_returns_person_role_pairs() {
        let pool = memory_pool().await;
        seed_entity(&pool, "alice", "person", r#"{"name":"Alice"}"#).await;
        seed_entity(&pool, "bob", "person", r#"{"name":"Bob"}"#).await;
        seed_entity(&pool, "t1", "todo", r#"{"title":"t1"}"#).await;
        seed_ref(&pool, "t1", "alice", "waiting_on").await;
        seed_ref(&pool, "t1", "bob", "related").await;

        let mut refs = person_refs_by_todo(&pool, "t1").await.expect("refs");
        refs.sort();
        assert_eq!(
            refs,
            vec![
                ("alice".to_string(), "waiting_on".to_string()),
                ("bob".to_string(), "related".to_string()),
            ]
        );
    }

    #[tokio::test]
    async fn project_people_derive_only_through_that_projects_todos() {
        let pool = memory_pool().await;
        seed_entity(&pool, "alice", "person", r#"{"name":"Alice"}"#).await;
        seed_entity(&pool, "bob", "person", r#"{"name":"Bob"}"#).await;
        seed_entity(&pool, "proj-a", "project", r#"{"name":"A"}"#).await;
        seed_entity(&pool, "proj-b", "project", r#"{"name":"B"}"#).await;
        seed_entity(
            &pool,
            "t1",
            "todo",
            r#"{"title":"t1","project_id":"proj-a"}"#,
        )
        .await;
        seed_entity(
            &pool,
            "t2",
            "todo",
            r#"{"title":"t2","project_id":"proj-b"}"#,
        )
        .await;
        seed_ref(&pool, "t1", "alice", "waiting_on").await;
        // bob is on a DIFFERENT project's todo — must NOT appear under proj-a.
        seed_ref(&pool, "t2", "bob", "related").await;

        let people = project_people(&pool, "proj-a")
            .await
            .expect("project_people");
        assert_eq!(
            people,
            vec!["alice".to_string()],
            "only people linked through proj-a's todos"
        );
    }

    #[tokio::test]
    async fn person_projects_returns_distinct_project_ids() {
        let pool = memory_pool().await;
        seed_entity(&pool, "alice", "person", r#"{"name":"Alice"}"#).await;
        // Two todos in proj-a (DISTINCT collapses), one in proj-b, one with no project.
        seed_entity(
            &pool,
            "t1",
            "todo",
            r#"{"title":"t1","project_id":"proj-a"}"#,
        )
        .await;
        seed_entity(
            &pool,
            "t2",
            "todo",
            r#"{"title":"t2","project_id":"proj-a"}"#,
        )
        .await;
        seed_entity(
            &pool,
            "t3",
            "todo",
            r#"{"title":"t3","project_id":"proj-b"}"#,
        )
        .await;
        seed_entity(&pool, "t4", "todo", r#"{"title":"t4"}"#).await;
        seed_ref(&pool, "t1", "alice", "related").await;
        seed_ref(&pool, "t2", "alice", "related").await;
        seed_ref(&pool, "t3", "alice", "waiting_on").await;
        seed_ref(&pool, "t4", "alice", "related").await;

        let mut projects = person_projects(&pool, "alice")
            .await
            .expect("person_projects");
        projects.sort();
        assert_eq!(
            projects,
            vec!["proj-a".to_string(), "proj-b".to_string()],
            "distinct project ids, null project excluded"
        );
    }

    #[tokio::test]
    async fn list_by_type_todo_attaches_person_refs() {
        let pool = memory_pool().await;
        seed_entity(&pool, "alice", "person", r#"{"name":"Alice"}"#).await;
        seed_entity(&pool, "bob", "person", r#"{"name":"Bob"}"#).await;
        seed_entity(&pool, "t1", "todo", r#"{"title":"t1","status":"active"}"#).await;
        seed_entity(&pool, "t2", "todo", r#"{"title":"t2","status":"active"}"#).await;
        seed_ref(&pool, "t1", "alice", "waiting_on").await;
        seed_ref(&pool, "t1", "bob", "related").await;
        // t2 has no refs.

        let rows = list_by_type(&pool, "todo").await.expect("list todos");
        let t1 = rows.iter().find(|r| r.id == "t1").expect("t1 present");
        let mut t1_refs = t1.person_refs.clone();
        t1_refs.sort();
        assert_eq!(
            t1_refs,
            vec![
                ("alice".to_string(), "waiting_on".to_string()),
                ("bob".to_string(), "related".to_string()),
            ],
            "t1 carries both Person References with roles"
        );

        let t2 = rows.iter().find(|r| r.id == "t2").expect("t2 present");
        assert!(
            t2.person_refs.is_empty(),
            "a Todo with no refs carries none"
        );
    }

    #[tokio::test]
    async fn list_by_type_non_todo_has_no_person_refs() {
        let pool = memory_pool().await;
        seed_entity(&pool, "alice", "person", r#"{"name":"Alice"}"#).await;
        let rows = list_by_type(&pool, "person").await.expect("list people");
        assert!(
            rows.iter().all(|r| r.person_refs.is_empty()),
            "non-Todo rows never carry person_refs"
        );
    }

    #[tokio::test]
    async fn projects_due_for_review_includes_reviewable_excludes_terminal_and_future() {
        let pool = memory_pool().await;
        let now = "2026-06-12T00:00:00";
        seed_entity(
            &pool,
            "p-active-due",
            "project",
            r#"{"name":"active due","status":"active","next_review_at":"2026-06-11T20:00:00"}"#,
        )
        .await;
        seed_entity(
            &pool,
            "p-onhold-due",
            "project",
            r#"{"name":"on_hold due","status":"on_hold","next_review_at":"2026-06-12T00:00:00"}"#,
        )
        .await;
        seed_entity(
            &pool,
            "p-active-future",
            "project",
            r#"{"name":"active future","status":"active","next_review_at":"2026-06-30T20:00:00"}"#,
        )
        .await;
        seed_entity(
            &pool,
            "p-completed",
            "project",
            r#"{"name":"done","status":"completed","completed_at":"2026-06-01T00:00:00","next_review_at":"2026-06-11T20:00:00"}"#,
        )
        .await;
        seed_entity(
            &pool,
            "p-dropped",
            "project",
            r#"{"name":"dropped","status":"dropped","dropped_at":"2026-06-01T00:00:00","next_review_at":"2026-06-11T20:00:00"}"#,
        )
        .await;
        seed_entity(
            &pool,
            "p-active-noreview",
            "project",
            r#"{"name":"active no review","status":"active"}"#,
        )
        .await;

        let mut ids: Vec<String> = projects_due_for_review(&pool, now)
            .await
            .expect("projects_due_for_review")
            .into_iter()
            .map(|row| row.id)
            .collect();
        ids.sort();
        assert_eq!(
            ids,
            vec!["p-active-due".to_string(), "p-onhold-due".to_string()],
            "active/on_hold with next_review_at <= now; terminal and future excluded"
        );
    }
}
