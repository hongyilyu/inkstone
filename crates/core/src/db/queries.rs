//! Every tier-2 SQL string, exactly once. Each function takes a sqlx executor
//! and runs one statement — no business rules, no orchestration. `pub(super)`
//! scopes the surface to the `db` module.

use sqlx::{Executor, QueryBuilder, Sqlite};
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
    thinking_level: &str,
    user_message_id: Uuid,
    started_at: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO runs \
         (id, thread_id, workflow_name, workflow_version, provider, model, \
          thinking_level, user_message_id, status, started_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)",
    )
    .bind(run_id.to_string())
    .bind(thread_id.to_string())
    .bind(workflow_name)
    .bind(workflow_version)
    .bind(provider)
    .bind(model)
    .bind(thinking_level)
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

/// Companion to [`recover_interrupted_runs`]: append an `error` Run Log milestone
/// for every Run the sweep just errored, so the durable record carries a terminal
/// row (the bulk recovery `UPDATE` is the lone status change outside the typed
/// `fail()` verb, which is the usual `run_log::append` site). Without this a
/// crash-recovered Run's latest milestone stays `running`, and `run/get_history`
/// would surface it as Running forever. Scoped to this boot's swept set via
/// `ended_at = ?` (every swept Run shares this boot's `now_ms`); the per-Run
/// `run_seq` is the correlated `MAX(run_seq)+1`, matching `next_run_seq`.
pub(super) async fn append_recovered_error_events<'e, E>(
    executor: E,
    error_message: &str,
    ended_at: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    let payload =
        serde_json::json!({ "code": "core_restarted", "message": error_message }).to_string();
    sqlx::query(
        "INSERT INTO run_log (run_id, run_seq, kind, payload, created_at) \
         SELECT r.id, \
                COALESCE((SELECT MAX(run_seq) FROM run_log WHERE run_id = r.id), -1) + 1, \
                'error', ?, ? \
         FROM runs r \
         WHERE r.status = 'errored' \
           AND r.terminal_reason = 'core_restarted' \
           AND r.ended_at = ?",
    )
    .bind(payload)
    .bind(ended_at)
    .bind(ended_at)
    .execute(executor)
    .await
    .map(|_| ())
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

pub(super) async fn entity_type_by_id<'e, E>(
    executor: E,
    entity_id: &str,
) -> sqlx::Result<Option<String>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_scalar("SELECT type FROM entities WHERE id = ?1")
        .bind(entity_id)
        .fetch_optional(executor)
        .await
}

pub(super) async fn entity_refs_for_sources<'e, E>(
    executor: E,
    source_entity_ids: &[String],
) -> sqlx::Result<Vec<(String, String, String, String, String, Option<String>)>>
where
    E: Executor<'e, Database = Sqlite>,
{
    if source_entity_ids.is_empty() {
        return Ok(Vec::new());
    }

    let mut query = QueryBuilder::<Sqlite>::new(
        "SELECT er.id, er.source_entity_id, er.target_entity_id, \
                target.type, target.data, er.label_snapshot \
         FROM entity_refs er \
         JOIN entities target ON target.id = er.target_entity_id \
         WHERE er.source_entity_id IN (",
    );
    let mut separated = query.separated(", ");
    for source_entity_id in source_entity_ids {
        separated.push_bind(source_entity_id);
    }
    separated.push_unseparated(
        ") AND target.type IN ('person', 'project', 'todo') \
         ORDER BY er.source_entity_id, er.created_at, er.id",
    );

    query.build_query_as().fetch_all(executor).await
}

/// Resolve the **origin** Entity Source (`created_from`) for a batch of Entities,
/// for the "Captured from" provenance read (ADR-0030). Returns one row per
/// Entity that HAS a `created_from` source, carrying both possible source shapes
/// (the schema's CHECK guarantees exactly one is non-NULL):
///
/// - a user Message source → its `thread_id` + the Thread `title` (resolved
///   through `messages`→`threads`), so the Client can link back to the Thread;
/// - a source-Entity (Journal Entry) source → its `source_entity_id`.
///
/// `created_from` is the ORIGIN relation — `updated_from` rows (a later proposal
/// edit) are excluded, so this answers "why does this Entity exist?", not "what
/// last touched it". An Entity may carry more than one `created_from` in the
/// long-term cross-Thread model (ADR-0030), so rows are ordered oldest-first and
/// the caller keeps the first per Entity (the true origin). Entities with no
/// `created_from` (user-authored, direct Library writes) simply return no row.
pub(super) async fn provenance_for_entities<'e, E>(
    executor: E,
    entity_ids: &[String],
) -> sqlx::Result<Vec<(String, Option<String>, Option<String>, Option<String>)>>
where
    E: Executor<'e, Database = Sqlite>,
{
    if entity_ids.is_empty() {
        return Ok(Vec::new());
    }

    let mut query = QueryBuilder::<Sqlite>::new(
        "SELECT source.entity_id, source.source_entity_id, \
                source_message.thread_id, source_thread.title \
         FROM entity_sources source \
         LEFT JOIN messages source_message \
           ON source_message.id = source.source_message_id \
         LEFT JOIN threads source_thread \
           ON source_thread.id = source_message.thread_id \
         WHERE source.relation = 'created_from' \
           AND source.entity_id IN (",
    );
    let mut separated = query.separated(", ");
    for entity_id in entity_ids {
        separated.push_bind(entity_id);
    }
    separated.push_unseparated(") ORDER BY source.entity_id, source.created_at, source.id");

    query.build_query_as().fetch_all(executor).await
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

pub(super) async fn journal_entry_refs_targeting<'e, E>(
    executor: E,
    target_entity_id: &str,
) -> sqlx::Result<Vec<(String, String, String, String)>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as(
        "SELECT er.id, er.source_entity_id, source.data, \
                COALESCE( \
                    er.label_snapshot, \
                    CASE target.type \
                        WHEN 'person' THEN json_extract(target.data, '$.name') \
                        WHEN 'project' THEN json_extract(target.data, '$.name') \
                        WHEN 'todo' THEN json_extract(target.data, '$.title') \
                    END, \
                    'Referenced entity' \
                ) AS label \
         FROM entity_refs er \
         JOIN entities source \
           ON source.id = er.source_entity_id \
          AND source.type = 'journal_entry' \
         JOIN entities target \
           ON target.id = er.target_entity_id \
         WHERE er.target_entity_id = ?1 \
         ORDER BY er.source_entity_id, er.created_at, er.id",
    )
    .bind(target_entity_id)
    .fetch_all(executor)
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

/// Insert a freshly-created Entity (ADR-0004), runs inside the apply tx.
/// `created_by` is the origin marker (`'proposal'` for an accepted Proposal,
/// `'user'` for a direct Library write); `created_via_proposal_id` is the
/// proposal id for the proposal path and `None` for the user path (the schema's
/// CHECK exempts `created_by='user'` rows from carrying one).
#[allow(clippy::too_many_arguments)]
pub(super) async fn insert_entity<'e, E>(
    executor: E,
    id: &str,
    entity_type: &str,
    schema_version: i64,
    data: &str,
    created_by: &str,
    created_via_proposal_id: Option<&str>,
    now_ms: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO entities \
         (id, type, schema_version, data, created_by, created_via_proposal_id, \
          created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(entity_type)
    .bind(schema_version)
    .bind(data)
    .bind(created_by)
    .bind(created_via_proposal_id)
    .bind(now_ms)
    .bind(now_ms)
    .execute(executor)
    .await
    .map(|_| ())
}

/// Insert an Entity's revision (ADR-0004); a fresh Entity gets `seq=1`. Runs
/// inside the apply tx. `proposal_id` is `Some` for a proposal-born revision and
/// `None` for a direct user edit (the column is nullable, ADR-0017/0033).
pub(super) async fn insert_entity_revision<'e, E>(
    executor: E,
    entity_id: &str,
    seq: i64,
    data: &str,
    proposal_id: Option<&str>,
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
    entity_type: &str,
    schema_version: i64,
    data: &str,
    now_ms: i64,
) -> sqlx::Result<u64>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE entities SET schema_version = ?, data = ?, updated_at = ? \
         WHERE id = ? AND type = ?",
    )
    .bind(schema_version)
    .bind(data)
    .bind(now_ms)
    .bind(entity_id)
    .bind(entity_type)
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

/// Insert an EntitySource row pointing at a SOURCE ENTITY (ADR-0030): used when a
/// create carries a `source_journal_entry_id`, so the new Entity is `created_from`
/// that Journal Entry. `source_message_id` is left NULL — the schema's CHECK
/// requires exactly one of `source_entity_id`/`source_message_id`. Mirrors
/// [`insert_entity_source_from_message`].
pub(super) async fn insert_entity_source_from_entity<'e, E>(
    executor: E,
    id: &str,
    entity_id: &str,
    source_entity_id: &str,
    relation: &str,
    now_ms: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO entity_sources \
         (id, entity_id, source_entity_id, relation, created_at) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(entity_id)
    .bind(source_entity_id)
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

pub(super) async fn entity_is_type<'e, E>(
    executor: E,
    entity_id: &str,
    entity_type: &str,
) -> sqlx::Result<bool>
where
    E: Executor<'e, Database = Sqlite>,
{
    let row: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM entities WHERE id = ?1 AND type = ?2 LIMIT 1")
            .bind(entity_id)
            .bind(entity_type)
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

pub(super) async fn entity_ref_id_for_source_target<'e, E>(
    executor: E,
    source_entity_id: &str,
    target_entity_id: &str,
) -> sqlx::Result<Option<String>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_scalar(
        "SELECT id FROM entity_refs \
         WHERE source_entity_id = ?1 AND target_entity_id = ?2 \
         LIMIT 1",
    )
    .bind(source_entity_id)
    .bind(target_entity_id)
    .fetch_optional(executor)
    .await
}

pub(super) async fn insert_entity_ref<'e, E>(
    executor: E,
    id: &str,
    source_entity_id: &str,
    target_entity_id: &str,
    label_snapshot: Option<&str>,
    now_ms: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO entity_refs \
         (id, source_entity_id, target_entity_id, label_snapshot, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT(source_entity_id, target_entity_id) DO NOTHING",
    )
    .bind(id)
    .bind(source_entity_id)
    .bind(target_entity_id)
    .bind(label_snapshot)
    .bind(now_ms)
    .execute(executor)
    .await
    .map(|_| ())
}

/// Insert one Todo Person Reference (ADR-0031). The caller de-dups per
/// `(todo_id, person_id)` in Rust before inserting (waiting_on wins), so this is
/// a plain INSERT; the `(todo_id, person_id)` PRIMARY KEY is the backstop. Runs
/// inside the apply tx.
pub(super) async fn insert_todo_person_ref<'e, E>(
    executor: E,
    todo_id: &str,
    person_id: &str,
    role: &str,
    now_ms: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO todo_person_refs \
         (todo_id, person_id, role, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(todo_id)
    .bind(person_id)
    .bind(role)
    .bind(now_ms)
    .bind(now_ms)
    .execute(executor)
    .await
    .map(|_| ())
}

/// Upsert one Todo Person Reference (ADR-0031), for `update_todo`'s
/// `add_person_refs`: insert the `(todo_id, person_id, role)`, or on a
/// `(todo_id, person_id)` conflict update the role with `waiting_on` winning —
/// a stored `waiting_on` is NEVER downgraded to `related`, but a stored `related`
/// upgrades to an incoming `waiting_on` (ADR-0031: `waiting_on` includes related
/// semantics). Runs inside the apply tx.
pub(super) async fn upsert_todo_person_ref<'e, E>(
    executor: E,
    todo_id: &str,
    person_id: &str,
    role: &str,
    now_ms: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO todo_person_refs \
         (todo_id, person_id, role, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT(todo_id, person_id) DO UPDATE SET \
         role = CASE WHEN todo_person_refs.role = 'waiting_on' THEN 'waiting_on' ELSE excluded.role END, \
         updated_at = excluded.updated_at",
    )
    .bind(todo_id)
    .bind(person_id)
    .bind(role)
    .bind(now_ms)
    .bind(now_ms)
    .execute(executor)
    .await
    .map(|_| ())
}

/// Delete EVERY Todo Person Reference for a Todo (ADR-0031), backing
/// `update_todo`'s `set_person_refs` full replace. Runs inside the apply tx.
pub(super) async fn delete_all_todo_person_refs<'e, E>(
    executor: E,
    todo_id: &str,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query("DELETE FROM todo_person_refs WHERE todo_id = ?1")
        .bind(todo_id)
        .execute(executor)
        .await
        .map(|_| ())
}

/// Delete one Todo Person Reference by `(todo_id, person_id)` (ADR-0031),
/// backing `update_todo`'s `remove_person_ids`. A missing pair is a no-op. Runs
/// inside the apply tx.
pub(super) async fn delete_todo_person_ref<'e, E>(
    executor: E,
    todo_id: &str,
    person_id: &str,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query("DELETE FROM todo_person_refs WHERE todo_id = ?1 AND person_id = ?2")
        .bind(todo_id)
        .bind(person_id)
        .execute(executor)
        .await
        .map(|_| ())
}

/// Read a Todo's current `data` JSON by id (ADR-0031), for `update_todo`'s
/// partial merge. `None` when the id does not exist or is not a `todo`. Runs
/// inside the apply tx (the merge must see committed state under the tx).
pub(super) async fn current_todo_data<'e, E>(
    executor: E,
    todo_id: &str,
) -> sqlx::Result<Option<String>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_scalar("SELECT data FROM entities WHERE id = ?1 AND type = 'todo'")
        .bind(todo_id)
        .fetch_optional(executor)
        .await
}

/// Read a Project's current `data` JSON by id (ADR-0034), for
/// `mark_project_reviewed`'s read-modify-write. `None` when the id does not exist
/// or is not a `project`. Runs inside the apply tx (the recompute must see
/// committed state under the tx).
pub(super) async fn current_project_data<'e, E>(
    executor: E,
    project_id: &str,
) -> sqlx::Result<Option<String>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_scalar("SELECT data FROM entities WHERE id = ?1 AND type = 'project'")
        .bind(project_id)
        .fetch_optional(executor)
        .await
}

/// Read every Todo that owns `project_id` (its `data.project_id` matches), for
/// the `delete_project` cascade (ADR-0031). Returns `(todo_id, data)` rows so the
/// caller can rewrite each Todo's JSON with `project_id` unset. `project_id`
/// lives in the Todo JSON (not an FK column), so this is matched via SQLite's
/// `json_extract`. Runs inside the apply tx.
pub(super) async fn todos_with_project<'e, E>(
    executor: E,
    project_id: &str,
) -> sqlx::Result<Vec<(String, String)>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as(
        "SELECT id, data FROM entities \
         WHERE type = 'todo' AND json_extract(data, '$.project_id') = ?1",
    )
    .bind(project_id)
    .fetch_all(executor)
    .await
}

/// Read every Todo owned by `project_id` as full `(id, data, created_at,
/// updated_at)` rows for the relationship read (`todos_by_project`), newest
/// first. Distinct from [`todos_with_project`], which returns only `(id, data)`
/// for the delete-cascade rewrite.
pub(super) async fn todos_by_project<'e, E>(
    executor: E,
    project_id: &str,
) -> sqlx::Result<Vec<(String, String, i64, i64)>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as(
        "SELECT id, data, created_at, updated_at FROM entities \
         WHERE type = 'todo' AND json_extract(data, '$.project_id') = ?1 \
         ORDER BY created_at DESC",
    )
    .bind(project_id)
    .fetch_all(executor)
    .await
}

/// Read every Todo linked to `person_id` via `todo_person_refs` (ADR-0031),
/// optionally filtered to `role`. Returns `(id, type, data, created_at,
/// updated_at)` rows like [`list_by_type`], newest-first. Core-internal V0 read
/// layer (Slice 11); V1 wires it to client APIs.
#[allow(dead_code)]
pub(super) async fn todos_by_person<'e, E>(
    executor: E,
    person_id: &str,
    role: Option<&str>,
) -> sqlx::Result<Vec<(String, String, String, i64, i64)>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as(
        "SELECT e.id, e.type, e.data, e.created_at, e.updated_at \
         FROM entities e \
         JOIN todo_person_refs r ON r.todo_id = e.id \
         WHERE e.type = 'todo' AND r.person_id = ?1 \
           AND (?2 IS NULL OR r.role = ?2) \
         ORDER BY e.created_at DESC",
    )
    .bind(person_id)
    .bind(role)
    .fetch_all(executor)
    .await
}

/// Read every Todo Person Reference on `todo_id` (ADR-0031) as `(person_id,
/// role)` pairs. Used by the recurrence successor-spawn (ADR-0039) to carry the
/// completed Todo's People forward onto its next occurrence.
pub(super) async fn person_refs_by_todo<'e, E>(
    executor: E,
    todo_id: &str,
) -> sqlx::Result<Vec<(String, String)>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as("SELECT person_id, role FROM todo_person_refs WHERE todo_id = ?1")
        .bind(todo_id)
        .fetch_all(executor)
        .await
}

/// Batch-read Todo Person References for many Todos at once (ADR-0032), returned
/// as `(todo_id, person_id, role)` rows so the caller can group by Todo. Mirrors
/// [`entity_refs_for_sources`]'s IN-clause shape to avoid an N+1 on the
/// `entity/list` read path. Ordered by `(todo_id, created_at, person_id)` for a
/// stable per-Todo ref order.
pub(super) async fn person_refs_for_todos<'e, E>(
    executor: E,
    todo_ids: &[String],
) -> sqlx::Result<Vec<(String, String, String)>>
where
    E: Executor<'e, Database = Sqlite>,
{
    if todo_ids.is_empty() {
        return Ok(Vec::new());
    }

    let mut query = QueryBuilder::<Sqlite>::new(
        "SELECT todo_id, person_id, role FROM todo_person_refs WHERE todo_id IN (",
    );
    let mut separated = query.separated(", ");
    for todo_id in todo_ids {
        separated.push_bind(todo_id);
    }
    separated.push_unseparated(") ORDER BY todo_id, created_at, person_id");

    query.build_query_as().fetch_all(executor).await
}

/// Distinct People linked to `project_id` through that Project's Todos: Project
/// -> Todos (json_extract project_id) -> `todo_person_refs` -> DISTINCT person_id
/// (ADR-0031). Core-internal V0 read layer (Slice 11).
#[allow(dead_code)]
pub(super) async fn project_people<'e, E>(
    executor: E,
    project_id: &str,
) -> sqlx::Result<Vec<String>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_scalar(
        "SELECT DISTINCT r.person_id \
         FROM entities e \
         JOIN todo_person_refs r ON r.todo_id = e.id \
         WHERE e.type = 'todo' AND json_extract(e.data, '$.project_id') = ?1 \
         ORDER BY r.person_id",
    )
    .bind(project_id)
    .fetch_all(executor)
    .await
}

/// Distinct Projects linked to `person_id` through their Todos: Person ->
/// `todo_person_refs` -> Todos -> DISTINCT json_extract project_id, excluding
/// Todos with no project (ADR-0031). Core-internal V0 read layer (Slice 11).
#[allow(dead_code)]
pub(super) async fn person_projects<'e, E>(
    executor: E,
    person_id: &str,
) -> sqlx::Result<Vec<String>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_scalar(
        "SELECT DISTINCT json_extract(e.data, '$.project_id') AS project_id \
         FROM entities e \
         JOIN todo_person_refs r ON r.todo_id = e.id \
         WHERE e.type = 'todo' AND r.person_id = ?1 \
           AND json_extract(e.data, '$.project_id') IS NOT NULL \
         ORDER BY project_id",
    )
    .bind(person_id)
    .fetch_all(executor)
    .await
}

/// Read every reviewable Project due for review (ADR-0031): status in
/// (`active`, `on_hold`) AND a non-null `next_review_at` at-or-before `now`
/// (string compare — the wall-clock format sorts chronologically). Returns
/// `(id, type, data, created_at, updated_at)` rows like [`list_by_type`].
/// Core-internal V0 read layer (Slice 11).
#[allow(dead_code)]
pub(super) async fn projects_due_for_review<'e, E>(
    executor: E,
    now: &str,
) -> sqlx::Result<Vec<(String, String, String, i64, i64)>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as(
        "SELECT id, type, data, created_at, updated_at \
         FROM entities \
         WHERE type = 'project' \
           AND json_extract(data, '$.status') IN ('active', 'on_hold') \
           AND json_extract(data, '$.next_review_at') IS NOT NULL \
           AND json_extract(data, '$.next_review_at') <= ?1 \
         ORDER BY created_at DESC",
    )
    .bind(now)
    .fetch_all(executor)
    .await
}

/// Delete an Entity by id, guarded on its `entity_type` (the caller resolves the
/// type from the `mutation_kind`). The Entity's dependent rows — revisions,
/// sources, and a Todo's/Person's `todo_person_refs` — cascade away via their FK
/// `ON DELETE CASCADE`. Returns the affected row count so the caller asserts a
/// single deletion. Runs inside the apply tx.
pub(super) async fn delete_entity<'e, E>(
    executor: E,
    entity_id: &str,
    entity_type: &str,
) -> sqlx::Result<u64>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query("DELETE FROM entities WHERE id = ?1 AND type = ?2")
        .bind(entity_id)
        .bind(entity_type)
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

/// Read a Message's `thread_id`. `None` when no such Message exists. Used by the
/// Run-completion FTS seam to index the assistant Message into `message_fts`.
pub(super) async fn thread_id_for_message<'e, E>(
    executor: E,
    message_id: &str,
) -> sqlx::Result<Option<String>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_scalar("SELECT thread_id FROM messages WHERE id = ?1")
        .bind(message_id)
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

/// Read the Workflow fields a Run snapshotted at its start (ADR-0024): the
/// `name`/`version`/`provider`/`model`/`thinking_level` resolved post-dispatch.
/// `None` when the Run does not exist. Backs `run_workflow_snapshot`, which
/// rebuilds the effective Workflow for a resume from this snapshot rather than
/// re-resolving live settings.
pub(super) async fn select_run_workflow_snapshot<'e, E>(
    executor: E,
    run_id: Uuid,
) -> sqlx::Result<Option<(String, String, String, String, String)>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as(
        "SELECT workflow_name, workflow_version, provider, model, thinking_level \
         FROM runs WHERE id = ?1",
    )
    .bind(run_id.to_string())
    .fetch_optional(executor)
    .await
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

/// Read a Run's tool calls for `thread/get` rehydration (ADR-0043), in timeline
/// order (`run_steps.seq`). Returns `(name, status)` rows; the caller filters
/// Proposal tool calls (which render as a `ProposalCard`, not a tool-activity
/// row) and maps the persisted status to the wire status. Joined through
/// `run_steps` so the order matches the live arrival order.
pub(super) async fn tool_calls_by_run<'e, E>(
    executor: E,
    run_id: Uuid,
) -> sqlx::Result<Vec<(String, String)>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as(
        "SELECT tc.name, tc.status \
         FROM run_steps rs \
         JOIN tool_calls tc ON tc.id = rs.tool_call_id \
         WHERE rs.run_id = ?1 AND rs.kind = 'tool_call' \
         ORDER BY rs.seq",
    )
    .bind(run_id.to_string())
    .fetch_all(executor)
    .await
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

/// Read the recent-Runs feed for `run/get_history` (ADR-0028 as-built): one row
/// per Run carrying its *latest* Run Log milestone (the max-`run_seq` entry),
/// joined to its Thread title, ordered by that milestone's `created_at`
/// descending and capped at `limit`. Returns `(run_id, thread_id, title, kind,
/// at)` rows.
///
/// The latest milestone is selected with a correlated subquery on `run_seq`
/// (monotonic per Run, so MAX(run_seq) is the newest entry regardless of
/// `created_at` ties). A Run always has at least its creation `running` row, so
/// the inner join never drops a Run. `kind` is returned verbatim — Core does not
/// fold the seven Run Log kinds into the five `RunStatus` values; presentation
/// lives in the client.
pub(super) async fn list_run_history<'e, E>(
    executor: E,
    limit: i64,
) -> sqlx::Result<Vec<(String, String, String, String, i64)>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as(
        "SELECT rl.run_id, r.thread_id, t.title, rl.kind, rl.created_at \
         FROM run_log rl \
         JOIN runs r ON r.id = rl.run_id \
         JOIN threads t ON t.id = r.thread_id \
         WHERE rl.run_seq = (SELECT MAX(run_seq) FROM run_log WHERE run_id = rl.run_id) \
         ORDER BY rl.created_at DESC, rl.run_id DESC \
         LIMIT ?",
    )
    .bind(limit)
    .fetch_all(executor)
    .await
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

// ─── message_fts (tier-3 projection, ADR-0035) ─────────────────────────

/// Index one Message's text into `message_fts`. Called at the user-create seam
/// (inside the caller's tx) and per completed Message during a rebuild. The
/// columns mirror the search hit shape; only `text` is tokenized.
pub(super) async fn insert_message_fts_row<'e, E>(
    executor: E,
    message_id: &str,
    thread_id: &str,
    run_id: &str,
    role: &str,
    text: &str,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO message_fts (message_id, thread_id, run_id, role, text) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(message_id)
    .bind(thread_id)
    .bind(run_id)
    .bind(role)
    .bind(text)
    .execute(executor)
    .await
    .map(|_| ())
}

/// Wipe `message_fts` for a full rebuild (ADR-0035). The projection is tier-3,
/// re-derivable from `message_parts`, so delete-and-recreate is safe.
pub(super) async fn clear_message_fts<'e, E>(executor: E) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query("DELETE FROM message_fts")
        .execute(executor)
        .await
        .map(|_| ())
}

/// Read every `completed` Message's identity (`id, thread_id, run_id, role`) for
/// the rebuild. The caller assembles each Message's text via the canonical
/// `text_parts_by_message` concat (same path `history_for_run` uses) and indexes
/// it, keeping the projection honestly derived from tier-2 `message_parts`.
pub(super) async fn completed_messages_for_fts<'e, E>(
    executor: E,
) -> sqlx::Result<Vec<(String, String, String, String)>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as(
        "SELECT id, thread_id, run_id, role FROM messages \
         WHERE status = 'completed' ORDER BY created_at, rowid",
    )
    .fetch_all(executor)
    .await
}

/// Chars of context kept on each side of the match in a snippet (ADR-0035).
const SNIPPET_PAD: i64 = 32;

/// LIKE escape character for the substring search. Backslash is escaped along
/// with `%` and `_` so a user query is matched literally (ADR-0035).
const LIKE_ESCAPE: char = '\\';

/// Escape LIKE metacharacters (`%`, `_`) and the escape char itself so the
/// needle is matched as literal text under `LIKE ... ESCAPE '\'`.
fn escape_like(query: &str) -> String {
    let mut out = String::with_capacity(query.len());
    for c in query.chars() {
        if c == LIKE_ESCAPE || c == '%' || c == '_' {
            out.push(LIKE_ESCAPE);
        }
        out.push(c);
    }
    out
}

/// Whether the needle contains a LIKE metacharacter (`%`, `_`) or the escape
/// char (`\`), and therefore needs the `ESCAPE`-clause path. A needle with none
/// of these is matched identically with or without escaping, so it can take the
/// plain `LIKE` path that preserves the FTS5 trigram acceleration.
fn needs_like_escape(query: &str) -> bool {
    query.contains('%') || query.contains('_') || query.contains(LIKE_ESCAPE)
}

/// Substring search over `message_fts` (ADR-0035): a case-insensitive
/// `text LIKE '%' || ? || '%'` (the trigram tokenizer accelerates it, no
/// `MATCH`), joined to `threads` for the title and `messages` for `created_at`,
/// ordered newest-first. The snippet is rendered in SQL with `instr`/`substr`
/// (char-based in SQLite — no byte-slice hazard) around the first case-insensitive
/// match, keeping [`SNIPPET_PAD`] chars of context per side with `…` where trimmed.
/// Returns `(message_id, thread_id, run_id, role, snippet, thread_title,
/// created_at)`.
///
/// **Trigram-preserving escape:** SQLite disables the FTS5 trigram LIKE
/// acceleration whenever an `ESCAPE` clause is present — even for a needle with
/// nothing to escape. So we only take the LIKE-escaped path (binding
/// `escape_like(query)` under `ESCAPE '\'`) for a needle that actually contains
/// `%`/`_`/`\`; the common no-wildcard needle takes the plain `LIKE` path, which
/// is byte-identical for such needles and keeps the trigram index engaged.
///
/// A blank/whitespace-only `query` returns no hits (an empty needle would make
/// `LIKE '%%'` match the whole corpus) — guarded here so the boundary is safe
/// regardless of caller.
#[allow(clippy::type_complexity)]
pub(super) async fn search_messages<'e, E>(
    executor: E,
    query: &str,
) -> sqlx::Result<Vec<(String, String, String, String, String, String, i64)>>
where
    E: Executor<'e, Database = Sqlite>,
{
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    // The snippet/select half is identical; only the WHERE clause's escape differs.
    // `?1` needle for WHERE; `?2` raw needle (instr/substr); `?3` pad.
    const SELECT_HEAD: &str = "SELECT s.message_id, s.thread_id, s.run_id, s.role, \
                CASE WHEN s.start > 1 THEN '…' ELSE '' END \
                  || substr(s.text, s.start, (s.pos - s.start) + s.slen + ?3) \
                  || CASE WHEN s.start - 1 + ((s.pos - s.start) + s.slen + ?3) < length(s.text) \
                          THEN '…' ELSE '' END, \
                s.title, s.created_at \
         FROM ( \
           SELECT f.message_id, f.thread_id, f.run_id, f.role, f.text, \
                  t.title, m.created_at, m.rowid AS m_rowid, \
                  length(?2) AS slen, \
                  instr(lower(f.text), lower(?2)) AS pos, \
                  max(1, instr(lower(f.text), lower(?2)) - ?3) AS start \
           FROM message_fts f \
           JOIN threads t ON t.id = f.thread_id \
           JOIN messages m ON m.id = f.message_id \
           WHERE f.text LIKE '%' || ?1 || '%'";
    const SELECT_TAIL: &str = " \
         ) AS s \
         ORDER BY s.created_at DESC, s.m_rowid DESC";

    // Wildcard needle → ESCAPE path (correct literal `%`/`_`, trigram bypassed by
    // SQLite); plain needle → no ESCAPE (trigram preserved). The bound `?1` matches.
    let (sql, needle) = if needs_like_escape(query) {
        (
            format!("{SELECT_HEAD} ESCAPE '\\'{SELECT_TAIL}"),
            escape_like(query),
        )
    } else {
        (format!("{SELECT_HEAD}{SELECT_TAIL}"), query.to_string())
    };

    sqlx::query_as(&sql)
        .bind(needle)
        .bind(query)
        .bind(SNIPPET_PAD)
        .fetch_all(executor)
        .await
}
