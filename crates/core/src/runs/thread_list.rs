//! `thread/list` handler: the first pure-read method (ADR-0022 read path).
//!
//! No params — read every Thread newest-first from tier 2, map each row to a
//! `ThreadSummary`, and frame a `{threads: [...]}` result. A DB read error
//! falls back to `send_error` (internal, -32603); read-only, so there are no
//! client-input error cases to validate.

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;

use super::reply::{send_error, send_response};
use crate::db;
use crate::protocol::{ThreadListResult, ThreadSummary};

pub(super) async fn handle(
    pool: &SqlitePool,
    id: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    let rows = match db::list_threads(pool).await {
        Ok(rows) => rows,
        Err(e) => {
            eprintln!("list_threads failed: {e}");
            send_error(out_tx, id, format!("list_threads: {e}"));
            return;
        }
    };

    let threads = rows
        .into_iter()
        .map(|(id, title, last_activity_at)| ThreadSummary {
            id,
            title,
            last_activity_at,
        })
        .collect();

    send_response(
        out_tx,
        id,
        serde_json::to_value(ThreadListResult { threads })
            .expect("ThreadListResult serializes"),
    );
}
