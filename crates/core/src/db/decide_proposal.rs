//! The one decide envelope for Proposals (ADR-0016, ADR-0025): every Decision —
//! accept or reject, any Proposal family — is one atomic transaction shaped
//! begin → guarded `proposals` flip → family write → tool-call resolve → commit.
//!
//! This module owns the exactly-once decide invariant: the flip under the
//! `WHERE status = 'pending'` guard (in [`ProposalStatus::accept`]/[`reject`])
//! is the SINGLE concurrency choke for deciding. On 0 affected rows a racing
//! decide already won, so the tx drops (rollback), nothing lands, and the
//! loser surfaces [`ApplyError::NotPending`] — exactly one concurrent decide
//! wins. Families plug in as in-tx writers; they never re-implement the guard,
//! the tool-call resolve, or the commit.

use sqlx::{Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

use super::ApplyError;
use super::lifecycle::ProposalStatus;
use super::queries;

/// The Run-coupled coordinates of one Proposal Decision, named once: the
/// owning Run, the `proposals` row, the awaited `tool_calls` row, the ADR-0014
/// retry key, and the decision time every stamped column shares.
pub(crate) struct DecisionCtx<'a> {
    pub run_id: Uuid,
    pub proposal_id: &'a str,
    pub tool_call_id: &'a str,
    pub decision_idempotency_key: Option<&'a str>,
    pub now_ms: i64,
}

/// What a family writer's future resolves to: the open tx handed back, the
/// family's value `T` (e.g. the affected `entity_id`), and the rendered
/// Decision payload for the tool-call resolve.
///
/// CONTRACT: the writer must hand back the SAME still-open transaction it
/// received — never commit it, and never substitute a fresh `pool.begin()` tx
/// — or the envelope's atomicity (flip + write + resolve in one commit) is
/// silently broken.
///
/// The writer takes the tx BY VALUE and returns a boxed `Send` future rather
/// than being an `AsyncFnOnce` borrowing the tx: a borrowed-tx async closure
/// puts a higher-ranked lifetime in the signature, and stable rustc cannot
/// prove `Send` for a generic async closure's future across one
/// ("implementation of `Send` is not general enough"), which the server
/// handler chain above `decide` requires of every decide future. The boxed
/// `dyn Future + Send` is concretely `Send`, so the proof goes through.
pub(crate) type WriterFuture<'w, T> = std::pin::Pin<
    Box<
        dyn Future<Output = Result<(Transaction<'static, Sqlite>, T, String), ApplyError>>
            + Send
            + 'w,
    >,
>;

/// Accept a Proposal in one atomic transaction: flip the `proposals` row to
/// `accepted` under the `status='pending'` guard (stamping `edited_payload` +
/// `decision_idempotency_key`), run the family's `writer` inside the same tx,
/// resolve the awaited `tool_calls` row to `completed` with the Decision
/// payload the writer rendered, and commit. Returns the writer's `T` (e.g. the
/// affected `entity_id`).
///
/// The writer renders the Decision payload AFTER its write returns so the
/// resume transcript can carry the real affected Entity id (ADR-0025). A
/// writer `Err` drops the tx — the flip and the writer's own writes roll back,
/// leaving the Proposal `pending` and the tool call unresolved.
pub(crate) async fn accept<'w, T>(
    pool: &SqlitePool,
    ctx: DecisionCtx<'_>,
    edited_payload: Option<&str>,
    writer: impl FnOnce(Transaction<'static, Sqlite>) -> WriterFuture<'w, T>,
) -> Result<T, ApplyError> {
    let mut tx = pool.begin().await?;

    // Flip the Proposal first under the `status='pending'` guard (the single
    // concurrency choke); on 0 rows a racing decide won, so bail before writing.
    let accepted = ProposalStatus::accept(
        &mut tx,
        ctx.run_id,
        ctx.proposal_id,
        edited_payload,
        ctx.decision_idempotency_key,
        ctx.now_ms,
    )
    .await?;
    if !accepted.won() {
        // tx drops without commit → rollback; nothing changed.
        return Err(ApplyError::NotPending);
    }

    // The family's write, inside this tx. An Err drops the tx — the flip and
    // any writer writes roll back together.
    let (mut tx, value, decision_result_payload) = writer(tx).await?;

    queries::resolve_tool_call(
        &mut *tx,
        ctx.tool_call_id,
        "completed",
        &decision_result_payload,
        ctx.now_ms,
    )
    .await?;

    tx.commit().await?;
    Ok(value)
}

/// Reject a Proposal in one atomic transaction, touching no entity store: flip
/// the `proposals` row to `rejected` under the `status='pending'` guard and
/// resolve the awaited `tool_calls` row to `completed` with a NORMAL
/// (non-error) decline —
/// `{"decision":"reject","content":<decline_content>,"is_error":false}` — so
/// the resumed model continues conversationally (ADR-0025). This is the only
/// build site of that decline JSON.
pub(crate) async fn reject(
    pool: &SqlitePool,
    ctx: DecisionCtx<'_>,
    decline_content: &str,
) -> Result<(), ApplyError> {
    let mut tx = pool.begin().await?;

    // Flip the Proposal first under the `status='pending'` guard; on 0 rows a
    // racing decide won, so bail before resolving the tool call.
    let rejected = ProposalStatus::reject(
        &mut tx,
        ctx.run_id,
        ctx.proposal_id,
        ctx.decision_idempotency_key,
        ctx.now_ms,
    )
    .await?;
    if !rejected.won() {
        // tx drops without commit → rollback; nothing changed.
        return Err(ApplyError::NotPending);
    }

    let decision_payload = serde_json::json!({
        "decision": "reject",
        "content": decline_content,
        "is_error": false,
    })
    .to_string();
    queries::resolve_tool_call(
        &mut *tx,
        ctx.tool_call_id,
        "completed",
        &decision_payload,
        ctx.now_ms,
    )
    .await?;

    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;

    /// A migrated in-memory pool so the schema CHECK constraints are in force.
    /// (Copied from db/proposals.rs's test mod — cfg(test) mods are private
    /// siblings, so the small seeding helpers are duplicated here.)
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

    /// Insert a Thread + a bare Run row in `status` directly (no Worker), to
    /// hand-craft the parked Run a pending Proposal hangs off.
    async fn insert_bare_run(pool: &SqlitePool, run_id: &str, status: &str) {
        let mut tx = pool.begin().await.expect("begin");
        sqlx::query(
            "INSERT INTO threads (id, title, created_at, last_activity_at) VALUES (?, ?, ?, ?)",
        )
        .bind(format!("thr-{run_id}"))
        .bind("t")
        .bind(1_i64)
        .bind(1_i64)
        .execute(&mut *tx)
        .await
        .expect("insert thread");
        // user_message_id FK is DEFERRABLE (resolved at COMMIT), so the run can
        // reference a message inserted later in the same tx.
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, \
              thinking_level, user_message_id, status, started_at) \
             VALUES (?, ?, 'w', '1', 'p', 'm', 'off', ?, ?, ?)",
        )
        .bind(run_id)
        .bind(format!("thr-{run_id}"))
        .bind(format!("msg-{run_id}"))
        .bind(status)
        .bind(1_i64)
        .execute(&mut *tx)
        .await
        .expect("insert run");
        sqlx::query(
            "INSERT INTO messages (id, thread_id, run_id, role, status, created_at, updated_at) \
             VALUES (?, ?, ?, 'assistant', 'streaming', ?, ?)",
        )
        .bind(format!("msg-{run_id}"))
        .bind(format!("thr-{run_id}"))
        .bind(run_id)
        .bind(1_i64)
        .bind(1_i64)
        .execute(&mut *tx)
        .await
        .expect("insert message");
        tx.commit().await.expect("commit bare run");
    }

    /// Seed a pending Proposal awaiting `tool_call_id` on `run_id`, returning
    /// the proposal id.
    async fn seed_pending_proposal(pool: &SqlitePool, run_id: Uuid, tool_call_id: &str) -> String {
        let proposal_id = Uuid::now_v7().to_string();
        let mut tx = pool.begin().await.expect("begin proposal seed");
        queries::insert_tool_call(
            &mut *tx,
            tool_call_id,
            run_id,
            "propose_workspace_mutation",
            r#"{"mutation_kind":"create_journal_entry","payload":{"occurred_at":"2026-06-10T10:30:00","body":[{"type":"text","text":"Bought milk."}]}}"#,
            2,
        )
        .await
        .expect("insert tool call");
        queries::insert_tool_call_run_step(&mut *tx, run_id, 2, tool_call_id, 2)
            .await
            .expect("insert tool step");
        queries::insert_proposal(&mut *tx, &proposal_id, tool_call_id, "create_journal_entry")
            .await
            .expect("insert proposal");
        tx.commit().await.expect("commit proposal seed");
        proposal_id
    }

    async fn proposal_status_of(pool: &SqlitePool, proposal_id: &str) -> String {
        sqlx::query_scalar("SELECT status FROM proposals WHERE id = ?1")
            .bind(proposal_id)
            .fetch_one(pool)
            .await
            .expect("proposal status")
    }

    async fn tool_call_status_of(pool: &SqlitePool, tool_call_id: &str) -> String {
        sqlx::query_scalar("SELECT status FROM tool_calls WHERE id = ?1")
            .bind(tool_call_id)
            .fetch_one(pool)
            .await
            .expect("tool call status")
    }

    async fn tool_call_result_of(pool: &SqlitePool, tool_call_id: &str) -> Option<String> {
        sqlx::query_scalar("SELECT result_payload FROM tool_calls WHERE id = ?1")
            .bind(tool_call_id)
            .fetch_one(pool)
            .await
            .expect("tool call result")
    }

    /// 1. An accept with a trivial writer commits the flip AND the tool-call
    /// resolve atomically, returning the writer's value.
    #[tokio::test]
    async fn accept_commits_flip_and_tool_call_resolve() {
        let pool = memory_pool().await;
        let run_id = Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap();
        insert_bare_run(&pool, &run_id.to_string(), "parked").await;
        let proposal_id = seed_pending_proposal(&pool, run_id, "tool-env-accept").await;

        let value = accept(
            &pool,
            DecisionCtx {
                run_id,
                proposal_id: &proposal_id,
                tool_call_id: "tool-env-accept",
                decision_idempotency_key: None,
                now_ms: 42,
            },
            None,
            |tx| {
                Box::pin(async move {
                    Ok((
                        tx,
                        7_i64,
                        r#"{"decision":"accept","content":"Accepted."}"#.to_string(),
                    ))
                })
            },
        )
        .await
        .expect("accept");
        assert_eq!(value, 7, "the writer's value is returned on commit");

        assert_eq!(proposal_status_of(&pool, &proposal_id).await, "accepted");
        assert_eq!(
            tool_call_status_of(&pool, "tool-env-accept").await,
            "completed"
        );
        assert_eq!(
            tool_call_result_of(&pool, "tool-env-accept")
                .await
                .as_deref(),
            Some(r#"{"decision":"accept","content":"Accepted."}"#),
            "the tool call carries the writer-rendered Decision payload"
        );
    }

    /// 2. An accept on a non-pending Proposal loses the guarded flip: it
    /// returns [`ApplyError::NotPending`] and the writer NEVER runs.
    #[tokio::test]
    async fn accept_on_non_pending_returns_not_pending_and_writer_never_runs() {
        let pool = memory_pool().await;
        let run_id = Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap();
        insert_bare_run(&pool, &run_id.to_string(), "parked").await;
        let proposal_id = seed_pending_proposal(&pool, run_id, "tool-env-lost").await;
        sqlx::query("UPDATE proposals SET status = 'rejected' WHERE id = ?1")
            .bind(&proposal_id)
            .execute(&pool)
            .await
            .expect("pre-decide the proposal");

        let writer_ran = AtomicBool::new(false);
        let writer_ran_flag = &writer_ran;
        let result = accept(
            &pool,
            DecisionCtx {
                run_id,
                proposal_id: &proposal_id,
                tool_call_id: "tool-env-lost",
                decision_idempotency_key: Some("idem-lost"),
                now_ms: 43,
            },
            None,
            |tx| {
                Box::pin(async move {
                    writer_ran_flag.store(true, Ordering::SeqCst);
                    Ok((tx, 0_i64, String::new()))
                })
            },
        )
        .await;

        assert!(matches!(result, Err(ApplyError::NotPending)));
        assert!(
            !writer_ran.load(Ordering::SeqCst),
            "the writer never runs on a lost accept"
        );
        assert_eq!(
            tool_call_status_of(&pool, "tool-env-lost").await,
            "pending",
            "the lost accept resolved no tool call"
        );
        let stamped_key: Option<String> =
            sqlx::query_scalar("SELECT decision_idempotency_key FROM proposals WHERE id = ?1")
                .bind(&proposal_id)
                .fetch_one(&pool)
                .await
                .expect("proposal key");
        assert_eq!(stamped_key, None, "the lost accept stamped nothing");
    }

    /// 3. A writer returning `Err` rolls the WHOLE tx back: the flip, the
    /// writer's own writes, and the tool-call resolve all vanish, leaving the
    /// Proposal `pending` and the tool call unresolved.
    #[tokio::test]
    async fn writer_error_rolls_back_flip_and_resolve() {
        let pool = memory_pool().await;
        let run_id = Uuid::parse_str("33333333-3333-4333-8333-333333333333").unwrap();
        insert_bare_run(&pool, &run_id.to_string(), "parked").await;
        let proposal_id = seed_pending_proposal(&pool, run_id, "tool-env-err").await;

        let result = accept(
            &pool,
            DecisionCtx {
                run_id,
                proposal_id: &proposal_id,
                tool_call_id: "tool-env-err",
                decision_idempotency_key: Some("idem-err"),
                now_ms: 44,
            },
            None,
            |mut tx| {
                Box::pin(async move {
                    // A real in-tx write that MUST roll back with the flip.
                    sqlx::query(
                        "INSERT INTO entities \
                         (id, type, schema_version, data, created_by, \
                          created_via_proposal_id, created_at, updated_at) \
                         VALUES ('e-rollback', 'todo', 1, '{}', 'user', NULL, 44, 44)",
                    )
                    .execute(&mut *tx)
                    .await
                    .expect("in-tx entity insert");
                    Err::<(Transaction<'static, Sqlite>, i64, String), ApplyError>(
                        ApplyError::TargetMissing,
                    )
                })
            },
        )
        .await;

        assert!(
            matches!(result, Err(ApplyError::TargetMissing)),
            "the writer's error surfaces unmapped: {result:?}"
        );
        assert_eq!(
            proposal_status_of(&pool, &proposal_id).await,
            "pending",
            "the flip rolled back with the tx"
        );
        assert_eq!(
            tool_call_status_of(&pool, "tool-env-err").await,
            "pending",
            "no tool call resolved"
        );
        assert_eq!(
            tool_call_result_of(&pool, "tool-env-err").await,
            None,
            "no Decision payload landed"
        );
        let entity_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM entities")
            .fetch_one(&pool)
            .await
            .expect("count entities");
        assert_eq!(entity_count, 0, "the writer's own write rolled back");
    }

    /// 4. A won accept stamps `decision_idempotency_key` AND `edited_payload`
    /// on the `proposals` row.
    #[tokio::test]
    async fn won_accept_stamps_idempotency_key_and_edited_payload() {
        let pool = memory_pool().await;
        let run_id = Uuid::parse_str("44444444-4444-4444-8444-444444444444").unwrap();
        insert_bare_run(&pool, &run_id.to_string(), "parked").await;
        let proposal_id = seed_pending_proposal(&pool, run_id, "tool-env-stamp").await;

        accept(
            &pool,
            DecisionCtx {
                run_id,
                proposal_id: &proposal_id,
                tool_call_id: "tool-env-stamp",
                decision_idempotency_key: Some("idem-env-stamp"),
                now_ms: 45,
            },
            Some(r#"{"title":"Edited"}"#),
            |tx| {
                Box::pin(async move {
                    Ok((
                        tx,
                        (),
                        r#"{"decision":"accept","content":"Accepted."}"#.to_string(),
                    ))
                })
            },
        )
        .await
        .expect("accept");

        let edited: Option<String> =
            sqlx::query_scalar("SELECT edited_payload FROM proposals WHERE id = ?1")
                .bind(&proposal_id)
                .fetch_one(&pool)
                .await
                .expect("proposal edited_payload");
        assert_eq!(edited.as_deref(), Some(r#"{"title":"Edited"}"#));
        let stamped_key: Option<String> =
            sqlx::query_scalar("SELECT decision_idempotency_key FROM proposals WHERE id = ?1")
                .bind(&proposal_id)
                .fetch_one(&pool)
                .await
                .expect("proposal key");
        assert_eq!(stamped_key.as_deref(), Some("idem-env-stamp"));
    }

    /// 5. A reject flips the Proposal `rejected` and resolves the tool call
    /// `completed` with the exact decline JSON (serde_json renders object keys
    /// sorted, so the stored bytes are `content`, `decision`, `is_error`).
    #[tokio::test]
    async fn reject_renders_decline_json_and_resolves_tool_call() {
        let pool = memory_pool().await;
        let run_id = Uuid::parse_str("55555555-5555-4555-8555-555555555555").unwrap();
        insert_bare_run(&pool, &run_id.to_string(), "parked").await;
        let proposal_id = seed_pending_proposal(&pool, run_id, "tool-env-reject").await;

        reject(
            &pool,
            DecisionCtx {
                run_id,
                proposal_id: &proposal_id,
                tool_call_id: "tool-env-reject",
                decision_idempotency_key: Some("idem-env-reject"),
                now_ms: 46,
            },
            "No thanks.",
        )
        .await
        .expect("reject");

        assert_eq!(proposal_status_of(&pool, &proposal_id).await, "rejected");
        assert_eq!(
            tool_call_status_of(&pool, "tool-env-reject").await,
            "completed"
        );
        assert_eq!(
            tool_call_result_of(&pool, "tool-env-reject")
                .await
                .as_deref(),
            Some(r#"{"content":"No thanks.","decision":"reject","is_error":false}"#),
            "the decline renders as a NORMAL (non-error) Decision payload"
        );
        let stamped_key: Option<String> =
            sqlx::query_scalar("SELECT decision_idempotency_key FROM proposals WHERE id = ?1")
                .bind(&proposal_id)
                .fetch_one(&pool)
                .await
                .expect("proposal key");
        assert_eq!(stamped_key.as_deref(), Some("idem-env-reject"));
    }

    /// 6. A reject on a non-pending Proposal loses the guarded flip: it
    /// returns [`ApplyError::NotPending`] and resolves nothing.
    #[tokio::test]
    async fn reject_on_non_pending_returns_not_pending() {
        let pool = memory_pool().await;
        let run_id = Uuid::parse_str("66666666-6666-4666-8666-666666666666").unwrap();
        insert_bare_run(&pool, &run_id.to_string(), "parked").await;
        let proposal_id = seed_pending_proposal(&pool, run_id, "tool-env-reject-lost").await;
        sqlx::query("UPDATE proposals SET status = 'accepted' WHERE id = ?1")
            .bind(&proposal_id)
            .execute(&pool)
            .await
            .expect("pre-decide the proposal");

        let result = reject(
            &pool,
            DecisionCtx {
                run_id,
                proposal_id: &proposal_id,
                tool_call_id: "tool-env-reject-lost",
                decision_idempotency_key: Some("idem-reject-lost"),
                now_ms: 47,
            },
            "No thanks.",
        )
        .await;

        assert!(matches!(result, Err(ApplyError::NotPending)));
        assert_eq!(
            proposal_status_of(&pool, &proposal_id).await,
            "accepted",
            "the prior decision stands"
        );
        assert_eq!(
            tool_call_status_of(&pool, "tool-env-reject-lost").await,
            "pending",
            "the lost reject resolved no tool call"
        );
        assert_eq!(
            tool_call_result_of(&pool, "tool-env-reject-lost").await,
            None,
            "no decline payload landed"
        );
    }
}
