//! Every tier-2 SQL string, exactly once. Each function takes a sqlx executor
//! and runs one statement — no business rules, no orchestration. `pub(super)`
//! scopes the surface to the `db` module.

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

/// Read every Thread for `thread/list`, most-recent-activity-first. Returns
/// `(id, title, last_activity_at)` rows.
pub(super) async fn list_threads<'e, E>(executor: E) -> sqlx::Result<Vec<(String, String, i64)>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as("SELECT id, title, last_activity_at FROM threads ORDER BY last_activity_at DESC")
        .fetch_all(executor)
        .await
}

/// Read a Thread's `title` by id for `thread/get`. `None` means the Thread
/// does not exist.
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
    terminal_reason: &str,
    ended_at: i64,
) -> sqlx::Result<u64>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE runs SET status = 'completed', \
         terminal_reason = ?, ended_at = ? WHERE id = ? AND status = 'running'",
    )
    .bind(terminal_reason)
    .bind(ended_at)
    .bind(run_id.to_string())
    .execute(executor)
    .await
    .map(|r| r.rows_affected())
}

pub(super) async fn mark_run_errored<'e, E>(
    executor: E,
    run_id: Uuid,
    terminal_reason: &str,
    error_code: &str,
    error_message: &str,
    ended_at: i64,
) -> sqlx::Result<u64>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE runs SET status = 'errored', \
         terminal_reason = ?, error_code = ?, error_message = ?, \
         ended_at = ? WHERE id = ? AND status = 'running'",
    )
    .bind(terminal_reason)
    .bind(error_code)
    .bind(error_message)
    .bind(ended_at)
    .bind(run_id.to_string())
    .execute(executor)
    .await
    .map(|r| r.rows_affected())
}

pub(super) async fn mark_running_run_cancelled<'e, E>(
    executor: E,
    run_id: Uuid,
    terminal_reason: &str,
    ended_at: i64,
) -> sqlx::Result<u64>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE runs SET status = 'cancelled', terminal_reason = ?, \
         ended_at = ? WHERE id = ? AND status = 'running'",
    )
    .bind(terminal_reason)
    .bind(ended_at)
    .bind(run_id.to_string())
    .execute(executor)
    .await
    .map(|r| r.rows_affected())
}

/// Boot recovery sweep (ADR-0012): error every Run still `running` after a Core
/// crash/restart, stamping `terminal_reason='core_restarted'` + error fields +
/// `ended_at`. Excludes `parked` (decidable per ADR-0025) and terminal states.
/// Returns the affected row count.
pub(super) async fn recover_interrupted_runs<'e, E>(
    executor: E,
    error_message: &str,
    ended_at: i64,
) -> sqlx::Result<u64>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE runs SET status = 'errored', terminal_reason = 'core_restarted', \
         error_code = 'core_restarted', error_message = ?, ended_at = ? \
         WHERE status = 'running'",
    )
    .bind(error_message)
    .bind(ended_at)
    .execute(executor)
    .await
    .map(|r| r.rows_affected())
}

/// Companion to [`recover_interrupted_runs`] (ADR-0017): flip every `streaming`
/// Message whose Run was just swept (now `errored` with
/// `terminal_reason='core_restarted'`) to `incomplete`, so no Message dangles at
/// `streaming` past its Run. Runs in the same boot tx; scoped to the swept set.
pub(super) async fn mark_recovered_streaming_messages_incomplete<'e, E>(
    executor: E,
    now_ms: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE messages SET status = 'incomplete', updated_at = ? \
         WHERE status = 'streaming' AND run_id IN \
         (SELECT id FROM runs WHERE status = 'errored' AND terminal_reason = 'core_restarted')",
    )
    .bind(now_ms)
    .execute(executor)
    .await
    .map(|_| ())
}

/// Park a Run (ADR-0025): set `status='parked'`, recording the waitpoint in
/// `awaiting_tool_call_id` (the Proposal's `tool_calls` row). Non-terminal — no
/// `ended_at`/`terminal_reason`/error fields.
pub(super) async fn mark_run_parked<'e, E>(
    executor: E,
    run_id: Uuid,
    awaiting_tool_call_id: &str,
) -> sqlx::Result<u64>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE runs SET status = 'parked', awaiting_tool_call_id = ? \
         WHERE id = ? AND status = 'running'",
    )
    .bind(awaiting_tool_call_id)
    .bind(run_id.to_string())
    .execute(executor)
    .await
    .map(|r| r.rows_affected())
}

/// Read a Run's `status` by id (ADR-0025). `None` when the Run does not exist.
/// Backs `run/subscribe`'s parked branch when no live hub exists.
pub(super) async fn run_status<'e, E>(executor: E, run_id: Uuid) -> sqlx::Result<Option<String>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_scalar("SELECT status FROM runs WHERE id = ?1")
        .bind(run_id.to_string())
        .fetch_optional(executor)
        .await
}

/// Load a Proposal by id for `proposal/decide` (ADR-0025). `None` when no such
/// Proposal exists. Returns `(run_id, tool_call_id, mutation_kind, status,
/// request_payload, decision_idempotency_key)`.
#[allow(clippy::type_complexity)]
pub(super) async fn proposal_by_id<'e, E>(
    executor: E,
    proposal_id: &str,
) -> sqlx::Result<Option<(String, String, String, String, String, Option<String>)>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as(
        "SELECT tc.run_id, p.tool_call_id, p.mutation_kind, p.status, \
                tc.request_payload, p.decision_idempotency_key \
         FROM proposals p \
         JOIN tool_calls tc ON tc.id = p.tool_call_id \
         WHERE p.id = ?1",
    )
    .bind(proposal_id)
    .fetch_optional(executor)
    .await
}

/// The Entity created by a Proposal, for idempotent decide (ADR-0025): a
/// repeated decide returns the already-created `entities.id` rather than
/// applying again. `None` when no Entity was created via this Proposal.
pub(super) async fn entity_id_for_proposal<'e, E>(
    executor: E,
    proposal_id: &str,
) -> sqlx::Result<Option<String>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_scalar(
        "SELECT entity_id FROM ( \
             SELECT id AS entity_id, created_at FROM entities WHERE created_via_proposal_id = ?1 \
             UNION ALL \
             SELECT entity_id, created_at FROM entity_revisions WHERE proposal_id = ?1 \
         ) ORDER BY created_at DESC LIMIT 1",
    )
    .bind(proposal_id)
    .fetch_optional(executor)
    .await
}

/// Accept a Proposal (ADR-0016, ADR-0025): flip the `proposals` row to
/// `accepted`, stamping `decided_by`/`decided_at`/`applied_at`/idempotency key
/// and the `edited_payload` (NULL for an unedited accept). Runs in the apply tx.
///
/// SELF-GUARDING: the `WHERE … AND status = 'pending'` clause is the single
/// concurrency choke — exactly one of two racing decides matches a still-pending
/// row. Returns the affected row count so the caller asserts `== 1` and rolls
/// back the loser, so a Proposal is never applied twice.
pub(super) async fn mark_proposal_accepted<'e, E>(
    executor: E,
    proposal_id: &str,
    edited_payload: Option<&str>,
    decision_idempotency_key: Option<&str>,
    now_ms: i64,
) -> sqlx::Result<u64>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE proposals SET status = 'accepted', decided_by = 'user', \
         decided_at = ?, applied_at = ?, edited_payload = ?, \
         decision_idempotency_key = ? WHERE id = ? AND status = 'pending'",
    )
    .bind(now_ms)
    .bind(now_ms)
    .bind(edited_payload)
    .bind(decision_idempotency_key)
    .bind(proposal_id)
    .execute(executor)
    .await
    .map(|r| r.rows_affected())
}

/// Reject a Proposal (ADR-0025): flip the `proposals` row to `rejected`,
/// stamping `decided_by`/`decided_at`. Runs in the reject tx. No `applied_at`/
/// `edited_payload` — reject applies nothing.
///
/// SELF-GUARDING (mirrors [`mark_proposal_accepted`]): the
/// `WHERE … AND status = 'pending'` clause is the single concurrency choke.
/// Returns the affected row count so the caller asserts `== 1` and rolls back
/// the loser, so a Proposal is never decided twice.
pub(super) async fn mark_proposal_rejected<'e, E>(
    executor: E,
    proposal_id: &str,
    decision_idempotency_key: Option<&str>,
    now_ms: i64,
) -> sqlx::Result<u64>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE proposals SET status = 'rejected', decided_by = 'user', \
         decided_at = ?, decision_idempotency_key = ? \
         WHERE id = ? AND status = 'pending'",
    )
    .bind(now_ms)
    .bind(decision_idempotency_key)
    .bind(proposal_id)
    .execute(executor)
    .await
    .map(|r| r.rows_affected())
}

// ─── entities + entity_revisions (ADR-0004) ───────────────────────────

/// Read every accepted Entity of `entity_type` for `entity/list`, newest-first.
/// Returns raw `(id, type, data, created_at, updated_at)` rows.
pub(super) async fn list_by_type<'e, E>(
    executor: E,
    entity_type: &str,
) -> sqlx::Result<Vec<(String, String, String, i64, i64)>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as(
        "SELECT id, type, data, created_at, updated_at \
         FROM entities WHERE type = ?1 ORDER BY created_at DESC",
    )
    .bind(entity_type)
    .fetch_all(executor)
    .await
}

/// Read one accepted Journal Entry's current snapshot by id from the canonical
/// `entities` row. `None` when the id does not exist or is not a journal entry.
pub(super) async fn current_journal_entry_by_id<'e, E>(
    executor: E,
    entity_id: &str,
) -> sqlx::Result<Option<(String, String)>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as("SELECT id, data FROM entities WHERE id = ?1 AND type = 'journal_entry'")
        .bind(entity_id)
        .fetch_optional(executor)
        .await
}

/// Read accepted Journal Entries created from the current Run's Thread. Returns
/// `(entity_id, latest_revision_data)` ordered by latest revision, newest-first.
pub(super) async fn current_thread_journal_entries<'e, E>(
    executor: E,
    run_id: Uuid,
) -> sqlx::Result<Vec<(String, String)>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as(
        "WITH latest_revisions AS ( \
             SELECT entity_id, data, created_at, seq, \
                    ROW_NUMBER() OVER ( \
                        PARTITION BY entity_id ORDER BY created_at DESC, seq DESC \
                    ) AS rn \
             FROM entity_revisions \
         ) \
         SELECT e.id, lr.data \
         FROM entities e \
         JOIN latest_revisions lr ON lr.entity_id = e.id AND lr.rn = 1 \
         WHERE e.type = 'journal_entry' \
           AND EXISTS ( \
               SELECT 1 \
               FROM runs current_run \
               JOIN messages source_message \
                 ON source_message.thread_id = current_run.thread_id \
               JOIN entity_sources source \
                 ON source.source_message_id = source_message.id \
               WHERE current_run.id = ?1 \
                 AND source.entity_id = e.id \
                 AND source.relation = 'created_from' \
                 AND source_message.role = 'user' \
           ) \
         ORDER BY lr.created_at DESC, lr.seq DESC, e.id DESC",
    )
    .bind(run_id.to_string())
    .fetch_all(executor)
    .await
}

/// Insert a freshly-created Entity (ADR-0004): `created_by='proposal'` with the
/// originating `created_via_proposal_id`. Runs inside the apply tx.
#[allow(clippy::too_many_arguments)]
pub(super) async fn insert_entity<'e, E>(
    executor: E,
    id: &str,
    entity_type: &str,
    schema_version: i64,
    data: &str,
    created_via_proposal_id: &str,
    now_ms: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO entities \
         (id, type, schema_version, data, created_by, created_via_proposal_id, \
          created_at, updated_at) \
         VALUES (?, ?, ?, ?, 'proposal', ?, ?, ?)",
    )
    .bind(id)
    .bind(entity_type)
    .bind(schema_version)
    .bind(data)
    .bind(created_via_proposal_id)
    .bind(now_ms)
    .bind(now_ms)
    .execute(executor)
    .await
    .map(|_| ())
}

/// Insert an Entity's revision (ADR-0004); a fresh Entity gets `seq=1`. Runs
/// inside the apply tx.
pub(super) async fn insert_entity_revision<'e, E>(
    executor: E,
    entity_id: &str,
    seq: i64,
    data: &str,
    proposal_id: &str,
    now_ms: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO entity_revisions (entity_id, seq, data, proposal_id, created_at) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(entity_id)
    .bind(seq)
    .bind(data)
    .bind(proposal_id)
    .bind(now_ms)
    .execute(executor)
    .await
    .map(|_| ())
}

pub(super) async fn next_entity_revision_seq<'e, E>(
    executor: E,
    entity_id: &str,
) -> sqlx::Result<i64>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_scalar(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM entity_revisions WHERE entity_id = ?1",
    )
    .bind(entity_id)
    .fetch_one(executor)
    .await
}

pub(super) async fn update_entity<'e, E>(
    executor: E,
    entity_id: &str,
    schema_version: i64,
    data: &str,
    now_ms: i64,
) -> sqlx::Result<u64>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE entities SET schema_version = ?, data = ?, updated_at = ? \
         WHERE id = ? AND type = 'journal_entry'",
    )
    .bind(schema_version)
    .bind(data)
    .bind(now_ms)
    .bind(entity_id)
    .execute(executor)
    .await
    .map(|r| r.rows_affected())
}

pub(super) async fn user_message_id_for_run<'e, E>(
    executor: E,
    run_id: Uuid,
) -> sqlx::Result<String>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_scalar("SELECT user_message_id FROM runs WHERE id = ?1")
        .bind(run_id.to_string())
        .fetch_one(executor)
        .await
}

pub(super) async fn insert_entity_source_from_message<'e, E>(
    executor: E,
    id: &str,
    entity_id: &str,
    source_message_id: &str,
    relation: &str,
    now_ms: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO entity_sources \
         (id, entity_id, source_message_id, relation, created_at) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(entity_id)
    .bind(source_message_id)
    .bind(relation)
    .bind(now_ms)
    .execute(executor)
    .await
    .map(|_| ())
}

pub(super) async fn journal_entry_target_is_valid<'e, E>(
    executor: E,
    run_id: Uuid,
    entity_id: &str,
) -> sqlx::Result<bool>
where
    E: Executor<'e, Database = Sqlite>,
{
    let row: Option<i64> = sqlx::query_scalar(
        "SELECT 1 \
         FROM entities e \
         JOIN entity_sources source \
           ON source.entity_id = e.id \
          AND source.relation = 'created_from' \
         JOIN messages source_message \
           ON source_message.id = source.source_message_id \
         JOIN runs current_run \
           ON current_run.id = ?2 \
         WHERE e.id = ?1 \
           AND e.type = 'journal_entry' \
           AND source_message.role = 'user' \
           AND source_message.thread_id = current_run.thread_id \
         LIMIT 1",
    )
    .bind(entity_id)
    .bind(run_id.to_string())
    .fetch_optional(executor)
    .await?;
    Ok(row.is_some())
}

pub(super) async fn entity_ref_belongs_to_source<'e, E>(
    executor: E,
    source_entity_id: &str,
    ref_id: &str,
) -> sqlx::Result<bool>
where
    E: Executor<'e, Database = Sqlite>,
{
    let row: Option<i64> = sqlx::query_scalar(
        "SELECT 1 \
         FROM entity_refs \
         WHERE id = ?1 \
           AND source_entity_id = ?2 \
         LIMIT 1",
    )
    .bind(ref_id)
    .bind(source_entity_id)
    .fetch_optional(executor)
    .await?;
    Ok(row.is_some())
}

pub(super) async fn delete_entity<'e, E>(executor: E, entity_id: &str) -> sqlx::Result<u64>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query("DELETE FROM entities WHERE id = ?1 AND type = 'journal_entry'")
        .bind(entity_id)
        .execute(executor)
        .await
        .map(|r| r.rows_affected())
}

/// Flip a parked Run back to `running` on resume (ADR-0025), clearing the
/// `awaiting_tool_call_id` waitpoint. The reverse of [`mark_run_parked`].
///
/// SELF-GUARDING: the `WHERE … AND status = 'parked'` clause is the single
/// concurrency choke for resume — only one of two racing resumes matches a
/// still-parked row. Returns the affected row count so the caller asserts
/// `== 1` and bails on 0 rather than spawning a second resume Worker.
pub(super) async fn mark_run_running<'e, E>(executor: E, run_id: Uuid) -> sqlx::Result<u64>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE runs SET status = 'running', awaiting_tool_call_id = NULL \
         WHERE id = ? AND status = 'parked'",
    )
    .bind(run_id.to_string())
    .execute(executor)
    .await
    .map(|r| r.rows_affected())
}

/// Cancel a parked Run (ADR-0014): flip `runs` to `cancelled` with
/// `terminal_reason='cancelled'` + `ended_at`. SELF-GUARDING on
/// `status='parked'`: if no longer parked this affects 0 rows and the caller's
/// tx rolls back. Returns the affected row count.
pub(super) async fn mark_parked_run_cancelled<'e, E>(
    executor: E,
    run_id: Uuid,
    terminal_reason: &str,
    ended_at: i64,
) -> sqlx::Result<u64>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE runs SET status = 'cancelled', terminal_reason = ?, \
         ended_at = ? WHERE id = ? AND status = 'parked'",
    )
    .bind(terminal_reason)
    .bind(ended_at)
    .bind(run_id.to_string())
    .execute(executor)
    .await
    .map(|r| r.rows_affected())
}

/// Cancel a pending Proposal (ADR-0014): flip `pending` to `cancelled`. Runs in
/// the cancel tx alongside [`mark_parked_run_cancelled`]. Returns the affected
/// row count so the caller rolls back if a concurrent decide already moved it.
pub(super) async fn mark_proposal_cancelled<'e, E>(
    executor: E,
    proposal_id: &str,
) -> sqlx::Result<u64>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE proposals SET status = 'cancelled' \
         WHERE id = ? AND status = 'pending'",
    )
    .bind(proposal_id)
    .execute(executor)
    .await
    .map(|r| r.rows_affected())
}

/// Read the Run's assistant Message id (the seq-0 row resume appends into).
/// `None` when the Run has no assistant message.
pub(super) async fn assistant_message_id_for_run<'e, E>(
    executor: E,
    run_id: Uuid,
) -> sqlx::Result<Option<String>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_scalar(
        "SELECT id FROM messages WHERE run_id = ?1 AND role = 'assistant' \
         ORDER BY created_at, rowid LIMIT 1",
    )
    .bind(run_id.to_string())
    .fetch_optional(executor)
    .await
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

/// Read a Thread's Messages for `thread/get`, chronological. Returns
/// `(id, role, status, run_id)` rows. Ordered by `created_at, rowid`: the
/// `rowid` tiebreaker keeps the user Message ahead of the assistant Message
/// when both are inserted in the same ms.
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

/// The `completed` Messages of a Thread belonging to Runs other than
/// `exclude_run_id`, oldest-first. Backs the multi-turn manifest history
/// (ADR-0018): excluding the current Run yields strictly the prior exchange,
/// and `completed` drops in-flight or errored partial assistant text. Returns
/// `(id, role)` rows.
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
) -> sqlx::Result<u64>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE message_parts SET text = text || ?1 \
         WHERE message_id = ?2 AND seq = ?3 \
         AND EXISTS (SELECT 1 FROM messages m \
                     WHERE m.id = message_parts.message_id \
                     AND m.status = 'streaming')",
    )
    .bind(delta)
    .bind(message_id.to_string())
    .bind(seq)
    .execute(executor)
    .await
    .map(|r| r.rows_affected())
}

/// Read a Message's text parts for `thread/get`, ordered by `seq`. The handler
/// concatenates them into the Message's wire text (ADR-0017). MVP has one part
/// at `seq=0`, but the concat handles multi-part too.
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
/// cumulative `message_parts.text` at `seq=0` plus the Run's `status`. Returns
/// `None` when the Run does not exist. Text is `Some("")` once streaming begins
/// but no delta is persisted; the outer `None` means no assistant part row.
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

/// The next `run_steps.seq` for a Run (`MAX(seq)+1`, or 0 for the first). The
/// initial run inserts user/assistant message steps at seq 0/1, so the first
/// tool-call step lands at seq 2.
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

/// Insert a `pending` `tool_calls` row with its request payload. `id` is the
/// Worker-assigned `tool_call_id` (a string, not necessarily a UUID). Resolved
/// later by [`resolve_tool_call`].
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

/// Resolve a `tool_calls` row with its result payload and time. `status` is the
/// terminal tool-call status (`completed` or `errored`).
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

/// Read a Run's ordered timeline for resume transcript reconstruction
/// (ADR-0025): every `run_steps` row in `seq` order, joined to the message role
/// or the tool call's name/payloads per step kind. Returns `(kind, message_id,
/// role, tool_call_id, tc_name, request_payload, result_payload)` tuples; the
/// caller assembles message text from parts separately.
#[allow(clippy::type_complexity)]
pub(super) async fn run_timeline<'e, E>(
    executor: E,
    run_id: Uuid,
) -> sqlx::Result<
    Vec<(
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    )>,
>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as(
        "SELECT rs.kind, rs.message_id, m.role, rs.tool_call_id, \
                tc.name, tc.request_payload, tc.result_payload \
         FROM run_steps rs \
         LEFT JOIN messages m ON m.id = rs.message_id \
         LEFT JOIN tool_calls tc ON tc.id = rs.tool_call_id \
         WHERE rs.run_id = ?1 \
         ORDER BY rs.seq",
    )
    .bind(run_id.to_string())
    .fetch_all(executor)
    .await
}

// ─── proposals (ADR-0025) ─────────────────────────────────────────────

/// Insert a `pending` `proposals` row, sidecar to the Proposal's `tool_calls`
/// row. The proposed payload and rationale stay on the tool_call's
/// `request_payload`, so this row carries only lifecycle columns.
pub(super) async fn insert_proposal<'e, E>(
    executor: E,
    id: &str,
    tool_call_id: &str,
    mutation_kind: &str,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO proposals (id, tool_call_id, mutation_kind, status) \
         VALUES (?, ?, ?, 'pending')",
    )
    .bind(id)
    .bind(tool_call_id)
    .bind(mutation_kind)
    .execute(executor)
    .await
    .map(|_| ())
}

/// A Run's pending Proposal for `proposal/get` (ADR-0025): `(id, mutation_kind,
/// status, request_payload)`, the payload carrying the proposed payload and
/// rationale. `None` when the Run has no pending Proposal.
pub(super) async fn pending_proposal_for_run<'e, E>(
    executor: E,
    run_id: Uuid,
) -> sqlx::Result<Option<(String, String, String, String)>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as(
        "SELECT p.id, p.mutation_kind, p.status, tc.request_payload \
         FROM proposals p \
         JOIN tool_calls tc ON tc.id = p.tool_call_id \
         WHERE tc.run_id = ?1 AND p.status = 'pending' \
         ORDER BY tc.requested_at DESC LIMIT 1",
    )
    .bind(run_id.to_string())
    .fetch_optional(executor)
    .await
}

// ─── run_log ──────────────────────────────────────────────────────────

pub(super) async fn next_run_seq<'e, E>(executor: E, run_id: Uuid) -> sqlx::Result<i64>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_scalar("SELECT COALESCE(MAX(run_seq), -1) + 1 FROM run_log WHERE run_id = ?")
        .bind(run_id.to_string())
        .fetch_one(executor)
        .await
}

pub(super) async fn insert_run_log_entry<'e, E>(
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
        "INSERT INTO run_log (run_id, run_seq, kind, payload, created_at) \
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

/// Read a user setting's value by key (ADR-0024). `None` when the key is unset.
pub(super) async fn get_setting<'e, E>(executor: E, key: &str) -> sqlx::Result<Option<String>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_scalar("SELECT value FROM settings WHERE key = ?1")
        .bind(key)
        .fetch_optional(executor)
        .await
}

/// Upsert a user setting (ADR-0024): insert-or-replace keyed by `key`.
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
