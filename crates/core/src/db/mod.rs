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
pub(crate) fn resolve_db_path() -> Result<PathBuf> {
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

/// One Message in a `thread/get` read: its identity, `role`, `status`,
/// owning `run_id`, and `text` already assembled (the concat of its text
/// parts in `seq` order). Flat-text-no-parts[] per ADR-0017/Q15 — the handler
/// maps this straight onto the wire `MessageView`.
pub struct MessageRow {
    pub id: String,
    pub role: String,
    pub status: String,
    pub run_id: String,
    pub text: String,
}

/// Read a Thread plus its Messages for `thread/get` (ADR-0022 read path).
/// Returns `None` when the Thread does not exist (the title query is the
/// existence check), so the handler maps that to `unknown_thread` (-32001).
/// Otherwise `Some((title, messages))` where messages are in chronological
/// order (`created_at, rowid` — the rowid tiebreaker keeps the user Message
/// ahead of the assistant Message on a same-ms insert) and each Message's
/// `text` is the concat of its text parts assembled in Rust.
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

/// Assemble the prior-Run conversation history for a Run's manifest
/// (ADR-0018 multi-turn). Returns `(role, text)` pairs for every
/// `completed` Message in `thread_id` belonging to a Run OTHER than
/// `exclude_run_id`, oldest-first, with each Message's text assembled from
/// its parts. The current Run is excluded so the history is strictly the
/// prior exchange; `completed`-only drops partial/errored assistant text.
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

/// Persist an incoming Tool Request (ADR-0017/0018): a `tool_calls` row in the
/// `pending` state plus a `run_steps` row of kind `tool_call` interleaving it
/// into the Run timeline — both in one transaction so the timeline never has a
/// tool call that isn't addressable via `run_steps`. `tool_call_id` is the
/// Worker-assigned id (the wire correlation key); `request_payload` is the
/// serialized tool args.
pub async fn persist_tool_call(
    pool: &SqlitePool,
    run_id: Uuid,
    tool_call_id: &str,
    name: &str,
    request_payload: &str,
    now_ms: i64,
) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;
    let seq = queries::next_run_step_seq(&mut *tx, run_id).await?;
    queries::insert_tool_call(&mut *tx, tool_call_id, run_id, name, request_payload, now_ms).await?;
    queries::insert_tool_call_run_step(&mut *tx, run_id, seq, tool_call_id, now_ms).await?;
    tx.commit().await
}

/// Resolve a previously-persisted Tool Request with its outcome (ADR-0017):
/// flip the `tool_calls` row to `status` (`completed` for a normal result,
/// `errored` for a tool failure) and store the serialized `result_payload`.
pub async fn resolve_tool_call(
    pool: &SqlitePool,
    tool_call_id: &str,
    status: &str,
    result_payload: &str,
    now_ms: i64,
) -> sqlx::Result<()> {
    queries::resolve_tool_call(pool, tool_call_id, status, result_payload, now_ms).await
}

/// Persist a pending Proposal (ADR-0025), sidecar to the Proposal's
/// `tool_calls` row. The proposed payload (`type`/`data`/`rationale`) rides on
/// the tool call's `request_payload` already persisted by
/// [`persist_tool_call`]; this row carries the Proposal lifecycle columns
/// (`kind`, `change_kind`, `status='pending'`). `change_kind` is `create` for
/// `propose_entity` (the only Proposal tool today).
pub async fn persist_proposal(
    pool: &SqlitePool,
    proposal_id: &str,
    tool_call_id: &str,
    kind: &str,
    change_kind: &str,
) -> sqlx::Result<()> {
    queries::insert_proposal(pool, proposal_id, tool_call_id, kind, change_kind).await
}

/// Park a Run on a Proposal (ADR-0025): set `runs.status='parked'` and record
/// the waitpoint in `awaiting_tool_call_id`. Park is non-terminal — no
/// `ended_at`/`terminal_reason`/error fields are touched, so the Run stays
/// decidable.
pub async fn mark_run_parked(
    pool: &SqlitePool,
    run_id: Uuid,
    awaiting_tool_call_id: &str,
) -> sqlx::Result<()> {
    queries::mark_run_parked(pool, run_id, awaiting_tool_call_id).await
}

/// Read a Run's `status` (ADR-0025). `None` when the Run does not exist.
/// Backs `run/subscribe`'s parked branch and the forwarder's no-false-done
/// check.
pub async fn run_status(pool: &SqlitePool, run_id: Uuid) -> sqlx::Result<Option<String>> {
    queries::run_status(pool, run_id).await
}

/// A Run's pending Proposal for `proposal/get` (ADR-0025). `data` and
/// `rationale` are extracted from the Proposal tool call's stored
/// `request_payload` (the `{type, data, rationale}` the model sent); `kind`,
/// `change_kind`, and `status` come from the `proposals` row.
pub struct ProposalRow {
    pub proposal_id: String,
    pub kind: String,
    pub change_kind: String,
    pub status: String,
    pub data: serde_json::Value,
    pub rationale: Option<String>,
}

/// Read the Run's pending Proposal, or `None` if it has none. Parses the
/// tool call's `request_payload` to recover the proposed `data`/`rationale`;
/// a malformed payload degrades to `data: null` / `rationale: None` rather
/// than failing the read.
pub async fn get_pending_proposal_for_run(
    pool: &SqlitePool,
    run_id: Uuid,
) -> sqlx::Result<Option<ProposalRow>> {
    let Some((proposal_id, kind, change_kind, status, request_payload)) =
        queries::pending_proposal_for_run(pool, run_id).await?
    else {
        return Ok(None);
    };
    let payload: serde_json::Value =
        serde_json::from_str(&request_payload).unwrap_or(serde_json::Value::Null);
    let data = payload
        .get("data")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let rationale = payload
        .get("rationale")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    Ok(Some(ProposalRow {
        proposal_id,
        kind,
        change_kind,
        status,
        data,
        rationale,
    }))
}

/// Auto-approve seam (ADR-0025, ADR-0016): whether a Proposal should be
/// approved automatically (skipping the park). Returns `false` for now — every
/// Proposal is manual, so every `propose_entity` parks the Run. A later policy
/// slice gives this a real body; the Worker is oblivious to auto vs manual
/// either way.
pub fn should_auto_approve() -> bool {
    false
}

/// A pending Proposal loaded by id for `proposal/decide` (ADR-0025). Carries
/// the owning Run, the awaited `tool_call_id`, the Proposal lifecycle columns,
/// the proposed `data` (parsed from the tool call's `request_payload`), and any
/// already-recorded `decision_idempotency_key`.
pub struct DecidableProposal {
    pub run_id: Uuid,
    pub tool_call_id: String,
    pub kind: String,
    #[allow(dead_code)]
    pub change_kind: String,
    pub status: String,
    pub data: serde_json::Value,
    pub decision_idempotency_key: Option<String>,
}

/// Load a Proposal by id for `proposal/decide`. `None` when no Proposal with
/// that id exists. The proposed `data` is parsed from the awaited tool call's
/// `request_payload`; a malformed payload degrades to `Value::Null`.
pub async fn load_proposal_for_decide(
    pool: &SqlitePool,
    proposal_id: &str,
) -> sqlx::Result<Option<DecidableProposal>> {
    let Some((run_id, tool_call_id, kind, change_kind, status, request_payload, idem)) =
        queries::proposal_by_id(pool, proposal_id).await?
    else {
        return Ok(None);
    };
    let Ok(run_id) = Uuid::parse_str(&run_id) else {
        return Ok(None);
    };
    let payload: serde_json::Value =
        serde_json::from_str(&request_payload).unwrap_or(serde_json::Value::Null);
    let data = payload
        .get("data")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    Ok(Some(DecidableProposal {
        run_id,
        tool_call_id,
        kind,
        change_kind,
        status,
        data,
        decision_idempotency_key: idem,
    }))
}

/// The `entities.id` already created via `proposal_id`, or `None`. Backs the
/// idempotent-decide check: a repeated `proposal/decide` (same Proposal already
/// accepted) returns the prior `entity_id` instead of re-applying.
pub async fn entity_id_for_proposal(
    pool: &SqlitePool,
    proposal_id: &str,
) -> sqlx::Result<Option<String>> {
    queries::entity_id_for_proposal(pool, proposal_id).await
}

/// Outcome of [`apply_proposal`] that the caller must distinguish (review M1).
/// `NotPending` is the lost-race branch — a concurrent decide already accepted
/// the Proposal, so the apply tx rolled back without a durable change and the
/// caller returns `proposal_not_pending`. `Sql` is any other DB failure.
#[derive(Debug)]
pub enum ApplyError {
    /// The `proposals` row was not `pending` when the guarded flip ran — a
    /// concurrent decide won. The transaction rolled back; nothing was applied.
    NotPending,
    /// An underlying SQL error inside the apply transaction.
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
            ApplyError::NotPending => write!(f, "proposal is not pending (lost the apply race)"),
            ApplyError::Sql(e) => write!(f, "{e}"),
        }
    }
}

/// Apply an accepted Proposal in ONE atomic transaction (ADR-0016, ADR-0025).
/// All-or-nothing: insert the `entities` row (`created_by='proposal'`,
/// `created_via_proposal_id`), its `entity_revisions` seq-1 snapshot, flip the
/// `proposals` row to `accepted` (+ `decided_by='user'`, `decided_at`,
/// `applied_at`, `decision_idempotency_key`, `edited_payload`), and resolve the
/// awaited `tool_calls` row to `completed` with `result_payload` = the Decision
/// rendered for the model to read on resume. No durable change exists before
/// this commits. Returns the new `entity_id`.
///
/// EDIT (ADR-0025): when `edited_payload` is `Some`, the entity `data` is the
/// EDITED payload (Core-validated by the caller), not the model's proposed
/// `data` — the edit is applied in one step. `proposals.edited_payload` records
/// the edit; an unedited accept passes `None` and writes the proposed `data`.
///
/// SELF-GUARDING against a double-apply (review M1): the `proposals` flip is
/// `… WHERE id = ? AND status = 'pending'`. If it affects 0 rows the Proposal
/// was already decided by a racing decide (keyed OR keyless), so the whole tx
/// rolls back and [`ApplyError::NotPending`] is returned — exactly one of two
/// concurrent decides applies. The caller maps `NotPending` to
/// `proposal_not_pending`.
#[allow(clippy::too_many_arguments)]
pub async fn apply_proposal(
    pool: &SqlitePool,
    proposal_id: &str,
    tool_call_id: &str,
    entity_type: &str,
    data: &serde_json::Value,
    edited_payload: Option<&serde_json::Value>,
    decision_idempotency_key: Option<&str>,
    decision_result_payload: &str,
    now_ms: i64,
) -> Result<String, ApplyError> {
    let entity_id = Uuid::now_v7().to_string();
    let edited_str = edited_payload.map(|v| v.to_string());
    // The applied entity data is the EDITED payload when present (edit), else
    // the model's proposed `data` (accept). The resolved tool_call's rendered
    // result and the entity snapshot both use this effective data so the model
    // reads the FINAL values on resume.
    let applied_data = edited_payload.unwrap_or(data);
    let data_str = applied_data.to_string();

    let mut tx = pool.begin().await?;

    // Flip the Proposal FIRST under the `status='pending'` guard — the single
    // concurrency choke. If a racing decide already accepted it this affects 0
    // rows; bail (rolling back the tx) before inserting a duplicate entity.
    let accepted = queries::mark_proposal_accepted(
        &mut *tx,
        proposal_id,
        edited_str.as_deref(),
        decision_idempotency_key,
        now_ms,
    )
    .await?;
    if accepted != 1 {
        // tx drops here without commit → rollback. No entity was inserted.
        return Err(ApplyError::NotPending);
    }

    queries::insert_entity(
        &mut *tx,
        &entity_id,
        entity_type,
        crate::entities::TODO_SCHEMA_VERSION,
        &data_str,
        proposal_id,
        now_ms,
    )
    .await?;
    queries::insert_entity_revision(&mut *tx, &entity_id, 1, &data_str, proposal_id, now_ms).await?;
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

/// Reject a Proposal in ONE atomic transaction (ADR-0025). Applies NOTHING to
/// the entity store: flip the `proposals` row to `rejected` (+ `decided_by`,
/// `decided_at`, `decision_idempotency_key`) and resolve the awaited
/// `tool_calls` row to `completed` with `result_payload` = the Decision the
/// model reads on resume — a NORMAL (non-error) decline so it continues
/// conversationally rather than retrying a failure. No `entities` /
/// `entity_revisions` write.
///
/// SELF-GUARDING against a double-decide (review M1, mirrors [`apply_proposal`]):
/// the `proposals` flip is `… WHERE id = ? AND status = 'pending'`. If it
/// affects 0 rows the Proposal was already decided by a racing decide, so the
/// whole tx rolls back and [`ApplyError::NotPending`] is returned. The caller
/// maps `NotPending` to `proposal_not_pending`.
pub async fn reject_proposal(
    pool: &SqlitePool,
    proposal_id: &str,
    tool_call_id: &str,
    decision_idempotency_key: Option<&str>,
    decision_result_payload: &str,
    now_ms: i64,
) -> Result<(), ApplyError> {
    let mut tx = pool.begin().await?;

    // Flip the Proposal FIRST under the `status='pending'` guard — the single
    // concurrency choke. If a racing decide already decided it this affects 0
    // rows; bail (rolling back the tx) before resolving the tool call.
    let rejected = queries::mark_proposal_rejected(
        &mut *tx,
        proposal_id,
        decision_idempotency_key,
        now_ms,
    )
    .await?;
    if rejected != 1 {
        // tx drops here without commit → rollback. Nothing was changed.
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
/// waitpoint. Called after `apply_proposal` commits and before the resume
/// Worker spawns, so a `run/subscribe` in the window sees `running`.
pub async fn mark_run_running(pool: &SqlitePool, run_id: Uuid) -> sqlx::Result<()> {
    queries::mark_run_running(pool, run_id).await
}

/// Cancel a parked Run and its pending Proposal in ONE transaction (ADR-0014,
/// slice 6). Self-guarding on `status='parked'`: flip the `runs` row to
/// `cancelled` (`terminal_reason='cancelled'`, `ended_at`) only while it is
/// still parked, then flip any `pending` Proposal of the Run to `cancelled`.
/// Returns whether the Run was actually cancelled — `false` (tx rolled back,
/// nothing changed) when a concurrent decide/cancel already moved the Run off
/// `parked`, which the caller maps to `already_terminal`.
pub async fn cancel_parked_run(
    pool: &SqlitePool,
    run_id: Uuid,
    now_ms: i64,
) -> sqlx::Result<bool> {
    let mut tx = pool.begin().await?;
    let cancelled = queries::mark_parked_run_cancelled(&mut *tx, run_id, now_ms).await?;
    if cancelled != 1 {
        // tx drops here without commit → rollback. The Run was not parked.
        return Ok(false);
    }
    queries::cancel_pending_proposals_for_run(&mut *tx, run_id).await?;
    tx.commit().await?;
    Ok(true)
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

/// One reconstructed turn-element of a Run's timeline for resume (ADR-0025).
/// A `Message` carries the assembled text + role; a `ToolCall` carries the
/// awaited tool's id/name/request and its resolved `result` (the persisted
/// `result_payload`, `None` if still pending → a synthesized "not executed"
/// result is emitted by the reconstruction).
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
pub async fn read_run_timeline(
    pool: &SqlitePool,
    run_id: Uuid,
) -> sqlx::Result<Vec<TimelineStep>> {
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

/// Worker emitted an explicit `error` Run Event (ADR-0006 lists errors as a
/// Run Event subtype; this is the real-provider error path). Same terminal shape as [`error_run`] but with a
/// caller-supplied `terminal_reason`, `error_code`, and `error_message`
/// carried into both the `runs` row and the terminal `run_events` payload.
/// `terminal_reason` must satisfy the `runs` CHECK constraint
/// (`worker_disconnected` for a disconnect, `errored` for a worker-emitted
/// error). One transaction so a reader sees the pre- or post-terminal
/// state, never a mix.
pub async fn error_run_with_message(
    pool: &SqlitePool,
    run_id: Uuid,
    terminal_reason: &str,
    error_code: &str,
    error_message: &str,
    now_ms: i64,
) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;
    let next_seq = queries::next_run_seq(&mut *tx, run_id).await?;
    queries::mark_run_errored(
        &mut *tx,
        run_id,
        terminal_reason,
        error_code,
        error_message,
        now_ms,
    )
    .await?;
    queries::mark_streaming_messages_incomplete(&mut *tx, run_id, now_ms).await?;
    let payload = serde_json::json!({ "code": error_code, "message": error_message }).to_string();
    queries::insert_run_event(&mut *tx, run_id, next_seq, "error", Some(&payload), now_ms).await?;
    tx.commit().await
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
