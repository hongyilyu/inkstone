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
//! A DB read error falls back to `send_error` (internal, -32603).

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;
use uuid::Uuid;

use super::reply::{send_error, send_invalid_params, send_response, send_unknown_thread};
use crate::db;
use crate::protocol::{MessageView, ThreadGetParams, ThreadGetResult};

pub(super) async fn handle(
    pool: &SqlitePool,
    id: serde_json::Value,
    params: ThreadGetParams,
    out_tx: &UnboundedSender<String>,
) {
    let Ok(thread_id) = Uuid::parse_str(&params.thread_id) else {
        send_invalid_params(
            out_tx,
            id,
            format!("invalid thread_id {:?}", params.thread_id),
        );
        return;
    };

    let (title, rows) = match db::get_thread_with_messages(pool, thread_id).await {
        Ok(Some(found)) => found,
        Ok(None) => {
            send_unknown_thread(out_tx, id, format!("unknown thread_id {thread_id}"));
            return;
        }
        Err(e) => {
            eprintln!("get_thread_with_messages failed: {e}");
            send_error(out_tx, id, format!("get_thread_with_messages: {e}"));
            return;
        }
    };

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

    send_response(
        out_tx,
        id,
        serde_json::to_value(ThreadGetResult {
            thread_id: thread_id.to_string(),
            title,
            messages,
        })
        .expect("ThreadGetResult serializes"),
    );
}
