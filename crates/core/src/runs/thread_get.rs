//! `thread/get` handler: rehydrate a Thread plus its Messages (ADR-0022 read
//! path).
//!
//! Read the Thread title (existence check) and its Messages in chronological
//! order, assemble each Message's `text` from its text parts
//! (flat-text-no-parts[], ADR-0017/Q15), and frame `{thread_id, title,
//! messages}`. This is the rehydration source for refresh-durability: a
//! `streaming` assistant Message carries its partial text and `run_id` so a
//! refreshed Client can resubscribe.
//!
//! Validation (ADR-0014 error codes, mirrors `run/post_message`):
//! - A malformed `thread_id` (not a UUID) → `invalid_params` (-32602).
//! - A well-formed `thread_id` for a Thread that does not exist →
//!   `unknown_thread` (-32001).
//! A DB read error surfaces as an internal error (-32603) via the combinator.

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;

use super::handler::{self, HandlerError};
use crate::db;
use crate::protocol::{MessageView, ThreadGetParams, ThreadGetResult};

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
