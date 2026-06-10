//! The Run Log: Core's durable record of a Run's lifecycle milestones
//! (CONTEXT.md: *Run Log*; ADR-0028). One ordered row per milestone, keyed
//! `(run_id, run_seq)`. Distinct from the wire **Run Event** (Worker-emitted,
//! observational, never persisted).
//!
//! [`append`] is the single writer: it allocates the next `run_seq` and
//! inserts the row in one place, so sequence discipline and the kind
//! vocabulary live here rather than scattered across the transition verbs
//! (`lifecycle`) and the run-creation / park orchestrations that call it.

use sqlx::SqliteConnection;
use uuid::Uuid;

use super::queries;

/// The kind discriminator for a Run Log row: the five Run-status moments plus
/// the two proposal milestones — exactly the values the schema CHECK admits.
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

/// Append one Run Log row, allocating the next per-Run `run_seq` itself. This
/// is the only place sequence allocation and insertion happen; callers (the
/// `lifecycle` transition verbs, run creation, and `park_on_proposal`) supply
/// just the kind and its JSON payload.
///
/// Takes `&mut SqliteConnection` — not a generic `Executor` — because it runs
/// two statements (allocate, then insert) on one connection; every caller
/// already holds a `&mut *tx` / `&mut *conn`, so the matching `run_seq` is
/// written in the same transaction as the status change that produced it.
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
