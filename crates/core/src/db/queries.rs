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

/// Park a Run (ADR-0025): set `status='parked'` and record the waitpoint in
/// `awaiting_tool_call_id`. Park is a non-terminal state — no `ended_at`,
/// `terminal_reason`, or error fields. `awaiting_tool_call_id` references the
/// `tool_calls` row of the Proposal's tool call.
pub(super) async fn mark_run_parked<'e, E>(
    executor: E,
    run_id: Uuid,
    awaiting_tool_call_id: &str,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE runs SET status = 'parked', awaiting_tool_call_id = ? WHERE id = ?",
    )
    .bind(awaiting_tool_call_id)
    .bind(run_id.to_string())
    .execute(executor)
    .await
    .map(|_| ())
}

/// Read a Run's `status` by id (ADR-0025). `None` when the Run does not exist.
/// Backs `run/subscribe`'s parked branch: with no live hub, the persisted
/// status decides whether to emit a terminal `done` or report `parked`.
pub(super) async fn run_status<'e, E>(
    executor: E,
    run_id: Uuid,
) -> sqlx::Result<Option<String>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_scalar("SELECT status FROM runs WHERE id = ?1")
    .bind(run_id.to_string())
    .fetch_optional(executor)
    .await
}

/// Load a Proposal by id for `proposal/decide` (ADR-0025): its lifecycle
/// columns, the owning Run, the proposed payload (from the tool call's
/// `request_payload`), and the recorded `decision_idempotency_key`. `None`
/// when no Proposal with that id exists. Returns `(run_id, tool_call_id, kind,
/// change_kind, status, request_payload, decision_idempotency_key)`.
#[allow(clippy::type_complexity)]
pub(super) async fn proposal_by_id<'e, E>(
    executor: E,
    proposal_id: &str,
) -> sqlx::Result<Option<(String, String, String, String, String, String, Option<String>)>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as(
        "SELECT tc.run_id, p.tool_call_id, p.kind, p.change_kind, p.status, \
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
/// repeated `proposal/decide` with the same `decision_idempotency_key` returns
/// the already-created `entities.id` rather than applying again. `None` when
/// no Entity was created via this Proposal.
pub(super) async fn entity_id_for_proposal<'e, E>(
    executor: E,
    proposal_id: &str,
) -> sqlx::Result<Option<String>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_scalar("SELECT id FROM entities WHERE created_via_proposal_id = ?1 LIMIT 1")
        .bind(proposal_id)
        .fetch_optional(executor)
        .await
}

/// Accept a Proposal (ADR-0016 single atomic apply, ADR-0025): flip the
/// `proposals` row to `accepted`, stamp `decided_by='user'` + `decided_at` +
/// `applied_at` + `decision_idempotency_key`, and record the `edited_payload`
/// (NULL for an unedited accept). Runs inside the caller's apply transaction.
pub(super) async fn mark_proposal_accepted<'e, E>(
    executor: E,
    proposal_id: &str,
    edited_payload: Option<&str>,
    decision_idempotency_key: Option<&str>,
    now_ms: i64,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "UPDATE proposals SET status = 'accepted', decided_by = 'user', \
         decided_at = ?, applied_at = ?, edited_payload = ?, \
         decision_idempotency_key = ? WHERE id = ?",
    )
    .bind(now_ms)
    .bind(now_ms)
    .bind(edited_payload)
    .bind(decision_idempotency_key)
    .bind(proposal_id)
    .execute(executor)
    .await
    .map(|_| ())
}

// ─── entities + entity_revisions (ADR-0004) ───────────────────────────

/// Insert a freshly-created Entity (ADR-0004): `created_by='proposal'` with the
/// originating `created_via_proposal_id`. `data` is the validated JSON snapshot;
/// `schema_version` stamps the type's current shape. Runs inside the apply tx.
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

/// Insert an Entity's revision (ADR-0004). A freshly-created Entity gets
/// `seq=1` carrying the same `data` + the originating `proposal_id`. Runs
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

/// Flip a parked Run back to `running` on resume (ADR-0025): clear the
/// `awaiting_tool_call_id` waitpoint. The reverse of [`mark_run_parked`]; the
/// Run goes parked→running before its resume Worker spawns.
pub(super) async fn mark_run_running<'e, E>(executor: E, run_id: Uuid) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query("UPDATE runs SET status = 'running', awaiting_tool_call_id = NULL WHERE id = ?")
        .bind(run_id.to_string())
        .execute(executor)
        .await
        .map(|_| ())
}

/// Read the run's assistant Message id (the seq-0 streaming row resume
/// continues appending into). `None` when the Run has no assistant message.
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

/// Read a Run's ordered timeline for resume transcript reconstruction
/// (ADR-0025): every `run_steps` row in `seq` order, joined to the message's
/// role (when a message step) and to the tool call's name/payloads (when a
/// tool_call step). One ordered query so the reconstruction walks the turn
/// structure exactly as it was recorded. Returns `(kind, message_id, role,
/// tool_call_id, tc_name, request_payload, result_payload)` tuples; the
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

/// Insert a `proposals` row in the `pending` state, sidecar to the Proposal's
/// `tool_calls` row. `kind` is the proposed entity type (from the proposed
/// `type`); `change_kind` is create|update|delete. The proposed `data` and
/// `rationale` are stored as a JSON sidecar in `edited_payload`'s sibling — for
/// now Core keeps the proposed payload on the tool_call's `request_payload`, so
/// this row carries only the lifecycle columns. `decision_idempotency_key` is
/// NULL until a Decision is made (a later slice).
pub(super) async fn insert_proposal<'e, E>(
    executor: E,
    id: &str,
    tool_call_id: &str,
    kind: &str,
    change_kind: &str,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO proposals (id, tool_call_id, kind, change_kind, status) \
         VALUES (?, ?, ?, ?, 'pending')",
    )
    .bind(id)
    .bind(tool_call_id)
    .bind(kind)
    .bind(change_kind)
    .execute(executor)
    .await
    .map(|_| ())
}

/// A Run's pending Proposal for `proposal/get` (ADR-0025): the proposal id,
/// kind, change_kind, lifecycle status, plus the Proposal tool call's stored
/// `request_payload` (carrying the proposed `type`/`data`/`rationale`). Joined
/// through `tool_calls` on `run_id`. `None` when the Run has no pending
/// Proposal.
pub(super) async fn pending_proposal_for_run<'e, E>(
    executor: E,
    run_id: Uuid,
) -> sqlx::Result<Option<(String, String, String, String, String)>>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query_as(
        "SELECT p.id, p.kind, p.change_kind, p.status, tc.request_payload \
         FROM proposals p \
         JOIN tool_calls tc ON tc.id = p.tool_call_id \
         WHERE tc.run_id = ?1 AND p.status = 'pending' \
         ORDER BY tc.requested_at DESC LIMIT 1",
    )
    .bind(run_id.to_string())
    .fetch_optional(executor)
    .await
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
