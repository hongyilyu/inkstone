//! The `ticktick_writes` state machine's durable verbs (ticktick-writes
//! W-A3): the park-time insert, the phase-A sibling envelope (accept flip +
//! `proposed → executing` — NO tool-call resolve, the remote call runs outside
//! any transaction), and the ONE guarded settle (`executing → settled` +
//! tool-call resolve in one commit). Every state flip is a guarded UPDATE
//! whose `WHERE state = …` clause is both the legality check and the race
//! choke, mirroring `lifecycle.rs`.

use sqlx::SqlitePool;
use uuid::Uuid;

use super::lifecycle::ProposalStatus;
use super::queries;
use super::ApplyError;

pub(crate) use queries::TickTickWriteRow;

/// Read one write row by proposal id.
pub(crate) async fn ticktick_write_by_proposal(
    pool: &SqlitePool,
    proposal_id: &str,
) -> sqlx::Result<Option<TickTickWriteRow>> {
    queries::ticktick_write_by_proposal(pool, proposal_id).await
}

/// Phase A (W-A3), one atomic transaction — the write family's SIBLING of the
/// entity decide envelope: the guarded `proposals` `pending → accepted` flip
/// (stamping `edited_payload` + `decision_idempotency_key`, the same single
/// concurrency choke) plus the guarded `ticktick_writes` `proposed →
/// executing` flip stamping `requested_at`. The awaited `tool_calls` row stays
/// PENDING and the Run stays parked — the POST and the settle happen later,
/// never inside a transaction.
///
/// A lost accept flip is [`ApplyError::NotPending`] (a concurrent decide won;
/// everything rolls back). A won accept whose write row is not `proposed` is a
/// Core-written invariant break — surfaced loud, rolled back.
pub(crate) async fn accept_ticktick_write(
    pool: &SqlitePool,
    run_id: Uuid,
    proposal_id: &str,
    edited_payload: Option<&str>,
    decision_idempotency_key: Option<&str>,
    now_ms: i64,
) -> Result<(), ApplyError> {
    let mut tx = pool.begin().await?;

    let accepted = ProposalStatus::accept(
        &mut tx,
        run_id,
        proposal_id,
        edited_payload,
        decision_idempotency_key,
        now_ms,
    )
    .await?;
    if !accepted.won() {
        return Err(ApplyError::NotPending);
    }

    let flipped = queries::mark_ticktick_write_executing(&mut *tx, proposal_id, now_ms).await?;
    if flipped != 1 {
        // The proposal was pending but its write row is not `proposed` — an
        // invariant break (park inserts the row; only phase A moves it).
        return Err(ApplyError::InvalidMutation(format!(
            "ticktick write for proposal {proposal_id} is not in state proposed"
        )));
    }

    tx.commit().await?;
    Ok(())
}

/// What the ONE guarded settle observed: this caller's flip won (the outcome
/// landed and the tool call resolved), or someone else settled first (the
/// recorded row rides along so the loser returns the durable truth).
#[derive(Debug)]
pub(crate) enum Settle {
    Won,
    AlreadySettled(Option<TickTickWriteRow>),
}

/// The ONE guarded settle path (W-A3): in one transaction, the guarded
/// `executing → settled` flip (+ outcome, `http_status`, `remote_task_id`,
/// `settled_at`) and the awaited tool call's `completed` resolve with the
/// outcome-bearing Decision payload. Exactly three triggers call this — phase
/// C, the deadline watchdog, and the boot sweep (plus the past-bound decide
/// replay as belt); reads NEVER settle. Losing the flip means someone else
/// settled: nothing is written and the recorded row is returned.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn settle_ticktick_write(
    pool: &SqlitePool,
    proposal_id: &str,
    tool_call_id: &str,
    outcome: &str,
    http_status: Option<i64>,
    remote_task_id: Option<&str>,
    decision_result_payload: &str,
    now_ms: i64,
) -> sqlx::Result<Settle> {
    let mut tx = pool.begin().await?;
    let flipped = queries::mark_ticktick_write_settled(
        &mut *tx,
        proposal_id,
        outcome,
        http_status,
        remote_task_id,
        now_ms,
    )
    .await?;
    if flipped != 1 {
        // Lost the flip (or the row is not executing at all): read the durable
        // truth outside the dropped tx.
        drop(tx);
        let row = queries::ticktick_write_by_proposal(pool, proposal_id).await?;
        return Ok(Settle::AlreadySettled(row));
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
    Ok(Settle::Won)
}

/// Every `executing` write's decide coordinates `(proposal_id, tool_call_id,
/// run_id)` — the boot sweep's settle-`unknown` branch.
pub(crate) async fn executing_ticktick_writes(
    pool: &SqlitePool,
) -> sqlx::Result<Vec<(String, String, String)>> {
    queries::executing_ticktick_writes(pool).await
}

/// Every `settled` write whose Run still reads `parked` (`run_id`s) — the boot
/// sweep's resume-only branch (the crash landed between phase C's commit and
/// resume).
pub(crate) async fn settled_ticktick_writes_still_parked(
    pool: &SqlitePool,
) -> sqlx::Result<Vec<String>> {
    queries::settled_ticktick_writes_still_parked(pool).await
}

/// The write state hanging off a parked Run's awaited Proposal (`proposed` /
/// `executing` / `settled`), or `None` when the waitpoint is not the write
/// family — the `run/cancel` matrix's dispatch read.
pub(crate) async fn ticktick_write_state_for_parked_run(
    pool: &SqlitePool,
    run_id: Uuid,
) -> sqlx::Result<Option<String>> {
    queries::ticktick_write_state_for_parked_run(pool, run_id).await
}

/// The settled-window cancel arm (W-A3 matrix): a REAL `parked → cancelled`
/// CAS with NO pending-proposal requirement (the write family's Proposal is
/// already accepted), racing resume's self-guarded `parked → running`. Cancel
/// wins → `true` (no spawn; the recorded outcome stays readable). Resume wins
/// → `false`; the caller re-reads and routes through the running path.
pub(crate) async fn cancel_parked_run_settled_write(
    pool: &SqlitePool,
    run_id: Uuid,
    now_ms: i64,
) -> sqlx::Result<bool> {
    let mut tx = pool.begin().await?;
    let moved = super::lifecycle::RunStatus::cancel(&mut tx, run_id, now_ms).await?;
    if !moved.won() {
        return Ok(false);
    }
    tx.commit().await?;
    Ok(true)
}
