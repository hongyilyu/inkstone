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
use crate::protocol::{ManifestMessage, ManifestToolCall, TranscriptToolResult};

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
        result: TranscriptToolResult,
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
                result,
            } => ManifestMessage::ToolResult {
                tool_call_id,
                result,
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
                    // Each assistant text segment is its own step (ADR-0045); the
                    // eager empty seq-0 row that used to be skipped here no longer
                    // exists (open-on-first-delta). A genuinely empty segment (an
                    // empty-string delta) carries nothing, so it is still dropped.
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
                // Pair EVERY tool_call with a result (ADR-0025): the persisted
                // result_payload (the parked call's is the Decision), else the
                // synthesized placeholder — reduced to the ONE transcript result
                // type (external-task-views A4).
                let result = match result {
                    Some(payload) => transcript_result(&name, &payload),
                    None => TranscriptToolResult::text(NOT_EXECUTED, false),
                };
                if let Some(Block::Assistant { tool_calls, .. }) = blocks.last_mut() {
                    tool_calls.push(ToolCallBlock {
                        id: id.clone(),
                        name,
                        arguments: request,
                    });
                }
                blocks.push(Block::ToolResult {
                    tool_call_id: id,
                    result,
                });
            }
        }
    }

    Ok(blocks)
}

/// Reduce a persisted `result_payload` to the ONE transcript result type
/// (external-task-views A4), keyed by the call's kind:
///
/// - **External (`ticktick_*`)**: the payload IS a `TranscriptToolResult` (the
///   finished frame or the interrupted settle wrote it) — decode it verbatim.
/// - **Core success** (`AgentToolResult` JSON): keep the content blocks, drop
///   the runtime `details`/`terminate` sidecars, `is_error: false`.
/// - **Proposal Decision** (`{"decision", "content", is_error?}`): its
///   `content` string as one text block.
/// - **Core error** (`{"code", "message"}`): the message as one text block,
///   `is_error: TRUE` — the migration away from the old string-reduction, which
///   replayed an error payload as a success-shaped result.
/// - Anything else passes through verbatim as one text block, so a tool's
///   output is never lost.
fn transcript_result(name: &str, payload: &str) -> TranscriptToolResult {
    if crate::tools::is_external(name)
        && let Ok(result) = serde_json::from_str::<TranscriptToolResult>(payload)
    {
        return result;
    }
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) {
        // Proposal Decision: {"decision": …, "content": <string>, is_error?}.
        if value.get("decision").is_some()
            && let Some(content) = value.get("content").and_then(|c| c.as_str())
        {
            let is_error = value.get("is_error").and_then(|e| e.as_bool()) == Some(true);
            return TranscriptToolResult::text(content, is_error);
        }
        // Core success: the persisted AgentToolResult {content: [...]}.
        if let Some(content) = value.get("content")
            && let Ok(blocks) =
                serde_json::from_value::<Vec<crate::protocol::ToolTextContent>>(content.clone())
        {
            return TranscriptToolResult {
                content: blocks,
                is_error: false,
            };
        }
        // Core error: {"code": …, "message": <string>}.
        if let Some(message) = value.get("message").and_then(|m| m.as_str())
            && value.get("code").is_some()
        {
            return TranscriptToolResult::text(message, true);
        }
    }
    TranscriptToolResult::text(payload, false)
}

#[cfg(test)]
mod tests {
    use crate::db::test_support::memory_pool;
    use super::*;

    /// Seed a Thread + a parked Run + its user Message (no parts, no steps —
    /// each test lays its own timeline). `user_message_id`'s FK is DEFERRABLE,
    /// so the Run can precede the Message inside one transaction.
    async fn seed_run(pool: &SqlitePool) -> Uuid {
        let run_id = Uuid::now_v7();
        let run = run_id.to_string();
        let mut tx = pool.begin().await.expect("begin seed");
        sqlx::query(
            "INSERT INTO threads (id, title, created_at, last_activity_at) VALUES (?, 't', 1, 1)",
        )
        .bind(format!("thr-{run}"))
        .execute(&mut *tx)
        .await
        .expect("insert thread");
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, \
              thinking_level, user_message_id, status, started_at) \
             VALUES (?, ?, 'w', '1', 'p', 'm', 'off', ?, 'parked', 1)",
        )
        .bind(&run)
        .bind(format!("thr-{run}"))
        .bind(format!("umsg-{run}"))
        .execute(&mut *tx)
        .await
        .expect("insert run");
        sqlx::query(
            "INSERT INTO messages (id, thread_id, run_id, role, status, created_at, updated_at) \
             VALUES (?, ?, ?, 'user', 'completed', 1, 1)",
        )
        .bind(format!("umsg-{run}"))
        .bind(format!("thr-{run}"))
        .bind(&run)
        .execute(&mut *tx)
        .await
        .expect("insert user message");
        tx.commit().await.expect("commit seed");
        run_id
    }

    async fn insert_message(pool: &SqlitePool, run_id: Uuid, id: &str, role: &str) {
        let run = run_id.to_string();
        sqlx::query(
            "INSERT INTO messages (id, thread_id, run_id, role, status, created_at, updated_at) \
             VALUES (?, ?, ?, ?, 'completed', 1, 1)",
        )
        .bind(id)
        .bind(format!("thr-{run}"))
        .bind(&run)
        .bind(role)
        .execute(pool)
        .await
        .expect("insert message");
    }

    async fn insert_text_part(pool: &SqlitePool, message_id: &str, seq: i64, text: &str) {
        sqlx::query(
            "INSERT INTO message_parts (message_id, seq, type, text) VALUES (?, ?, 'text', ?)",
        )
        .bind(message_id)
        .bind(seq)
        .bind(text)
        .execute(pool)
        .await
        .expect("insert text part");
    }

    /// A `kind='message'` `run_steps` row. `(message_id, part_seq)` must point at
    /// an existing `message_parts` row (composite FK + CHECK, 0001_initial.sql).
    async fn step_message(
        pool: &SqlitePool,
        run_id: Uuid,
        seq: i64,
        message_id: &str,
        part_seq: i64,
    ) {
        sqlx::query(
            "INSERT INTO run_steps (run_id, seq, kind, message_id, part_seq, created_at) \
             VALUES (?, ?, 'message', ?, ?, 1)",
        )
        .bind(run_id.to_string())
        .bind(seq)
        .bind(message_id)
        .bind(part_seq)
        .execute(pool)
        .await
        .expect("insert message step");
    }

    /// A `tool_calls` row: `completed` with a `result_payload`, or `pending`
    /// with none (the unexecuted-sibling shape reconstruct must synthesize for).
    async fn insert_tool_call(
        pool: &SqlitePool,
        run_id: Uuid,
        id: &str,
        name: &str,
        request: &str,
        result: Option<&str>,
    ) {
        let status = if result.is_some() {
            "completed"
        } else {
            "pending"
        };
        sqlx::query(
            "INSERT INTO tool_calls \
             (id, run_id, name, request_payload, status, result_payload, requested_at) \
             VALUES (?, ?, ?, ?, ?, ?, 1)",
        )
        .bind(id)
        .bind(run_id.to_string())
        .bind(name)
        .bind(request)
        .bind(status)
        .bind(result)
        .execute(pool)
        .await
        .expect("insert tool_call");
    }

    /// A `kind='tool_call'` `run_steps` row (message_id/part_seq NULL per CHECK).
    async fn step_tool(pool: &SqlitePool, run_id: Uuid, seq: i64, tool_call_id: &str) {
        sqlx::query(
            "INSERT INTO run_steps (run_id, seq, kind, tool_call_id, created_at) \
             VALUES (?, ?, 'tool_call', ?, 1)",
        )
        .bind(run_id.to_string())
        .bind(seq)
        .bind(tool_call_id)
        .execute(pool)
        .await
        .expect("insert tool step");
    }

    /// The just-decided parked call: its persisted `result_payload` is the
    /// Decision, whose `content` becomes the final `tool_result` block the
    /// resumed model reads (ADR-0025).
    #[tokio::test]
    async fn parked_decided_proposal_pairs_decision_result() {
        let pool = memory_pool().await;
        let run_id = seed_run(&pool).await;
        let user_msg = format!("umsg-{run_id}");
        let asst_msg = format!("amsg-{run_id}");
        insert_text_part(&pool, &user_msg, 0, "Log that I bought milk.").await;
        step_message(&pool, run_id, 0, &user_msg, 0).await;
        insert_message(&pool, run_id, &asst_msg, "assistant").await;
        insert_text_part(&pool, &asst_msg, 0, "Proposing a journal entry.").await;
        step_message(&pool, run_id, 1, &asst_msg, 0).await;
        insert_tool_call(
            &pool,
            run_id,
            "tc-1",
            "propose_workspace_mutation",
            r#"{"mutation_kind":"create_journal_entry"}"#,
            Some(r#"{"decision":"accept","content":"Accepted. Created Journal Entry (entity_id=e1)."}"#),
        )
        .await;
        step_tool(&pool, run_id, 2, "tc-1").await;

        let blocks = reconstruct(&pool, run_id).await.expect("reconstruct");
        match blocks.as_slice() {
            [
                Block::User { text: user },
                Block::Assistant {
                    text: Some(asst),
                    tool_calls: no_calls,
                },
                Block::Assistant {
                    text: None,
                    tool_calls,
                },
                Block::ToolResult {
                    tool_call_id,
                    result,
                },
            ] => {
                assert_eq!(user, "Log that I bought milk.");
                assert_eq!(asst, "Proposing a journal entry.");
                assert!(no_calls.is_empty(), "text block carries no tool_calls");
                assert_eq!(tool_calls.len(), 1);
                assert_eq!(tool_calls[0].id, "tc-1");
                assert_eq!(tool_call_id, "tc-1");
                assert_eq!(
                    *result,
                    TranscriptToolResult::text(
                        "Accepted. Created Journal Entry (entity_id=e1).",
                        false
                    ),
                    "a Decision is a normal (non-error) result"
                );
            }
            other => panic!(
                "expected [User, Assistant(text), Assistant(tool_call), ToolResult], got {} blocks",
                other.len()
            ),
        }
    }

    /// The provider-validity invariant (module doc): EVERY `tool_call` pairs
    /// with a `tool_result`. An unexecuted sibling (result NULL — left pending
    /// when the Run parked) gets the synthesized placeholder, `is_error: false`.
    #[tokio::test]
    async fn unexecuted_sibling_gets_not_executed_result() {
        let pool = memory_pool().await;
        let run_id = seed_run(&pool).await;
        insert_tool_call(
            &pool,
            run_id,
            "tc-done",
            "search_entities",
            r#"{"q":"milk"}"#,
            Some(r#"{"content":"no hits"}"#),
        )
        .await;
        step_tool(&pool, run_id, 0, "tc-done").await;
        insert_tool_call(&pool, run_id, "tc-pending", "read_thread", "{}", None).await;
        step_tool(&pool, run_id, 1, "tc-pending").await;

        let blocks = reconstruct(&pool, run_id).await.expect("reconstruct");

        let result = blocks
            .iter()
            .find_map(|b| match b {
                Block::ToolResult {
                    tool_call_id,
                    result,
                } if tool_call_id == "tc-pending" => Some(result),
                _ => None,
            })
            .expect("the unexecuted sibling has a paired result");
        assert_eq!(
            *result,
            TranscriptToolResult::text("not executed; resubmit if still needed", false)
        );

        // The invariant itself, as a loop: no orphan tool_call.
        let call_ids: Vec<&str> = blocks
            .iter()
            .flat_map(|b| match b {
                Block::Assistant { tool_calls, .. } => {
                    tool_calls.iter().map(|tc| tc.id.as_str()).collect()
                }
                _ => Vec::new(),
            })
            .collect();
        assert_eq!(call_ids, ["tc-done", "tc-pending"]);
        for id in call_ids {
            assert!(
                blocks.iter().any(|b| matches!(
                    b,
                    Block::ToolResult { tool_call_id, .. } if tool_call_id == id
                )),
                "tool_call {id} must pair with a tool_result (providers reject an orphan)"
            );
        }
    }

    /// An EXTERNAL (`ticktick_*`) call replays with its persisted
    /// TranscriptToolResult decoded VERBATIM (external-task-views A4): the
    /// resumed model reads the same content blocks + error flag the original
    /// call produced, through the one schema Core results also use. The tool
    /// NAME rides the paired assistant block (the Worker codec restores it).
    #[tokio::test]
    async fn external_call_replays_transcript_result_verbatim() {
        let pool = memory_pool().await;
        let run_id = seed_run(&pool).await;
        insert_tool_call(
            &pool,
            run_id,
            "tc-ext",
            "ticktick_filter_tasks",
            r#"{"filter":{"status":[0]}}"#,
            Some(r#"{"content":[{"type":"text","text":"1 task found"}],"is_error":false}"#),
        )
        .await;
        step_tool(&pool, run_id, 0, "tc-ext").await;

        let blocks = reconstruct(&pool, run_id).await.expect("reconstruct");
        match blocks.as_slice() {
            [
                Block::Assistant { tool_calls, .. },
                Block::ToolResult {
                    tool_call_id,
                    result,
                },
            ] => {
                assert_eq!(tool_calls[0].id, "tc-ext");
                assert_eq!(
                    tool_calls[0].name, "ticktick_filter_tasks",
                    "the paired assistant block carries the tool name for the codec to restore"
                );
                assert_eq!(tool_call_id, "tc-ext");
                assert_eq!(
                    *result,
                    TranscriptToolResult::text("1 task found", false),
                    "the external result decodes verbatim, not string-reduced"
                );
            }
            other => panic!(
                "expected [Assistant(tool_call), ToolResult], got {} blocks",
                other.len()
            ),
        }
    }

    /// The attach predicate (the `matches!` on a trailing TEXT-LESS assistant
    /// block): because every tool_call pairs with its result IMMEDIATELY, the
    /// block trailing at the next call is a ToolResult — so consecutive calls
    /// each open a FRESH assistant block. Pins that one-call-per-block shape.
    #[tokio::test]
    async fn tool_call_attaches_to_trailing_textless_assistant_block() {
        let pool = memory_pool().await;
        let run_id = seed_run(&pool).await;
        insert_tool_call(
            &pool,
            run_id,
            "tc-a",
            "search_entities",
            r#"{"q":"milk"}"#,
            Some(r#"{"content":"[]"}"#),
        )
        .await;
        step_tool(&pool, run_id, 0, "tc-a").await;
        insert_tool_call(
            &pool,
            run_id,
            "tc-b",
            "read_thread",
            "{}",
            Some(r#"{"content":"empty thread"}"#),
        )
        .await;
        step_tool(&pool, run_id, 1, "tc-b").await;

        let blocks = reconstruct(&pool, run_id).await.expect("reconstruct");
        match blocks.as_slice() {
            [
                Block::Assistant {
                    text: None,
                    tool_calls: a,
                },
                Block::ToolResult {
                    tool_call_id: ra, ..
                },
                Block::Assistant {
                    text: None,
                    tool_calls: b,
                },
                Block::ToolResult {
                    tool_call_id: rb, ..
                },
            ] => {
                assert_eq!(a.len(), 1);
                assert_eq!(a[0].id, "tc-a");
                assert_eq!(ra, "tc-a");
                assert_eq!(b.len(), 1);
                assert_eq!(b[0].id, "tc-b");
                assert_eq!(rb, "tc-b");
            }
            other => panic!(
                "expected assistant/result pairs per call, got {} blocks",
                other.len()
            ),
        }
    }

    /// An empty assistant text segment (an empty-string delta) carries nothing
    /// and drops; the surrounding text/tool interleave keeps its order.
    #[tokio::test]
    async fn empty_assistant_segment_dropped_interleaved_order_kept() {
        let pool = memory_pool().await;
        let run_id = seed_run(&pool).await;
        let asst_msg = format!("amsg-{run_id}");
        insert_message(&pool, run_id, &asst_msg, "assistant").await;
        insert_text_part(&pool, &asst_msg, 0, "A").await;
        step_message(&pool, run_id, 0, &asst_msg, 0).await;
        insert_tool_call(
            &pool,
            run_id,
            "tc-1",
            "search_entities",
            "{}",
            Some(r#"{"content":"hits"}"#),
        )
        .await;
        step_tool(&pool, run_id, 1, "tc-1").await;
        insert_text_part(&pool, &asst_msg, 1, "").await;
        step_message(&pool, run_id, 2, &asst_msg, 1).await;
        insert_text_part(&pool, &asst_msg, 2, "B").await;
        step_message(&pool, run_id, 3, &asst_msg, 2).await;

        let blocks = reconstruct(&pool, run_id).await.expect("reconstruct");
        match blocks.as_slice() {
            [
                Block::Assistant { text: Some(a), .. },
                Block::Assistant {
                    text: None,
                    tool_calls,
                },
                Block::ToolResult { .. },
                Block::Assistant { text: Some(b), .. },
            ] => {
                assert_eq!(a, "A");
                assert_eq!(tool_calls.len(), 1);
                assert_eq!(b, "B");
            }
            other => panic!(
                "the empty segment must drop, order must hold; got {} blocks",
                other.len()
            ),
        }
    }

    /// Every persisted payload shape reduces to the ONE transcript result type
    /// (external-task-views A4): Decisions surface their `content`; a Core
    /// error migrates to `is_error: true` (no longer replayed success-shaped);
    /// a Core success keeps its content blocks and DROPS the runtime
    /// `details`/`terminate` sidecars; an external payload decodes verbatim;
    /// anything else passes through as one text block so output is never lost.
    #[test]
    fn transcript_result_reduces_every_payload_shape() {
        // Proposal Decisions: accept and reject are both normal results.
        assert_eq!(
            transcript_result(
                "propose_workspace_mutation",
                r#"{"decision":"accept","content":"Accepted. Created Person (entity_id=e1)."}"#
            ),
            TranscriptToolResult::text("Accepted. Created Person (entity_id=e1).", false)
        );
        assert_eq!(
            transcript_result(
                "propose_workspace_mutation",
                r#"{"decision":"reject","content":"User declined this proposal.","is_error":false}"#
            ),
            TranscriptToolResult::text("User declined this proposal.", false)
        );

        // Core success: content blocks verbatim, details/terminate dropped.
        assert_eq!(
            transcript_result(
                "search_entities",
                r#"{"content":[{"type":"text","text":"no hits"}],"details":{"secret":"x"},"terminate":true}"#
            ),
            TranscriptToolResult::text("no hits", false)
        );

        // Core error: is_error TRUE (the old string-reduction replayed this as
        // a success-shaped raw JSON string).
        assert_eq!(
            transcript_result("search_entities", r#"{"code":"bad_params","message":"boom"}"#),
            TranscriptToolResult::text("boom", true)
        );

        // External: the payload IS a TranscriptToolResult — decoded verbatim,
        // error flag preserved.
        assert_eq!(
            transcript_result(
                "ticktick_filter_tasks",
                r#"{"content":[{"type":"text","text":"interrupted"}],"is_error":true}"#
            ),
            TranscriptToolResult::interrupted()
        );

        // Pass-throughs: non-JSON, JSON without a decodable shape.
        assert_eq!(
            transcript_result("search_entities", "plain text output"),
            TranscriptToolResult::text("plain text output", false)
        );
        assert_eq!(
            transcript_result("search_entities", r#"{"ok":true}"#),
            TranscriptToolResult::text(r#"{"ok":true}"#, false)
        );
        assert_eq!(
            transcript_result("search_entities", r#"{"content":42}"#),
            TranscriptToolResult::text(r#"{"content":42}"#, false)
        );
    }
}
