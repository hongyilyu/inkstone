//! Run persistence and lifecycle facade (run rows, streaming parts, tool
//! calls, guarded status transitions, retry/recovery). SQL stays in
//! [`queries`], matching the DB module's one-statement query convention; this
//! module owns the Run write shapes and transaction boundaries.

use sqlx::SqlitePool;
use uuid::Uuid;

// Lifecycle types come through the facade's re-exports (mod.rs keeps their
// ADR-0028/0029 annotations), not `super::lifecycle` directly, so the facade
// surface stays the one import path.
use super::{Moved, ProposalStatus, RunStatus, TerminalReason};
use super::queries::{self, PartType};
use super::run_log;
use crate::workflow::Workflow;

/// Read the recent-Runs feed for `run/get_history` (ADR-0028 as-built): one row
/// per Run carrying its latest Run Log milestone, newest-first, capped at
/// `limit`. Returns `(run_id, thread_id, title, kind, at)` rows; `kind` is the
/// milestone kind verbatim (the client maps it to a label). An empty Workspace
/// returns an empty Vec.
pub async fn list_run_history(
    pool: &SqlitePool,
    limit: i64,
) -> sqlx::Result<Vec<(String, String, String, String, i64)>> {
    queries::list_run_history(pool, limit).await
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
/// Inserts the assistant `messages` row (`streaming`) with NO text part yet —
/// [`open_assistant_part`] opens the first one on the first delta (ADR-0045).
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
/// begin/commit): the Run row, user Message + `seq=0` text part + its message
/// run step, the assistant Message (`streaming`, NO eager text part/step —
/// ADR-0045), the `running` run-log row, and the Thread activity touch.
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
        workflow.thinking_level.as_deref().unwrap_or_default(),
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
    // No eager assistant text part or message step (ADR-0045): the assistant
    // Message row exists, but its first `message_parts` row + `run_steps` row
    // open on the FIRST `text_delta`, at the live seq — so text emitted after a
    // tool call sequences after it instead of being pinned ahead at run start.
    queries::insert_message_run_step(&mut **tx, run_id, 0, user_message_id, 0, now_ms).await?;

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

/// Open a NEW assistant segment of `part_type` on the first delta after a boundary
/// (run start / a tool / a park), per ADR-0045. In one transaction: insert a fresh
/// `message_parts` row of that type at the message's next `part_seq` seeded with
/// `delta`, plus its `run_steps` `message` row at the Run's live `seq` carrying that
/// `part_seq` — so the segment sequences at the point the content actually began. The
/// `run_steps` row is always `kind='message'`; only the part TYPE distinguishes text
/// from reasoning, and the run loop tracks a separate open slot per type (pi gives no
/// delta-contiguity guarantee). Returns `Some(part_seq)` (the open part the run loop
/// appends into), or `None` if the assistant Message is no longer `streaming` (a late
/// delta after a terminal transition — dropped, mirroring [`append_assistant_part`]'s guard).
pub async fn open_assistant_part(
    pool: &SqlitePool,
    run_id: Uuid,
    assistant_message_id: Uuid,
    part_type: PartType,
    delta: &str,
    now_ms: i64,
) -> sqlx::Result<Option<i64>> {
    let mut tx = pool.begin().await?;
    if !queries::message_is_streaming(&mut *tx, assistant_message_id).await? {
        return Ok(None);
    }
    let part_seq = queries::next_message_part_seq(&mut *tx, assistant_message_id).await?;
    let step_seq = queries::next_run_step_seq(&mut *tx, run_id).await?;
    // We already hold the `PartType`, so write through the type-agnostic inserter
    // directly rather than round-tripping the enum back into a literal-named face.
    queries::insert_message_part(&mut *tx, assistant_message_id, part_seq, part_type, delta).await?;
    queries::insert_message_run_step(
        &mut *tx,
        run_id,
        step_seq,
        assistant_message_id,
        part_seq,
        now_ms,
    )
    .await?;
    tx.commit().await?;
    Ok(Some(part_seq))
}

/// Append a streaming delta to the currently-open assistant segment at `part_seq`
/// (ADR-0045; the run loop tracks which part is open per type and opens a fresh one
/// after each boundary via [`open_assistant_part`]). The append SQL is type-agnostic
/// (it keys on `(message_id, part_seq)` + streaming status, not `type`), so one
/// function serves both text and reasoning parts. Single statement; SQLite serializes
/// writes. Returns `false` (no row updated) when the Message is no longer `streaming`,
/// so a late delta is dropped.
pub async fn append_assistant_part(
    pool: &SqlitePool,
    assistant_message_id: Uuid,
    part_seq: i64,
    delta: &str,
) -> sqlx::Result<bool> {
    queries::append_text_part(pool, assistant_message_id, part_seq, delta)
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

pub(super) async fn persist_tool_call_rows(
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

/// Read a Run's [`RunStatus`] (ADR-0025); `None` when the Run does not exist.
/// Backs `run/subscribe`'s parked branch and the forwarder's no-false-done check.
///
/// The stored string is parsed into the enum at this seam (ADR-0029): read sites
/// match typed variants, not raw strings. A row whose stored `status` fails to
/// parse surfaces as a loud `sqlx::Error::Decode` rather than collapsing to `None`
/// (which means "no such Run"), mirroring [`entity_type_by_id`]. The `runs.status`
/// CHECK constraint means a live DB never produces an unknown value, so this arm
/// is defensive.
pub async fn run_status(pool: &SqlitePool, run_id: Uuid) -> sqlx::Result<Option<RunStatus>> {
    match queries::run_status(pool, run_id).await? {
        None => Ok(None),
        Some(raw) => RunStatus::from_str(&raw)
            .map(Some)
            .ok_or_else(|| sqlx::Error::Decode(format!("unknown stored run status {raw:?}").into())),
    }
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

/// Prepare an errored Run for in-place retry (ADR-0028 retry amendment, #230) in
/// ONE transaction: flip `errored → running` (the guarded [`RunStatus::retry`]),
/// and — only if won — DISCARD the failed attempt's output so the re-drive starts
/// clean. The Run keeps its `run_id` AND `assistant_message_id`; only the failed
/// *contents* are dropped.
///
/// On `Moved::Lost` (the Run was not `errored` — a concurrent retry/sweep won, or
/// it was never errored) nothing is cleared and the caller maps it to
/// `not_errored`. On `Moved::Won`, discard ONLY the failed attempt's OWN
/// uncommitted output — NOT a prior DECIDED proposal's committed rows:
///   - delete the Run's `run_steps` EXCEPT a proposal-backed `tool_call` step
///     (`delete_run_steps_except_proposals`), and the failed attempt's NON-proposal
///     `tool_calls` (`delete_unproposed_tool_calls`) — else `select_run_snapshot`'s
///     `group_concat(text)` would append the retry text after the dead text and
///     `thread/get`'s timeline would replay the failed segments. A proposal-backed
///     tool_call + its run_step are SPARED: deleting that tool_call would
///     `ON DELETE CASCADE` (0001:116) its `proposals` row, orphaning the surviving
///     `entities.created_via_proposal_id` / `entity_revisions.proposal_id` FKs and
///     rolling back the whole tx — and the kept step still rehydrates the decided
///     proposal segment (`segment_timeline`). Order: `run_steps` first (the dropped
///     `message` steps' composite FK points at the parts; the dropped `tool_call`
///     steps FK their tool_calls), then the assistant `message_parts`, then the
///     unproposed `tool_calls`;
///   - re-flip the assistant Message `incomplete → streaming` so the streaming
///     part writers (gated on `status='streaming'`) accept the re-driven deltas;
///   - re-snapshot the Run's resolved Workflow columns from `workflow` (re-resolved
///     LIVE by the caller via `dispatcher::dispatch_and_resolve`, so a model switch
///     before retry takes effect — ADR-0024 contrast with resume's snapshot).
///
/// The caller owns the spawn: it reads back the `assistant_message_id` + history
/// and `worker::spawn`s on the SAME ids (mode `None`/fresh).
pub async fn prepare_retry(
    pool: &SqlitePool,
    run_id: Uuid,
    workflow: &Workflow,
    now_ms: i64,
) -> sqlx::Result<Moved> {
    let mut tx = pool.begin().await?;

    let moved = RunStatus::retry(&mut *tx, run_id, now_ms).await?;
    if !moved.won() {
        // Not errored (lost the flip): clear nothing, leave the Run untouched.
        return Ok(moved);
    }

    // Clear the failed attempt's OWN rows, sparing a prior decided proposal's
    // committed history. The assistant message id is read FIRST: the run_steps
    // delete scopes message-step removal to it (so the user-prompt step survives —
    // a later park/resume must still reconstruct the user turn), and the parts
    // delete + streaming re-flip target it. run_steps go first (the dropped
    // `message` steps' composite FK references message_parts, and the dropped
    // `tool_call` steps FK tool_calls), then the assistant parts, then the
    // unproposed tool_calls.
    if let Some(assistant_message_id) =
        queries::assistant_message_id_for_run(&mut *tx, run_id).await?
    {
        queries::delete_run_steps_except_proposals(&mut *tx, run_id, &assistant_message_id).await?;
        queries::delete_message_parts(&mut *tx, &assistant_message_id).await?;
        queries::mark_message_streaming(&mut *tx, &assistant_message_id, now_ms).await?;
    }
    queries::delete_unproposed_tool_calls(&mut *tx, run_id).await?;

    // Re-snapshot the Run's model columns from the freshly-resolved Workflow.
    queries::resnapshot_run_workflow(
        &mut *tx,
        run_id,
        &workflow.name,
        &workflow.version,
        &workflow.provider,
        workflow.model.as_deref().unwrap_or_default(),
        workflow.thinking_level.as_deref().unwrap_or_default(),
    )
    .await?;

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

/// A Run's original user prompt (its user Message's concatenated text) and
/// `thread_id` (run-retry, ADR-0028 amendment, #230). `None` when the Run does
/// not exist or its `thread_id` is unparseable. Retry re-drives this prompt as a
/// fresh turn after re-resolving the Workflow from the Thread + prompt.
pub async fn run_prompt_and_thread(
    pool: &SqlitePool,
    run_id: Uuid,
) -> sqlx::Result<Option<(String, Uuid)>> {
    let Some(thread_id) = queries::thread_id_for_run(pool, run_id).await? else {
        return Ok(None);
    };
    let Ok(thread_uuid) = Uuid::parse_str(&thread_id) else {
        return Ok(None);
    };
    let user_message_id = queries::user_message_id_for_run(pool, run_id).await?;
    let prompt = queries::text_parts_by_message(pool, &user_message_id)
        .await?
        .concat();
    Ok(Some((prompt, thread_uuid)))
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
/// (ADR-0025/0045): each `run_steps` row in `seq` order. A `message` step now
/// resolves to its SPECIFIC text part (`run_timeline` joins `(message_id,
/// part_seq)`), so each contiguous text segment replays as its own step in
/// position — text after a tool follows it — rather than a message's parts lumped
/// onto one step. Tool steps carry the name/request/result.
pub async fn read_run_timeline(pool: &SqlitePool, run_id: Uuid) -> sqlx::Result<Vec<TimelineStep>> {
    let rows = queries::run_timeline(pool, run_id).await?;
    let mut steps = Vec::with_capacity(rows.len());
    for (
        kind,
        message_id,
        role,
        part_text,
        tool_call_id,
        tc_name,
        request_payload,
        result_payload,
    ) in rows
    {
        match kind.as_str() {
            "message" => {
                if message_id.is_none() {
                    continue;
                }
                steps.push(TimelineStep::Message {
                    role: role.unwrap_or_default(),
                    text: part_text.unwrap_or_default(),
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
#[derive(Debug)]
pub struct RunSnapshot {
    pub text: String,
    /// The Run's [`RunStatus`]. Part of the ADR-0022 snapshot shape; the
    /// subscribe handler reads it to tell terminal from live under the gate, and
    /// the `thread/get` rehydration read consumes it in a later slice.
    pub status: RunStatus,
}

/// Read the snapshot-then-tail starting point: the assistant message's
/// cumulative text (all `message_parts` concatenated in `seq` order) and the
/// Run status. `None` when the Run does not exist (subscribe handler stays
/// defensible against unknown run ids).
///
/// The stored status is parsed into [`RunStatus`] at this seam; an unknown value
/// surfaces as a loud `sqlx::Error::Decode` (see [`run_status`]).
pub async fn select_run_snapshot(
    pool: &SqlitePool,
    run_id: Uuid,
) -> sqlx::Result<Option<RunSnapshot>> {
    let Some((text, status)) = queries::select_run_snapshot(pool, run_id).await? else {
        return Ok(None);
    };
    let status = RunStatus::from_str(&status)
        .ok_or_else(|| sqlx::Error::Decode(format!("unknown stored run status {status:?}").into()))?;
    Ok(Some(RunSnapshot {
        text: text.unwrap_or_default(),
        status,
    }))
}

/// Rebuild the effective Workflow a Run executes from its persisted snapshot
/// (ADR-0024). The `runs` row snapshots the post-dispatch resolved
/// `name`/`version`/`provider`/`model`/`thinking_level` at Run start; the
/// un-tunable, un-snapshotted fields (`system_prompt`, `tools`) come from the
/// static base Workflow of the same name. `None` when the Run does not exist.
///
/// This is how resume honors ADR-0024 ("a setting changed mid-Run affects the
/// next Run, not the running one"): it reads the snapshot, never re-resolving
/// live settings, so a model/effort change between park and decide cannot leak
/// into the resumed Run.
pub async fn run_workflow_snapshot(
    pool: &SqlitePool,
    run_id: Uuid,
    base: &Workflow,
) -> sqlx::Result<Option<Workflow>> {
    Ok(queries::select_run_workflow_snapshot(pool, run_id)
        .await?
        .map(
            |(name, version, provider, model, thinking_level)| Workflow {
                name,
                version,
                provider,
                model: Some(model),
                thinking_level: Some(thinking_level),
                system_prompt: base.system_prompt.clone(),
                tools: base.tools.clone(),
            },
        ))
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
        TerminalReason::WorkerDisconnected,
        "worker_disconnected",
        "worker exited without emitting done event",
        now_ms,
    )
    .await
}

/// Worker emitted an explicit `error` Run Event (ADR-0006). Same terminal shape
/// as [`error_run`] but with caller-supplied `terminal_reason`, `error_code`,
/// and `error_message` carried into the `runs` row and `run_log` payload. The
/// `runs` CHECK string is produced from `terminal_reason` via `as_str()` inside
/// [`RunStatus::fail`]. One transaction.
pub async fn error_run_with_message(
    pool: &SqlitePool,
    run_id: Uuid,
    terminal_reason: TerminalReason,
    error_code: &str,
    error_message: &str,
    now_ms: i64,
) -> sqlx::Result<Moved> {
    let mut tx = pool.begin().await?;
    let moved =
        RunStatus::fail(&mut *tx, run_id, terminal_reason, error_code, error_message, now_ms)
            .await?;
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
    let error_message = "core restarted while run in flight";
    let swept = queries::recover_interrupted_runs(&mut *tx, error_message, now_ms).await?;
    queries::mark_recovered_streaming_messages_incomplete(&mut *tx, now_ms).await?;
    // Append the terminal `error` Run Log row the typed `fail()` verb would have
    // written, so a crash-recovered Run reads as errored (not Running) in
    // `run/get_history`. Same tx as the status flip.
    queries::append_recovered_error_events(&mut *tx, error_message, now_ms).await?;
    tx.commit().await?;
    Ok(swept)
}
