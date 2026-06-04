//! Every tier-2 SQL string lives here, exactly once. Each function takes
//! a sqlx executor (`&SqlitePool`, `&mut SqliteConnection`, or
//! `&mut Transaction<'_, Sqlite>`) and runs one statement. No business
//! rules, no orchestration — those compose in [`super`].
//!
//! `pub(super)` keeps the surface scoped to the `db` module: callers
//! outside `db::` cannot construct or hand-roll a SQL string.

use sqlx::{Executor, Sqlite};
use uuid::Uuid;

// ─── threads ──────────────────────────────────────────────────────────

pub(super) async fn thread_exists<'e, E>(executor: E, thread_id: Uuid) -> sqlx::Result<bool>
where
    E: Executor<'e, Database = Sqlite>,
{
    let row: Option<i64> = sqlx::query_scalar("SELECT 1 FROM threads WHERE id = ?1 LIMIT 1")
        .bind(thread_id.to_string())
        .fetch_optional(executor)
        .await?;
    Ok(row.is_some())
}

pub(super) async fn insert_thread<'e, E>(
    executor: E,
    id: Uuid,
    title: &str,
    now_ms: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO threads (id, title, created_at, last_activity_at) \
         VALUES (?, ?, ?, ?)",
    )
    .bind(id.to_string())
    .bind(title)
    .bind(now_ms)
    .bind(now_ms)
    .execute(executor)
    .await
    .map(|_| ())
}

pub(super) async fn touch_thread_activity<'e, E>(
    executor: E,
    thread_id: Uuid,
    now_ms: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query("UPDATE threads SET last_activity_at = ? WHERE id = ?")
        .bind(now_ms)
        .bind(thread_id.to_string())
        .execute(executor)
        .await
        .map(|_| ())
}

/// Read every Thread for `thread/list`, ordered most-recent-activity-first.
/// Returns `(id, title, last_activity_at)` rows; the handler maps them to
/// `ThreadSummary`. Read-only — no FK/transaction concerns.
pub(super) async fn list_threads<'e, E>(executor: E) -> sqlx::Result<Vec<(String, String, i64)>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as("SELECT id, title, last_activity_at FROM threads ORDER BY last_activity_at DESC")
        .fetch_all(executor)
        .await
}

/// Read a Thread's `title` by id for `thread/get`. `None` means the Thread
/// does not exist — the handler maps that to `unknown_thread` (-32001).
pub(super) async fn thread_title<'e, E>(
    executor: E,
    thread_id: Uuid,
) -> sqlx::Result<Option<String>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_scalar("SELECT title FROM threads WHERE id = ?1")
        .bind(thread_id.to_string())
        .fetch_optional(executor)
        .await
}

// ─── runs ─────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
pub(super) async fn insert_run<'e, E>(
    executor: E,
    run_id: Uuid,
    thread_id: Uuid,
    workflow_name: &str,
    workflow_version: &str,
    provider: &str,
    model: &str,
    user_message_id: Uuid,
    started_at: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO runs \
         (id, thread_id, workflow_name, workflow_version, provider, model, \
          user_message_id, status, started_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)",
    )
    .bind(run_id.to_string())
    .bind(thread_id.to_string())
    .bind(workflow_name)
    .bind(workflow_version)
    .bind(provider)
    .bind(model)
    .bind(user_message_id.to_string())
    .bind(started_at)
    .execute(executor)
    .await
    .map(|_| ())
}

pub(super) async fn mark_run_completed<'e, E>(
    executor: E,
    run_id: Uuid,
    ended_at: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE runs SET status = 'completed', \
         terminal_reason = 'completed', ended_at = ? WHERE id = ?",
    )
    .bind(ended_at)
    .bind(run_id.to_string())
    .execute(executor)
    .await
    .map(|_| ())
}

pub(super) async fn mark_run_errored<'e, E>(
    executor: E,
    run_id: Uuid,
    terminal_reason: &str,
    error_code: &str,
    error_message: &str,
    ended_at: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE runs SET status = 'errored', \
         terminal_reason = ?, error_code = ?, error_message = ?, \
         ended_at = ? WHERE id = ?",
    )
    .bind(terminal_reason)
    .bind(error_code)
    .bind(error_message)
    .bind(ended_at)
    .bind(run_id.to_string())
    .execute(executor)
    .await
    .map(|_| ())
}

// ─── messages ─────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
pub(super) async fn insert_message<'e, E>(
    executor: E,
    id: Uuid,
    thread_id: Uuid,
    run_id: Uuid,
    role: &str,
    status: &str,
    now_ms: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO messages \
         (id, thread_id, run_id, role, status, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id.to_string())
    .bind(thread_id.to_string())
    .bind(run_id.to_string())
    .bind(role)
    .bind(status)
    .bind(now_ms)
    .bind(now_ms)
    .execute(executor)
    .await
    .map(|_| ())
}

pub(super) async fn mark_assistant_messages_completed<'e, E>(
    executor: E,
    run_id: Uuid,
    now_ms: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE messages SET status = 'completed', updated_at = ? \
         WHERE run_id = ? AND role = 'assistant'",
    )
    .bind(now_ms)
    .bind(run_id.to_string())
    .execute(executor)
    .await
    .map(|_| ())
}

pub(super) async fn mark_streaming_messages_incomplete<'e, E>(
    executor: E,
    run_id: Uuid,
    now_ms: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE messages SET status = 'incomplete', updated_at = ? \
         WHERE run_id = ? AND status = 'streaming'",
    )
    .bind(now_ms)
    .bind(run_id.to_string())
    .execute(executor)
    .await
    .map(|_| ())
}

/// Read a Thread's Messages for `thread/get`, in chronological order.
/// Returns `(id, role, status, run_id)` rows. Ordered by `created_at, rowid`:
/// the user and assistant Messages of the first Run are inserted in the same
/// ms, so the monotonic `rowid` tiebreaker keeps the user Message (inserted
/// first) ahead of the assistant Message on a ms-tie. The handler assembles
/// each Message's text from its parts.
pub(super) async fn messages_by_thread<'e, E>(
    executor: E,
    thread_id: Uuid,
) -> sqlx::Result<Vec<(String, String, String, String)>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as(
        "SELECT id, role, status, run_id FROM messages \
         WHERE thread_id = ?1 ORDER BY created_at, rowid",
    )
    .bind(thread_id.to_string())
    .fetch_all(executor)
    .await
}

/// The `completed` Messages of a Thread that belong to Runs OTHER than
/// `exclude_run_id`, oldest-first. Backs the multi-turn manifest history
/// (ADR-0018 as-built): the current Run's just-inserted rows are excluded so
/// the assembled history is strictly the prior exchange, and `status =
/// 'completed'` drops any in-flight or errored partial assistant text.
/// Returns `(id, role)` rows; the caller assembles each Message's text from
/// its parts.
pub(super) async fn history_messages_for_run<'e, E>(
    executor: E,
    thread_id: Uuid,
    exclude_run_id: Uuid,
) -> sqlx::Result<Vec<(String, String)>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as(
        "SELECT id, role FROM messages \
         WHERE thread_id = ?1 AND run_id != ?2 AND status = 'completed' \
         ORDER BY created_at, rowid",
    )
    .bind(thread_id.to_string())
    .bind(exclude_run_id.to_string())
    .fetch_all(executor)
    .await
}

// ─── message_parts ────────────────────────────────────────────────────

pub(super) async fn insert_text_part<'e, E>(
    executor: E,
    message_id: Uuid,
    seq: i64,
    text: &str,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query("INSERT INTO message_parts (message_id, seq, type, text) VALUES (?, ?, 'text', ?)")
        .bind(message_id.to_string())
        .bind(seq)
        .bind(text)
        .execute(executor)
        .await
        .map(|_| ())
}

pub(super) async fn append_text_part<'e, E>(
    executor: E,
    message_id: Uuid,
    seq: i64,
    delta: &str,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE message_parts SET text = text || ?1 \
         WHERE message_id = ?2 AND seq = ?3",
    )
    .bind(delta)
    .bind(message_id.to_string())
    .bind(seq)
    .execute(executor)
    .await
    .map(|_| ())
}

/// Read a Message's text parts for `thread/get`, ordered by `seq`. Returns
/// the `text` columns; the handler concatenates them into the Message's
/// assembled wire text (flat-text-no-parts[], ADR-0017/Q15). The MVP has one
/// text part per Message at `seq=0`, but the concat handles multi-part too.
pub(super) async fn text_parts_by_message<'e, E>(
    executor: E,
    message_id: &str,
) -> sqlx::Result<Vec<String>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_scalar(
        "SELECT text FROM message_parts \
         WHERE message_id = ?1 AND type = 'text' ORDER BY seq",
    )
    .bind(message_id)
    .fetch_all(executor)
    .await
}

/// Read a Run's snapshot for `run/subscribe`: the assistant message's
/// cumulative `message_parts.text` at `seq=0` plus the Run's `status`.
/// Returns `None` when the Run does not exist. The text is `Some("")` for
/// a Run that has begun streaming but persisted no delta yet; `None` only
/// when there is no assistant message_part row at all.
pub(super) async fn select_run_snapshot<'e, E>(
    executor: E,
    run_id: Uuid,
) -> sqlx::Result<Option<(Option<String>, String)>>
where
    E: Executor<'e, Database = Sqlite>,
{
    let row: Option<(Option<String>, String)> = sqlx::query_as(
        "SELECT mp.text, r.status \
         FROM runs r \
         JOIN messages m ON m.run_id = r.id AND m.role = 'assistant' \
         JOIN message_parts mp ON mp.message_id = m.id AND mp.seq = 0 \
         WHERE r.id = ?1",
    )
    .bind(run_id.to_string())
    .fetch_optional(executor)
    .await?;
    Ok(row)
}

// ─── run_steps ────────────────────────────────────────────────────────

pub(super) async fn insert_message_run_step<'e, E>(
    executor: E,
    run_id: Uuid,
    seq: i64,
    message_id: Uuid,
    now_ms: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO run_steps \
         (run_id, seq, kind, message_id, tool_call_id, created_at) \
         VALUES (?, ?, 'message', ?, NULL, ?)",
    )
    .bind(run_id.to_string())
    .bind(seq)
    .bind(message_id.to_string())
    .bind(now_ms)
    .execute(executor)
    .await
    .map(|_| ())
}

/// The next `run_steps.seq` for a Run (`MAX(seq)+1`, or 0 for the first).
/// The initial run inserts the user + assistant message steps at seq 0/1, so
/// the first tool-call step lands at seq 2.
pub(super) async fn next_run_step_seq<'e, E>(executor: E, run_id: Uuid) -> sqlx::Result<i64>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_scalar("SELECT COALESCE(MAX(seq), -1) + 1 FROM run_steps WHERE run_id = ?")
        .bind(run_id.to_string())
        .fetch_one(executor)
        .await
}

// ─── tool_calls (ADR-0017) ────────────────────────────────────────────

/// Insert a `tool_calls` row in the `pending` state with its request payload.
/// `id` is the Worker-assigned `tool_call_id` (a string, not necessarily a
/// UUID). Resolved later by [`complete_tool_call`].
pub(super) async fn insert_tool_call<'e, E>(
    executor: E,
    id: &str,
    run_id: Uuid,
    name: &str,
    request_payload: &str,
    now_ms: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO tool_calls \
         (id, run_id, name, request_payload, status, requested_at) \
         VALUES (?, ?, ?, ?, 'pending', ?)",
    )
    .bind(id)
    .bind(run_id.to_string())
    .bind(name)
    .bind(request_payload)
    .bind(now_ms)
    .execute(executor)
    .await
    .map(|_| ())
}

/// Flip a `tool_calls` row to `completed` with its result payload and resolve
/// time. `status` is the terminal tool-call status (`completed` or `errored`).
pub(super) async fn resolve_tool_call<'e, E>(
    executor: E,
    id: &str,
    status: &str,
    result_payload: &str,
    now_ms: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE tool_calls SET status = ?, result_payload = ?, resolved_at = ? \
         WHERE id = ?",
    )
    .bind(status)
    .bind(result_payload)
    .bind(now_ms)
    .bind(id)
    .execute(executor)
    .await
    .map(|_| ())
}

/// Insert a `run_steps` row of kind `tool_call`, interleaving the tool call
/// into the Run timeline at `seq`.
pub(super) async fn insert_tool_call_run_step<'e, E>(
    executor: E,
    run_id: Uuid,
    seq: i64,
    tool_call_id: &str,
    now_ms: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO run_steps \
         (run_id, seq, kind, message_id, tool_call_id, created_at) \
         VALUES (?, ?, 'tool_call', NULL, ?, ?)",
    )
    .bind(run_id.to_string())
    .bind(seq)
    .bind(tool_call_id)
    .bind(now_ms)
    .execute(executor)
    .await
    .map(|_| ())
}

// ─── run_events ───────────────────────────────────────────────────────

pub(super) async fn next_run_seq<'e, E>(executor: E, run_id: Uuid) -> sqlx::Result<i64>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_scalar(
        "SELECT COALESCE(MAX(run_seq), -1) + 1 FROM run_events WHERE run_id = ?",
    )
    .bind(run_id.to_string())
    .fetch_one(executor)
    .await
}

pub(super) async fn insert_run_event<'e, E>(
    executor: E,
    run_id: Uuid,
    run_seq: i64,
    kind: &str,
    payload: Option<&str>,
    now_ms: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO run_events (run_id, run_seq, kind, payload, created_at) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(run_id.to_string())
    .bind(run_seq)
    .bind(kind)
    .bind(payload)
    .bind(now_ms)
    .execute(executor)
    .await
    .map(|_| ())
}

// ─── settings ─────────────────────────────────────────────────────────

/// Read a user setting's value by key (ADR-0024). `None` when the key is
/// unset (the caller supplies the default).
pub(super) async fn get_setting<'e, E>(executor: E, key: &str) -> sqlx::Result<Option<String>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_scalar("SELECT value FROM settings WHERE key = ?1")
        .bind(key)
        .fetch_optional(executor)
        .await
}

/// Upsert a user setting (ADR-0024). Insert-or-replace keyed by `key` so a
/// repeated `settings/set` overwrites the prior value.
pub(super) async fn set_setting<'e, E>(executor: E, key: &str, value: &str) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key)
    .bind(value)
    .execute(executor)
    .await
    .map(|_| ())
}
