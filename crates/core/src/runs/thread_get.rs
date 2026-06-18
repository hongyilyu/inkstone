//! `thread/get` handler: rehydrate a Thread plus its Messages in chronological
//! order (ADR-0022 read path). The rehydration source for refresh-durability:
//! a `streaming` assistant Message carries its partial text and `run_id` so a
//! refreshed Client can resubscribe.
//!
//! Validation (ADR-0014, mirrors `run/post_message`): a malformed `thread_id`
//! → `invalid_params`; a well-formed but unknown one → `unknown_thread`.

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;

use super::handler::{self, HandlerError};
use crate::db;
use crate::protocol::{MessageView, ThreadGetParams, ThreadGetResult, ToolCallView};

pub(super) async fn handle(
    pool: &SqlitePool,
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    handler::handle(id, params, out_tx, |params: ThreadGetParams| async move {
        let thread_id = params.thread_id;
        let (title, rows) = db::get_thread_with_messages(pool, thread_id)
            .await
            .map_err(|e| HandlerError::Internal(e.into()))?
            .ok_or(HandlerError::UnknownThread(thread_id))?;

        let messages = rows
            .into_iter()
            .map(|row| MessageView {
                id: row.id,
                role: row.role,
                status: row.status,
                run_id: row.run_id,
                text: row.text,
                tool_calls: row
                    .tool_calls
                    .into_iter()
                    .map(|tc| ToolCallView {
                        name: tc.name,
                        status: tc.status,
                    })
                    .collect(),
            })
            .collect();

        Ok(ThreadGetResult {
            thread_id: thread_id.to_string(),
            title,
            messages,
        })
    })
    .await;
}
