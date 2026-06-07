//! Resume transcript reconstruction (ADR-0025). When a parked Run is decided,
//! Core spawns a FRESH Worker whose manifest carries the Run's transcript
//! rebuilt from tier 2 — `runs` → `run_steps` → `tool_calls` + message text.
//! The transcript is a typed-block `ManifestMessage[]` (ADR-0018 as-built):
//! `user{text}` / `assistant{text, tool_calls}` / `tool_result{…}`.
//!
//! Provider-validity invariant (ADR-0025): EVERY `tool_call` is paired with a
//! `tool_result` — its persisted result if completed, the **Decision** for the
//! just-decided parked call (persisted as that call's `result_payload` inside
//! the atomic apply), or a synthesized "not executed" result for an
//! unexecuted sibling. A `toolResult` is rejected by providers unless its
//! `toolCall` precedes it, so an orphan would break resume. The FINAL message
//! is the Decision `tool_result`.

use sqlx::SqlitePool;
use uuid::Uuid;

use crate::db::{self, TimelineStep};
use crate::protocol::{ManifestMessage, ManifestToolCall};

/// One reconstructed transcript block, owning its strings so the spawned
/// resume task can borrow them into the (borrowing) [`ManifestMessage`] when
/// it serializes the manifest. Mirrors the `ManifestMessage` union.
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
    /// Value is cloned (the manifest owns it); strings are borrowed.
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

/// The synthesized result for a `tool_call` that has no persisted result — an
/// unexecuted sibling left pending when the Run parked (ADR-0025). Keeps the
/// transcript provider-valid (no orphan `tool_call`) while telling the model it
/// did not run.
const NOT_EXECUTED: &str = "not executed; resubmit if still needed";

/// Reconstruct a Run's resume transcript from tier 2 (ADR-0025). Walks the
/// ordered timeline: a user/assistant message becomes a `user`/`assistant`
/// block; each `tool_call` step is attached as a `tool_call` block on a
/// trailing assistant block AND emits a paired `tool_result` block (its
/// persisted result text, or the synthesized "not executed" placeholder). The
/// final block is the Decision `tool_result` — guaranteed because the parked
/// call's `result_payload` was set to the Decision in the atomic apply that
/// precedes this read.
pub async fn reconstruct(pool: &SqlitePool, run_id: Uuid) -> sqlx::Result<Vec<Block>> {
    let steps = db::read_run_timeline(pool, run_id).await?;
    let mut blocks: Vec<Block> = Vec::new();

    for step in steps {
        match step {
            TimelineStep::Message { role, text } => {
                if role == "assistant" {
                    // Skip the empty seq-0 streaming assistant row (no text, no
                    // tool calls yet) — it carries nothing for the transcript
                    // and resume continues appending into it. A non-empty
                    // assistant turn is preserved.
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
                // Attach the tool_call to a trailing assistant block (reuse one
                // with no text/only tool_calls; else open a fresh one), so the
                // assistant turn that issued the call carries it.
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

                // Pair EVERY tool_call with a result (ADR-0025). The parked
                // call's persisted result_payload is the Decision (set in the
                // atomic apply); a completed sibling carries its own result; an
                // unexecuted sibling gets the synthesized placeholder.
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

/// Render a persisted `tool_calls.result_payload` into the `tool_result`
/// content text the model reads. The Decision payload is
/// `{"decision":…, "content":…}` — surface its `content`. A plain-string or
/// other-shaped payload is passed through verbatim (a non-Proposal tool's
/// result), so reconstruction never loses a sibling's output.
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
