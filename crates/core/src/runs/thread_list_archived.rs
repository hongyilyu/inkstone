//! `thread/list_archived` handler (ADR-0052): the inverse of `thread/list` —
//! no params, read every ARCHIVED Thread newest-archived-first, map each row to
//! a `ThreadSummary`, frame `{threads: [...]}`. Reuses `ThreadListResult` (the
//! Archived view is purely additive to the parity gate). Read-only, so the only
//! failure is an internal DB error (via the combinator).

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;

use super::handler::{self, HandlerError};
use crate::db;
use crate::protocol::{ThreadListResult, ThreadSummary};

pub(super) async fn handle(
    pool: &SqlitePool,
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    handler::handle(id, params, out_tx, |_p: serde_json::Value| async move {
        let rows = db::list_archived_threads(pool)
            .await
            .map_err(|e| HandlerError::Internal(e.into()))?;

        let threads = rows
            .into_iter()
            .map(|(id, title, last_activity_at)| ThreadSummary {
                id,
                title,
                last_activity_at,
            })
            .collect();

        Ok(ThreadListResult { threads })
    })
    .await;
}
