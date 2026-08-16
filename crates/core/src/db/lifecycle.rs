//! Typed lifecycle transitions for Runs and Proposals. Every status change
//! funnels through these guarded verbs; the SQL `WHERE status = ...` clause is
//! both the legality check and the race choke. Each verb owns the fields and
//! run_log row that move with the status.

use sqlx::SqliteConnection;
use uuid::Uuid;

use super::queries;
use super::run_log::{self, RunLogKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Moved {
    Won,
    Lost,
}

impl Moved {
    fn from_rows(rows: u64) -> Self {
        if rows == 1 { Self::Won } else { Self::Lost }
    }

    pub fn won(self) -> bool {
        matches!(self, Self::Won)
    }
}

/// An external (`ticktick_*`) call a terminal transition settled as
/// interrupted (external-task-views A4): the Run died between the call's
/// started and finished frames. The caller publishes a
/// `tool_call {status: error, result: interrupted}` event per entry after the
/// transaction commits, before the terminal Run Event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InterruptedExternalCall {
    pub tool_call_id: String,
    pub name: String,
}

/// A terminal transition's outcome. `Won` carries the external calls its settle
/// interrupted; `Lost` means a concurrent terminal transition already claimed the
/// Run. A lost move never has interrupted rows — the enum makes that
/// unrepresentable (was a struct whose "empty on a lost move" invariant lived in
/// prose).
#[derive(Debug)]
pub enum Terminal {
    Won {
        interrupted: Vec<InterruptedExternalCall>,
    },
    Lost,
}

impl Terminal {
    pub fn won(&self) -> bool {
        matches!(self, Terminal::Won { .. })
    }
}

/// Settle the Run's still-pending external calls inside a won terminal
/// transition (external-task-views A4) — every terminal verb calls this, so
/// cancel, worker error, EOF, AND the boot recovery sweep share one rule.
async fn settle_interrupted_external_calls(
    conn: &mut SqliteConnection,
    run_id: Uuid,
    now_ms: i64,
) -> sqlx::Result<Vec<InterruptedExternalCall>> {
    let payload = serde_json::to_string(&crate::protocol::TranscriptToolResult::interrupted())
        .expect("TranscriptToolResult serializes");
    let rows =
        queries::settle_pending_external_tool_calls(&mut *conn, run_id, &payload, now_ms).await?;
    Ok(rows
        .into_iter()
        .map(|(tool_call_id, name)| InterruptedExternalCall { tool_call_id, name })
        .collect())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalReason {
    Completed,
    Cancelled,
    WorkerDisconnected,
    // Boot recovery sweep (ADR-0012): the funnel errors each interrupted Run
    // through `fail()` with this reason.
    CoreRestarted,
    Errored,
}

impl TerminalReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
            Self::WorkerDisconnected => "worker_disconnected",
            Self::CoreRestarted => "core_restarted",
            Self::Errored => "errored",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunStatus {
    Running,
    Parked,
    Completed,
    Errored,
    Cancelled,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Parked => "parked",
            Self::Completed => "completed",
            Self::Errored => "errored",
            Self::Cancelled => "cancelled",
        }
    }

    /// Parse a stored `runs.status` value. `None` for an unknown string — the
    /// inverse of [`as_str`](Self::as_str), and the one place the string→enum
    /// mapping lives. The read seam ([`crate::db::run_status`]) maps that `None`
    /// to a loud `sqlx::Error::Decode` rather than degrading silently, mirroring
    /// `entity_type_by_id`; the `runs.status` CHECK constraint means a live DB
    /// never produces an unknown value, so that arm is defensive.
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "running" => Some(Self::Running),
            "parked" => Some(Self::Parked),
            "completed" => Some(Self::Completed),
            "errored" => Some(Self::Errored),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }

    /// Whether the Run is parked, waiting on a Decision (ADR-0025). The parked
    /// classifier lives here once for the resume-gate and subscribe read sites.
    pub fn is_parked(self) -> bool {
        matches!(self, Self::Parked)
    }

    pub(super) async fn complete(
        conn: &mut SqliteConnection,
        run_id: Uuid,
        now_ms: i64,
    ) -> sqlx::Result<Terminal> {
        debug_assert_eq!(Self::Running.as_str(), "running");
        debug_assert_eq!(Self::Completed.as_str(), "completed");
        let moved = Moved::from_rows(
            queries::mark_run_completed(
                &mut *conn,
                run_id,
                TerminalReason::Completed.as_str(),
                now_ms,
            )
            .await?,
        );
        if !moved.won() {
            return Ok(Terminal::Lost);
        }

        queries::mark_assistant_messages_completed(&mut *conn, run_id, now_ms).await?;
        run_log::append(&mut *conn, run_id, RunLogKind::Done, None, now_ms).await?;
        let interrupted = settle_interrupted_external_calls(&mut *conn, run_id, now_ms).await?;
        Ok(Terminal::Won { interrupted })
    }

    pub(super) async fn fail(
        conn: &mut SqliteConnection,
        run_id: Uuid,
        terminal_reason: TerminalReason,
        error_code: &str,
        error_message: &str,
        now_ms: i64,
    ) -> sqlx::Result<Terminal> {
        debug_assert_eq!(Self::Running.as_str(), "running");
        debug_assert_eq!(Self::Errored.as_str(), "errored");
        let moved = Moved::from_rows(
            queries::mark_run_errored(
                &mut *conn,
                run_id,
                terminal_reason.as_str(),
                error_code,
                error_message,
                now_ms,
            )
            .await?,
        );
        if !moved.won() {
            return Ok(Terminal::Lost);
        }

        queries::mark_streaming_messages_incomplete(&mut *conn, run_id, now_ms).await?;
        let payload =
            serde_json::json!({ "code": error_code, "message": error_message }).to_string();
        run_log::append(&mut *conn, run_id, RunLogKind::Error, Some(&payload), now_ms).await?;
        let interrupted = settle_interrupted_external_calls(&mut *conn, run_id, now_ms).await?;
        Ok(Terminal::Won { interrupted })
    }

    pub(super) async fn park(
        conn: &mut SqliteConnection,
        run_id: Uuid,
        awaiting_tool_call_id: &str,
        now_ms: i64,
    ) -> sqlx::Result<Moved> {
        debug_assert_eq!(Self::Running.as_str(), "running");
        debug_assert_eq!(Self::Parked.as_str(), "parked");
        let moved = Moved::from_rows(
            queries::mark_run_parked(&mut *conn, run_id, awaiting_tool_call_id).await?,
        );
        if !moved.won() {
            return Ok(moved);
        }

        let payload =
            serde_json::json!({ "awaiting_tool_call_id": awaiting_tool_call_id }).to_string();
        run_log::append(&mut *conn, run_id, RunLogKind::Parked, Some(&payload), now_ms).await?;
        Ok(moved)
    }

    pub(super) async fn resume(conn: &mut SqliteConnection, run_id: Uuid) -> sqlx::Result<Moved> {
        debug_assert_eq!(Self::Parked.as_str(), "parked");
        debug_assert_eq!(Self::Running.as_str(), "running");
        let moved = Moved::from_rows(queries::mark_run_running(&mut *conn, run_id).await?);
        Ok(moved)
    }

    /// Re-drive an errored Run in place (ADR-0028 retry amendment, #230): the lone
    /// outbound edge `errored` gains. Self-guards on `WHERE status = 'errored'` (the
    /// legality check AND the race choke — a concurrent second retry or boot sweep
    /// that already moved the Run matches 0 rows → `Moved::Lost`). NOT `resume`:
    /// `resume` guards `parked` and would match 0 rows here. On `won()` the terminal
    /// fields are cleared back to live by the guarded query, and the retry milestone
    /// reuses [`RunLogKind::Running`] — the same "now running" moment a fresh start
    /// logs (no new kind, no `run_log` CHECK change). The boot sweep is
    /// unchanged; this is the single user-initiated exception.
    pub(super) async fn retry(
        conn: &mut SqliteConnection,
        run_id: Uuid,
        now_ms: i64,
    ) -> sqlx::Result<Moved> {
        debug_assert_eq!(Self::Errored.as_str(), "errored");
        debug_assert_eq!(Self::Running.as_str(), "running");
        let moved =
            Moved::from_rows(queries::mark_errored_run_running(&mut *conn, run_id).await?);
        if !moved.won() {
            return Ok(moved);
        }

        run_log::append(&mut *conn, run_id, RunLogKind::Running, None, now_ms).await?;
        Ok(moved)
    }

    pub(super) async fn cancel(
        conn: &mut SqliteConnection,
        run_id: Uuid,
        now_ms: i64,
    ) -> sqlx::Result<Moved> {
        debug_assert_eq!(Self::Parked.as_str(), "parked");
        debug_assert_eq!(Self::Cancelled.as_str(), "cancelled");
        let moved = Moved::from_rows(
            queries::mark_parked_run_cancelled(
                &mut *conn,
                run_id,
                TerminalReason::Cancelled.as_str(),
                now_ms,
            )
            .await?,
        );
        if !moved.won() {
            return Ok(moved);
        }

        queries::mark_streaming_messages_incomplete(&mut *conn, run_id, now_ms).await?;
        // Settle still-pending external rows in this transition too — the one
        // rule EVERY terminal verb shares. A parked Run has no live tail, so the
        // settled rows surface on reload/late-subscribe, not as events.
        settle_interrupted_external_calls(&mut *conn, run_id, now_ms).await?;
        let payload = serde_json::json!({ "target": "run" }).to_string();
        run_log::append(&mut *conn, run_id, RunLogKind::Cancelled, Some(&payload), now_ms).await?;
        Ok(moved)
    }

    pub(super) async fn cancel_running(
        conn: &mut SqliteConnection,
        run_id: Uuid,
        now_ms: i64,
    ) -> sqlx::Result<Terminal> {
        debug_assert_eq!(Self::Running.as_str(), "running");
        debug_assert_eq!(Self::Cancelled.as_str(), "cancelled");
        let moved = Moved::from_rows(
            queries::mark_running_run_cancelled(
                &mut *conn,
                run_id,
                TerminalReason::Cancelled.as_str(),
                now_ms,
            )
            .await?,
        );
        if !moved.won() {
            return Ok(Terminal::Lost);
        }

        queries::mark_streaming_messages_incomplete(&mut *conn, run_id, now_ms).await?;
        let payload = serde_json::json!({ "target": "run" }).to_string();
        run_log::append(&mut *conn, run_id, RunLogKind::Cancelled, Some(&payload), now_ms).await?;
        let interrupted = settle_interrupted_external_calls(&mut *conn, run_id, now_ms).await?;
        Ok(Terminal::Won { interrupted })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProposalStatus {
    Pending,
    Accepted,
    Rejected,
    Cancelled,
}

impl ProposalStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Accepted => "accepted",
            Self::Rejected => "rejected",
            Self::Cancelled => "cancelled",
        }
    }

    pub(super) async fn accept(
        conn: &mut SqliteConnection,
        run_id: Uuid,
        proposal_id: &str,
        edited_payload: Option<&str>,
        decision_idempotency_key: Option<&str>,
        now_ms: i64,
    ) -> sqlx::Result<Moved> {
        debug_assert_eq!(Self::Pending.as_str(), "pending");
        let moved = Moved::from_rows(
            queries::mark_proposal_accepted(
                &mut *conn,
                proposal_id,
                edited_payload,
                decision_idempotency_key,
                now_ms,
            )
            .await?,
        );
        if moved.won() {
            insert_proposal_decided_event(
                conn,
                run_id,
                proposal_id,
                ProposalStatus::Accepted,
                now_ms,
            )
            .await?;
        }
        Ok(moved)
    }

    pub(super) async fn reject(
        conn: &mut SqliteConnection,
        run_id: Uuid,
        proposal_id: &str,
        decision_idempotency_key: Option<&str>,
        now_ms: i64,
    ) -> sqlx::Result<Moved> {
        debug_assert_eq!(Self::Pending.as_str(), "pending");
        let moved = Moved::from_rows(
            queries::mark_proposal_rejected(
                &mut *conn,
                proposal_id,
                decision_idempotency_key,
                now_ms,
            )
            .await?,
        );
        if moved.won() {
            insert_proposal_decided_event(
                conn,
                run_id,
                proposal_id,
                ProposalStatus::Rejected,
                now_ms,
            )
            .await?;
        }
        Ok(moved)
    }

    pub(super) async fn cancel(
        conn: &mut SqliteConnection,
        run_id: Uuid,
        proposal_id: &str,
        now_ms: i64,
    ) -> sqlx::Result<Moved> {
        debug_assert_eq!(Self::Pending.as_str(), "pending");
        debug_assert_eq!(Self::Cancelled.as_str(), "cancelled");
        let moved =
            Moved::from_rows(queries::mark_proposal_cancelled(&mut *conn, proposal_id).await?);
        if !moved.won() {
            return Ok(moved);
        }

        let payload = serde_json::json!({
            "target": "proposal",
            "proposal_id": proposal_id,
        })
        .to_string();
        run_log::append(&mut *conn, run_id, RunLogKind::Cancelled, Some(&payload), now_ms).await?;
        Ok(moved)
    }
}

async fn insert_proposal_decided_event(
    conn: &mut SqliteConnection,
    run_id: Uuid,
    proposal_id: &str,
    status: ProposalStatus,
    now_ms: i64,
) -> sqlx::Result<()> {
    let payload = serde_json::json!({
        "proposal_id": proposal_id,
        "status": status.as_str(),
    })
    .to_string();
    run_log::append(&mut *conn, run_id, RunLogKind::ProposalDecided, Some(&payload), now_ms).await
}

#[cfg(test)]
mod tests {
    use super::{RunStatus, TerminalReason};

    /// `TerminalReason::as_str()` is the single owner of the `runs.terminal_reason`
    /// wire string (ADR-0028/0029): the `error_run_*`/`fail`/`cancel`/`complete`
    /// verbs now pass a variant and the string is produced once, here. This pins
    /// every variant to its exact CHECK-constraint value so a rename that would
    /// silently violate the `runs` CHECK fails this test instead of a migration at
    /// runtime.
    #[test]
    fn terminal_reason_as_str_matches_check_vocabulary() {
        assert_eq!(TerminalReason::Completed.as_str(), "completed");
        assert_eq!(TerminalReason::Cancelled.as_str(), "cancelled");
        assert_eq!(TerminalReason::WorkerDisconnected.as_str(), "worker_disconnected");
        assert_eq!(TerminalReason::CoreRestarted.as_str(), "core_restarted");
        assert_eq!(TerminalReason::Errored.as_str(), "errored");
    }

    /// `RunStatus` owns the Run-status vocabulary once (ADR-0028 read side): the
    /// `as_str`/`from_str` round-trip covers every variant, an unknown stored
    /// string is rejected (the `db::run_status` seam maps that `None` to a loud
    /// `Decode` error), and the terminal/parked groupings live here on the type
    /// rather than re-spelled at each read site.
    #[test]
    fn run_status_round_trips_and_classifies() {
        let all = [
            RunStatus::Running,
            RunStatus::Parked,
            RunStatus::Completed,
            RunStatus::Errored,
            RunStatus::Cancelled,
        ];

        // `as_str` → `from_str` round-trips every variant.
        for status in all {
            assert_eq!(
                RunStatus::from_str(status.as_str()),
                Some(status),
                "round-trip {status:?}"
            );
        }

        // An unknown / empty stored string parses to `None`.
        assert_eq!(RunStatus::from_str("bogus"), None);
        assert_eq!(RunStatus::from_str(""), None);

        // Parked grouping: only `parked`.
        assert!(RunStatus::Parked.is_parked());
        for status in [
            RunStatus::Running,
            RunStatus::Completed,
            RunStatus::Errored,
            RunStatus::Cancelled,
        ] {
            assert!(!status.is_parked(), "{status:?} is not parked");
        }
    }
}
