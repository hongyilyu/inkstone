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

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    /// A migrated in-memory pool with `max_connections(1)` so the single
    /// `:memory:` database persists across calls.
    async fn memory_pool() -> SqlitePool {
        let options = SqliteConnectOptions::new()
            .filename(":memory:")
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("open in-memory sqlite");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        pool
    }

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
                    content,
                    is_error,
                },
            ] => {
                assert_eq!(user, "Log that I bought milk.");
                assert_eq!(asst, "Proposing a journal entry.");
                assert!(no_calls.is_empty(), "text block carries no tool_calls");
                assert_eq!(tool_calls.len(), 1);
                assert_eq!(tool_calls[0].id, "tc-1");
                assert_eq!(tool_call_id, "tc-1");
                assert_eq!(content, "Accepted. Created Journal Entry (entity_id=e1).");
                assert_eq!(*is_error, None, "a Decision is a normal result");
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

        let (content, is_error) = blocks
            .iter()
            .find_map(|b| match b {
                Block::ToolResult {
                    tool_call_id,
                    content,
                    is_error,
                } if tool_call_id == "tc-pending" => Some((content.as_str(), *is_error)),
                _ => None,
            })
            .expect("the unexecuted sibling has a paired result");
        assert_eq!(content, "not executed; resubmit if still needed");
        assert_eq!(is_error, Some(false));

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

    /// A Decision payload surfaces its `content`; anything else — non-JSON, JSON
    /// without a STRING `content` — passes through verbatim so a non-Proposal
    /// tool's output is never lost.
    #[test]
    fn render_result_content_unwraps_decision_and_passes_through() {
        assert_eq!(
            render_result_content(
                r#"{"decision":"accept","content":"Accepted. Created Todo (entity_id=e1)."}"#
            ),
            "Accepted. Created Todo (entity_id=e1)."
        );
        assert_eq!(
            render_result_content(
                r#"{"decision":"reject","content":"User declined this proposal.","is_error":false}"#
            ),
            "User declined this proposal."
        );
        assert_eq!(
            render_result_content("plain text output"),
            "plain text output"
        );
        assert_eq!(render_result_content(r#"{"ok":true}"#), r#"{"ok":true}"#);
        assert_eq!(
            render_result_content(r#"{"content":42}"#),
            r#"{"content":42}"#
        );
    }
}
