//! `run/get_history` handler (ADR-0028 as-built read path): an optional `limit`,
//! read each Run's latest Run Log milestone newest-first, map each row to a
//! `RunHistoryItem`, frame `{runs: [...]}`. Read-only, so the only failure is an
//! internal DB error (via the combinator). Mirrors `thread_list::handle`.

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;

use super::handler::{self, HandlerError};
use crate::db;
use crate::protocol::{RunGetHistoryParams, RunHistoryItem, RunHistoryResult};

/// How many recent Runs `run/get_history` returns when the caller omits `limit`.
/// A fixed cap (no keyset paging) suits the single-user log (ADR-0007); the feed
/// only ever shows recent activity.
const RUN_HISTORY_DEFAULT_LIMIT: i64 = 50;

/// Hard ceiling on `limit` regardless of what the caller asks for, so an
/// arbitrarily large value can't force a heavy read / huge response frame.
const RUN_HISTORY_MAX_LIMIT: i64 = 200;

pub(super) async fn handle(
    pool: &SqlitePool,
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    handler::handle(id, params, out_tx, |raw: serde_json::Value| async move {
        // Omitted params arrive as `Null` (JsonRpcRequest.params defaults to it);
        // treat that as defaults. A present-but-malformed `limit` (e.g. a string)
        // is still a real `invalid_params`.
        let p: RunGetHistoryParams = if raw.is_null() {
            RunGetHistoryParams::default()
        } else {
            serde_json::from_value(raw)
                .map_err(|e| HandlerError::InvalidParams(format!("invalid params: {e}")))?
        };
        // A non-positive or absent limit falls back to the default; the value is
        // a display cap, not a security boundary. A positive limit is still
        // clamped to a hard ceiling so a huge value can't force a heavy read.
        let limit = match p.limit {
            Some(n) if n > 0 => n.min(RUN_HISTORY_MAX_LIMIT),
            _ => RUN_HISTORY_DEFAULT_LIMIT,
        };

        let rows = db::list_run_history(pool, limit)
            .await
            .map_err(|e| HandlerError::Internal(e.into()))?;

        let runs = rows
            .into_iter()
            .map(|(run_id, thread_id, title, kind, at)| RunHistoryItem {
                run_id,
                thread_id,
                title,
                kind,
                at,
            })
            .collect();

        Ok(RunHistoryResult { runs })
    })
    .await;
}
