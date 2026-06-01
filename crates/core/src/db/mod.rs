//! SQLite tier-2 storage (ADR-0017). Resolves the DB path, opens a pool,
//! and runs the embedded migration. The pool is the durable home for
//! Threads, Runs, Messages, Run Events, Tool Calls, Proposals, and
//! Entities.
//!
//! All SQL strings live in [`queries`]; this module owns the high-level
//! operations and transaction boundaries. Outside `db::`, no caller
//! writes SQL — they call these functions.

mod queries;

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use uuid::Uuid;

use crate::workflow::Workflow;

/// Current wall-clock time as ms since UNIX_EPOCH. Used as `created_at` /
/// `updated_at` / `started_at` / `ended_at` for tier-2 rows.
pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time before epoch")
        .as_millis() as i64
}

/// Resolve the DB path: `INKSTONE_DB_PATH` env override wins; otherwise
/// land on `<OS data dir>/inkstone/db.sqlite`:
/// - macOS:   `~/Library/Application Support/inkstone/db.sqlite`
/// - Linux:   `$XDG_DATA_HOME/inkstone/db.sqlite` (or `~/.local/share/inkstone/...`)
/// - Windows: `%APPDATA%/inkstone/db.sqlite`
fn resolve_db_path() -> Result<PathBuf> {
    if let Some(env) = std::env::var_os("INKSTONE_DB_PATH") {
        return Ok(PathBuf::from(env));
    }
    Ok(os_data_dir()?.join("inkstone").join("db.sqlite"))
}

/// Per-OS application-data directory. Hand-rolled instead of pulling in a
/// crate; the rules are short and the inputs are env vars + `$HOME`.
#[cfg(target_os = "macos")]
fn os_data_dir() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").context("$HOME not set")?;
    Ok(PathBuf::from(home).join("Library").join("Application Support"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn os_data_dir() -> Result<PathBuf> {
    if let Some(xdg) = std::env::var_os("XDG_DATA_HOME").filter(|s| !s.is_empty()) {
        return Ok(PathBuf::from(xdg));
    }
    let home = std::env::var_os("HOME").context("$HOME not set")?;
    Ok(PathBuf::from(home).join(".local").join("share"))
}

#[cfg(target_os = "windows")]
fn os_data_dir() -> Result<PathBuf> {
    let appdata = std::env::var_os("APPDATA").context("%APPDATA% not set")?;
    Ok(PathBuf::from(appdata))
}

/// Open the SQLite pool, creating the file (and parent dir) if missing,
/// and run the bundled migration. Returns a pool ready for queries.
pub async fn open() -> Result<SqlitePool> {
    let path = resolve_db_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create parent dir {}", parent.display()))?;
    }

    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await
        .with_context(|| format!("open SQLite pool at {}", path.display()))?;

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .context("run SQLite migrations")?;

    Ok(pool)
}

/// Return whether a Thread row with `thread_id` exists. `run/post_message`
/// is existing-thread-only (ADR-0022): it calls this before persisting a new
/// Run so a well-formed-but-unknown `thread_id` is rejected with
/// `unknown_thread` and writes zero rows.
pub async fn thread_exists(pool: &SqlitePool, thread_id: Uuid) -> sqlx::Result<bool> {
    queries::thread_exists(pool, thread_id).await
}

/// Read all Threads for `thread/list` (ADR-0022 read path), ordered
/// most-recent-activity-first. Returns `(id, title, last_activity_at)` rows;
/// the handler maps them to the wire `ThreadSummary` shape.
pub async fn list_threads(pool: &SqlitePool) -> sqlx::Result<Vec<(String, String, i64)>> {
    queries::list_threads(pool).await
}

/// Single transaction with deferred FK enforcement. sqlx's `pool.begin()`
/// issues `BEGIN` (deferred by default in SQLite), so the FK cycle between
/// `runs.user_message_id` and `messages.run_id` resolves only at COMMIT.
///
/// Also pre-inserts the assistant `messages` row (`status='streaming'`)
/// + an empty `message_parts` row at `seq=0` so each Worker `text_delta`
/// event can append to it via [`append_assistant_text`].
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

/// Message-first thread creation (ADR-0022): mint a NEW Thread row (with a
/// derived `title`) THEN the same initial-run rows `persist_initial_run`
/// writes — all in ONE transaction. `thread/create` uses this so the Thread
/// and its first message are born atomically. Deferred-FK ordering is
/// identical to `persist_initial_run` (begin → inserts → commit).
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

/// Shared initial-run inserts for a Thread that already exists in the open
/// transaction: the Run row, the user Message + its `seq=0` text part, the
/// assistant Message (`status='streaming'`) + an empty `seq=0` text part
/// (so each Worker `text_delta` can append via [`append_assistant_text`]),
/// the two `message_run_steps`, the `status` `run_event`, and the Thread
/// activity touch. Runs inside the caller's transaction; the caller owns
/// the `begin`/`commit` (and any preceding `insert_thread`).
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
        workflow.name,
        &workflow.version.to_string(),
        "echo",
        "echo",
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

    queries::insert_run_event(
        &mut **tx,
        run_id,
        0,
        "status",
        Some(r#"{"status":"running"}"#),
        now_ms,
    )
    .await?;

    queries::touch_thread_activity(&mut **tx, thread_id, now_ms).await
}

/// Append a streaming `text_delta` to the assistant `message_parts.text`
/// row that [`persist_initial_run`] pre-inserted at `seq=0`. Single
/// statement; SQLite serializes writes, no UPSERT semantics needed.
pub async fn append_assistant_text(
    pool: &SqlitePool,
    assistant_message_id: Uuid,
    delta: &str,
) -> sqlx::Result<()> {
    queries::append_text_part(pool, assistant_message_id, 0, delta).await
}

/// A Run's snapshot for `run/subscribe` (ADR-0022): the assistant
/// message's cumulative text at the subscribe instant plus the Run's
/// status. `text` is empty for a Run that has streamed no delta yet.
pub struct RunSnapshot {
    pub text: String,
    /// The Run's `runs.status` at the snapshot instant. Slice 1 keys
    /// streaming-vs-terminal off hub presence, not this field; it is part
    /// of the ADR-0022 snapshot shape and consumed by the `thread/get`
    /// rehydration read in a later slice.
    #[allow(dead_code)]
    pub status: String,
}

/// Read the snapshot-then-tail starting point for `run_id`: the assistant
/// message's cumulative `message_parts.text` (seq 0) and the Run status.
/// Returns `None` when the Run does not exist, so the subscribe handler can
/// stay defensible against an unknown run id.
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

/// Slice 4: clean termination. Worker emitted `done`; flip `runs` to
/// `completed`, the assistant `messages` row from `streaming` to
/// `completed`, and append a terminal `run_events` row with `kind='done'`.
/// All three writes happen in one transaction so a reader sees either the
/// pre-terminal or post-terminal state, never an in-between mix.
pub async fn complete_run(pool: &SqlitePool, run_id: Uuid, now_ms: i64) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;
    let next_seq = queries::next_run_seq(&mut *tx, run_id).await?;
    queries::mark_run_completed(&mut *tx, run_id, now_ms).await?;
    queries::mark_assistant_messages_completed(&mut *tx, run_id, now_ms).await?;
    queries::insert_run_event(&mut *tx, run_id, next_seq, "done", None, now_ms).await?;
    tx.commit().await
}

/// Slice 4: Worker stdout EOF without a `done` event (the worker died, was
/// killed, or otherwise hung up). Flip `runs` to `errored` with
/// `terminal_reason='worker_disconnected'`, every `messages.status='streaming'`
/// row for this Run to `'incomplete'` (the ADR-0017 invariant — no Message
/// is left dangling at `'streaming'` after its Run terminates), and append
/// a terminal `run_events` row with `kind='error'`. One transaction.
pub async fn error_run(pool: &SqlitePool, run_id: Uuid, now_ms: i64) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;
    let next_seq = queries::next_run_seq(&mut *tx, run_id).await?;
    queries::mark_run_errored(
        &mut *tx,
        run_id,
        "worker_disconnected",
        "worker_disconnected",
        "worker exited without emitting done event",
        now_ms,
    )
    .await?;
    queries::mark_streaming_messages_incomplete(&mut *tx, run_id, now_ms).await?;
    queries::insert_run_event(
        &mut *tx,
        run_id,
        next_seq,
        "error",
        Some(
            r#"{"code":"worker_disconnected","message":"worker exited without emitting done event"}"#,
        ),
        now_ms,
    )
    .await?;
    tx.commit().await
}
