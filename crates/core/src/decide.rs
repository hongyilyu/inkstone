//! `crate::decide`: the deep, idempotent Decision-application module (ADR-0025,
//! ADR-0016).
//!
//! [`apply`] takes the decoded `proposal/decide` inputs (proposal id, decision
//! string, optional edited payload, optional idempotency key) plus its plain
//! deps — the pool and an injected `resume` closure — and returns a typed
//! `Result<DecideOutcome, DecideError>`. It owns the whole transaction:
//! idempotency precedence, the guarded apply/reject (a lost race is
//! [`DecideError::LostRace`]), and the resume + still-parked recovery collapsed
//! into ONE trailing resume gate. The `resume` seam is a closure so this module
//! takes no dependency on the `worker` subsystem (ADR-0026); production passes
//! `|run_id| worker::resume(run_id, pool, hubs)`.
//!
//! Mutation dispatch (validate, schema version, accept-decision text) stays
//! behind [`crate::entities`], so neither this module nor the handler matches on
//! a mutation string.

use sqlx::SqlitePool;
use uuid::Uuid;

use crate::db;
use crate::entities;

/// The user's resolution of a Proposal, parsed from the wire `decision` string
/// inside [`apply`] (the STRING only — an `edit`'s payload-PRESENCE requirement
/// is enforced later, on the fresh apply path, NOT at parse time).
enum Decision {
    Accept,
    Reject,
    Edit,
}

/// The successful outcome of a decide: the Proposal was accepted (an Entity
/// landed — its id) or rejected (no Entity). Both carry the `run_id` so the
/// handler can push `proposal/changed` without re-reading it.
#[derive(Debug)]
pub enum DecideOutcome {
    Accepted { run_id: Uuid, entity_id: String },
    Rejected { run_id: Uuid },
}

/// The decide failure vocabulary, owned by this module (NOT the handler's
/// `HandlerError`). The handler maps each to a wire code at one site:
/// `LostRace`/`NotDecidable` → `-32002`, `Invalid` → `-32602`, `Internal` →
/// `-32603`.
#[derive(Debug)]
pub enum DecideError {
    /// The guarded apply/reject flip affected 0 rows — a concurrent decide won
    /// the race. Nothing was applied here.
    LostRace,
    /// The Proposal cannot be decided in its current state (unknown id, already
    /// decided and not recoverable, or its Run is not parked).
    NotDecidable(String),
    /// The inputs are invalid (unknown decision, edit without payload, or the
    /// applied payload fails mutation validation).
    Invalid(String),
    /// An internal fault (a DB error, or a DB inconsistency). Logged
    /// server-side by the handler; never surfaced verbatim to the client.
    Internal(anyhow::Error),
}

/// Apply a Decision on a Proposal (ADR-0025, ADR-0016) then re-drive resume if
/// the Run is still parked. The collapsed transaction:
///
/// 1. parse the `decision` STRING into a [`Decision`] (this module owns it); an
///    unknown decision is `Invalid` — an `edit`'s payload PRESENCE is NOT
///    checked here, only on the fresh path at step 3, so a payload-less `edit`
///    retry of an already-decided Proposal still replays the prior result and
///    re-drives recovery rather than erroring;
/// 2. load the Proposal (unknown id → `NotDecidable`);
/// 3. compute the outcome — keyed idempotent replay, else already-decided
///    recovery-if-still-parked, else a fresh guarded apply/reject (the fresh
///    path is where an `edit` without a payload becomes `Invalid`);
/// 4. ONE trailing resume gate: if the Run is still `parked`, re-drive the
///    injected `resume` (covers a fresh decide, a keyed replay, and an
///    already-decided-still-parked recovery; a no-op once the Run advanced).
///
/// `worker::resume` self-guards the `parked → running` flip, so the trailing
/// gate is safe to fire whenever the Run reads `parked`.
pub async fn apply<F, Fut>(
    pool: &SqlitePool,
    proposal_id: Uuid,
    decision: &str,
    edited_payload: Option<serde_json::Value>,
    idempotency_key: Option<String>,
    resume: F,
) -> Result<DecideOutcome, DecideError>
where
    F: FnOnce(Uuid) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<()>>,
{
    let decision = parse_decision(decision)?;
    let proposal_id = proposal_id.to_string();

    let proposal = db::load_proposal_for_decide(pool, &proposal_id)
        .await
        .map_err(|e| DecideError::Internal(e.into()))?
        .ok_or_else(|| DecideError::NotDecidable(format!("no proposal {proposal_id}")))?;

    let outcome = compute_outcome(
        pool,
        &proposal_id,
        &proposal,
        &decision,
        edited_payload.as_ref(),
        idempotency_key.as_deref(),
    )
    .await?;

    // Single resume gate (replaces the three scattered resume calls + both
    // `recover_resume_if_parked` copies). Reached only on the Ok path.
    if run_is_parked(pool, proposal.run_id).await? {
        resume(proposal.run_id)
            .await
            .map_err(DecideError::Internal)?;
    }

    Ok(outcome)
}

/// Parse the wire `decision` string into a [`Decision`]. An unknown decision is
/// [`DecideError::Invalid`] (no load, no write). This recognizes the STRING
/// only — an `edit`'s payload-presence requirement is deferred to the fresh
/// apply path ([`apply_or_reject`]), so a payload-less `edit` retry of an
/// already-decided Proposal still replays the prior result + recovery rather
/// than erroring before the idempotency/recovery branches.
fn parse_decision(decision: &str) -> Result<Decision, DecideError> {
    match decision {
        "accept" => Ok(Decision::Accept),
        "reject" => Ok(Decision::Reject),
        "edit" => Ok(Decision::Edit),
        other => Err(DecideError::Invalid(format!(
            "decision {other:?} not implemented"
        ))),
    }
}

/// The decide precedence (ADR-0025), collapsed into one flow:
///
/// 1. **Keyed replay** — a repeat decide carrying the SAME recorded key returns
///    the prior result (any Run status), no re-apply.
/// 2. **Already decided** without a key match — if durable yet the Run is still
///    parked, return the prior result (the recovery path; the trailing gate
///    re-resumes). Otherwise it is genuinely not decidable.
/// 3. **Pending** — the Run must be parked; then apply/reject under the guard
///    (and ONLY here is an `edit` without a payload rejected as `Invalid`).
///
/// Steps 1–2 never inspect `edited_payload`: a payload-less retry/replay of an
/// already-decided Proposal replays/recovers, matching the pre-extraction handler.
async fn compute_outcome(
    pool: &SqlitePool,
    proposal_id: &str,
    proposal: &db::DecidableProposal,
    decision: &Decision,
    edited_payload: Option<&serde_json::Value>,
    idempotency_key: Option<&str>,
) -> Result<DecideOutcome, DecideError> {
    if let Some(recorded) = proposal.decision_idempotency_key.as_deref()
        && idempotency_key == Some(recorded)
    {
        return prior_outcome(pool, proposal_id, proposal).await;
    }

    if proposal.status != "pending" {
        if (proposal.status == "accepted" || proposal.status == "rejected")
            && run_is_parked(pool, proposal.run_id).await?
        {
            return prior_outcome(pool, proposal_id, proposal).await;
        }
        return Err(DecideError::NotDecidable(format!(
            "proposal {proposal_id} is {} (not pending)",
            proposal.status
        )));
    }

    if !run_is_parked(pool, proposal.run_id).await? {
        return Err(DecideError::NotDecidable(format!(
            "run {} is not parked",
            proposal.run_id
        )));
    }

    apply_or_reject(
        pool,
        proposal_id,
        proposal,
        decision,
        edited_payload,
        idempotency_key,
    )
    .await
}

/// The prior result of an already-decided Proposal (the keyed-replay / recovery
/// branches): `rejected` → `Rejected`; `accepted` → its created `entity_id`
/// (`entity_id_for_proposal`). An accepted Proposal with no Entity is a DB
/// inconsistency → `Internal`. Callers only reach this for accepted/rejected.
async fn prior_outcome(
    pool: &SqlitePool,
    proposal_id: &str,
    proposal: &db::DecidableProposal,
) -> Result<DecideOutcome, DecideError> {
    match proposal.status.as_str() {
        "rejected" => Ok(DecideOutcome::Rejected {
            run_id: proposal.run_id,
        }),
        "accepted" => {
            let entity_id = db::entity_id_for_proposal(pool, proposal_id)
                .await
                .map_err(|e| DecideError::Internal(e.into()))?
                .ok_or_else(|| {
                    DecideError::Internal(anyhow::anyhow!(
                        "accepted proposal {proposal_id} has no entity"
                    ))
                })?;
            Ok(DecideOutcome::Accepted {
                run_id: proposal.run_id,
                entity_id,
            })
        }
        other => Err(DecideError::Internal(anyhow::anyhow!(
            "prior outcome for proposal {proposal_id} with unexpected status {other}"
        ))),
    }
}

/// The fresh guarded transaction: render the Decision as the awaited tool's
/// result (what the resumed model reads), validate accept/edit (NOT reject) via
/// [`crate::entities`], then ONE atomic [`db::apply_proposal`] / [`db::reject_proposal`].
/// `ApplyError::NotPending` (the guarded flip lost a concurrent race) →
/// `LostRace`; `ApplyError::Sql` → `Internal`.
///
/// This is also where an `edit` WITHOUT an `edited_payload` is rejected as
/// `Invalid` — LATE (only on the fresh path), matching the pre-extraction
/// handler, so the keyed-replay / recovery branches upstream never depend on
/// the retry carrying a payload.
async fn apply_or_reject(
    pool: &SqlitePool,
    proposal_id: &str,
    proposal: &db::DecidableProposal,
    decision: &Decision,
    edited_payload: Option<&serde_json::Value>,
    idempotency_key: Option<&str>,
) -> Result<DecideOutcome, DecideError> {
    let run_id = proposal.run_id;

    if matches!(decision, Decision::Reject) {
        // The decline MUST render as a NORMAL (non-error) tool result so the
        // resumed model continues conversationally (byte-identical to the
        // pre-extraction handler).
        let decision_payload = serde_json::json!({
            "decision": "reject",
            "content": "User declined this proposal.",
            "is_error": false,
        })
        .to_string();
        return match db::reject_proposal(
            pool,
            run_id,
            proposal_id,
            &proposal.tool_call_id,
            idempotency_key,
            &decision_payload,
            db::now_ms(),
        )
        .await
        {
            Ok(()) => Ok(DecideOutcome::Rejected { run_id }),
            Err(db::ApplyError::NotPending) => Err(DecideError::LostRace),
            Err(db::ApplyError::Sql(e)) => Err(DecideError::Internal(e.into())),
        };
    }

    // Accept OR edit. An `edit` REQUIRES an `edited_payload`; its absence is
    // `Invalid` (no write) — checked HERE on the fresh path, NOT at parse time,
    // so a payload-less `edit` retry of an already-decided Proposal replays via
    // the branches above instead of erroring. A plain accept ignores any wire
    // payload (`None`), matching the original. The applied payload is the
    // edited payload for an edit, else the model's proposed payload; validate
    // it first.
    let edited_payload: Option<&serde_json::Value> = match decision {
        Decision::Edit => match edited_payload {
            Some(payload) => Some(payload),
            None => {
                return Err(DecideError::Invalid(
                    "edit requires edited_payload".to_string(),
                ));
            }
        },
        _ => None,
    };
    let applied_payload = edited_payload.unwrap_or(&proposal.payload);

    entities::validate(&proposal.mutation_kind, applied_payload).map_err(DecideError::Invalid)?;

    let decision_payload = serde_json::json!({
        "decision": "accept",
        "content": entities::render_accept(&proposal.mutation_kind, applied_payload),
    })
    .to_string();

    let mutation_kind = &proposal.mutation_kind;
    match db::apply_proposal(
        pool,
        run_id,
        proposal_id,
        &proposal.tool_call_id,
        entities::entity_type(mutation_kind),
        entities::schema_version(mutation_kind),
        &proposal.payload,
        edited_payload,
        entities::source_relation_from_user_message(mutation_kind),
        idempotency_key,
        &decision_payload,
        db::now_ms(),
    )
    .await
    {
        Ok(entity_id) => Ok(DecideOutcome::Accepted { run_id, entity_id }),
        Err(db::ApplyError::NotPending) => Err(DecideError::LostRace),
        Err(db::ApplyError::Sql(e)) => Err(DecideError::Internal(e.into())),
    }
}

/// Whether the Run currently reads `parked`. Backs both the pending-decide
/// precondition and the trailing resume gate.
async fn run_is_parked(pool: &SqlitePool, run_id: Uuid) -> Result<bool, DecideError> {
    Ok(db::run_status(pool, run_id)
        .await
        .map_err(|e| DecideError::Internal(e.into()))?
        .as_deref()
        == Some("parked"))
}

#[cfg(test)]
mod tests {
    use super::{DecideError, DecideOutcome, apply};
    use crate::db;
    use sqlx::SqlitePool;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use uuid::Uuid;

    /// A migrated in-memory pool with `max_connections(1)` so the single
    /// `:memory:` database persists across calls (mirrors `db::tests::memory_pool`).
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

    /// Seed a parked Run + assistant Message + a pending Journal Entry Proposal.
    /// Returns `(run_id, proposal_id)`. The `awaiting_tool_call_id` waitpoint is
    /// set by a trailing UPDATE because that FK is non-deferrable while the
    /// `tool_calls.run_id` FK points back at the Run (a chicken-and-egg the
    /// production `park_on_proposal` avoids by inserting the tool_call first).
    async fn seed_parked_proposal(pool: &SqlitePool) -> (Uuid, Uuid) {
        let run_id = Uuid::now_v7();
        let proposal_id = Uuid::now_v7();
        let run = run_id.to_string();
        let thread = format!("thr-{run}");
        let user_msg = format!("umsg-{run}");
        let asst_msg = format!("amsg-{run}");
        let tool_call_id = format!("tc-{run}");
        let now = db::now_ms();

        let mut tx = pool.begin().await.expect("begin seed");

        sqlx::query(
            "INSERT INTO threads (id, title, created_at, last_activity_at) VALUES (?, 't', ?, ?)",
        )
        .bind(&thread)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await
        .expect("insert thread");

        // Run starts parked; awaiting_tool_call_id is set below once the
        // tool_call exists. user_message_id's FK is DEFERRABLE (resolved at
        // COMMIT against the message inserted next).
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, \
              user_message_id, status, started_at) \
             VALUES (?, ?, 'w', '1', 'p', 'm', ?, 'parked', ?)",
        )
        .bind(&run)
        .bind(&thread)
        .bind(&user_msg)
        .bind(now)
        .execute(&mut *tx)
        .await
        .expect("insert run");

        sqlx::query(
            "INSERT INTO messages (id, thread_id, run_id, role, status, created_at, updated_at) \
             VALUES (?, ?, ?, 'user', 'completed', ?, ?)",
        )
        .bind(&user_msg)
        .bind(&thread)
        .bind(&run)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await
        .expect("insert user message");
        sqlx::query(
            "INSERT INTO messages (id, thread_id, run_id, role, status, created_at, updated_at) \
             VALUES (?, ?, ?, 'assistant', 'streaming', ?, ?)",
        )
        .bind(&asst_msg)
        .bind(&thread)
        .bind(&run)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await
        .expect("insert assistant message");

        sqlx::query(
            "INSERT INTO tool_calls (id, run_id, name, request_payload, status, requested_at) \
             VALUES (?, ?, 'propose_workspace_mutation', ?, 'pending', ?)",
        )
        .bind(&tool_call_id)
        .bind(&run)
        .bind(r#"{"mutation_kind":"create_journal_entry","payload":{"occurred_at":"2026-06-10T10:30:00","body":[{"type":"text","text":"Bought milk."}]},"rationale":"track the moment"}"#)
        .bind(now)
        .execute(&mut *tx)
        .await
        .expect("insert tool_call");

        sqlx::query(
            "INSERT INTO proposals (id, tool_call_id, mutation_kind, status) \
             VALUES (?, ?, 'create_journal_entry', 'pending')",
        )
        .bind(proposal_id.to_string())
        .bind(&tool_call_id)
        .execute(&mut *tx)
        .await
        .expect("insert proposal");

        sqlx::query("UPDATE runs SET awaiting_tool_call_id = ? WHERE id = ?")
            .bind(&tool_call_id)
            .bind(&run)
            .execute(&mut *tx)
            .await
            .expect("set waitpoint");

        tx.commit().await.expect("commit seed");
        (run_id, proposal_id)
    }

    /// A fake resume: records (via the shared flag) that it ran AND flips the
    /// Run `parked → running` like the real `worker::resume`, so a follow-up
    /// keyed replay / the resume gate observe an advanced Run.
    fn resume_closure(
        pool: SqlitePool,
        flag: Arc<AtomicBool>,
    ) -> impl FnOnce(Uuid) -> futures_util::future::BoxFuture<'static, anyhow::Result<()>> {
        use futures_util::FutureExt;
        move |run_id| {
            async move {
                flag.store(true, Ordering::SeqCst);
                db::mark_run_running(&pool, run_id).await?;
                Ok(())
            }
            .boxed()
        }
    }

    async fn entity_count(pool: &SqlitePool) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM entities")
            .fetch_one(pool)
            .await
            .expect("count entities")
    }

    async fn proposal_status(pool: &SqlitePool, proposal_id: &str) -> String {
        sqlx::query_scalar("SELECT status FROM proposals WHERE id = ?")
            .bind(proposal_id)
            .fetch_one(pool)
            .await
            .expect("proposal status")
    }

    async fn tool_call_result(pool: &SqlitePool, proposal_id: &str) -> (String, Option<String>) {
        sqlx::query_as(
            "SELECT tc.status, tc.result_payload FROM tool_calls tc \
             JOIN proposals p ON p.tool_call_id = tc.id WHERE p.id = ?",
        )
        .bind(proposal_id)
        .fetch_one(pool)
        .await
        .expect("tool_call row")
    }

    async fn entity_data(pool: &SqlitePool, entity_id: &str) -> serde_json::Value {
        let data: String = sqlx::query_scalar("SELECT data FROM entities WHERE id = ?")
            .bind(entity_id)
            .fetch_one(pool)
            .await
            .expect("entity data");
        serde_json::from_str(&data).expect("entity data json")
    }

    /// Force a Proposal to `accepted` directly (simulating a prior decide), with
    /// an optional recorded idempotency key.
    async fn force_proposal_accepted(pool: &SqlitePool, proposal_id: &str, key: Option<&str>) {
        let now = db::now_ms();
        sqlx::query(
            "UPDATE proposals SET status='accepted', decided_by='user', \
             decided_at=?, applied_at=?, decision_idempotency_key=? WHERE id=?",
        )
        .bind(now)
        .bind(now)
        .bind(key)
        .bind(proposal_id)
        .execute(pool)
        .await
        .expect("force proposal accepted");
    }

    async fn force_run_status(pool: &SqlitePool, run_id: Uuid, status: &str) {
        sqlx::query("UPDATE runs SET status=? WHERE id=?")
            .bind(status)
            .bind(run_id.to_string())
            .execute(pool)
            .await
            .expect("force run status");
    }

    /// Insert an accepted Entity created via `proposal_id` (so a recovery /
    /// keyed replay's `entity_id_for_proposal` lookup finds it). Returns its id.
    async fn insert_accepted_entity(pool: &SqlitePool, proposal_id: &str) -> String {
        let entity_id = Uuid::now_v7().to_string();
        let now = db::now_ms();
        sqlx::query(
            "INSERT INTO entities \
             (id, type, schema_version, data, created_by, created_via_proposal_id, \
              created_at, updated_at) \
             VALUES (?, 'journal_entry', 1, ?, 'proposal', ?, ?, ?)",
        )
        .bind(&entity_id)
        .bind(r#"{"occurred_at":"2026-06-10T10:30:00","body":[{"type":"text","text":"Bought milk."}]}"#)
        .bind(proposal_id)
        .bind(now)
        .bind(now)
        .execute(pool)
        .await
        .expect("insert accepted entity");
        entity_id
    }

    // 1. accept → Accepted{entity_id}; exactly one entity lands; resume invoked.
    #[tokio::test]
    async fn accept_applies_once_and_resumes() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let resumed = Arc::new(AtomicBool::new(false));

        let outcome = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            Some("k1".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await
        .expect("accept succeeds");

        let entity_id = match outcome {
            DecideOutcome::Accepted { entity_id, .. } => entity_id,
            other => panic!("expected Accepted, got {other:?}"),
        };
        assert!(!entity_id.is_empty(), "accept yields an entity id");
        assert_eq!(entity_count(&pool).await, 1, "exactly one entity lands");
        assert_eq!(
            proposal_status(&pool, &proposal_id.to_string()).await,
            "accepted"
        );
        assert!(resumed.load(Ordering::SeqCst), "resume closure invoked");
    }

    // 2. reject → Rejected; no entity; tool_call resolved with a non-error
    //    decline; resume invoked.
    #[tokio::test]
    async fn reject_resolves_without_applying_and_resumes() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let resumed = Arc::new(AtomicBool::new(false));

        let outcome = apply(
            &pool,
            proposal_id,
            "reject",
            None,
            Some("r1".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await
        .expect("reject succeeds");

        assert!(
            matches!(outcome, DecideOutcome::Rejected { .. }),
            "reject yields Rejected: {outcome:?}"
        );
        assert_eq!(entity_count(&pool).await, 0, "reject applies no entity");
        assert_eq!(
            proposal_status(&pool, &proposal_id.to_string()).await,
            "rejected"
        );
        let (tc_status, payload) = tool_call_result(&pool, &proposal_id.to_string()).await;
        assert_eq!(tc_status, "completed", "decline resolves the tool call");
        let payload: serde_json::Value =
            serde_json::from_str(&payload.expect("decline carries a result payload")).unwrap();
        assert_eq!(payload["decision"], "reject");
        assert_ne!(
            payload["is_error"].as_bool(),
            Some(true),
            "decline is a NORMAL (non-error) tool result"
        );
        assert!(
            resumed.load(Ordering::SeqCst),
            "reject resumes the parked run"
        );
    }

    // 3. edit → Accepted; the entity data holds the EDITED values; resume invoked.
    #[tokio::test]
    async fn edit_applies_edited_payload_and_resumes() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let resumed = Arc::new(AtomicBool::new(false));

        let outcome = apply(
            &pool,
            proposal_id,
            "edit",
            Some(serde_json::json!({
                "occurred_at": "2026-06-10T10:35:00",
                "body": [{ "type": "text", "text": "Bought oat milk." }]
            })),
            Some("e1".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await
        .expect("edit succeeds");

        let entity_id = match outcome {
            DecideOutcome::Accepted { entity_id, .. } => entity_id,
            other => panic!("expected Accepted, got {other:?}"),
        };
        assert_eq!(
            entity_data(&pool, &entity_id).await["body"][0]["text"],
            "Bought oat milk.",
            "entity carries the EDITED body, not the model's proposed payload"
        );
        assert_eq!(
            entity_count(&pool).await,
            1,
            "edit lands exactly one entity"
        );
        assert!(
            resumed.load(Ordering::SeqCst),
            "edit resumes the parked run"
        );
    }

    // 4. same-key replay → the second decide returns the prior Accepted{same
    //    entity_id} and inserts NO second entity (and does not re-resume the
    //    already-advanced Run).
    #[tokio::test]
    async fn same_key_replay_returns_prior_without_reapplying() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;

        let first_flag = Arc::new(AtomicBool::new(false));
        let first = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            Some("same".to_string()),
            resume_closure(pool.clone(), first_flag.clone()),
        )
        .await
        .expect("first accept");
        let first_entity = match first {
            DecideOutcome::Accepted { entity_id, .. } => entity_id,
            other => panic!("expected Accepted, got {other:?}"),
        };
        assert!(
            first_flag.load(Ordering::SeqCst),
            "first decide resumes the parked run"
        );

        let second_flag = Arc::new(AtomicBool::new(false));
        let second = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            Some("same".to_string()),
            resume_closure(pool.clone(), second_flag.clone()),
        )
        .await
        .expect("second accept (replay)");
        match second {
            DecideOutcome::Accepted { entity_id, .. } => {
                assert_eq!(
                    entity_id, first_entity,
                    "replay returns the prior entity id"
                );
            }
            other => panic!("expected Accepted replay, got {other:?}"),
        }
        assert_eq!(
            entity_count(&pool).await,
            1,
            "replay inserts no second entity"
        );
        assert!(
            !second_flag.load(Ordering::SeqCst),
            "replay does not re-resume an already-advanced run"
        );
    }

    // 5. lost race → a Proposal pre-decided by a concurrent decide (different
    //    key) whose Run already advanced off `parked` is no longer decidable;
    //    nothing is re-applied and resume is NOT invoked.
    //
    //    NOTE: `decide::apply` routes an already-decided Proposal through the
    //    keyed-replay / recovery / not-decidable branches BEFORE the guarded DB
    //    flip, so `DecideError::LostRace` (the `ApplyError::NotPending` mapping)
    //    is reachable only under a genuine concurrent TOCTOU and cannot be forced
    //    single-threaded. The deterministic stale-decide outcome here is
    //    `NotDecidable` — which maps to the SAME wire code (`-32002`) as
    //    `LostRace`. The `LostRace` arm itself is exercised by the db-layer
    //    guarded-race tests (`apply_proposal`/`reject_proposal` returning
    //    `NotPending`).
    #[tokio::test]
    async fn stale_decide_after_concurrent_winner_is_not_decidable() {
        let pool = memory_pool().await;
        let (run_id, proposal_id) = seed_parked_proposal(&pool).await;
        force_proposal_accepted(&pool, &proposal_id.to_string(), Some("winner")).await;
        force_run_status(&pool, run_id, "running").await;
        let resumed = Arc::new(AtomicBool::new(false));

        let outcome = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            Some("loser".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await;

        assert!(
            matches!(outcome, Err(DecideError::NotDecidable(_))),
            "a stale decide on an already-decided, advanced Run is not decidable: {outcome:?}"
        );
        assert_eq!(
            entity_count(&pool).await,
            0,
            "the stale decide applies nothing"
        );
        assert!(
            !resumed.load(Ordering::SeqCst),
            "a non-fresh decide does not resume"
        );
    }

    // 6a. still-parked recovery → an already-accepted Proposal whose Run is still
    //     parked returns the prior result AND re-drives resume (the recovery path).
    #[tokio::test]
    async fn still_parked_recovery_returns_prior_and_re_resumes() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        // A prior decide accepted (the entity landed) but its resume failed
        // before flipping the Run, leaving it durably accepted yet still parked.
        force_proposal_accepted(&pool, &proposal_id.to_string(), None).await;
        let prior_entity = insert_accepted_entity(&pool, &proposal_id.to_string()).await;
        let resumed = Arc::new(AtomicBool::new(false));

        let outcome = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            None,
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await
        .expect("recovery returns the prior result");

        match outcome {
            DecideOutcome::Accepted { entity_id, .. } => {
                assert_eq!(
                    entity_id, prior_entity,
                    "recovery returns the prior entity id"
                );
            }
            other => panic!("expected prior Accepted, got {other:?}"),
        }
        assert_eq!(
            entity_count(&pool).await,
            1,
            "recovery inserts no second entity"
        );
        assert!(
            resumed.load(Ordering::SeqCst),
            "still-parked recovery re-drives resume"
        );
    }

    // 6b. for a Run already past `parked`, a keyed replay returns the prior
    //     result but resume is NOT invoked.
    #[tokio::test]
    async fn keyed_replay_after_run_advanced_does_not_re_resume() {
        let pool = memory_pool().await;
        let (run_id, proposal_id) = seed_parked_proposal(&pool).await;
        force_proposal_accepted(&pool, &proposal_id.to_string(), Some("k")).await;
        let prior_entity = insert_accepted_entity(&pool, &proposal_id.to_string()).await;
        force_run_status(&pool, run_id, "completed").await;
        let resumed = Arc::new(AtomicBool::new(false));

        let outcome = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            Some("k".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await
        .expect("keyed replay returns the prior result");

        match outcome {
            DecideOutcome::Accepted { entity_id, .. } => {
                assert_eq!(
                    entity_id, prior_entity,
                    "keyed replay returns the prior entity id"
                );
            }
            other => panic!("expected prior Accepted, got {other:?}"),
        }
        assert!(
            !resumed.load(Ordering::SeqCst),
            "a Run already past parked is not re-resumed"
        );
    }

    // Regression (iter1 FAIL): a payload-less `edit` RETRY of an already-decided
    // Proposal whose Run is still parked must RECOVER (replay the prior result +
    // re-drive resume), NOT short-circuit to `Invalid`. The "edit requires
    // edited_payload" check belongs on the FRESH apply path, AFTER the
    // recovery/idempotency branches — hoisting it ahead of the load (iter1) wedged
    // the Run forever on the ADR-0025 resume-failure recovery path.
    #[tokio::test]
    async fn still_parked_edit_retry_without_payload_recovers() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        // A prior decide accepted (the entity landed) but its resume failed before
        // flipping the Run, leaving it durably accepted yet still parked. The retry
        // re-sends `decision="edit"` but WITHOUT the payload.
        force_proposal_accepted(&pool, &proposal_id.to_string(), None).await;
        let prior_entity = insert_accepted_entity(&pool, &proposal_id.to_string()).await;
        let resumed = Arc::new(AtomicBool::new(false));

        let outcome = apply(
            &pool,
            proposal_id,
            "edit",
            None, // payload-less edit retry — must NOT short-circuit to Invalid
            None,
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await
        .expect("payload-less edit retry recovers the prior result (NOT Invalid)");

        match outcome {
            DecideOutcome::Accepted { entity_id, .. } => {
                assert_eq!(
                    entity_id, prior_entity,
                    "recovery returns the prior entity id"
                );
            }
            other => panic!("expected prior Accepted, got {other:?}"),
        }
        assert_eq!(
            entity_count(&pool).await,
            1,
            "recovery inserts no second entity"
        );
        assert!(
            resumed.load(Ordering::SeqCst),
            "still-parked recovery re-drives resume even for a payload-less edit"
        );
    }

    // The legitimate `Invalid` case (tests-reviewer advisory #2), now on the FRESH
    // path: a fresh pending + parked Proposal decided `edit` WITHOUT a payload is
    // `Invalid` — nothing applied, nothing resumed, Proposal stays re-decidable.
    #[tokio::test]
    async fn fresh_edit_without_payload_is_invalid() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let resumed = Arc::new(AtomicBool::new(false));

        let outcome = apply(
            &pool,
            proposal_id,
            "edit",
            None, // a FRESH edit genuinely requires a payload
            Some("e-none".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await;

        assert!(
            matches!(outcome, Err(DecideError::Invalid(_))),
            "a fresh payload-less edit is Invalid on the fresh path: {outcome:?}"
        );
        assert_eq!(
            entity_count(&pool).await,
            0,
            "an Invalid edit applies nothing"
        );
        assert_eq!(
            proposal_status(&pool, &proposal_id.to_string()).await,
            "pending",
            "an Invalid edit leaves the Proposal pending + re-decidable"
        );
        assert!(
            !resumed.load(Ordering::SeqCst),
            "an Invalid edit does not resume"
        );
    }
}
