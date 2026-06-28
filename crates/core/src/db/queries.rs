//! Every tier-2 SQL string, exactly once. Each function takes a sqlx executor
//! and runs one statement — no business rules, no orchestration. `pub(super)`
//! scopes the surface to the `db` module.

use sqlx::{Executor, QueryBuilder, Sqlite};
use uuid::Uuid;

use super::observations::{ObservationFilter, ObservationRow, ObservationSourceFilter};

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

/// Read every ACTIVE Thread for `thread/list`, most-recent-activity-first.
/// `WHERE archived_at IS NULL` excludes archived Threads (ADR-0052). Returns
/// `(id, title, last_activity_at)` rows.
pub(super) async fn list_threads<'e, E>(executor: E) -> sqlx::Result<Vec<(String, String, i64)>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as(
        "SELECT id, title, last_activity_at FROM threads \
         WHERE archived_at IS NULL ORDER BY last_activity_at DESC",
    )
    .fetch_all(executor)
    .await
}

/// Read the ARCHIVED Threads for `thread/list_archived` (ADR-0052),
/// newest-archived first (`ORDER BY archived_at DESC`). Same
/// `(id, title, last_activity_at)` tuple shape as [`list_threads`], so the
/// archived view reuses the same row consumer.
pub(super) async fn list_archived_threads<'e, E>(
    executor: E,
) -> sqlx::Result<Vec<(String, String, i64)>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as(
        "SELECT id, title, last_activity_at FROM threads \
         WHERE archived_at IS NOT NULL ORDER BY archived_at DESC",
    )
    .fetch_all(executor)
    .await
}

/// Stamp a Thread's `archived_at` (ms-epoch) to archive it (ADR-0052). Touches
/// ONLY `archived_at` — does NOT cascade to messages/runs/provenance (the whole
/// point of archive-not-delete) and does NOT bump `last_activity_at`. Mirrors
/// [`update_thread_title`]'s single-column UPDATE shape; a missing row matches
/// nothing (the verb guards existence, ADR-0052).
pub(super) async fn archive_thread<'e, E>(
    executor: E,
    thread_id: Uuid,
    now_ms: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query("UPDATE threads SET archived_at = ?2 WHERE id = ?1")
        .bind(thread_id.to_string())
        .bind(now_ms)
        .execute(executor)
        .await
        .map(|_| ())
}

/// Clear a Thread's `archived_at` to un-archive it (ADR-0052), restoring it to
/// the default `list_threads`. The inverse of [`archive_thread`].
pub(super) async fn unarchive_thread<'e, E>(executor: E, thread_id: Uuid) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query("UPDATE threads SET archived_at = NULL WHERE id = ?1")
        .bind(thread_id.to_string())
        .execute(executor)
        .await
        .map(|_| ())
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

/// Overwrite a Thread's `title` by id, unconditionally. Touches ONLY `title` —
/// NOT `last_activity_at` (titling is not activity, unlike
/// [`touch_thread_activity`]). A missing row matches nothing and is a silent
/// no-op (no error). Backs the generated-title write.
pub(super) async fn update_thread_title<'e, E>(
    executor: E,
    thread_id: Uuid,
    title: &str,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query("UPDATE threads SET title = ?2 WHERE id = ?1")
        .bind(thread_id.to_string())
        .bind(title)
        .execute(executor)
        .await
        .map(|_| ())
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

/// The Entity created or updated by a Proposal — resolved over
/// `entities.created_via_proposal_id` UNION `entity_revisions.proposal_id` for this
/// Proposal (the revision arm joins `entities` to read its `type`). Backs BOTH the
/// idempotent decide check (ADR-0025: a repeated accept returns the prior id rather
/// than re-applying) and the `thread/get` decided-proposal segment's `entity_id`
/// (ADR-0044 amendment). A single-entity create/update yields exactly one row; a
/// multi-entity `apply_intent_graph` apply mints several entities sharing one
/// `created_at`, so the resolution matches the live decide anchor deterministically:
/// it prefers the `journal_entry` row (the JE is the `apply_intent_graph` anchor —
/// see `intent_graph.rs`), then newest `created_at`, then `entity_id DESC` as a
/// stable final tiebreaker so two non-JE entities never flip between reloads.
/// `None` when no Entity was created/updated via this Proposal.
pub(super) async fn entity_id_for_proposal<'e, E>(
    executor: E,
    proposal_id: &str,
) -> sqlx::Result<Option<String>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_scalar(
        "SELECT entity_id FROM ( \
             SELECT id AS entity_id, type, created_at FROM entities \
                 WHERE created_via_proposal_id = ?1 \
             UNION ALL \
             SELECT er.entity_id, e.type, er.created_at FROM entity_revisions er \
                 JOIN entities e ON e.id = er.entity_id \
                 WHERE er.proposal_id = ?1 \
         ) ORDER BY (type = 'journal_entry') DESC, created_at DESC, entity_id DESC LIMIT 1",
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

/// Read the raw `(id, data, created_at, updated_at)` rows for a set of Journal
/// Entry ids, for the `entity/backlinks` "Mentioned in" assembly (ADR-0050). The
/// caller orders + attaches refs/source; rows come back in arbitrary order.
pub(super) async fn journal_entries_by_ids<'e, E>(
    executor: E,
    journal_entry_ids: &[String],
) -> sqlx::Result<Vec<(String, String, i64, i64)>>
where
    E: Executor<'e, Database = Sqlite>,
{
    if journal_entry_ids.is_empty() {
        return Ok(Vec::new());
    }

    let mut query = QueryBuilder::<Sqlite>::new(
        "SELECT id, data, created_at, updated_at FROM entities \
         WHERE type = 'journal_entry' AND id IN (",
    );
    let mut separated = query.separated(", ");
    for journal_entry_id in journal_entry_ids {
        separated.push_bind(journal_entry_id);
    }
    separated.push_unseparated(")");

    query.build_query_as().fetch_all(executor).await
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
///   through `messages`→`threads`), so the Client can link back to the Thread,
///   plus the capturing message `id` so it can deep-link to the exact message
///   (#184);
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
) -> sqlx::Result<Vec<(String, Option<String>, Option<String>, Option<String>, Option<String>)>>
where
    E: Executor<'e, Database = Sqlite>,
{
    if entity_ids.is_empty() {
        return Ok(Vec::new());
    }

    let mut query = QueryBuilder::<Sqlite>::new(
        "SELECT source.entity_id, source.source_entity_id, \
                source_message.thread_id, source_thread.title, source_message.id \
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

/// Read a Run's `thread_id`. `None` when no such Run exists. Backs `run/retry`'s
/// re-resolution (the Workflow is dispatched from the Run's Thread + prompt).
pub(super) async fn thread_id_for_run<'e, E>(
    executor: E,
    run_id: Uuid,
) -> sqlx::Result<Option<String>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_scalar("SELECT thread_id FROM runs WHERE id = ?1")
        .bind(run_id.to_string())
        .fetch_optional(executor)
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

#[allow(clippy::too_many_arguments)]
pub(super) async fn insert_observation<'e, E>(
    executor: E,
    id: &str,
    schema_key: &str,
    schema_version: i64,
    occurred_at: &str,
    ended_at: Option<&str>,
    values_json: &str,
    note: Option<&str>,
    created_by: &str,
    created_via_proposal_id: Option<&str>,
    now_ms: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO observations \
         (id, schema_key, schema_version, occurred_at, ended_at, values_json, note, \
          created_by, created_via_proposal_id, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(schema_key)
    .bind(schema_version)
    .bind(occurred_at)
    .bind(ended_at)
    .bind(values_json)
    .bind(note)
    .bind(created_by)
    .bind(created_via_proposal_id)
    .bind(now_ms)
    .bind(now_ms)
    .execute(executor)
    .await
    .map(|_| ())
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn insert_next_observation_revision<'e, E>(
    executor: E,
    observation_id: &str,
    schema_key: &str,
    schema_version: i64,
    occurred_at: &str,
    ended_at: Option<&str>,
    values_json: &str,
    note: Option<&str>,
    proposal_id: Option<&str>,
    now_ms: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO observation_revisions \
         (observation_id, seq, schema_key, schema_version, occurred_at, ended_at, values_json, \
          note, proposal_id, created_at) \
         VALUES ( \
           ?, \
           (SELECT COALESCE(MAX(seq), 0) + 1 FROM observation_revisions WHERE observation_id = ?), \
           ?, ?, ?, ?, ?, ?, ?, ? \
         )",
    )
    .bind(observation_id)
    .bind(observation_id)
    .bind(schema_key)
    .bind(schema_version)
    .bind(occurred_at)
    .bind(ended_at)
    .bind(values_json)
    .bind(note)
    .bind(proposal_id)
    .bind(now_ms)
    .execute(executor)
    .await
    .map(|_| ())
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn update_observation<'e, E>(
    executor: E,
    observation_id: &str,
    schema_version: i64,
    occurred_at: &str,
    ended_at: Option<&str>,
    values_json: &str,
    note: Option<&str>,
    now_ms: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE observations \
         SET schema_version = ?, occurred_at = ?, ended_at = ?, \
             values_json = ?, note = ?, updated_at = ? \
         WHERE id = ?",
    )
    .bind(schema_version)
    .bind(occurred_at)
    .bind(ended_at)
    .bind(values_json)
    .bind(note)
    .bind(now_ms)
    .bind(observation_id)
    .execute(executor)
    .await
    .map(|_| ())
}

pub(super) async fn observation_schema_key<'e, E>(
    executor: E,
    observation_id: &str,
) -> sqlx::Result<Option<String>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_scalar("SELECT schema_key FROM observations WHERE id = ?1")
        .bind(observation_id)
        .fetch_optional(executor)
        .await
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn insert_observation_source<'e, E>(
    executor: E,
    id: &str,
    observation_id: &str,
    source_entity_id: Option<&str>,
    source_message_id: Option<&str>,
    relation: &str,
    now_ms: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO observation_sources \
         (id, observation_id, source_entity_id, source_message_id, relation, created_at) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(observation_id)
    .bind(source_entity_id)
    .bind(source_message_id)
    .bind(relation)
    .bind(now_ms)
    .execute(executor)
    .await
    .map(|_| ())
}

pub(super) async fn query_observations<'e, E>(
    executor: E,
    filter: &ObservationFilter,
) -> sqlx::Result<Vec<ObservationRow>>
where
    E: Executor<'e, Database = Sqlite>,
{
    let mut query = QueryBuilder::<Sqlite>::new(
        "SELECT o.id, o.schema_key, o.schema_version, o.occurred_at, o.ended_at, \
                o.values_json, o.note, o.created_at, o.updated_at, \
                s.relation, s.source_entity_id, s.source_message_id \
         FROM observations o \
         LEFT JOIN observation_sources s ON s.observation_id = o.id \
         WHERE 1 = 1",
    );

    if !filter.schema_keys.is_empty() {
        query.push(" AND o.schema_key IN (");
        let mut separated = query.separated(", ");
        for key in &filter.schema_keys {
            separated.push_bind(key);
        }
        separated.push_unseparated(")");
    }
    if let Some(from) = &filter.from {
        query.push(" AND o.occurred_at >= ");
        query.push_bind(from);
    }
    if let Some(to) = &filter.to {
        query.push(" AND o.occurred_at <= ");
        query.push_bind(to);
    }
    if let Some(source) = &filter.source {
        match source {
            ObservationSourceFilter::JournalEntry { id } => {
                query.push(
                    " AND EXISTS ( \
                        SELECT 1 FROM observation_sources filter_source \
                        WHERE filter_source.observation_id = o.id \
                          AND filter_source.source_entity_id = ",
                );
                query.push_bind(id);
                query.push(")");
            }
            ObservationSourceFilter::Message { id } => {
                query.push(
                    " AND EXISTS ( \
                        SELECT 1 FROM observation_sources filter_source \
                        WHERE filter_source.observation_id = o.id \
                          AND filter_source.source_message_id = ",
                );
                query.push_bind(id);
                query.push(")");
            }
        }
    }
    if let Some(related_entity_id) = &filter.related_entity_id {
        query.push(
            " AND o.schema_key = 'habit.checkin' \
              AND json_extract(o.values_json, '$.habit_id') = ",
        );
        query.push_bind(related_entity_id);
    }

    query.push(" ORDER BY o.occurred_at DESC, o.created_at DESC, o.id DESC");
    if let Some(limit) = filter.limit {
        query.push(" LIMIT ");
        query.push_bind(limit);
    }

    query
        .build_query_as::<(
            String,
            String,
            i64,
            String,
            Option<String>,
            String,
            Option<String>,
            i64,
            i64,
            Option<String>,
            Option<String>,
            Option<String>,
        )>()
        .fetch_all(executor)
        .await
        .map(|rows| {
            rows.into_iter()
                .map(
                    |(
                        id,
                        schema_key,
                        schema_version,
                        occurred_at,
                        ended_at,
                        values_json,
                        note,
                        created_at,
                        updated_at,
                        source_relation,
                        source_entity_id,
                        source_message_id,
                    )| ObservationRow {
                        id,
                        schema_key,
                        schema_version,
                        occurred_at,
                        ended_at,
                        values_json,
                        note,
                        created_at,
                        updated_at,
                        source_relation,
                        source_entity_id,
                        source_message_id,
                    },
                )
                .collect()
        })
}

pub(super) async fn habit_checkin_observations_exist<'e, E>(
    executor: E,
    habit_id: &str,
) -> sqlx::Result<bool>
where
    E: Executor<'e, Database = Sqlite>,
{
    let row: Option<i64> = sqlx::query_scalar(
        "SELECT 1 \
         FROM observations \
         WHERE schema_key = 'habit.checkin' \
           AND json_extract(values_json, '$.habit_id') = ?1 \
         LIMIT 1",
    )
    .bind(habit_id)
    .fetch_optional(executor)
    .await?;
    Ok(row.is_some())
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

/// The Thread a `journal_entry` was `created_from` — the origin user Message's
/// Thread, which a re-scan Run starts in (ADR-0042). Clones the
/// [`journal_entry_target_is_valid`] join (type='journal_entry' → created_from
/// user Message) minus the current-Run guard, projecting that Message's
/// `thread_id`. `None` if `je_id` names no `journal_entry` or has no such origin.
///
/// `LIMIT 1` is deterministic, not arbitrary: a JE carries EXACTLY ONE
/// `created_from` user-Message source, written once at mint by the single writer
/// (`apply_entity_mutation` → `insert_entity_source_from_message`); no path
/// re-sources an existing JE (an `update_journal_entry` writes `updated_from`,
/// and the re-scan anchor-reuse path writes no source row for the JE). The schema
/// does not enforce this uniqueness, so a future second-`created_from` writer must
/// preserve the invariant or revisit this read — the sibling
/// [`journal_entry_target_is_valid`] guard relies on the same one-origin fact.
pub(super) async fn journal_entry_origin_thread_id<'e, E>(
    executor: E,
    je_id: &str,
) -> sqlx::Result<Option<String>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_scalar(
        "SELECT source_message.thread_id \
         FROM entities e \
         JOIN entity_sources source \
           ON source.entity_id = e.id \
          AND source.relation = 'created_from' \
         JOIN messages source_message \
           ON source_message.id = source.source_message_id \
         WHERE e.id = ?1 \
           AND e.type = 'journal_entry' \
           AND source_message.role = 'user' \
         LIMIT 1",
    )
    .bind(je_id)
    .fetch_optional(executor)
    .await
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

pub(super) async fn message_exists<'e, E>(executor: E, message_id: &str) -> sqlx::Result<bool>
where
    E: Executor<'e, Database = Sqlite>,
{
    let row: Option<i64> = sqlx::query_scalar("SELECT 1 FROM messages WHERE id = ?1 LIMIT 1")
        .bind(message_id)
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

/// Read a Person's current `data` JSON by id. `None` when the id does not exist
/// or is not a `person`. Sibling of [`current_todo_data`]/[`current_project_data`],
/// added for `proposal/get`'s `update_person` review context.
pub(super) async fn current_person_data<'e, E>(
    executor: E,
    person_id: &str,
) -> sqlx::Result<Option<String>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_scalar("SELECT data FROM entities WHERE id = ?1 AND type = 'person'")
        .bind(person_id)
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

/// Re-drive an errored Run in place (ADR-0028 retry amendment, #230): flip
/// `errored → running` and co-move the terminal fields back to live —
/// `terminal_reason`/`error_code`/`error_message`/`ended_at` all `NULL` — so the
/// Run reads as a clean live Run and the loop's `complete`/`fail`/`cancel` verbs
/// (guarded `status='running'`) re-apply on the re-driven attempt.
///
/// SELF-GUARDING on `status='errored'`: this is the legality check AND the race
/// choke (a concurrent second retry, or a boot sweep, that already moved the Run
/// matches 0 rows → `Moved::Lost`). It is NOT `mark_run_running`, which guards
/// `status='parked'` and would match 0 rows on an errored Run. Returns the
/// affected row count.
pub(super) async fn mark_errored_run_running<'e, E>(executor: E, run_id: Uuid) -> sqlx::Result<u64>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE runs SET status = 'running', terminal_reason = NULL, \
         error_code = NULL, error_message = NULL, ended_at = NULL \
         WHERE id = ? AND status = 'errored'",
    )
    .bind(run_id.to_string())
    .execute(executor)
    .await
    .map(|r| r.rows_affected())
}

/// Delete a Message's `message_parts` (run-retry, ADR-0028 amendment): the failed
/// attempt's persisted text/reasoning parts, so `select_run_snapshot`'s
/// `group_concat(text)` and `thread/get`'s segment timeline don't carry the failed
/// attempt forward. The assistant `run_steps` reference these via the composite FK
/// `(message_id, part_seq)`, so they MUST be deleted first (see
/// [`delete_run_steps`]). Runs inside the retry tx.
pub(super) async fn delete_message_parts<'e, E>(executor: E, message_id: &str) -> sqlx::Result<u64>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query("DELETE FROM message_parts WHERE message_id = ?1")
        .bind(message_id)
        .execute(executor)
        .await
        .map(|r| r.rows_affected())
}

/// Delete a Run's `run_steps` EXCEPT the steps of a kept (proposal-backed)
/// tool_call (run-retry, ADR-0028 amendment): the failed attempt's ASSISTANT
/// `message` steps (the partial text/reasoning that pollutes
/// `select_run_snapshot`'s `group_concat`) and its NON-proposal `tool_call` steps
/// are dropped, but a `tool_call` step whose `tool_call_id` has a `proposals`
/// sidecar is KEPT — that step is a prior DECIDED proposal's committed history and
/// must still rehydrate as a `proposal` segment via [`segment_timeline`]. A kept
/// step's FK to the kept tool_call ([`delete_unproposed_tool_calls`]) stays valid.
///
/// The `message`-step deletion is SCOPED to `assistant_message_id`: a Run's
/// user-prompt step is ALSO a `kind='message'` (`tool_call_id IS NULL`) row, so a
/// blanket `tool_call_id IS NULL` would strip the user turn too — and a later
/// park/resume of this same Run would then reconstruct a transcript missing the
/// user message (`resume::reconstruct` walks `run_timeline`). Only the assistant's
/// own message steps are the failed attempt's output; the user-prompt step survives.
///
/// Deleted BEFORE [`delete_message_parts`] (the dropped `message` steps' composite
/// FK references the parts) and BEFORE [`delete_unproposed_tool_calls`] (the
/// dropped `tool_call` steps FK those tool_calls). Runs inside the retry tx.
pub(super) async fn delete_run_steps_except_proposals<'e, E>(
    executor: E,
    run_id: Uuid,
    assistant_message_id: &str,
) -> sqlx::Result<u64>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "DELETE FROM run_steps \
         WHERE run_id = ?1 \
           AND ((tool_call_id IS NULL AND message_id = ?2) \
                OR (tool_call_id IS NOT NULL \
                    AND tool_call_id NOT IN (SELECT tool_call_id FROM proposals)))",
    )
    .bind(run_id.to_string())
    .bind(assistant_message_id)
    .execute(executor)
    .await
    .map(|r| r.rows_affected())
}

/// Delete a Run's `tool_calls` that are NOT proposal-backed (run-retry, ADR-0028
/// amendment): the failed attempt's own tool I/O. A tool_call WITH a `proposals`
/// sidecar is SPARED — it is committed history of a prior decided proposal, and its
/// `ON DELETE CASCADE` to `proposals` (migration 0001:116) would cascade-delete the
/// proposals row, orphaning the surviving `entities.created_via_proposal_id` /
/// `entity_revisions.proposal_id` FKs (no on-delete) and rolling back the whole
/// retry tx. Deleted AFTER [`delete_run_steps_except_proposals`] (whose dropped
/// `tool_call` steps FK these). Runs inside the retry tx.
pub(super) async fn delete_unproposed_tool_calls<'e, E>(
    executor: E,
    run_id: Uuid,
) -> sqlx::Result<u64>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "DELETE FROM tool_calls \
         WHERE run_id = ?1 AND id NOT IN (SELECT tool_call_id FROM proposals)",
    )
    .bind(run_id.to_string())
    .execute(executor)
    .await
    .map(|r| r.rows_affected())
}

/// Re-flip an assistant Message `incomplete → streaming` (run-retry, ADR-0028
/// amendment): the failed attempt left it `incomplete` (via
/// [`mark_streaming_messages_incomplete`]); the re-driven attempt streams into it,
/// and `open_assistant_part`/`append_assistant_part` gate on `status='streaming'`.
/// The Message id is reused so the bubble identity is stable. Returns the affected
/// row count. Runs inside the retry tx.
pub(super) async fn mark_message_streaming<'e, E>(
    executor: E,
    message_id: &str,
    now_ms: i64,
) -> sqlx::Result<u64>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE messages SET status = 'streaming', updated_at = ?1 \
         WHERE id = ?2 AND status = 'incomplete'",
    )
    .bind(now_ms)
    .bind(message_id)
    .execute(executor)
    .await
    .map(|r| r.rows_affected())
}

/// Re-snapshot a Run's resolved Workflow columns (run-retry, ADR-0028 amendment):
/// retry re-resolves the Workflow from LIVE settings (so "switch model, then
/// retry" works), then overwrites the snapshot the original attempt stored —
/// mirroring the columns [`insert_run`] sets at Run start. Runs inside the retry tx.
#[allow(clippy::too_many_arguments)]
pub(super) async fn resnapshot_run_workflow<'e, E>(
    executor: E,
    run_id: Uuid,
    workflow_name: &str,
    workflow_version: &str,
    provider: &str,
    model: &str,
    thinking_level: &str,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE runs SET workflow_name = ?, workflow_version = ?, provider = ?, \
         model = ?, thinking_level = ? WHERE id = ?",
    )
    .bind(workflow_name)
    .bind(workflow_version)
    .bind(provider)
    .bind(model)
    .bind(thinking_level)
    .bind(run_id.to_string())
    .execute(executor)
    .await
    .map(|_| ())
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

/// Whether a Message is still `streaming` (ADR-0045): the streaming guard for
/// opening a new assistant text segment, mirroring [`append_text_part`]'s inline
/// `EXISTS … status='streaming'` so a late delta after a terminal transition
/// neither opens a stray part nor appends.
pub(super) async fn message_is_streaming<'e, E>(
    executor: E,
    message_id: Uuid,
) -> sqlx::Result<bool>
where
    E: Executor<'e, Database = Sqlite>,
{
    let row: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM messages WHERE id = ?1 AND status = 'streaming' LIMIT 1",
    )
    .bind(message_id.to_string())
    .fetch_optional(executor)
    .await?;
    Ok(row.is_some())
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
    insert_message_part(executor, message_id, seq, PartType::Text, text).await
}

/// A `type='reasoning'`-seeding face for TEST seeds only — production opens reasoning
/// parts through [`super::open_assistant_part`], which calls [`insert_message_part`]
/// with the `PartType` it holds. Kept as a named convenience for the rehydration tests
/// that build a timeline row-by-row (ADR-0045 reasoning amendment).
#[cfg(test)]
pub(super) async fn insert_reasoning_part<'e, E>(
    executor: E,
    message_id: Uuid,
    seq: i64,
    text: &str,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    insert_message_part(executor, message_id, seq, PartType::Reasoning, text).await
}

/// The `message_parts.type` discriminant for a streamed assistant part (ADR-0045).
/// `text` is the reply prose; `reasoning` is the thinking trace (#202). Both ride the
/// same open-on-first-delta / append machine — only this tag distinguishes them, and
/// only the read (`segment_timeline`) and resume filter (`run_timeline`) branch on it.
/// Re-exported from `db` ([`super::PartType`]) so the run loop names the kind it opens.
#[derive(Clone, Copy)]
pub(crate) enum PartType {
    Text,
    Reasoning,
}

impl PartType {
    fn as_str(self) -> &'static str {
        match self {
            PartType::Text => "text",
            PartType::Reasoning => "reasoning",
        }
    }
}

/// Insert one `message_parts` row of `part_type`, seeded with `text`. The sole
/// writer of a streamed part: the open path ([`super::open_assistant_part`]) calls it
/// directly with the `PartType` it holds, while [`insert_text_part`]/
/// [`insert_reasoning_part`] are thin literal-named faces for the seed/test callers.
pub(super) async fn insert_message_part<'e, E>(
    executor: E,
    message_id: Uuid,
    seq: i64,
    part_type: PartType,
    text: &str,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query("INSERT INTO message_parts (message_id, seq, type, text) VALUES (?, ?, ?, ?)")
        .bind(message_id.to_string())
        .bind(seq)
        .bind(part_type.as_str())
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
/// cumulative text — ALL its text parts concatenated in `seq` order (ADR-0045;
/// text is no longer a single `seq=0` blob, so the snapshot must span the
/// per-segment parts) — plus the Run's `status`. Returns `None` when the Run has
/// no assistant Message (an unknown run id). The inner `None` text means the
/// assistant Message exists but has streamed no part yet; mod.rs defaults it to
/// `""`. The ordered inner subquery feeds `group_concat`, the portable SQLite
/// idiom for an order-stable concat.
pub(super) async fn select_run_snapshot<'e, E>(
    executor: E,
    run_id: Uuid,
) -> sqlx::Result<Option<(Option<String>, String)>>
where
    E: Executor<'e, Database = Sqlite>,
{
    let row: Option<(Option<String>, String)> = sqlx::query_as(
        "SELECT ( \
                  SELECT group_concat(text, '') FROM ( \
                    SELECT text FROM message_parts \
                    WHERE message_id = m.id AND type = 'text' ORDER BY seq \
                  ) \
                ) AS text, \
                r.status \
         FROM runs r \
         JOIN messages m ON m.run_id = r.id AND m.role = 'assistant' \
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

/// Insert a `run_steps` row of kind `message`, resolving to a SPECIFIC text part
/// via `(message_id, part_seq)` (ADR-0045). `seq` is the run-timeline position;
/// `part_seq` is the `message_parts.seq` this step's text lives in.
pub(super) async fn insert_message_run_step<'e, E>(
    executor: E,
    run_id: Uuid,
    seq: i64,
    message_id: Uuid,
    part_seq: i64,
    now_ms: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO run_steps \
         (run_id, seq, kind, message_id, part_seq, tool_call_id, created_at) \
         VALUES (?, ?, 'message', ?, ?, NULL, ?)",
    )
    .bind(run_id.to_string())
    .bind(seq)
    .bind(message_id.to_string())
    .bind(part_seq)
    .bind(now_ms)
    .execute(executor)
    .await
    .map(|_| ())
}

/// The next `run_steps.seq` for a Run (`MAX(seq)+1`, or 0 for the first). The
/// initial run inserts only the user message step at seq 0 (ADR-0045: no eager
/// assistant step); the first assistant text segment / tool call lands at seq 1.
pub(super) async fn next_run_step_seq<'e, E>(executor: E, run_id: Uuid) -> sqlx::Result<i64>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_scalar("SELECT COALESCE(MAX(seq), -1) + 1 FROM run_steps WHERE run_id = ?")
        .bind(run_id.to_string())
        .fetch_one(executor)
        .await
}

/// The next `message_parts.seq` for a Message (`MAX(seq)+1`, or 0 for the
/// first). Used to open a fresh assistant text segment (ADR-0045): each contiguous
/// run of text after a boundary is a new part at the next seq.
pub(super) async fn next_message_part_seq<'e, E>(
    executor: E,
    message_id: Uuid,
) -> sqlx::Result<i64>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_scalar("SELECT COALESCE(MAX(seq), -1) + 1 FROM message_parts WHERE message_id = ?")
        .bind(message_id.to_string())
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

/// Read a Run's ordered `segments[]` timeline for `thread/get` rehydration
/// (ADR-0045): every `run_steps` row in `seq` order, with the data each segment
/// kind renders joined on. Supersedes the separate `tool_calls_by_run` (ADR-0043)
/// + `decided_proposal_for_run` (ADR-0044) reads — one walk yields the whole
/// ordered turn. Returns
/// `(kind, part_text, tc_name, tc_status, request_payload, proposal_id,
/// mutation_kind, proposal_status)` tuples; the caller ([`super::segment_rows_for_run`])
/// turns each row into a `text` / `tool_call` / `proposal` segment, in this order:
///
/// - `kind='message'` → a `text` segment from `part_text` (the resolved
///   `message_parts` row); the caller filters an empty-text part.
/// - `kind='tool_call'` with a `proposals` row → a `proposal` segment carrying
///   `proposal_id`/`mutation_kind`/`proposal_status`. The caller keeps only the
///   decided (`accepted`/`rejected`) ones, mirroring ADR-0044 (a `pending` one
///   renders its interactive card, deferred; a `cancelled` one is cleared live).
/// - `kind='tool_call'` without a `proposals` row → a `tool_call` segment from
///   `tc_name`/`tc_status`/`request_payload`. The caller filters a `pending` tool
///   call (an in-flight call at reload time is owned by the live tail, ADR-0043)
///   and Proposal-named tools that somehow carry no `proposals` row.
///
/// All filtering of statuses lives in the caller (over the parsed strings) rather
/// than the SQL, so one ordered walk drives every segment kind and the seq order is
/// never broken by a per-kind sub-read.
///
/// `message` steps are restricted to `assistant_message_id`: a Run's `run_steps`
/// also carry the USER Message's text step (seq 0), which belongs to the user
/// `MessageRow`, not the assistant turn — including it would prepend the prompt to
/// the assistant's segments. `tool_call` steps have no `message_id`, so they pass
/// the filter and stay in seq order between the assistant text segments.
///
/// Two columns join the original 8 for the ADR-0045 reasoning amendment (#202):
/// `mp.type` (the caller switches the `message` branch on it — `text` vs
/// `reasoning`) and a Core-computed `duration_ms` for reasoning. Duration is the
/// span from this step's `created_at` to the IMMEDIATE NEXT step's `created_at`
/// (the lowest later `seq` in the SAME Run — a correlated subquery ordered by
/// `seq`, NOT `MIN(created_at)`: a later step stamped at an earlier time, e.g.
/// same-ms or clock skew, must not be mistaken for the next one; the subquery also
/// dodges the WHERE filter that drops the user-Message step, so it never widens the
/// window), COALESCE'd to `runs.ended_at` when this is the last step. A negative
/// span (clock skew) or an unknown end yields `NULL`; the caller only reads it for
/// reasoning rows.
pub(super) async fn segment_timeline<'e, E>(
    executor: E,
    run_id: Uuid,
    assistant_message_id: &str,
) -> sqlx::Result<Vec<SegmentTimelineRow>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as(
        "SELECT rs.kind, mp.text, \
                tc.name, tc.status, tc.request_payload, \
                p.id, p.mutation_kind, p.status, \
                mp.type, \
                ( \
                  SELECT nxt.created_at - rs.created_at \
                  FROM run_steps nxt \
                  WHERE nxt.run_id = rs.run_id AND nxt.seq > rs.seq \
                  ORDER BY nxt.seq \
                  LIMIT 1 \
                ) \
                AS duration_to_next, \
                ( \
                  SELECT ended_at FROM runs WHERE id = rs.run_id \
                ) \
                AS run_ended_at, \
                rs.created_at \
         FROM run_steps rs \
         LEFT JOIN message_parts mp \
           ON mp.message_id = rs.message_id AND mp.seq = rs.part_seq \
         LEFT JOIN tool_calls tc ON tc.id = rs.tool_call_id \
         LEFT JOIN proposals p ON p.tool_call_id = rs.tool_call_id \
         WHERE rs.run_id = ?1 \
           AND (rs.kind = 'tool_call' OR rs.message_id = ?2) \
         ORDER BY rs.seq",
    )
    .bind(run_id.to_string())
    .bind(assistant_message_id)
    .fetch_all(executor)
    .await
    .map(|rows: Vec<(_, _, _, _, _, _, _, _, _, Option<i64>, Option<i64>, i64)>| {
        rows.into_iter()
            .map(
                |(
                    kind,
                    part_text,
                    tc_name,
                    tc_status,
                    request_payload,
                    proposal_id,
                    mutation_kind,
                    proposal_status,
                    part_type,
                    duration_to_next,
                    run_ended_at,
                    step_created_at,
                )| {
                    // Resolve the reasoning span at the seam: the next step's
                    // delta if there is one, else `run.ended_at − created_at`.
                    // A negative span (clock skew) or an unknown end → None.
                    let duration_ms = duration_to_next
                        .or_else(|| run_ended_at.map(|end| end - step_created_at))
                        .filter(|&d| d >= 0);
                    SegmentTimelineRow {
                        kind,
                        part_text,
                        part_type,
                        tc_name,
                        tc_status,
                        request_payload,
                        proposal_id,
                        mutation_kind,
                        proposal_status,
                        duration_ms,
                    }
                },
            )
            .collect()
    })
}

/// One row of the [`segment_timeline`] walk, named so the caller
/// ([`super::segment_rows_for_run`]) reads it by field instead of unpacking a
/// 10-wide positional tuple with `_` holes (ADR-0045). The raw SQL still selects a
/// wide tuple; this is the resolved, caller-facing shape (duration already folded
/// from the next-step/`ended_at` seam). `part_type` is the `message_parts.type`
/// (text/reasoning); `duration_ms` is meaningful only for reasoning rows.
pub(super) struct SegmentTimelineRow {
    pub kind: String,
    pub part_text: Option<String>,
    pub part_type: Option<String>,
    pub tc_name: Option<String>,
    pub tc_status: Option<String>,
    pub request_payload: Option<String>,
    pub proposal_id: Option<String>,
    pub mutation_kind: Option<String>,
    pub proposal_status: Option<String>,
    pub duration_ms: Option<i64>,
}

/// Read a Run's ordered timeline for resume transcript reconstruction
/// (ADR-0025/0045): every `run_steps` row in `seq` order. A `message` step now
/// resolves to a SPECIFIC text part via `(message_id, part_seq)`, so the part's
/// `text` is joined here (`part_text`) and the reader replays per-part text in
/// `seq` order rather than lumping a message's parts onto one step. Returns
/// `(kind, message_id, role, part_text, tool_call_id, tc_name, request_payload,
/// result_payload)` tuples.
///
/// `type='reasoning'` message steps are EXCLUDED (ADR-0045 reasoning amendment,
/// #202): reasoning is display-only and never replayed into the worker
/// transcript — replaying a thinking block without its provider signature is a
/// live correctness hazard (#201 defers the signed round-trip). The filter is a
/// WHERE condition so a reasoning step yields no row at all (it never becomes a
/// `TimelineStep::Message`); text/attachment message steps and all tool steps
/// pass unchanged.
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
        Option<String>,
    )>,
>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as(
        "SELECT rs.kind, rs.message_id, m.role, mp.text, rs.tool_call_id, \
                tc.name, tc.request_payload, tc.result_payload \
         FROM run_steps rs \
         LEFT JOIN messages m ON m.id = rs.message_id \
         LEFT JOIN message_parts mp \
           ON mp.message_id = rs.message_id AND mp.seq = rs.part_seq \
         LEFT JOIN tool_calls tc ON tc.id = rs.tool_call_id \
         WHERE rs.run_id = ?1 \
           AND (rs.kind = 'tool_call' OR mp.type IS NULL OR mp.type <> 'reasoning') \
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

// ─── message search (ADR-0035) ─────────────────────────────────────────

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
/// plain `LIKE` path (no `ESCAPE` clause to bind).
fn needs_like_escape(query: &str) -> bool {
    query.contains('%') || query.contains('_') || query.contains(LIKE_ESCAPE)
}

/// Substring search over Message text (ADR-0035): a plain case-insensitive
/// `text LIKE '%' || ? || '%'` scan over each `completed` Message's text,
/// assembled live from its `message_parts` (the same `group_concat(text)` in
/// `seq` order that `select_run_snapshot` uses), joined to `threads` for the
/// title. Rows come from `messages m WHERE m.status = 'completed'`: a user
/// Message is `completed` at Run creation (searchable immediately); an assistant
/// Message becomes `completed` only at Run completion (`complete_run`) — the same
/// completed-only gating the dropped FTS projection enforced. Ordered
/// newest-first, capped at 50. The snippet is rendered in SQL with `instr`/`substr`
/// (char-based in SQLite — no byte-slice hazard) around the first case-insensitive
/// match, keeping [`SNIPPET_PAD`] chars of context per side with `…` where trimmed.
/// Returns `(message_id, thread_id, run_id, role, snippet, thread_title,
/// created_at)`.
///
/// **Literal-wildcard escape:** a needle containing `%`/`_`/`\` takes the
/// LIKE-escaped path (binding `escape_like(query)` under `ESCAPE '\'`) so the
/// metacharacters match literally; the common no-wildcard needle takes the plain
/// `LIKE` path (byte-identical for such needles, no `ESCAPE` clause to bind).
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
    //
    // The inner `f` selects each `completed` Message's text assembled live from
    // `message_parts` (the canonical `group_concat(text)` in `seq` order), in place
    // of the dropped `message_fts` mirror. `AND f.text <> ''` reproduces the
    // mirror's empty-row exclusion (an empty-text Message contributed no FTS row,
    // so could not match) — without it an all-empty Message would spuriously match
    // a needle, and `instr` on '' would yield a degenerate snippet window.
    const SELECT_HEAD: &str = "SELECT s.message_id, s.thread_id, s.run_id, s.role, \
                CASE WHEN s.start > 1 THEN '…' ELSE '' END \
                  || substr(s.text, s.start, (s.pos - s.start) + s.slen + ?3) \
                  || CASE WHEN s.start - 1 + ((s.pos - s.start) + s.slen + ?3) < length(s.text) \
                          THEN '…' ELSE '' END, \
                s.title, s.created_at \
         FROM ( \
           SELECT f.message_id, f.thread_id, f.run_id, f.role, f.text, \
                  t.title, m_created_at AS created_at, m_rowid, \
                  length(?2) AS slen, \
                  instr(lower(f.text), lower(?2)) AS pos, \
                  max(1, instr(lower(f.text), lower(?2)) - ?3) AS start \
           FROM ( \
             SELECT m.id AS message_id, m.thread_id, m.run_id, m.role, \
                    m.created_at AS m_created_at, m.rowid AS m_rowid, \
                    ( \
                      SELECT group_concat(text, '') FROM ( \
                        SELECT text FROM message_parts \
                        WHERE message_id = m.id AND type = 'text' ORDER BY seq \
                      ) \
                    ) AS text \
             FROM messages m \
             WHERE m.status = 'completed' \
           ) AS f \
           JOIN threads t ON t.id = f.thread_id \
           WHERE f.text <> '' AND f.text LIKE '%' || ?1 || '%'";
    // Cap the result set: a common substring ("the", "a") otherwise matches every
    // message in the workspace and floods the palette with thousands of rows. 50
    // newest matches is plenty for a jump-to-message picker (ADR-0035).
    const SELECT_TAIL: &str = " \
         ) AS s \
         ORDER BY s.created_at DESC, s.m_rowid DESC \
         LIMIT 50";

    // Wildcard needle → ESCAPE path (correct literal `%`/`_` matching); plain
    // needle → no ESCAPE. The bound `?1` matches.
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
