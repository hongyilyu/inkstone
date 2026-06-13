//! User-initiated Entity CRUD application for `entity/mutate` (ADR-0033).
//!
//! [`apply`] is the thread-less, Proposal-less mirror of [`crate::decide`]: it
//! validates a `{mutation_kind, payload}` request, runs the run-INDEPENDENT
//! target-reference checks shared with `decide`, then applies the mutation
//! through the same [`crate::db::apply_entity_mutation`] core with
//! `created_by='user'` and no Proposal anchor. A plain Library create has no
//! Run, no user Message, and no Journal-Entry anchor, so it writes no Entity
//! Source row (ADR-0033 "source row iff a real source").

use sqlx::SqlitePool;

use crate::db;
use crate::entities;
use crate::mutation_target::{self, TargetError};

/// A successful user mutation: the affected Entity id, present on create/update
/// and absent on delete (which removes the row).
#[derive(Debug)]
pub struct Outcome {
    pub entity_id: Option<String>,
}

/// Whether a `mutation_kind` removes an Entity (no surviving row, so no
/// `entity_id` on the wire). Mirrors the apply core's delete classification.
fn is_delete_mutation(mutation_kind: &str) -> bool {
    matches!(
        mutation_kind,
        "delete_journal_entry" | "delete_person" | "delete_project" | "delete_todo"
    )
}

/// The user-mutation failure vocabulary. The handler maps each to a wire code:
/// `Invalid → -32602`, `Internal → -32603`.
#[derive(Debug)]
pub enum MutateError {
    /// Invalid inputs: an unsupported `mutation_kind`, a payload that fails
    /// schema validation, or a target reference that does not resolve.
    Invalid(String),
    /// A DB error or inconsistency. Logged server-side; never surfaced verbatim.
    Internal(anyhow::Error),
}

/// Apply a user-initiated Entity mutation (ADR-0033): validate the payload by
/// `mutation_kind`, run the run-INDEPENDENT target-reference checks (shared with
/// `decide`), then apply it through the shared core as a `created_by='user'`,
/// Proposal-less write in one atomic tx. Returns the affected `entity_id`
/// (`None` for a delete, which leaves no row). Thread-less by design — the
/// same-thread Journal guard does not apply to user writes.
pub async fn apply(
    pool: &SqlitePool,
    mutation_kind: &str,
    payload: &serde_json::Value,
) -> Result<Outcome, MutateError> {
    entities::validate(mutation_kind, payload).map_err(MutateError::Invalid)?;

    mutation_target::validate_mutation_target_refs(pool, mutation_kind, payload)
        .await
        .map_err(|e| match e {
            TargetError::Invalid(reason) => MutateError::Invalid(reason),
            TargetError::Internal(err) => MutateError::Internal(err),
        })?;

    let entity_id = db::apply_user_mutation(
        pool,
        mutation_kind,
        entities::entity_type(mutation_kind),
        entities::schema_version(mutation_kind),
        entities::target_entity_id(mutation_kind, payload),
        payload,
        db::now_ms(),
    )
    .await
    .map_err(|e| match e {
        db::ApplyError::InvalidMutation(reason) => MutateError::Invalid(reason),
        // The user path opens its own tx with no Proposal flip, so the guarded
        // `NotPending` race is unreachable; treat it as an internal inconsistency.
        db::ApplyError::NotPending => {
            MutateError::Internal(anyhow::anyhow!("user mutation hit an unexpected pending guard"))
        }
        db::ApplyError::Sql(err) => MutateError::Internal(err.into()),
    })?;

    let entity_id = if is_delete_mutation(mutation_kind) {
        None
    } else {
        Some(entity_id)
    };
    Ok(Outcome { entity_id })
}

#[cfg(test)]
mod tests {
    use super::apply;
    use sqlx::SqlitePool;
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

    // A user `create_person` lands a canonical Entity directly: exactly one
    // `entities` row (type='person', created_by='user', created_via_proposal_id
    // NULL), a seq-1 `entity_revisions` row with a NULL proposal_id, and ZERO
    // `proposals` rows — the user write-path bypasses the Proposal gate (ADR-0033).
    #[tokio::test]
    async fn create_person_lands_user_authored_canonical_entity() {
        let pool = memory_pool().await;

        let outcome = apply(&pool, "create_person", &serde_json::json!({ "name": "Alice" }))
            .await
            .expect("user create_person succeeds");
        let entity_id = outcome.entity_id.expect("create yields an entity id");
        assert!(!entity_id.is_empty(), "create yields a non-empty entity id");

        let (entity_type, created_by, created_via): (String, String, Option<String>) =
            sqlx::query_as(
                "SELECT type, created_by, created_via_proposal_id FROM entities WHERE id = ?1",
            )
            .bind(&entity_id)
            .fetch_one(&pool)
            .await
            .expect("entity row");
        assert_eq!(entity_type, "person");
        assert_eq!(created_by, "user");
        assert_eq!(
            created_via, None,
            "a user-authored Entity carries no proposal id"
        );

        let entity_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM entities")
            .fetch_one(&pool)
            .await
            .expect("count entities");
        assert_eq!(entity_count, 1, "exactly one entity lands");

        let (seq, rev_proposal): (i64, Option<String>) =
            sqlx::query_as("SELECT seq, proposal_id FROM entity_revisions WHERE entity_id = ?1")
                .bind(&entity_id)
                .fetch_one(&pool)
                .await
                .expect("revision row");
        assert_eq!(seq, 1, "fresh Entity gets a seq-1 revision");
        assert_eq!(
            rev_proposal, None,
            "a direct user edit writes a NULL-proposal revision"
        );

        let proposal_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM proposals")
            .fetch_one(&pool)
            .await
            .expect("count proposals");
        assert_eq!(proposal_count, 0, "the user path creates no Proposal");

        let source_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM entity_sources WHERE entity_id = ?1")
                .bind(&entity_id)
                .fetch_one(&pool)
                .await
                .expect("count sources");
        assert_eq!(
            source_count, 0,
            "a plain user create writes no entity_source row"
        );
    }
}
