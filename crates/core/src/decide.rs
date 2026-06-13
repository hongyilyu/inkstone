//! Idempotent Decision-application for `proposal/decide` (ADR-0025, ADR-0016).
//!
//! [`apply`] owns the whole transaction: idempotency precedence, the guarded
//! apply/reject (lost race → [`DecideError::LostRace`]), and one trailing resume
//! gate. The `resume` seam is a closure so this module takes no `worker`
//! dependency (ADR-0026). Mutation dispatch stays behind [`crate::entities`].

use sqlx::SqlitePool;
use uuid::Uuid;

use crate::db;
use crate::entities;

/// The user's resolution of a Proposal, parsed from the wire `decision` string.
/// An `edit`'s payload-presence is enforced later (fresh apply path), not here.
enum Decision {
    Accept,
    Reject,
    Edit,
}

/// A successful decide: accepted (an Entity landed) or rejected. Both carry the
/// `run_id` so the handler can push `proposal/changed` without re-reading it.
#[derive(Debug)]
pub enum DecideOutcome {
    Accepted { run_id: Uuid, entity_id: String },
    Rejected { run_id: Uuid },
}

/// The decide failure vocabulary. The handler maps each to a wire code:
/// `LostRace`/`NotDecidable` → `-32002`, `Invalid` → `-32602`, `Internal` →
/// `-32603`.
#[derive(Debug)]
pub enum DecideError {
    /// The guarded apply/reject flip affected 0 rows — a concurrent decide won.
    LostRace,
    /// The Proposal cannot be decided in its current state (unknown id, already
    /// decided and not recoverable, or its Run is not parked).
    NotDecidable(String),
    /// Invalid inputs (unknown decision, edit without payload, or the applied
    /// payload fails mutation validation).
    Invalid(String),
    /// A DB error or inconsistency. Logged server-side; never surfaced verbatim.
    Internal(anyhow::Error),
}

/// Apply a Decision on a Proposal (ADR-0025, ADR-0016), then re-drive resume if
/// the Run is still parked:
///
/// 1. parse the `decision` string (unknown → `Invalid`);
/// 2. load the Proposal (unknown id → `NotDecidable`);
/// 3. compute the outcome — keyed replay, else already-decided
///    recovery-if-still-parked, else a fresh guarded apply/reject;
/// 4. one trailing resume gate: if the Run still reads `parked`, re-drive the
///    injected `resume` (a no-op once the Run advanced).
///
/// `worker::resume` self-guards the `parked → running` flip, so the gate is safe
/// to fire whenever the Run reads `parked`.
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

    // Single resume gate, reached only on the Ok path.
    if run_is_parked(pool, proposal.run_id).await? {
        resume(proposal.run_id)
            .await
            .map_err(DecideError::Internal)?;
    }

    Ok(outcome)
}

/// Parse the wire `decision` string; unknown → [`DecideError::Invalid`]. Only
/// the string — an `edit`'s payload-presence is deferred to [`apply_or_reject`]
/// so a payload-less `edit` retry still replays/recovers rather than erroring.
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

/// The decide precedence (ADR-0025):
///
/// 1. **Keyed replay** — a repeat decide with the SAME recorded key returns the
///    prior result (any Run status), no re-apply.
/// 2. **Already decided** without a key match — return the prior result if the
///    Run is still parked (recovery; trailing gate re-resumes), else not
///    decidable.
/// 3. **Pending** — the Run must be parked, then apply/reject under the guard.
///
/// Steps 1–2 never inspect `edited_payload`, so a payload-less retry/replay
/// recovers rather than erroring.
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

/// The prior result of an already-decided Proposal: `rejected` → `Rejected`;
/// `accepted` → its created `entity_id`. An accepted Proposal with no Entity is
/// a DB inconsistency → `Internal`. Only reached for accepted/rejected.
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
                .or_else(|| {
                    entities::target_entity_id(&proposal.mutation_kind, &proposal.payload)
                        .map(str::to_string)
                })
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
/// result, validate accept/edit (not reject) via [`crate::entities`], then one
/// atomic [`db::apply_proposal`] / [`db::reject_proposal`]. `NotPending` →
/// `LostRace`; `InvalidMutation` → `Invalid`; `Sql` → `Internal`. Also where an
/// `edit` without an `edited_payload` is rejected as `Invalid` (late, so the
/// recovery branches upstream never depend on the retry carrying a payload).
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
        // A decline renders as a NORMAL (non-error) tool result so the resumed
        // model continues conversationally.
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
            Err(db::ApplyError::InvalidMutation(reason)) => Err(DecideError::Invalid(reason)),
            Err(db::ApplyError::NotPending) => Err(DecideError::LostRace),
            Err(db::ApplyError::Sql(e)) => Err(DecideError::Internal(e.into())),
        };
    }

    // Accept or edit. An `edit` requires an `edited_payload` (absence → `Invalid`,
    // checked here so a payload-less retry replays via the branches above); a
    // plain accept ignores any wire payload. The applied payload is the edited
    // one for an edit, else the proposed payload; validate it first.
    if matches!(decision, Decision::Edit)
        && matches!(
            proposal.mutation_kind.as_str(),
            "delete_journal_entry"
                | "delete_person"
                | "delete_project"
                | "delete_todo"
                | "reference_existing_entity_from_journal_entry"
        )
    {
        return Err(DecideError::Invalid(format!(
            "{} does not support edit",
            proposal.mutation_kind
        )));
    }

    let edited_payload = match decision {
        Decision::Edit => match edited_payload {
            Some(payload) => Some(preserve_update_target_entity_id(
                &proposal.mutation_kind,
                &proposal.payload,
                payload,
            )?),
            None => {
                return Err(DecideError::Invalid(
                    "edit requires edited_payload".to_string(),
                ));
            }
        },
        _ => None,
    };
    let edited_payload = edited_payload.as_ref();
    let applied_payload = edited_payload.unwrap_or(&proposal.payload);

    entities::validate(&proposal.mutation_kind, applied_payload).map_err(DecideError::Invalid)?;
    validate_mutation_target(
        pool,
        proposal.run_id,
        &proposal.mutation_kind,
        applied_payload,
    )
    .await?;

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
        mutation_kind,
        entities::entity_type(mutation_kind),
        entities::schema_version(mutation_kind),
        entities::target_entity_id(mutation_kind, applied_payload),
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
        Err(db::ApplyError::InvalidMutation(reason)) => Err(DecideError::Invalid(reason)),
        Err(db::ApplyError::NotPending) => Err(DecideError::LostRace),
        Err(db::ApplyError::Sql(e)) => Err(DecideError::Internal(e.into())),
    }
}

async fn validate_mutation_target(
    pool: &SqlitePool,
    run_id: Uuid,
    mutation_kind: &str,
    payload: &serde_json::Value,
) -> Result<(), DecideError> {
    // Run-INDEPENDENT target-reference checks are shared with the user path
    // (`mutate`, ADR-0033): a create's `source_journal_entry_id` anchor, a Todo's
    // `project_id`/person refs, an update/delete target's type, and a reference's
    // `target_entity_id` type. Checked BEFORE apply so a bad reference writes
    // nothing.
    crate::mutation_target::validate_mutation_target_refs(pool, mutation_kind, payload)
        .await
        .map_err(|e| match e {
            crate::mutation_target::TargetError::Invalid(reason) => DecideError::Invalid(reason),
            crate::mutation_target::TargetError::Internal(err) => DecideError::Internal(err),
        })?;

    // The SAME-THREAD JOURNAL GUARD is run-coupled (keyed on `run_id`) and stays
    // here. A reference's `source_entity_id` must be a Journal Entry in the
    // current Thread; the shared helper already verified its `target_entity_id`.
    if mutation_kind == "reference_existing_entity_from_journal_entry" {
        let source_entity_id = entities::target_entity_id(mutation_kind, payload).ok_or_else(|| {
            DecideError::Invalid(
                "source_entity_id is required for reference_existing_entity_from_journal_entry"
                    .to_string(),
            )
        })?;
        validate_current_thread_journal_entry(pool, run_id, mutation_kind, source_entity_id)
            .await?;
        return Ok(());
    }

    // A journal-entry update/delete keeps the stricter same-thread guard: the
    // target must be a Journal Entry originally created_from a user Message in the
    // current Thread.
    if mutation_kind != "update_journal_entry" && mutation_kind != "delete_journal_entry" {
        return Ok(());
    }

    let entity_id = entities::target_entity_id(mutation_kind, payload).ok_or_else(|| {
        DecideError::Invalid(format!("entity_id is required for {mutation_kind}"))
    })?;
    validate_current_thread_journal_entry(pool, run_id, mutation_kind, entity_id).await?;

    Ok(())
}

async fn validate_current_thread_journal_entry(
    pool: &SqlitePool,
    run_id: Uuid,
    mutation_kind: &str,
    entity_id: &str,
) -> Result<(), DecideError> {
    let allowed = db::journal_entry_target_is_valid(pool, run_id, entity_id)
        .await
        .map_err(|e| DecideError::Internal(e.into()))?;
    if !allowed {
        return Err(DecideError::Invalid(format!(
            "{mutation_kind} target must be a Journal Entry originally created_from a user Message in the current Thread"
        )));
    }
    Ok(())
}

fn preserve_update_target_entity_id(
    mutation_kind: &str,
    proposal_payload: &serde_json::Value,
    edited_payload: &serde_json::Value,
) -> Result<serde_json::Value, DecideError> {
    if !matches!(
        mutation_kind,
        "update_journal_entry" | "update_person" | "update_project" | "update_todo"
    ) {
        return Ok(edited_payload.clone());
    }

    // The target key is `todo_id` for update_todo, `entity_id` for the others.
    let target_key = if mutation_kind == "update_todo" {
        "todo_id"
    } else {
        "entity_id"
    };

    let Some(target_id) = entities::target_entity_id(mutation_kind, proposal_payload) else {
        return Err(DecideError::Invalid(format!(
            "{mutation_kind} proposal is missing {target_key}"
        )));
    };
    if let Some(edited_target_id) = entities::target_entity_id(mutation_kind, edited_payload) {
        if edited_target_id != target_id {
            return Err(DecideError::Invalid(format!(
                "{mutation_kind} edit cannot change {target_key}"
            )));
        }
        return Ok(edited_payload.clone());
    }

    let Some(mut payload) = edited_payload.as_object().cloned() else {
        return Ok(edited_payload.clone());
    };

    payload.insert(
        target_key.to_string(),
        serde_json::Value::String(target_id.to_string()),
    );
    Ok(serde_json::Value::Object(payload))
}

/// Whether the Run currently reads `parked`. Backs the pending-decide
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

    /// Seed a parked Run + assistant Message + a pending Journal Entry Proposal.
    /// Returns `(run_id, proposal_id)`. The `awaiting_tool_call_id` waitpoint is
    /// set by a trailing UPDATE because that FK is non-deferrable while the
    /// `tool_calls.run_id` FK points back at the Run.
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
        // tool_call exists. user_message_id's FK is DEFERRABLE (resolved at COMMIT).
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

    /// A fake resume: sets the shared flag AND flips the Run `parked → running`
    /// like the real `worker::resume`, so a follow-up observes an advanced Run.
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

    /// Force a Proposal to `accepted` (simulating a prior decide), with an
    /// optional recorded idempotency key.
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
    /// keyed-replay lookup finds it). Returns its id.
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

    #[tokio::test]
    async fn edit_update_rejects_targetless_original_proposal() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        sqlx::query("UPDATE proposals SET mutation_kind = 'update_journal_entry' WHERE id = ?")
            .bind(&proposal_id_str)
            .execute(&pool)
            .await
            .expect("force update proposal kind");
        sqlx::query(
            "UPDATE tool_calls SET request_payload = ? \
             WHERE id = (SELECT tool_call_id FROM proposals WHERE id = ?)",
        )
        .bind(
            serde_json::json!({
                "mutation_kind": "update_journal_entry",
                "payload": {
                    "occurred_at": "2026-06-10T10:30:00",
                    "body": [{ "type": "text", "text": "Missing target." }]
                },
                "rationale": "malformed update proposal"
            })
            .to_string(),
        )
        .bind(&proposal_id_str)
        .execute(&pool)
        .await
        .expect("force targetless proposal payload");

        let resumed = Arc::new(AtomicBool::new(false));
        let outcome = apply(
            &pool,
            proposal_id,
            "edit",
            Some(serde_json::json!({
                "entity_id": Uuid::now_v7().to_string(),
                "occurred_at": "2026-06-10T10:35:00",
                "body": [{ "type": "text", "text": "Retargeted edit." }]
            })),
            Some("targetless-update-edit".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await;

        let Err(DecideError::Invalid(reason)) = outcome else {
            panic!("expected invalid targetless update edit, got {outcome:?}");
        };
        assert!(
            reason.contains("missing entity_id"),
            "invalid reason names missing proposal target: {reason}"
        );
        assert_eq!(entity_count(&pool).await, 0, "invalid edit applies nothing");
        assert_eq!(
            proposal_status(&pool, &proposal_id_str).await,
            "pending",
            "invalid edit leaves the proposal pending"
        );
        assert!(
            !resumed.load(Ordering::SeqCst),
            "invalid edit does not resume"
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

    // 5. A Proposal pre-decided by a concurrent decide whose Run already advanced
    //    off `parked` is no longer decidable; nothing re-applies, resume is NOT
    //    invoked. `LostRace` itself needs a genuine TOCTOU (unreachable single-
    //    threaded); the deterministic outcome here is `NotDecidable`, which maps
    //    to the same wire code (`-32002`). `LostRace` is covered by the db-layer
    //    guarded-race tests.
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
        // A prior decide accepted but its resume failed before flipping the Run.
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

    // Regression: a payload-less `edit` retry of an already-decided Proposal whose
    // Run is still parked must RECOVER (replay + re-drive resume), not short-circuit
    // to `Invalid`. The "edit requires edited_payload" check belongs on the fresh
    // path, after the recovery/idempotency branches.
    #[tokio::test]
    async fn still_parked_edit_retry_without_payload_recovers() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        // A prior decide accepted but its resume failed before flipping the Run.
        // The retry re-sends `decision="edit"` but WITHOUT the payload.
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

    // A fresh pending + parked Proposal decided `edit` WITHOUT a payload is
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

    /// Resume pre-spawn failure recovery (ADR-0025): when `resume` fails BEFORE
    /// flipping the Run off `parked`, the accept stays committed and the decide
    /// surfaces `Internal`, but the Run is left parked. A follow-up keyed replay
    /// with a working resume replays the prior result AND re-drives resume via the
    /// still-parked recovery branch.
    #[tokio::test]
    async fn resume_failure_leaves_run_parked_and_recovers_on_retry() {
        use futures_util::FutureExt;

        let pool = memory_pool().await;
        let (run_id, proposal_id) = seed_parked_proposal(&pool).await;

        // First decide: accept applies, then the resume closure fails without
        // flipping the Run.
        let failing_resume =
            |_run_id| async { Err(anyhow::anyhow!("token resolution failed")) }.boxed();
        let first = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            Some("k-resume-fail".to_string()),
            failing_resume,
        )
        .await;

        assert!(
            matches!(first, Err(DecideError::Internal(_))),
            "a resume failure surfaces as Internal: {first:?}"
        );
        // The accept is durable: entity landed once, Proposal accepted.
        assert_eq!(entity_count(&pool).await, 1, "the accept applied once");
        assert_eq!(
            proposal_status(&pool, &proposal_id.to_string()).await,
            "accepted"
        );
        // The Run is still parked (resume returned Err before flipping), so the
        // still-parked recovery branch is reachable.
        assert_eq!(
            db::run_status(&pool, run_id).await.unwrap().as_deref(),
            Some("parked"),
            "a failed resume leaves the Run parked, not errored"
        );

        // Retry with the SAME key and a working resume: keyed replay returns the
        // prior result AND the trailing gate re-drives resume.
        let resumed = Arc::new(AtomicBool::new(false));
        let second = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            Some("k-resume-fail".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await
        .expect("retry recovers");

        assert!(
            matches!(second, DecideOutcome::Accepted { .. }),
            "retry replays the prior Accepted: {second:?}"
        );
        assert_eq!(
            entity_count(&pool).await,
            1,
            "retry inserts no second entity"
        );
        assert!(
            resumed.load(Ordering::SeqCst),
            "the still-parked retry re-drives resume"
        );
    }
}
