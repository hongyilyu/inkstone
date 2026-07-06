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

#[cfg(test)]
mod tests {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

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
              thinking_level, user_message_id, status, started_at) \
             VALUES (?, ?, 'w', '1', 'p', 'm', 'off', ?, ?, ?)",
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

    /// The typed read seam fails loudly on an unknown stored status rather than
    /// degrading to `None` (which means "no such Run"). The `runs.status` CHECK
    /// constraint keeps a live DB from ever producing this, so the row is forged
    /// with `PRAGMA ignore_check_constraints` — exercising the defensive
    /// `from_str` → `Decode` arm in `run_status` and `select_run_snapshot`, and
    /// proving the unknown-string error stays distinct from the absent-row `None`.
    #[tokio::test]
    async fn read_seam_rejects_unknown_stored_status() {
        let pool = memory_pool().await;
        // The seam keys on `run_id.to_string()`, so the forged row needs a real
        // UUID id. Relax the CHECK only to seed an out-of-vocabulary status.
        let run_id = Uuid::now_v7();
        sqlx::query("PRAGMA ignore_check_constraints = ON")
            .execute(&pool)
            .await
            .expect("relax checks");
        insert_bare_run(&pool, &run_id.to_string(), "halfway").await;

        // run_status: unknown stored value → Decode, not Ok(None).
        let err = run_status(&pool, run_id)
            .await
            .expect_err("unknown status must surface as an error, not None");
        assert!(
            matches!(err, sqlx::Error::Decode(_)),
            "unknown stored status is a Decode fault, got {err:?}"
        );

        // select_run_snapshot: same defensive arm. `insert_bare_run` already
        // inserted the assistant Message; a `seq=0` part makes the snapshot row
        // JOIN materialize so the parse (not a missing row) is what's exercised.
        sqlx::query(
            "INSERT INTO message_parts (message_id, seq, type, text) \
             VALUES (?, 0, 'text', 'hi')",
        )
        .bind(format!("msg-{run_id}"))
        .execute(&pool)
        .await
        .expect("seed assistant part");
        let snap_err = select_run_snapshot(&pool, run_id)
            .await
            .expect_err("snapshot of an unknown status must error");
        assert!(
            matches!(snap_err, sqlx::Error::Decode(_)),
            "unknown snapshot status is a Decode fault, got {snap_err:?}"
        );

        // An absent Run stays Ok(None) — the error arm must not swallow that case.
        let absent = run_status(&pool, Uuid::now_v7())
            .await
            .expect("absent read ok");
        assert!(absent.is_none(), "an absent Run reads as None, never Decode");
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

        // The sweep appends a terminal `error` Run Log milestone for the swept
        // Run (the raw bulk UPDATE is outside the typed `fail()` verb), so
        // `run/get_history` reads it as errored, not Running. The preserved
        // parked Run gets none.
        assert_eq!(
            run_event_count(&pool, "run-running", "error").await,
            1,
            "swept Run gets one terminal error Run Log row"
        );
        assert_eq!(
            run_event_count(&pool, "run-parked", "error").await,
            0,
            "preserved parked Run gets no error row"
        );
        let recovered_kind: String = sqlx::query_scalar(
            "SELECT kind FROM run_log WHERE run_id = 'run-running' \
             ORDER BY run_seq DESC LIMIT 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            recovered_kind, "error",
            "the recovered Run's latest milestone is error, so the feed shows it errored not running"
        );
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

    /// Seed a Thread (with a distinct `title`) + a bare Run, then append one
    /// Run Log milestone (`kind` at `created_at`) — the minimum to exercise the
    /// `list_run_history` latest-milestone/recency read directly.
    async fn seed_run_with_milestone(
        pool: &SqlitePool,
        run_id: &str,
        title: &str,
        kind: &str,
        created_at: i64,
    ) {
        let mut tx = pool.begin().await.expect("begin");
        sqlx::query(
            "INSERT INTO threads (id, title, created_at, last_activity_at) VALUES (?, ?, ?, ?)",
        )
        .bind(format!("thr-{run_id}"))
        .bind(title)
        .bind(created_at)
        .bind(created_at)
        .execute(&mut *tx)
        .await
        .expect("insert thread");
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, \
              thinking_level, user_message_id, status, started_at) \
             VALUES (?, ?, 'w', '1', 'p', 'm', 'off', ?, 'running', ?)",
        )
        .bind(run_id)
        .bind(format!("thr-{run_id}"))
        .bind(format!("msg-{run_id}"))
        .bind(created_at)
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
        .bind(created_at)
        .bind(created_at)
        .execute(&mut *tx)
        .await
        .expect("insert message");
        tx.commit().await.expect("commit seeded run");

        // The creation `running` row at seq 0, then the supplied milestone at
        // seq 1 (so the latest-milestone selection has more than one row to pick
        // the max from — exactly the live shape `run_log::append` produces).
        queries::insert_run_log_entry(pool, Uuid::parse_str(run_id).unwrap(), 0, "running", None, created_at)
            .await
            .expect("insert running milestone");
        if kind != "running" {
            queries::insert_run_log_entry(
                pool,
                Uuid::parse_str(run_id).unwrap(),
                1,
                kind,
                None,
                created_at,
            )
            .await
            .expect("insert latest milestone");
        }
    }

    /// `list_run_history` returns one row per Run carrying its *latest* milestone
    /// kind verbatim, newest-first by that milestone's `created_at`, capped at
    /// `limit`; an empty Workspace returns an empty Vec.
    #[tokio::test]
    async fn list_run_history_orders_by_recency_with_verbatim_kind() {
        let pool = memory_pool().await;

        // Empty Workspace → empty feed.
        let empty = list_run_history(&pool, 50).await.expect("empty read ok");
        assert!(empty.is_empty(), "a never-run Workspace returns no history");

        // Three Runs at increasing milestone times; the newest is `error`, then
        // `proposal_decided` (a resumed-still-working Run's latest milestone —
        // NOT folded to `running`), then `done` oldest.
        seed_run_with_milestone(
            &pool,
            "11111111-1111-4111-8111-111111111111",
            "oldest done",
            "done",
            100,
        )
        .await;
        seed_run_with_milestone(
            &pool,
            "22222222-2222-4222-8222-222222222222",
            "middle resumed",
            "proposal_decided",
            200,
        )
        .await;
        seed_run_with_milestone(
            &pool,
            "33333333-3333-4333-8333-333333333333",
            "newest error",
            "error",
            300,
        )
        .await;

        let rows = list_run_history(&pool, 50).await.expect("history read ok");
        assert_eq!(rows.len(), 3, "one row per Run");

        // Newest-first by the latest milestone's created_at.
        assert_eq!(rows[0].2, "newest error");
        assert_eq!(rows[0].3, "error", "latest milestone kind verbatim");
        assert_eq!(rows[0].4, 300, "recency key is the milestone created_at");

        assert_eq!(rows[1].2, "middle resumed");
        assert_eq!(
            rows[1].3, "proposal_decided",
            "resumed Run surfaces its proposal_decided milestone, not a folded running"
        );

        assert_eq!(rows[2].2, "oldest done");
        assert_eq!(rows[2].3, "done");

        // thread_id is the owning Thread; run_id is the Run.
        assert_eq!(rows[0].0, "33333333-3333-4333-8333-333333333333");
        assert_eq!(rows[0].1, "thr-33333333-3333-4333-8333-333333333333");

        // The limit caps the row count, keeping the newest.
        let capped = list_run_history(&pool, 2).await.expect("capped read ok");
        assert_eq!(capped.len(), 2, "limit caps the feed");
        assert_eq!(capped[0].2, "newest error");
        assert_eq!(capped[1].2, "middle resumed");
    }

    /// When two Runs' latest milestones share an identical `created_at` (ms ties
    /// are real at this granularity), the `, rl.run_id DESC` tie-break makes the
    /// order deterministic — the higher run_id sorts first.
    #[tokio::test]
    async fn list_run_history_breaks_created_at_ties_by_run_id() {
        let pool = memory_pool().await;

        // Two Runs, same latest-milestone created_at (500). Without the tie-break
        // their relative order would be undefined; with `run_id DESC` the
        // lexically-greater id ("bbbb…") must precede the lesser ("aaaa…").
        let lo = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let hi = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        seed_run_with_milestone(&pool, lo, "lo id", "done", 500).await;
        seed_run_with_milestone(&pool, hi, "hi id", "done", 500).await;

        let rows = list_run_history(&pool, 50).await.expect("history read ok");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].0, hi, "higher run_id sorts first on a created_at tie");
        assert_eq!(rows[1].0, lo);
    }

    /// ADR-0045 reasoning amendment (correctness-critical): a reasoning part is
    /// DISPLAY-ONLY — `read_run_timeline` (the resume transcript reader) must NEVER
    /// surface it as a `TimelineStep::Message`. Replaying thinking without its
    /// provider signature is a live correctness hazard (#201 defers the signed
    /// round-trip), so the resume transcript carries only the surrounding text.
    #[tokio::test]
    async fn read_run_timeline_excludes_reasoning_parts() {
        let pool = memory_pool().await;
        let thread_id = Uuid::now_v7();
        let run_id = Uuid::now_v7();
        let assistant_id = Uuid::now_v7();

        let mut tx = pool.begin().await.expect("begin");
        queries::insert_thread(&mut *tx, thread_id, "T", 1)
            .await
            .expect("thread");
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, \
              thinking_level, user_message_id, status, started_at) \
             VALUES (?, ?, 'w', '1', 'p', 'm', 'medium', ?, 'parked', 1)",
        )
        .bind(run_id.to_string())
        .bind(thread_id.to_string())
        .bind(assistant_id.to_string())
        .execute(&mut *tx)
        .await
        .expect("run");
        queries::insert_message(
            &mut *tx,
            assistant_id,
            thread_id,
            run_id,
            "assistant",
            "completed",
            1,
        )
        .await
        .expect("assistant message");
        // text @ seq 0, reasoning @ seq 1, text @ seq 2 — the reasoning must drop
        // from the resume transcript while the two text steps replay verbatim.
        queries::insert_text_part(&mut *tx, assistant_id, 0, "Replying now.")
            .await
            .expect("text part 0");
        queries::insert_message_run_step(&mut *tx, run_id, 0, assistant_id, 0, 10)
            .await
            .expect("text step 0");
        queries::insert_reasoning_part(&mut *tx, assistant_id, 1, "SECRET-REASONING")
            .await
            .expect("reasoning part 1");
        queries::insert_message_run_step(&mut *tx, run_id, 1, assistant_id, 1, 20)
            .await
            .expect("reasoning step 1");
        queries::insert_text_part(&mut *tx, assistant_id, 2, "All set.")
            .await
            .expect("text part 2");
        queries::insert_message_run_step(&mut *tx, run_id, 2, assistant_id, 2, 30)
            .await
            .expect("text step 2");
        tx.commit().await.expect("commit seed");

        let steps = read_run_timeline(&pool, run_id).await.expect("timeline");

        // No step's text equals the reasoning text — it never replays.
        assert!(
            !steps.iter().any(|s| matches!(
                s,
                TimelineStep::Message { text, .. } if text == "SECRET-REASONING"
            )),
            "a reasoning part must never become a resume transcript Message step"
        );
        // The surrounding text steps still resolve.
        let texts: Vec<&str> = steps
            .iter()
            .filter_map(|s| match s {
                TimelineStep::Message { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            texts,
            vec!["Replying now.", "All set."],
            "text steps replay verbatim, reasoning is dropped"
        );
    }

    /// Drive a bare Run to `errored` directly (terminal fields stamped), to seed
    /// the retry verb's `from` state. Mirrors what `RunStatus::fail` leaves behind.
    async fn mark_bare_run_errored(pool: &SqlitePool, run_id: &str) {
        sqlx::query(
            "UPDATE runs SET status = 'errored', terminal_reason = 'errored', \
             error_code = 'agent_error', error_message = 'boom', ended_at = 99 \
             WHERE id = ?1",
        )
        .bind(run_id)
        .execute(pool)
        .await
        .expect("mark errored");
    }

    /// `RunStatus::retry` lock (ADR-0028 retry amendment, #230): the guarded
    /// `errored → running` flip wins only from `errored`, clears the four terminal
    /// fields, and a `running`/`completed`/`parked`/`cancelled` Run loses (0 rows,
    /// no mutation). The single outbound edge `errored` gains.
    #[tokio::test]
    async fn retry_verb_flips_errored_to_running_and_clears_terminal_fields() {
        let pool = memory_pool().await;
        let run_id = Uuid::now_v7();
        let run = run_id.to_string();
        insert_bare_run(&pool, &run, "running").await;
        mark_bare_run_errored(&pool, &run).await;

        // Won: errored → running, terminal fields cleared.
        let mut tx = pool.begin().await.expect("begin");
        let moved = RunStatus::retry(&mut tx, run_id, 100).await.expect("retry");
        tx.commit().await.expect("commit");
        assert_eq!(moved, Moved::Won);

        let (status, tr, ec, em, ended): (String, Option<String>, Option<String>, Option<String>, Option<i64>) =
            sqlx::query_as(
                "SELECT status, terminal_reason, error_code, error_message, ended_at \
                 FROM runs WHERE id = ?1",
            )
            .bind(&run)
            .fetch_one(&pool)
            .await
            .expect("read run");
        assert_eq!(status, "running");
        assert_eq!(tr, None, "terminal_reason cleared");
        assert_eq!(ec, None, "error_code cleared");
        assert_eq!(em, None, "error_message cleared");
        assert_eq!(ended, None, "ended_at cleared");

        // A retry milestone reuses RunLogKind::Running (no new kind).
        let last_kind: String = sqlx::query_scalar(
            "SELECT kind FROM run_log WHERE run_id = ?1 ORDER BY run_seq DESC LIMIT 1",
        )
        .bind(&run)
        .fetch_one(&pool)
        .await
        .expect("read run_log");
        assert_eq!(last_kind, "running");

        // Lost: a non-errored Run matches 0 rows and is untouched.
        for status in ["running", "completed", "parked", "cancelled"] {
            let other = Uuid::now_v7();
            let other_s = other.to_string();
            insert_bare_run(&pool, &other_s, status).await;
            let mut tx = pool.begin().await.expect("begin");
            let moved = RunStatus::retry(&mut tx, other, 100).await.expect("retry lost");
            tx.commit().await.expect("commit");
            assert_eq!(moved, Moved::Lost, "{status} run cannot be retried");
            assert_eq!(run_status_of(&pool, &other_s).await, status, "{status} unchanged");
        }
    }
}
