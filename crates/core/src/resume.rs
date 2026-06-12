//! Resume transcript reconstruction (ADR-0025). When a parked Run is decided,
//! Core spawns a fresh Worker whose manifest carries the Run's transcript
//! rebuilt from tier 2 into a typed-block `ManifestMessage[]` (ADR-0018).
//!
//! Provider-validity invariant: EVERY `tool_call` is paired with a `tool_result`
//! — its persisted result if completed, the Decision for the just-decided parked
//! call, or a synthesized "not executed" result for an unexecuted sibling.
//! Providers reject an orphan `tool_result`. The final message is the Decision.

use sqlx::SqlitePool;
use uuid::Uuid;

use crate::db::{self, TimelineStep};
use crate::protocol::{ManifestMessage, ManifestToolCall};

/// One reconstructed transcript block, owning its strings so the spawned resume
/// task can borrow them into the (borrowing) [`ManifestMessage`]. Mirrors that
/// union.
pub enum Block {
    User {
        text: String,
    },
    Assistant {
        text: Option<String>,
        tool_calls: Vec<ToolCallBlock>,
    },
    ToolResult {
        tool_call_id: String,
        content: String,
        is_error: Option<bool>,
    },
}

/// One assistant tool-call block (the request half of a paired tool call).
pub struct ToolCallBlock {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

impl Block {
    /// Borrow this owned block as a wire [`ManifestMessage`]. The arguments
    /// Value is cloned; strings are borrowed.
    pub fn as_message(&self) -> ManifestMessage<'_> {
        match self {
            Block::User { text } => ManifestMessage::User { text },
            Block::Assistant { text, tool_calls } => ManifestMessage::Assistant {
                text: text.as_deref(),
                tool_calls: if tool_calls.is_empty() {
                    None
                } else {
                    Some(
                        tool_calls
                            .iter()
                            .map(|tc| ManifestToolCall {
                                id: &tc.id,
                                name: &tc.name,
                                arguments: tc.arguments.clone(),
                            })
                            .collect(),
                    )
                },
            },
            Block::ToolResult {
                tool_call_id,
                content,
                is_error,
            } => ManifestMessage::ToolResult {
                tool_call_id,
                content,
                is_error: *is_error,
            },
        }
    }
}

/// The synthesized result for a `tool_call` with no persisted result — an
/// unexecuted sibling left pending when the Run parked. Keeps the transcript
/// provider-valid while telling the model it did not run.
const NOT_EXECUTED: &str = "not executed; resubmit if still needed";

/// Reconstruct a Run's resume transcript from tier 2 (ADR-0025). Walks the
/// ordered timeline: a message becomes a `user`/`assistant` block; each
/// `tool_call` step is attached to a trailing assistant block AND emits a paired
/// `tool_result` block (its persisted result, or the "not executed" placeholder).
/// The final block is the Decision `tool_result`, set in the preceding atomic apply.
pub async fn reconstruct(pool: &SqlitePool, run_id: Uuid) -> sqlx::Result<Vec<Block>> {
    let steps = db::read_run_timeline(pool, run_id).await?;
    let mut blocks: Vec<Block> = Vec::new();

    for step in steps {
        match step {
            TimelineStep::Message { role, text } => {
                if role == "assistant" {
                    // Skip the empty seq-0 streaming assistant row — it carries
                    // nothing and resume continues appending into it.
                    if text.is_empty() {
                        continue;
                    }
                    blocks.push(Block::Assistant {
                        text: Some(text),
                        tool_calls: Vec::new(),
                    });
                } else {
                    blocks.push(Block::User { text });
                }
            }
            TimelineStep::ToolCall {
                id,
                name,
                request,
                result,
            } => {
                // Attach the tool_call to a trailing assistant block (reuse a
                // text-less one, else open a fresh one).
                let attach = matches!(
                    blocks.last(),
                    Some(Block::Assistant { text, .. }) if text.is_none()
                );
                if !attach {
                    blocks.push(Block::Assistant {
                        text: None,
                        tool_calls: Vec::new(),
                    });
                }
                if let Some(Block::Assistant { tool_calls, .. }) = blocks.last_mut() {
                    tool_calls.push(ToolCallBlock {
                        id: id.clone(),
                        name,
                        arguments: request,
                    });
                }

                // Pair EVERY tool_call with a result (ADR-0025): the persisted
                // result_payload (the parked call's is the Decision), else the
                // synthesized placeholder.
                let (content, is_error) = match result {
                    Some(payload) => (render_result_content(&payload), None),
                    None => (NOT_EXECUTED.to_string(), Some(false)),
                };
                blocks.push(Block::ToolResult {
                    tool_call_id: id,
                    content,
                    is_error,
                });
            }
        }
    }

    Ok(blocks)
}

/// Render a persisted `result_payload` into `tool_result` content. A Decision
/// payload `{"decision":…, "content":…}` surfaces its `content`; any other shape
/// passes through verbatim, so a non-Proposal tool's output is never lost.
fn render_result_content(payload: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(payload) {
        Ok(v) => v
            .get("content")
            .and_then(|c| c.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| payload.to_string()),
        Err(_) => payload.to_string(),
    }
}
