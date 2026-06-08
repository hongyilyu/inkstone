//! Typed lifecycle transitions for Runs and Proposals.
//!
//! Status is materialized in tier 2, but every change funnels through these
//! guarded verbs. The SQL `WHERE status = ...` clause is both the legality
//! check and the race choke; each verb owns the fields and run_events row that
//! must move with the status.

use sqlx::SqliteConnection;
use uuid::Uuid;

use super::queries;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalReason {
    Completed,
    Cancelled,
    WorkerDisconnected,
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

    pub(super) async fn complete(
        conn: &mut SqliteConnection,
        run_id: Uuid,
        now_ms: i64,
    ) -> sqlx::Result<Moved> {
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
            return Ok(moved);
        }

        queries::mark_assistant_messages_completed(&mut *conn, run_id, now_ms).await?;
        let next_seq = queries::next_run_seq(&mut *conn, run_id).await?;
        queries::insert_run_event(&mut *conn, run_id, next_seq, "done", None, now_ms).await?;
        Ok(moved)
    }

    pub(super) async fn fail(
        conn: &mut SqliteConnection,
        run_id: Uuid,
        terminal_reason: TerminalReason,
        error_code: &str,
        error_message: &str,
        now_ms: i64,
    ) -> sqlx::Result<Moved> {
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
            return Ok(moved);
        }

        queries::mark_streaming_messages_incomplete(&mut *conn, run_id, now_ms).await?;
        let payload =
            serde_json::json!({ "code": error_code, "message": error_message }).to_string();
        let next_seq = queries::next_run_seq(&mut *conn, run_id).await?;
        queries::insert_run_event(
            &mut *conn,
            run_id,
            next_seq,
            "error",
            Some(&payload),
            now_ms,
        )
        .await?;
        Ok(moved)
    }
}
