//! The Run Log: Core's durable record of a Run's lifecycle milestones
//! (ADR-0028). One ordered row per milestone, keyed `(run_id, run_seq)`.
//! Distinct from the wire Run Event (Worker-emitted, never persisted).
//! [`append`] is the single writer, so sequence discipline and the kind
//! vocabulary live here.

use sqlx::SqliteConnection;
use uuid::Uuid;

use super::queries;

/// Run Log row kind: the five Run-status moments plus the two proposal
/// milestones — exactly the values the schema CHECK admits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RunLogKind {
    Running,
    Parked,
    Done,
    Error,
    Cancelled,
    ProposalPending,
    ProposalDecided,
}

impl RunLogKind {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Parked => "parked",
            Self::Done => "done",
            Self::Error => "error",
            Self::Cancelled => "cancelled",
            Self::ProposalPending => "proposal_pending",
            Self::ProposalDecided => "proposal_decided",
        }
    }
}

/// Append one Run Log row, allocating the next per-Run `run_seq` itself; callers
/// supply just the kind and its JSON payload.
///
/// Takes `&mut SqliteConnection` (not a generic `Executor`) because it runs two
/// statements (allocate, then insert) on one connection, so the `run_seq` lands
/// in the same transaction as the status change that produced it.
pub(super) async fn append(
    conn: &mut SqliteConnection,
    run_id: Uuid,
    kind: RunLogKind,
    payload: Option<&str>,
    now_ms: i64,
) -> sqlx::Result<()> {
    let seq = queries::next_run_seq(&mut *conn, run_id).await?;
    queries::insert_run_log_entry(&mut *conn, run_id, seq, kind.as_str(), payload, now_ms).await
}
