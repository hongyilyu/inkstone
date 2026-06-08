//! `thread/list` handler: the first pure-read method (ADR-0022 read path).
//!
//! No params — read every Thread newest-first from tier 2, map each row to a
//! `ThreadSummary`, and frame a `{threads: [...]}` result. A DB read error
//! surfaces as an internal error (-32603) via the combinator (ADR-0029);
//! read-only, so there are no client-input error cases to validate.

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
        let rows = db::list_threads(pool)
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
