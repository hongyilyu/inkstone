//! Proposal storage facade (park, read, decide-time apply/reject, and the
//! user-mutation twin). SQL stays in [`queries`], matching the DB module's
//! one-statement query convention; this module owns the Proposal shapes,
//! [`ApplyError`], and the accept/reject transaction boundaries.

use sqlx::SqlitePool;
use uuid::Uuid;

use super::apply;
use super::{Moved, ProposalStatus, RunStatus};
use super::queries;
use super::runs::persist_tool_call_rows;
use super::run_log;

/// Park a Run on a Proposal tool request (ADR-0025): persist the tool call +
/// timeline step + pending Proposal, then move the Run `running -> parked` with
/// the waitpoint and lifecycle events (`parked`, `proposal_pending`), all in one
/// transaction. If the Run is no longer `running` the guarded park loses and the
/// transaction rolls back.
#[allow(clippy::too_many_arguments)]
pub async fn park_on_proposal(
    pool: &SqlitePool,
    run_id: Uuid,
    proposal_id: &str,
    tool_call_id: &str,
    name: &str,
    request_payload: &str,
    mutation_kind: &str,
    now_ms: i64,
) -> sqlx::Result<Moved> {
    let mut tx = pool.begin().await?;

    persist_tool_call_rows(&mut tx, run_id, tool_call_id, name, request_payload, now_ms).await?;
    queries::insert_proposal(&mut *tx, proposal_id, tool_call_id, mutation_kind).await?;

    let moved = RunStatus::park(&mut *tx, run_id, tool_call_id, now_ms).await?;
    if !moved.won() {
        return Ok(moved);
    }

    let payload = serde_json::json!({
        "proposal_id": proposal_id,
        "tool_call_id": tool_call_id,
        "mutation_kind": mutation_kind,
    })
    .to_string();
    run_log::append(
        &mut *tx,
        run_id,
        run_log::RunLogKind::ProposalPending,
        Some(&payload),
        now_ms,
    )
    .await?;

    tx.commit().await?;
    Ok(moved)
}

/// A Run's pending Proposal for `proposal/get` (ADR-0025). `payload` and
/// `rationale` come from the tool call's stored `request_payload`;
/// `mutation_kind` and `status` from the `proposals` row.
pub struct ProposalRow {
    pub proposal_id: String,
    pub mutation_kind: String,
    pub status: String,
    pub payload: serde_json::Value,
    pub rationale: Option<String>,
}

/// Read the Run's pending Proposal, or `None`. A malformed `request_payload`
/// degrades to `payload: null` / `rationale: None` rather than failing the read.
pub async fn get_pending_proposal_for_run(
    pool: &SqlitePool,
    run_id: Uuid,
) -> sqlx::Result<Option<ProposalRow>> {
    let Some((proposal_id, mutation_kind, status, request_payload)) =
        queries::pending_proposal_for_run(pool, run_id).await?
    else {
        return Ok(None);
    };
    let payload: serde_json::Value =
        serde_json::from_str(&request_payload).unwrap_or(serde_json::Value::Null);
    let proposal_payload = payload
        .get("payload")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let rationale = payload
        .get("rationale")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    Ok(Some(ProposalRow {
        proposal_id,
        mutation_kind,
        status,
        payload: proposal_payload,
        rationale,
    }))
}

/// Auto-approve seam (ADR-0025, ADR-0016). Always `false` for now — every
/// Proposal is manual, so every `propose_workspace_mutation` parks the Run.
pub fn should_auto_approve() -> bool {
    false
}

/// A Proposal loaded by id for `proposal/decide` (ADR-0025): owning Run, awaited
/// `tool_call_id`, lifecycle columns, the proposed `payload` (from the tool
/// call's `request_payload`), and any recorded `decision_idempotency_key`.
pub struct DecidableProposal {
    pub run_id: Uuid,
    pub tool_call_id: String,
    pub mutation_kind: String,
    pub status: String,
    pub payload: serde_json::Value,
    pub decision_idempotency_key: Option<String>,
}

/// Load a Proposal by id for `proposal/decide`; `None` when it does not exist.
/// A malformed `request_payload` degrades the proposed `payload` to `null`.
pub async fn load_proposal_for_decide(
    pool: &SqlitePool,
    proposal_id: &str,
) -> sqlx::Result<Option<DecidableProposal>> {
    let Some((run_id, tool_call_id, mutation_kind, status, request_payload, idem)) =
        queries::proposal_by_id(pool, proposal_id).await?
    else {
        return Ok(None);
    };
    let Ok(run_id) = Uuid::parse_str(&run_id) else {
        return Ok(None);
    };
    let payload: serde_json::Value =
        serde_json::from_str(&request_payload).unwrap_or(serde_json::Value::Null);
    let proposal_payload = payload
        .get("payload")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    Ok(Some(DecidableProposal {
        run_id,
        tool_call_id,
        mutation_kind,
        status,
        payload: proposal_payload,
        decision_idempotency_key: idem,
    }))
}

/// The `entities.id` already created via `proposal_id`, or `None`. Backs the
/// idempotent-decide check: a repeated accept returns the prior `entity_id`
/// instead of re-applying.
pub async fn entity_id_for_proposal(
    pool: &SqlitePool,
    proposal_id: &str,
) -> sqlx::Result<Option<String>> {
    queries::entity_id_for_proposal(pool, proposal_id).await
}

pub async fn journal_entry_target_is_valid(
    pool: &SqlitePool,
    run_id: Uuid,
    entity_id: &str,
) -> sqlx::Result<bool> {
    queries::journal_entry_target_is_valid(pool, run_id, entity_id).await
}

/// The origin Thread a `journal_entry` was `created_from` (ADR-0042) — the
/// destination a `journal_entry/rescan` Run starts in. `None` if `je_id` names
/// no `journal_entry` or has no resolvable origin Thread.
pub async fn journal_entry_origin_thread_id(
    pool: &SqlitePool,
    je_id: &str,
) -> sqlx::Result<Option<String>> {
    queries::journal_entry_origin_thread_id(pool, je_id).await
}

/// Failure modes of [`apply_proposal`] the caller must distinguish (review M1).
#[derive(Debug)]
pub enum ApplyError {
    /// An impossible mutation contract, e.g. an update without a target id.
    InvalidMutation(String),
    /// The guarded `proposals` flip found the row non-`pending` (a concurrent
    /// decide won); the tx rolled back, nothing applied. Maps to
    /// `proposal_not_pending`.
    NotPending,
    /// An update/delete found its target Entity row already gone (the
    /// affected-0-rows case): a user deleted the Entity out from under a parked
    /// Proposal (ADR-0033). Distinct from a genuine DB fault so the caller can
    /// resolve the parked Run cleanly (decide maps it to `NotDecidable`).
    TargetMissing,
    /// Any other SQL error inside the apply transaction.
    Sql(sqlx::Error),
}

impl From<sqlx::Error> for ApplyError {
    fn from(e: sqlx::Error) -> Self {
        ApplyError::Sql(e)
    }
}

impl std::fmt::Display for ApplyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApplyError::InvalidMutation(reason) => write!(f, "{reason}"),
            ApplyError::NotPending => write!(f, "proposal is not pending (lost the apply race)"),
            ApplyError::TargetMissing => write!(f, "proposal target entity no longer exists"),
            ApplyError::Sql(e) => write!(f, "{e}"),
        }
    }
}

/// Apply an accepted Proposal in one atomic transaction (ADR-0016, ADR-0025):
/// flip the `proposals` row to `accepted` under the `status='pending'` guard,
/// run the shared [`apply::apply_entity_mutation`] core, and resolve the awaited
/// `tool_calls` row to `completed` with the Decision the model reads on resume.
/// Returns the new `entity_id`. `entity_type`/`schema_version` are
/// caller-resolved, so this layer names no specific Entity Type.
///
/// This function owns the run-coupled work the shared core deliberately does not:
/// the guarded accept flip, resolving the Entity Source (the JE anchor from the
/// payload for a `created_from` create, else the user Message from `run_id`), the
/// trailing tool-call resolve, and the commit. Everything else — the per-kind
/// entity data/revision/ref/source writes — lives in `apply_entity_mutation`,
/// shared with the user path (ADR-0033).
///
/// EDIT (ADR-0025): when `edited_payload` is `Some`, the entity `data` is the
/// edited payload (Core-validated by the caller) and `proposals.edited_payload`
/// records the edit; an unedited accept passes `None` and writes the proposed
/// `data`.
///
/// `decision_result_payload` is rendered after the entity write returns so the
/// resume transcript can carry the real affected Entity id. This matters for
/// follow-up agent proposals that must target or source from the accepted Entity.
///
/// Self-guarding (review M1): the `proposals` flip is guarded on
/// `status='pending'`. On 0 rows a racing decide already won, so the tx rolls
/// back and [`ApplyError::NotPending`] is returned — exactly one concurrent
/// decide applies.
#[allow(clippy::too_many_arguments)]
pub async fn apply_proposal(
    pool: &SqlitePool,
    run_id: Uuid,
    proposal_id: &str,
    tool_call_id: &str,
    kind: crate::mutation::MutationKind,
    target_entity_id: Option<&str>,
    payload: &serde_json::Value,
    edited_payload: Option<&serde_json::Value>,
    source_relation_from_user_message: Option<crate::mutation::SourceRelation>,
    decision_idempotency_key: Option<&str>,
    decision_result_payload: impl FnOnce(&str) -> String,
    now_ms: i64,
) -> Result<String, ApplyError> {
    use crate::mutation::SourceRelation;
    let edited_str = edited_payload.map(|v| v.to_string());
    let effective_payload = edited_payload.unwrap_or(payload);

    let mut tx = pool.begin().await?;

    // Flip the Proposal first under the `status='pending'` guard (the single
    // concurrency choke); on 0 rows a racing decide won, so bail before applying.
    let accepted = ProposalStatus::accept(
        &mut *tx,
        run_id,
        proposal_id,
        edited_str.as_deref(),
        decision_idempotency_key,
        now_ms,
    )
    .await?;
    if !accepted.won() {
        // tx drops without commit → rollback; no entity inserted.
        return Err(ApplyError::NotPending);
    }

    // Resolve the run-coupled Entity Source descriptor for the shared core. A
    // create carrying `source_journal_entry_id` is sourced `created_from` that
    // Journal Entry (source_entity_id), not the user Message. Absent the field,
    // the Message-sourcing path is unchanged: read the Run's immutable
    // `user_message_id` here (inside this tx). JournalEntry provenance is
    // `created_from` only (ADR-0030/0031): an `updated_from` source always points
    // at the user Message, so the field is honored solely for creates.
    let source = match source_relation_from_user_message {
        Some(relation) => {
            let je_id = (relation == SourceRelation::CreatedFrom)
                .then(|| crate::entities::source_journal_entry_id(effective_payload))
                .flatten();
            Some(match je_id {
                Some(journal_entry_id) => apply::EntitySource::FromJournalEntry {
                    journal_entry_id: journal_entry_id.to_string(),
                    relation: relation.as_str().to_string(),
                },
                None => apply::EntitySource::FromMessage {
                    message_id: queries::user_message_id_for_run(&mut *tx, run_id).await?,
                    relation: relation.as_str().to_string(),
                },
            })
        }
        None => None,
    };

    let entity_id = apply::apply_entity_mutation(
        &mut tx,
        apply::EntityMutationSpec {
            kind,
            target_entity_id,
            payload,
            edited_payload,
            created_by: "proposal",
            proposal_id: Some(proposal_id),
            source,
            now_ms,
        },
    )
    .await?;

    let decision_result_payload = decision_result_payload(&entity_id);
    queries::resolve_tool_call(
        &mut *tx,
        tool_call_id,
        "completed",
        &decision_result_payload,
        now_ms,
    )
    .await?;

    tx.commit().await?;
    Ok(entity_id)
}

/// Apply a user-initiated Entity mutation in one atomic transaction (ADR-0033):
/// the user write-path's `begin → apply_entity_mutation → commit`, with no
/// Proposal flip and no tool-call resolve (there is no Run). The shared core is
/// driven with `created_by='user'`, `proposal_id=None`, and `source=None` — a
/// plain Library write has no Run, user Message, or Journal-Entry anchor, so it
/// writes no Entity Source row (ADR-0033 "source row iff a real source").
/// The `kind` carries the Entity Type / schema version / target-key, and the
/// `target_entity_id` is caller-resolved, so this layer names no specific Entity
/// Type, mirroring [`apply_proposal`].
pub async fn apply_user_mutation(
    pool: &SqlitePool,
    kind: crate::mutation::MutationKind,
    target_entity_id: Option<&str>,
    payload: &serde_json::Value,
    now_ms: i64,
) -> Result<String, ApplyError> {
    let mut tx = pool.begin().await?;
    let entity_id = apply::apply_entity_mutation(
        &mut tx,
        apply::EntityMutationSpec {
            kind,
            target_entity_id,
            payload,
            edited_payload: None,
            created_by: "user",
            proposal_id: None,
            source: None,
            now_ms,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(entity_id)
}

/// Reject a Proposal in one atomic transaction (ADR-0025), touching no entity
/// store: flip the `proposals` row to `rejected` and resolve the awaited
/// `tool_calls` row to `completed` with the Decision the model reads on resume —
/// a normal (non-error) decline so it continues conversationally. Self-guarding
/// on `status='pending'` like [`apply_proposal`]: 0 rows → rollback +
/// [`ApplyError::NotPending`].
pub async fn reject_proposal(
    pool: &SqlitePool,
    run_id: Uuid,
    proposal_id: &str,
    tool_call_id: &str,
    decision_idempotency_key: Option<&str>,
    decision_result_payload: &str,
    now_ms: i64,
) -> Result<(), ApplyError> {
    let mut tx = pool.begin().await?;

    // Flip the Proposal first under the `status='pending'` guard; on 0 rows a
    // racing decide won, so bail before resolving the tool call.
    let rejected = ProposalStatus::reject(
        &mut *tx,
        run_id,
        proposal_id,
        decision_idempotency_key,
        now_ms,
    )
    .await?;
    if !rejected.won() {
        // tx drops without commit → rollback; nothing changed.
        return Err(ApplyError::NotPending);
    }

    queries::resolve_tool_call(
        &mut *tx,
        tool_call_id,
        "completed",
        decision_result_payload,
        now_ms,
    )
    .await?;

    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;
    use crate::db::mark_run_running;

    /// A migrated in-memory pool so the `runs` CHECK constraints are in force.
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
    /// hand-craft `running`/`parked` Runs for the tests.
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

    async fn run_status_of(pool: &SqlitePool, run_id: &str) -> String {
        sqlx::query_scalar("SELECT status FROM runs WHERE id = ?1")
            .bind(run_id)
            .fetch_one(pool)
            .await
            .expect("run row")
    }

    async fn run_event_count(pool: &SqlitePool, run_id: &str, kind: &str) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM run_log WHERE run_id = ?1 AND kind = ?2")
            .bind(run_id)
            .bind(kind)
            .fetch_one(pool)
            .await
            .expect("count run events")
    }

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

    #[tokio::test]
    async fn park_on_proposal_is_atomic_and_records_events() {
        let pool = memory_pool().await;
        let run_id = Uuid::parse_str("55555555-5555-4555-8555-555555555555").unwrap();
        insert_bare_run(&pool, &run_id.to_string(), "running").await;

        let moved = park_on_proposal(
            &pool,
            run_id,
            "proposal-1",
            "tool-1",
            "propose_workspace_mutation",
            r#"{"mutation_kind":"create_journal_entry","payload":{"occurred_at":"2026-06-10T10:30:00","body":[{"type":"text","text":"Bought milk."}]}}"#,
            "create_journal_entry",
            42,
        )
        .await
        .expect("park");

        assert_eq!(moved, Moved::Won);
        assert_eq!(run_status_of(&pool, &run_id.to_string()).await, "parked");
        assert_eq!(
            run_event_count(&pool, &run_id.to_string(), "parked").await,
            1
        );
        assert_eq!(
            run_event_count(&pool, &run_id.to_string(), "proposal_pending").await,
            1
        );

        let second = park_on_proposal(
            &pool,
            run_id,
            "proposal-2",
            "tool-2",
            "propose_workspace_mutation",
            r#"{"mutation_kind":"create_journal_entry","payload":{"occurred_at":"2026-06-10T10:31:00","body":[{"type":"text","text":"Bought eggs."}]}}"#,
            "create_journal_entry",
            43,
        )
        .await
        .expect("second park");
        assert_eq!(second, Moved::Lost);
        let proposal_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM proposals")
            .fetch_one(&pool)
            .await
            .expect("count proposals");
        assert_eq!(proposal_count, 1, "lost park rolled back its proposal row");
    }

    #[tokio::test]
    async fn accept_records_proposal_decided_and_resume_is_guarded() {
        let pool = memory_pool().await;
        let run_id = Uuid::parse_str("66666666-6666-4666-8666-666666666666").unwrap();
        insert_bare_run(&pool, &run_id.to_string(), "parked").await;
        let proposal_id = seed_pending_proposal(&pool, run_id, "tool-accept").await;

        let entity_id = apply_proposal(
            &pool,
            run_id,
            &proposal_id,
            "tool-accept",
            crate::mutation::MutationKind::CreateJournalEntry,
            None,
            &serde_json::json!({
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "text", "text": "Bought milk." }]
            }),
            None,
            Some(crate::mutation::SourceRelation::CreatedFrom),
            Some("idem-accept"),
            |_| r#"{"decision":"accept","content":"Accepted."}"#.to_string(),
            42,
        )
        .await
        .expect("apply");
        assert!(!entity_id.is_empty());
        let source_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM entity_sources es \
             JOIN runs r ON r.user_message_id = es.source_message_id \
             WHERE es.entity_id = ?1 AND es.relation = 'created_from' AND r.id = ?2",
        )
        .bind(&entity_id)
        .bind(run_id.to_string())
        .fetch_one(&pool)
        .await
        .expect("count entity_sources");
        assert_eq!(
            source_count, 1,
            "accepted entity records its source Message"
        );
        // The stored schema_version is the one the Entity Type owns (derived from
        // the kind via the descriptor), so this catches apply_proposal stamping
        // the wrong version for the Journal Entry it created.
        let stored_schema_version: i64 =
            sqlx::query_scalar("SELECT schema_version FROM entities WHERE id = ?1")
                .bind(&entity_id)
                .fetch_one(&pool)
                .await
                .expect("entity schema_version");
        assert_eq!(
            stored_schema_version,
            crate::mutation::JOURNAL_ENTRY_SCHEMA_VERSION
        );
        assert_eq!(
            run_event_count(&pool, &run_id.to_string(), "proposal_decided").await,
            1
        );

        let first_resume = mark_run_running(&pool, run_id).await.expect("resume");
        assert_eq!(first_resume, Moved::Won);
        let second_resume = mark_run_running(&pool, run_id).await.expect("resume again");
        assert_eq!(second_resume, Moved::Lost);

        let duplicate = apply_proposal(
            &pool,
            run_id,
            &proposal_id,
            "tool-accept",
            crate::mutation::MutationKind::CreateJournalEntry,
            None,
            &serde_json::json!({
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "text", "text": "Bought milk." }]
            }),
            None,
            Some(crate::mutation::SourceRelation::CreatedFrom),
            Some("idem-accept-2"),
            |_| r#"{"decision":"accept","content":"Accepted."}"#.to_string(),
            43,
        )
        .await;
        assert!(matches!(duplicate, Err(ApplyError::NotPending)));
        assert_eq!(
            run_event_count(&pool, &run_id.to_string(), "proposal_decided").await,
            1,
            "lost apply wrote no duplicate event"
        );
    }

    /// Defense-in-depth (ADR-0030/0031): `source_journal_entry_id` is honored
    /// only for `created_from` (creates). An `updated_from` apply that somehow
    /// carries the field still sources from the user Message — never from a
    /// Journal Entry. (Update validators already reject the field at decide; this
    /// guards the apply layer directly so a future allowlist relaxation can't
    /// mis-source an update or FK-fail on a stray JE id.)
    #[tokio::test]
    async fn update_ignores_source_journal_entry_id_and_stays_message_sourced() {
        let pool = memory_pool().await;
        let run_id = Uuid::parse_str("99999999-9999-4999-8999-999999999999").unwrap();
        insert_bare_run(&pool, &run_id.to_string(), "parked").await;

        // An existing Person to update (created_by='user', no proposal needed).
        let person_id = Uuid::now_v7().to_string();
        sqlx::query(
            "INSERT INTO entities \
             (id, type, schema_version, data, created_by, created_via_proposal_id, \
              created_at, updated_at) \
             VALUES (?, 'person', ?, ?, 'user', NULL, ?, ?)",
        )
        .bind(&person_id)
        .bind(crate::mutation::PERSON_SCHEMA_VERSION)
        .bind(r#"{"name":"Alice"}"#)
        .bind(1_i64)
        .bind(1_i64)
        .execute(&pool)
        .await
        .expect("seed person");

        let proposal_id = seed_pending_proposal(&pool, run_id, "tool-update-src").await;

        // The update payload smuggles a source_journal_entry_id pointing at a
        // NON-existent entity. The buggy (pre-gate) path would route to
        // insert_entity_source_from_entity and FK-fail; the gate keeps it on the
        // Message path because relation == "updated_from".
        let bogus_journal_entry_id = Uuid::now_v7().to_string();
        let entity_id = apply_proposal(
            &pool,
            run_id,
            &proposal_id,
            "tool-update-src",
            crate::mutation::MutationKind::UpdatePerson,
            Some(&person_id),
            &serde_json::json!({
                "entity_id": person_id,
                "name": "Alice Updated",
                "source_journal_entry_id": bogus_journal_entry_id,
            }),
            None,
            Some(crate::mutation::SourceRelation::UpdatedFrom),
            Some("idem-update-src"),
            |_| r#"{"decision":"accept","content":"Accepted."}"#.to_string(),
            42,
        )
        .await
        .expect("update applies (must not FK-fail on the stray JE id)");
        assert_eq!(entity_id, person_id);

        // The updated_from source points at the user Message, NOT the Journal Entry.
        let (msg_count, ent_count): (i64, i64) = sqlx::query_as(
            "SELECT \
               COUNT(*) FILTER (WHERE source_message_id IS NOT NULL AND source_entity_id IS NULL), \
               COUNT(*) FILTER (WHERE source_entity_id IS NOT NULL) \
             FROM entity_sources WHERE entity_id = ?1 AND relation = 'updated_from'",
        )
        .bind(&person_id)
        .fetch_one(&pool)
        .await
        .expect("count updated_from sources");
        assert_eq!(msg_count, 1, "update is sourced from the user Message");
        assert_eq!(
            ent_count, 0,
            "update is never sourced from a Journal Entry (source_journal_entry_id ignored on update)"
        );
    }

    /// A parked Proposal whose target Entity was deleted out from under it
    /// (ADR-0033's user-delete-vs-parked-agent-proposal race): `apply_proposal`'s
    /// update/delete affected-0-rows path surfaces a distinct
    /// [`ApplyError::TargetMissing`], NOT an opaque [`ApplyError::Sql`], so the
    /// caller can resolve the parked Run cleanly (decide maps it to
    /// `NotDecidable` → `-32002`). Nothing is written and the Proposal's flip
    /// rolls back with the tx.
    #[tokio::test]
    async fn apply_delete_with_vanished_target_is_target_missing() {
        let pool = memory_pool().await;
        let run_id = Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
        insert_bare_run(&pool, &run_id.to_string(), "parked").await;
        let proposal_id = seed_pending_proposal(&pool, run_id, "tool-vanished").await;

        // A delete_journal_entry whose `entity_id` names an Entity that does not
        // exist — modeling the target deleted after the Proposal parked. The
        // delete's affected-0-rows check fires.
        let missing_entity_id = Uuid::now_v7().to_string();
        let result = apply_proposal(
            &pool,
            run_id,
            &proposal_id,
            "tool-vanished",
            crate::mutation::MutationKind::DeleteJournalEntry,
            Some(&missing_entity_id),
            &serde_json::json!({ "entity_id": missing_entity_id }),
            None,
            None,
            Some("idem-vanished"),
            |_| r#"{"decision":"accept","content":"Accepted."}"#.to_string(),
            42,
        )
        .await;

        assert!(
            matches!(result, Err(ApplyError::TargetMissing)),
            "a vanished delete target surfaces TargetMissing, not opaque Sql: {result:?}"
        );
        let entity_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM entities")
            .fetch_one(&pool)
            .await
            .expect("count entities");
        assert_eq!(entity_count, 0, "nothing is written on a vanished target");
        // The guarded Proposal flip rolled back with the tx — still pending.
        let proposal_status: String =
            sqlx::query_scalar("SELECT status FROM proposals WHERE id = ?1")
                .bind(&proposal_id)
                .fetch_one(&pool)
                .await
                .expect("proposal status");
        assert_eq!(
            proposal_status, "pending",
            "the apply tx rolled back, leaving the Proposal pending"
        );
    }

    /// The update affected-0-rows path also surfaces [`ApplyError::TargetMissing`]
    /// (not opaque `Sql`): an `update_person` whose target Entity was deleted out
    /// from under the parked Proposal. Covers the generic update arm alongside the
    /// delete arm above.
    #[tokio::test]
    async fn apply_update_with_vanished_target_is_target_missing() {
        let pool = memory_pool().await;
        let run_id = Uuid::parse_str("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").unwrap();
        insert_bare_run(&pool, &run_id.to_string(), "parked").await;
        let proposal_id = seed_pending_proposal(&pool, run_id, "tool-vanished-upd").await;

        let missing_entity_id = Uuid::now_v7().to_string();
        let result = apply_proposal(
            &pool,
            run_id,
            &proposal_id,
            "tool-vanished-upd",
            crate::mutation::MutationKind::UpdatePerson,
            Some(&missing_entity_id),
            &serde_json::json!({ "entity_id": missing_entity_id, "name": "Ghost" }),
            None,
            Some(crate::mutation::SourceRelation::UpdatedFrom),
            Some("idem-vanished-upd"),
            |_| r#"{"decision":"accept","content":"Accepted."}"#.to_string(),
            42,
        )
        .await;

        assert!(
            matches!(result, Err(ApplyError::TargetMissing)),
            "a vanished update target surfaces TargetMissing: {result:?}"
        );
        let entity_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM entities")
            .fetch_one(&pool)
            .await
            .expect("count entities");
        assert_eq!(entity_count, 0, "nothing is written on a vanished target");
    }

    #[tokio::test]
    async fn reject_records_proposal_decided_and_is_guarded() {
        let pool = memory_pool().await;
        let run_id = Uuid::parse_str("88888888-8888-4888-8888-888888888888").unwrap();
        insert_bare_run(&pool, &run_id.to_string(), "parked").await;
        let proposal_id = seed_pending_proposal(&pool, run_id, "tool-reject").await;

        reject_proposal(
            &pool,
            run_id,
            &proposal_id,
            "tool-reject",
            Some("idem-reject"),
            r#"{"decision":"reject","content":"Rejected."}"#,
            42,
        )
        .await
        .expect("reject");

        let proposal_status: String =
            sqlx::query_scalar("SELECT status FROM proposals WHERE id = ?1")
                .bind(&proposal_id)
                .fetch_one(&pool)
                .await
                .expect("proposal status");
        assert_eq!(proposal_status, "rejected");
        let tool_status: String =
            sqlx::query_scalar("SELECT status FROM tool_calls WHERE id = 'tool-reject'")
                .fetch_one(&pool)
                .await
                .expect("tool status");
        assert_eq!(tool_status, "completed");
        let entity_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM entities")
            .fetch_one(&pool)
            .await
            .expect("count entities");
        assert_eq!(entity_count, 0, "reject applies no entity");
        assert_eq!(
            run_event_count(&pool, &run_id.to_string(), "proposal_decided").await,
            1
        );

        let duplicate = reject_proposal(
            &pool,
            run_id,
            &proposal_id,
            "tool-reject",
            Some("idem-reject-2"),
            r#"{"decision":"reject","content":"Rejected."}"#,
            43,
        )
        .await;
        assert!(matches!(duplicate, Err(ApplyError::NotPending)));
        assert_eq!(
            run_event_count(&pool, &run_id.to_string(), "proposal_decided").await,
            1,
            "lost reject wrote no duplicate event"
        );
    }

    /// Insert an Entity row directly with the given `type` + `data` JSON, so the
    /// relationship-read tests can seed Todos/Persons/Projects without a Proposal.
    async fn seed_entity(pool: &SqlitePool, id: &str, entity_type: &str, data: &str) {
        sqlx::query(
            "INSERT INTO entities \
             (id, type, schema_version, data, created_by, created_via_proposal_id, \
              created_at, updated_at) \
             VALUES (?, ?, 1, ?, 'user', NULL, 1, 1)",
        )
        .bind(id)
        .bind(entity_type)
        .bind(data)
        .execute(pool)
        .await
        .expect("insert entity");
    }

    /// Seed a Thread + Run + user Message chain so a Message-sourced provenance
    /// row resolves a real `thread_id`/`thread_title`. The `runs.user_message_id`
    /// and `messages.run_id` FKs are circular but DEFERRABLE, so the whole chain
    /// commits in one tx. Returns the seeded user-message id.
    async fn seed_thread_message(
        pool: &SqlitePool,
        thread_id: &str,
        thread_title: &str,
        message_id: &str,
    ) {
        let mut tx = pool.begin().await.expect("begin");
        sqlx::query(
            "INSERT INTO threads (id, title, created_at, last_activity_at) VALUES (?, ?, 1, 1)",
        )
        .bind(thread_id)
        .bind(thread_title)
        .execute(&mut *tx)
        .await
        .expect("insert thread");
        let run_id = format!("run-for-{message_id}");
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, \
              thinking_level, user_message_id, status, started_at) \
             VALUES (?, ?, 'w', '1', 'p', 'm', 'off', ?, 'completed', 1)",
        )
        .bind(&run_id)
        .bind(thread_id)
        .bind(message_id)
        .execute(&mut *tx)
        .await
        .expect("insert run");
        sqlx::query(
            "INSERT INTO messages (id, thread_id, run_id, role, status, created_at, updated_at) \
             VALUES (?, ?, ?, 'user', 'completed', 1, 1)",
        )
        .bind(message_id)
        .bind(thread_id)
        .bind(&run_id)
        .execute(&mut *tx)
        .await
        .expect("insert message");
        tx.commit().await.expect("commit thread+message");
    }

    /// Seed one `entity_sources` row. Exactly one of `source_message_id` /
    /// `source_entity_id` is set (the schema CHECK); pass the other as `None`.
    async fn seed_source(
        pool: &SqlitePool,
        id: &str,
        entity_id: &str,
        source_message_id: Option<&str>,
        source_entity_id: Option<&str>,
        relation: &str,
        created_at: i64,
    ) {
        sqlx::query(
            "INSERT INTO entity_sources \
             (id, entity_id, source_message_id, source_entity_id, relation, created_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(entity_id)
        .bind(source_message_id)
        .bind(source_entity_id)
        .bind(relation)
        .bind(created_at)
        .execute(pool)
        .await
        .expect("insert entity_source");
    }

    /// `journal_entry_origin_thread_id` resolves the Thread a Journal Entry was
    /// `created_from` (the origin user Message's Thread), the destination a re-scan
    /// Run starts in. A non-existent id, or an id naming a non-`journal_entry`
    /// Entity, resolves to `None` — so the rescan handler errors instead of
    /// spawning into the wrong Thread.
    #[tokio::test]
    async fn journal_entry_origin_thread_id_resolves_je_origin_only() {
        let pool = memory_pool().await;
        seed_thread_message(&pool, "thr-origin", "Morning dump", "msg-origin").await;

        // (a) A Journal Entry `created_from` the user Message in thr-origin.
        seed_entity(&pool, "je-1", "journal_entry", r#"{"occurred_at":"x"}"#).await;
        seed_source(
            &pool,
            "src-je",
            "je-1",
            Some("msg-origin"),
            None,
            "created_from",
            10,
        )
        .await;

        // (b) A non-`journal_entry` Entity that ALSO has a created_from message
        // source — the query must reject it on the type guard, not resolve its
        // Thread.
        seed_entity(&pool, "t-1", "todo", r#"{"title":"Buy milk"}"#).await;
        seed_source(
            &pool,
            "src-todo",
            "t-1",
            Some("msg-origin"),
            None,
            "created_from",
            10,
        )
        .await;

        assert_eq!(
            journal_entry_origin_thread_id(&pool, "je-1")
                .await
                .expect("query runs"),
            Some("thr-origin".to_string()),
            "a journal_entry resolves its created_from origin Thread"
        );
        assert_eq!(
            journal_entry_origin_thread_id(&pool, "missing")
                .await
                .expect("query runs"),
            None,
            "an unknown id resolves to None"
        );
        assert_eq!(
            journal_entry_origin_thread_id(&pool, "t-1")
                .await
                .expect("query runs"),
            None,
            "a non-journal_entry Entity resolves to None even with a created_from source"
        );
    }
}
