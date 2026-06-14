//! Typed lifecycle transitions for Runs and Proposals. Every status change
//! funnels through these guarded verbs; the SQL `WHERE status = ...` clause is
//! both the legality check and the race choke. Each verb owns the fields and
//! run_log row that move with the status.

use sqlx::SqliteConnection;
use uuid::Uuid;

use super::message_fts;
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
        // Index the now-completed assistant Message's finalized text into the
        // tier-3 search projection (ADR-0035), in this same transaction. This is
        // the only transition that completes assistant Messages; `fail`/`park`/
        // `cancel` leave them streaming/incomplete and must not index. Empty text
        // is skipped by `index_message`.
        if let Some(message_id) = queries::assistant_message_id_for_run(&mut *conn, run_id).await? {
            if let Some(thread_id) = queries::thread_id_for_message(&mut *conn, &message_id).await?
            {
                let text = queries::text_parts_by_message(&mut *conn, &message_id)
                    .await?
                    .concat();
                message_fts::index_message(
                    &mut *conn,
                    &message_id,
                    &thread_id,
                    &run_id.to_string(),
                    "assistant",
                    &text,
                )
                .await?;
            }
        }
        run_log::append(&mut *conn, run_id, RunLogKind::Done, None, now_ms).await?;
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
        run_log::append(&mut *conn, run_id, RunLogKind::Error, Some(&payload), now_ms).await?;
        Ok(moved)
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
        let payload = serde_json::json!({ "target": "run" }).to_string();
        run_log::append(&mut *conn, run_id, RunLogKind::Cancelled, Some(&payload), now_ms).await?;
        Ok(moved)
    }

    pub(super) async fn cancel_running(
        conn: &mut SqliteConnection,
        run_id: Uuid,
        now_ms: i64,
    ) -> sqlx::Result<Moved> {
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
            return Ok(moved);
        }

        queries::mark_streaming_messages_incomplete(&mut *conn, run_id, now_ms).await?;
        let payload = serde_json::json!({ "target": "run" }).to_string();
        run_log::append(&mut *conn, run_id, RunLogKind::Cancelled, Some(&payload), now_ms).await?;
        Ok(moved)
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
