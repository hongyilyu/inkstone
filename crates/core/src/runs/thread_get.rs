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
use crate::db::{self, MessageSegment};
use crate::protocol::{MessageView, Segment, ThreadGetParams, ThreadGetResult};

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
                terminal_reason: row.terminal_reason,
                // Map each db-side timeline item to its wire `Segment` variant,
                // preserving order (ADR-0045). The variants are 1:1.
                segments: row
                    .segments
                    .into_iter()
                    .map(|segment| match segment {
                        MessageSegment::Text { text } => Segment::Text { text },
                        MessageSegment::ToolCall { name, status, arg } => {
                            Segment::ToolCall { name, status, arg }
                        }
                        MessageSegment::Proposal {
                            proposal_id,
                            mutation_kind,
                            status,
                            entity_id,
                        } => Segment::Proposal {
                            proposal_id,
                            mutation_kind,
                            status,
                            entity_id,
                        },
                        MessageSegment::Reasoning { text, duration_ms } => {
                            Segment::Reasoning { text, duration_ms }
                        }
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
