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
use crate::mutation::{MutationKind, WriteOp};
use crate::mutation_target::{self, TargetError};

/// A successful user mutation: the affected Entity id, present on create/update
/// and absent on delete (which removes the row).
#[derive(Debug)]
pub struct Outcome {
    pub entity_id: Option<String>,
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
    // Resolve the wire string once (the single string→type point on this path):
    // an unknown kind is a client error (-32602), the old validate `_` arm's role.
    let kind = MutationKind::from_wire(mutation_kind).ok_or_else(|| {
        MutateError::Invalid(format!("mutation_kind {mutation_kind:?} not supported"))
    })?;
    let desc = kind.describe();

    entities::validate(kind, payload).map_err(MutateError::Invalid)?;

    // A direct Library create is anchor-less by design (ADR-0033: "source row iff
    // a real source" — the user path has no Run, user Message, or Journal-Entry
    // anchor). `entities::validate` accepts `source_journal_entry_id` for the
    // shared agent path, but the user path must REJECT it rather than silently
    // validate provenance and persist no entity_sources row.
    if matches!(
        kind,
        MutationKind::CreatePerson | MutationKind::CreateProject | MutationKind::CreateTodo
    ) && entities::source_journal_entry_id(payload).is_some()
    {
        return Err(MutateError::Invalid(
            "source_journal_entry_id is not supported on direct user creates".to_string(),
        ));
    }

    mutation_target::validate_mutation_target_refs(pool, kind, payload)
        .await
        .map_err(|e| match e {
            // On the USER path a vanished primary target is a client-correctable
            // concurrent delete: Invalid (-32602), the same as a bad reference.
            // (Only the agent accept path maps TargetMissing to NotDecidable per
            // ADR-0033.)
            TargetError::TargetMissing(reason) | TargetError::Invalid(reason) => {
                MutateError::Invalid(reason)
            }
            TargetError::Internal(err) => MutateError::Internal(err),
        })?;

    let entity_id = db::apply_user_mutation(
        pool,
        kind,
        crate::mutation::target_entity_id(desc, payload),
        payload,
        db::now_ms(),
    )
    .await
    .map_err(|e| match e {
        db::ApplyError::InvalidMutation(reason) => MutateError::Invalid(reason),
        // The user path opens its own tx with no Proposal flip, so the guarded
        // `NotPending` race is unreachable; treat it as an internal inconsistency.
        db::ApplyError::NotPending => MutateError::Internal(anyhow::anyhow!(
            "user mutation hit an unexpected pending guard"
        )),
        // The target was deleted between the pre-apply validation and the write
        // (a concurrent delete). Client-correctable, so Invalid, not Internal.
        db::ApplyError::TargetMissing => {
            MutateError::Invalid("target entity no longer exists".to_string())
        }
        db::ApplyError::Sql(err) => MutateError::Internal(err.into()),
    })?;

    let entity_id = if desc.write_op == WriteOp::Delete {
        None
    } else {
        Some(entity_id)
    };
    Ok(Outcome { entity_id })
}

#[cfg(test)]
mod tests {
    use super::{MutateError, apply};
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

        let outcome = apply(
            &pool,
            "create_person",
            &serde_json::json!({ "name": "Alice" }),
        )
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

    // A user `update_todo` whose partial sets `due_at` to JSON `null` CLEARS that
    // field (ADR-0033 three-way merge): the stored Todo data carries no `due_at`
    // key afterward, and the update writes a seq-2 revision with a NULL proposal_id
    // (a direct user edit). Seeds the Todo via the create path so it starts WITH a
    // `due_at` to clear.
    #[tokio::test]
    async fn update_todo_null_clears_due_at() {
        let pool = memory_pool().await;

        let outcome = apply(
            &pool,
            "create_todo",
            &serde_json::json!({
                "todo": { "title": "Ship it", "due_at": "2026-07-01T09:00:00" }
            }),
        )
        .await
        .expect("user create_todo succeeds");
        let todo_id = outcome.entity_id.expect("create yields an entity id");

        // Sanity: the seeded Todo has a due_at to clear.
        let seeded: String = sqlx::query_scalar("SELECT data FROM entities WHERE id = ?1")
            .bind(&todo_id)
            .fetch_one(&pool)
            .await
            .expect("seeded todo data");
        let seeded: serde_json::Value = serde_json::from_str(&seeded).expect("seeded data is JSON");
        assert!(
            seeded.get("due_at").is_some(),
            "seeded Todo has a due_at: {seeded}"
        );

        apply(
            &pool,
            "update_todo",
            &serde_json::json!({ "todo_id": todo_id, "todo": { "due_at": null } }),
        )
        .await
        .expect("user update_todo clears due_at");

        let stored: String = sqlx::query_scalar("SELECT data FROM entities WHERE id = ?1")
            .bind(&todo_id)
            .fetch_one(&pool)
            .await
            .expect("stored todo data");
        let stored: serde_json::Value = serde_json::from_str(&stored).expect("stored data is JSON");
        assert!(
            stored.get("due_at").is_none(),
            "clearing via null removes the due_at key entirely: {stored}"
        );
        assert_eq!(
            stored.get("title").and_then(serde_json::Value::as_str),
            Some("Ship it"),
            "the unsupplied title is preserved: {stored}"
        );

        let (seq, rev_proposal): (i64, Option<String>) = sqlx::query_as(
            "SELECT seq, proposal_id FROM entity_revisions \
             WHERE entity_id = ?1 ORDER BY seq DESC LIMIT 1",
        )
        .bind(&todo_id)
        .fetch_one(&pool)
        .await
        .expect("latest revision row");
        assert_eq!(seq, 2, "the clear writes the second revision");
        assert_eq!(
            rev_proposal, None,
            "a direct user edit writes a NULL-proposal revision"
        );
    }

    // A user `delete_person` removes the target `entities` row outright (hard
    // delete, ADR-0033); dependent revisions cascade away via FK. Returns no
    // entity_id (the row is gone).
    #[tokio::test]
    async fn delete_person_removes_row() {
        let pool = memory_pool().await;

        let entity_id = apply(
            &pool,
            "create_person",
            &serde_json::json!({ "name": "Bob" }),
        )
        .await
        .expect("user create_person succeeds")
        .entity_id
        .expect("create yields an entity id");

        let outcome = apply(
            &pool,
            "delete_person",
            &serde_json::json!({ "entity_id": entity_id }),
        )
        .await
        .expect("user delete_person succeeds");
        assert!(
            outcome.entity_id.is_none(),
            "a delete leaves no surviving entity id"
        );

        let row_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM entities WHERE id = ?1")
            .bind(&entity_id)
            .fetch_one(&pool)
            .await
            .expect("count entity rows");
        assert_eq!(row_count, 0, "the Person entity row is gone");

        let rev_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM entity_revisions WHERE entity_id = ?1")
                .bind(&entity_id)
                .fetch_one(&pool)
                .await
                .expect("count revisions");
        assert_eq!(rev_count, 0, "the revisions cascade away with the entity");
    }

    // A user `update_person` replaces the target Person's data and appends a seq-2
    // revision with a NULL proposal_id (a direct user edit, ADR-0033).
    #[tokio::test]
    async fn update_person_changes_field() {
        let pool = memory_pool().await;

        let entity_id = apply(&pool, "create_person", &serde_json::json!({ "name": "X1" }))
            .await
            .expect("user create_person succeeds")
            .entity_id
            .expect("create yields an entity id");

        let outcome = apply(
            &pool,
            "update_person",
            &serde_json::json!({ "entity_id": entity_id, "name": "X2" }),
        )
        .await
        .expect("user update_person succeeds");
        assert_eq!(
            outcome.entity_id.as_deref(),
            Some(entity_id.as_str()),
            "an update returns the same entity id"
        );

        let stored: String = sqlx::query_scalar("SELECT data FROM entities WHERE id = ?1")
            .bind(&entity_id)
            .fetch_one(&pool)
            .await
            .expect("stored person data");
        let stored: serde_json::Value = serde_json::from_str(&stored).expect("stored data is JSON");
        assert_eq!(
            stored.get("name").and_then(serde_json::Value::as_str),
            Some("X2"),
            "the name field is updated: {stored}"
        );

        let (seq, rev_proposal): (i64, Option<String>) = sqlx::query_as(
            "SELECT seq, proposal_id FROM entity_revisions \
             WHERE entity_id = ?1 ORDER BY seq DESC LIMIT 1",
        )
        .bind(&entity_id)
        .fetch_one(&pool)
        .await
        .expect("latest revision row");
        assert_eq!(seq, 2, "the update writes the second revision");
        assert_eq!(
            rev_proposal, None,
            "a direct user edit writes a NULL-proposal revision"
        );
    }

    // A user `update_person` whose payload sets the optional `note` to JSON `null`
    // CLEARS it (ADR-0033): the stored Person data carries no `note` key — the
    // full-document update drops null-valued optional fields rather than persisting
    // a JSON null. The required `name` survives.
    #[tokio::test]
    async fn update_person_null_clears_note() {
        let pool = memory_pool().await;

        let entity_id = apply(
            &pool,
            "create_person",
            &serde_json::json!({ "name": "Carol", "note": "old note" }),
        )
        .await
        .expect("user create_person succeeds")
        .entity_id
        .expect("create yields an entity id");

        apply(
            &pool,
            "update_person",
            &serde_json::json!({ "entity_id": entity_id, "name": "Carol", "note": null }),
        )
        .await
        .expect("user update_person clears note");

        let stored: String = sqlx::query_scalar("SELECT data FROM entities WHERE id = ?1")
            .bind(&entity_id)
            .fetch_one(&pool)
            .await
            .expect("stored person data");
        let stored: serde_json::Value = serde_json::from_str(&stored).expect("stored data is JSON");
        assert!(
            stored.get("note").is_none(),
            "clearing via null removes the note key entirely: {stored}"
        );
        assert_eq!(
            stored.get("name").and_then(serde_json::Value::as_str),
            Some("Carol"),
            "the required name survives the clear: {stored}"
        );
    }

    // A `null` on a NON-clearable (required) field is rejected as
    // `MutateError::Invalid` (ADR-0033): the sentinel-clear carve-out covers only
    // optional fields, so clearing `title`/`status`/`name` is meaningless and the
    // validator must reject it. Guards against a regression broadening the carve-out
    // to required fields. Each target is seeded via the create path first so the
    // failure is the null update, not a missing target.
    #[tokio::test]
    async fn null_on_non_clearable_field_is_rejected() {
        let pool = memory_pool().await;

        let todo_id = apply(
            &pool,
            "create_todo",
            &serde_json::json!({ "todo": { "title": "Ship it" } }),
        )
        .await
        .expect("user create_todo succeeds")
        .entity_id
        .expect("create yields an entity id");

        let person_id = apply(
            &pool,
            "create_person",
            &serde_json::json!({ "name": "Dave" }),
        )
        .await
        .expect("user create_person succeeds")
        .entity_id
        .expect("create yields an entity id");

        let project_id = apply(
            &pool,
            "create_project",
            &serde_json::json!({ "name": "Roadmap" }),
        )
        .await
        .expect("user create_project succeeds")
        .entity_id
        .expect("create yields an entity id");

        let rejections = [
            (
                "update_todo",
                serde_json::json!({ "todo_id": todo_id, "todo": { "title": null } }),
            ),
            (
                "update_todo",
                serde_json::json!({ "todo_id": todo_id, "todo": { "status": null } }),
            ),
            (
                "update_person",
                serde_json::json!({ "entity_id": person_id, "name": null }),
            ),
            (
                "update_project",
                serde_json::json!({ "entity_id": project_id, "name": null }),
            ),
            (
                // `name` is present so the rejection traces to the null `status`
                // (a non-clearable enum), not the required-name check — otherwise
                // "name is required" would fire first and mask the status guard.
                "update_project",
                serde_json::json!({ "entity_id": project_id, "name": "Roadmap", "status": null }),
            ),
        ];

        for (kind, payload) in rejections {
            let err = apply(&pool, kind, &payload)
                .await
                .expect_err("a null on a non-clearable field is rejected");
            assert!(
                matches!(err, MutateError::Invalid(_)),
                "{kind} null-on-required is Invalid, got: {err:?} ({payload})"
            );
        }
    }

    // FIX #10: a direct user create carrying `source_journal_entry_id` is REJECTED
    // as `Invalid` (ADR-0033). The shared `entities::validate` accepts the field
    // for the agent path, but the Library is anchor-less (no Run, no user Message,
    // no Journal-Entry anchor), so the user path must reject it rather than
    // validate provenance and then silently persist no entity_sources row. Covers
    // all three create kinds.
    #[tokio::test]
    async fn create_with_source_journal_entry_id_is_rejected() {
        let pool = memory_pool().await;
        let je_id = uuid::Uuid::now_v7().to_string();

        let cases = [
            (
                "create_person",
                serde_json::json!({ "name": "Alice", "source_journal_entry_id": je_id }),
            ),
            (
                "create_project",
                serde_json::json!({ "name": "Roadmap", "source_journal_entry_id": je_id }),
            ),
            (
                "create_todo",
                serde_json::json!({
                    "todo": { "title": "Ship it" },
                    "source_journal_entry_id": je_id
                }),
            ),
        ];

        for (kind, payload) in cases {
            let err = apply(&pool, kind, &payload)
                .await
                .expect_err("a user create with a source anchor is rejected");
            // Assert the SPECIFIC user-path policy message, not just `Invalid`: a
            // random `source_journal_entry_id` would also be rejected by the
            // downstream `validate_mutation_target_refs` anchor check, so matching
            // only `Invalid(_)` would still pass if the explicit user-path branch
            // regressed. Pinning the message proves THAT branch fired.
            let MutateError::Invalid(reason) = &err else {
                panic!("{kind} with source_journal_entry_id is Invalid, got: {err:?}");
            };
            assert_eq!(
                reason, "source_journal_entry_id is not supported on direct user creates",
                "{kind} must be rejected by the direct-user-create policy, not generic anchor validation"
            );
        }

        let entity_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM entities")
            .fetch_one(&pool)
            .await
            .expect("count entities");
        assert_eq!(entity_count, 0, "a rejected user create writes nothing");
    }

    // A user `update_project` whose payload sets the optional `outcome` to JSON
    // `null` CLEARS it (ADR-0033 three-way merge): the stored Project data carries
    // no `outcome` key afterward, and the clear writes a seq-2 revision with a NULL
    // proposal_id (a direct user edit). Directly exercises the full-document-replace
    // + present_non_null clear path on Project (Person covers the same path above).
    #[tokio::test]
    async fn update_project_null_clears_outcome() {
        let pool = memory_pool().await;

        let entity_id = apply(
            &pool,
            "create_project",
            &serde_json::json!({ "name": "Roadmap", "outcome": "Ship v2" }),
        )
        .await
        .expect("user create_project succeeds")
        .entity_id
        .expect("create yields an entity id");

        // Sanity: the seeded Project has an outcome to clear.
        let seeded: String = sqlx::query_scalar("SELECT data FROM entities WHERE id = ?1")
            .bind(&entity_id)
            .fetch_one(&pool)
            .await
            .expect("seeded project data");
        let seeded: serde_json::Value = serde_json::from_str(&seeded).expect("seeded data is JSON");
        assert_eq!(
            seeded.get("outcome").and_then(serde_json::Value::as_str),
            Some("Ship v2"),
            "seeded Project has an outcome: {seeded}"
        );

        apply(
            &pool,
            "update_project",
            &serde_json::json!({ "entity_id": entity_id, "name": "Roadmap", "outcome": null }),
        )
        .await
        .expect("user update_project clears outcome");

        let stored: String = sqlx::query_scalar("SELECT data FROM entities WHERE id = ?1")
            .bind(&entity_id)
            .fetch_one(&pool)
            .await
            .expect("stored project data");
        let stored: serde_json::Value = serde_json::from_str(&stored).expect("stored data is JSON");
        assert!(
            stored.get("outcome").is_none(),
            "clearing via null removes the outcome key entirely: {stored}"
        );
        assert_eq!(
            stored.get("name").and_then(serde_json::Value::as_str),
            Some("Roadmap"),
            "the required name survives the clear: {stored}"
        );

        let (seq, rev_proposal): (i64, Option<String>) = sqlx::query_as(
            "SELECT seq, proposal_id FROM entity_revisions \
             WHERE entity_id = ?1 ORDER BY seq DESC LIMIT 1",
        )
        .bind(&entity_id)
        .fetch_one(&pool)
        .await
        .expect("latest revision row");
        assert_eq!(seq, 2, "the clear writes the second revision");
        assert_eq!(
            rev_proposal, None,
            "a direct user edit writes a NULL-proposal revision"
        );
    }

    // A user `mark_project_reviewed` through the full user path (validate →
    // target-ref → apply) stamps the review fields and appends a NULL-proposal
    // seq-2 revision (ADR-0034). The active create seeds review fields, so this
    // also confirms the review timestamps actually advance.
    #[tokio::test]
    async fn mark_project_reviewed_user_path_stamps_review() {
        let pool = memory_pool().await;

        let entity_id = apply(
            &pool,
            "create_project",
            &serde_json::json!({ "name": "Ship v1" }),
        )
        .await
        .expect("user create_project succeeds")
        .entity_id
        .expect("create yields an entity id");

        let outcome = apply(
            &pool,
            "mark_project_reviewed",
            &serde_json::json!({ "entity_id": entity_id }),
        )
        .await
        .expect("user mark_project_reviewed succeeds");
        assert_eq!(
            outcome.entity_id.as_deref(),
            Some(entity_id.as_str()),
            "mark reviewed returns the affected project id"
        );

        let stored: String = sqlx::query_scalar("SELECT data FROM entities WHERE id = ?1")
            .bind(&entity_id)
            .fetch_one(&pool)
            .await
            .expect("stored project data");
        let stored: serde_json::Value = serde_json::from_str(&stored).expect("stored data is JSON");
        assert!(
            stored.get("last_reviewed_at").is_some(),
            "review stamps last_reviewed_at: {stored}"
        );
        assert!(
            stored
                .get("next_review_at")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|s| s.ends_with("T20:00:00")),
            "next_review_at advances to a 20:00 anchor: {stored}"
        );

        let (seq, rev_proposal): (i64, Option<String>) = sqlx::query_as(
            "SELECT seq, proposal_id FROM entity_revisions \
             WHERE entity_id = ?1 ORDER BY seq DESC LIMIT 1",
        )
        .bind(&entity_id)
        .fetch_one(&pool)
        .await
        .expect("latest revision row");
        assert_eq!(seq, 2, "the review writes a second revision");
        assert_eq!(
            rev_proposal, None,
            "a user review writes a NULL-proposal revision"
        );
    }

    // A user Bookmark rides the same Entity path People/Projects use (ADR-0036):
    // `create_bookmark` lands a created_by='user' Canonical Entity
    // (type='bookmark', schema_version=1); `list_by_type` returns it;
    // `update_bookmark` FULL-DOCUMENT-replaces `data` (the omitted `url` is
    // dropped); `delete_bookmark` removes the row. Mirrors
    // `create_person_lands_user_authored_canonical_entity`.
    #[tokio::test]
    async fn bookmark_crud_via_entity_path() {
        let pool = memory_pool().await;

        // create → a user-authored, schema-versioned bookmark Entity.
        let entity_id = apply(
            &pool,
            "create_bookmark",
            &serde_json::json!({ "title": "Effect docs", "url": "https://effect.website" }),
        )
        .await
        .expect("user create_bookmark succeeds")
        .entity_id
        .expect("create yields an entity id");

        let (entity_type, created_by, schema_version, data): (String, String, i64, String) =
            sqlx::query_as(
                "SELECT type, created_by, schema_version, data FROM entities WHERE id = ?1",
            )
            .bind(&entity_id)
            .fetch_one(&pool)
            .await
            .expect("entity row");
        assert_eq!(entity_type, "bookmark");
        assert_eq!(created_by, "user");
        assert_eq!(schema_version, 1);
        let data: serde_json::Value = serde_json::from_str(&data).expect("data is JSON");
        assert_eq!(
            data.get("title").and_then(serde_json::Value::as_str),
            Some("Effect docs")
        );
        assert_eq!(
            data.get("url").and_then(serde_json::Value::as_str),
            Some("https://effect.website")
        );

        // list → the bookmark is returned by its type.
        let rows = crate::db::list_by_type(&pool, "bookmark")
            .await
            .expect("list bookmarks");
        assert_eq!(rows.len(), 1, "exactly one bookmark lists");
        assert_eq!(rows[0].id, entity_id);
        assert_eq!(rows[0].r#type, "bookmark");

        // update → FULL-document replace: the omitted `url` is dropped, `note` set.
        apply(
            &pool,
            "update_bookmark",
            &serde_json::json!({ "entity_id": entity_id, "title": "Effect", "note": "read later" }),
        )
        .await
        .expect("user update_bookmark succeeds");

        let stored: String = sqlx::query_scalar("SELECT data FROM entities WHERE id = ?1")
            .bind(&entity_id)
            .fetch_one(&pool)
            .await
            .expect("stored bookmark data");
        let stored: serde_json::Value = serde_json::from_str(&stored).expect("data is JSON");
        assert_eq!(
            stored.get("title").and_then(serde_json::Value::as_str),
            Some("Effect"),
            "title replaced: {stored}"
        );
        assert_eq!(
            stored.get("note").and_then(serde_json::Value::as_str),
            Some("read later"),
            "note set: {stored}"
        );
        assert!(
            stored.get("url").is_none(),
            "full-document replace drops the omitted url: {stored}"
        );

        // delete → the row is gone.
        let outcome = apply(
            &pool,
            "delete_bookmark",
            &serde_json::json!({ "entity_id": entity_id }),
        )
        .await
        .expect("user delete_bookmark succeeds");
        assert!(outcome.entity_id.is_none(), "a delete leaves no entity id");

        let row_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM entities WHERE id = ?1")
            .bind(&entity_id)
            .fetch_one(&pool)
            .await
            .expect("count entity rows");
        assert_eq!(row_count, 0, "the bookmark row is gone");
    }

    // mark_project_reviewed against a non-Project entity_id is Invalid (the
    // target-ref check rejects a wrong-type target before any write).
    #[tokio::test]
    async fn mark_project_reviewed_wrong_type_is_invalid() {
        let pool = memory_pool().await;
        let person_id = apply(&pool, "create_person", &serde_json::json!({ "name": "Al" }))
            .await
            .expect("create person")
            .entity_id
            .expect("entity id");

        let result = apply(
            &pool,
            "mark_project_reviewed",
            &serde_json::json!({ "entity_id": person_id }),
        )
        .await;
        assert!(
            matches!(result, Err(MutateError::Invalid(_))),
            "marking a non-Project reviewed is Invalid: {result:?}"
        );
    }

    // update_bookmark / delete_bookmark against a non-Bookmark entity_id is
    // Invalid: the target-ref check rejects a wrong-type target before any write,
    // so a regression dropping the `Some("bookmark")` arm (which would let these
    // mutate an unrelated Person) is caught. Mirrors
    // `mark_project_reviewed_wrong_type_is_invalid`.
    #[tokio::test]
    async fn bookmark_mutations_against_wrong_type_are_invalid() {
        let pool = memory_pool().await;
        let person_id = apply(&pool, "create_person", &serde_json::json!({ "name": "Al" }))
            .await
            .expect("create person")
            .entity_id
            .expect("entity id");

        let update = apply(
            &pool,
            "update_bookmark",
            &serde_json::json!({ "entity_id": person_id, "title": "Hijacked" }),
        )
        .await;
        assert!(
            matches!(update, Err(MutateError::Invalid(_))),
            "update_bookmark against a Person is Invalid: {update:?}"
        );

        let delete = apply(
            &pool,
            "delete_bookmark",
            &serde_json::json!({ "entity_id": person_id }),
        )
        .await;
        assert!(
            matches!(delete, Err(MutateError::Invalid(_))),
            "delete_bookmark against a Person is Invalid: {delete:?}"
        );

        // The Person is untouched (neither mutation wrote or deleted it).
        let row_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM entities WHERE id = ?1 AND type = 'person'")
                .bind(&person_id)
                .fetch_one(&pool)
                .await
                .expect("count person rows");
        assert_eq!(row_count, 1, "the wrong-type target survives untouched");
    }

    #[tokio::test]
    async fn habit_crud_via_entity_path() {
        let pool = memory_pool().await;

        let entity_id = apply(
            &pool,
            "create_habit",
            &serde_json::json!({
                "name": "Morning walk",
                "cadence": { "interval": 1, "unit": "day" },
                "target": "20 minutes"
            }),
        )
        .await
        .expect("user create_habit succeeds")
        .entity_id
        .expect("create yields an entity id");

        let (entity_type, created_by, schema_version, data): (String, String, i64, String) =
            sqlx::query_as(
                "SELECT type, created_by, schema_version, data FROM entities WHERE id = ?1",
            )
            .bind(&entity_id)
            .fetch_one(&pool)
            .await
            .expect("entity row");
        assert_eq!(entity_type, "habit");
        assert_eq!(created_by, "user");
        assert_eq!(schema_version, 1);
        let data: serde_json::Value = serde_json::from_str(&data).expect("data is JSON");
        assert_eq!(
            data.get("name").and_then(serde_json::Value::as_str),
            Some("Morning walk")
        );
        assert_eq!(
            data.get("cadence").and_then(|cadence| cadence.get("unit")),
            Some(&serde_json::json!("day"))
        );

        let rows = crate::db::list_by_type(&pool, "habit")
            .await
            .expect("list habits");
        assert_eq!(rows.len(), 1, "exactly one habit lists");
        assert_eq!(rows[0].id, entity_id);
        assert_eq!(rows[0].r#type, "habit");

        apply(
            &pool,
            "update_habit",
            &serde_json::json!({
                "entity_id": entity_id,
                "name": "Morning walk",
                "cadence": { "interval": 1, "unit": "day" },
                "status": "paused",
                "note": "rain week"
            }),
        )
        .await
        .expect("user update_habit succeeds");

        let stored: String = sqlx::query_scalar("SELECT data FROM entities WHERE id = ?1")
            .bind(&entity_id)
            .fetch_one(&pool)
            .await
            .expect("stored habit data");
        let stored: serde_json::Value = serde_json::from_str(&stored).expect("data is JSON");
        assert_eq!(
            stored.get("status").and_then(serde_json::Value::as_str),
            Some("paused"),
            "status replaced: {stored}"
        );
        assert!(
            stored.get("target").is_none(),
            "full-document replace drops the omitted target: {stored}"
        );

        let outcome = apply(
            &pool,
            "delete_habit",
            &serde_json::json!({ "entity_id": entity_id }),
        )
        .await
        .expect("user delete_habit succeeds");
        assert!(outcome.entity_id.is_none(), "a delete leaves no entity id");

        let row_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM entities WHERE id = ?1")
            .bind(&entity_id)
            .fetch_one(&pool)
            .await
            .expect("count entity rows");
        assert_eq!(row_count, 0, "the habit row is gone");
    }

    #[tokio::test]
    async fn habit_mutations_against_wrong_type_are_invalid() {
        let pool = memory_pool().await;
        let person_id = apply(&pool, "create_person", &serde_json::json!({ "name": "Al" }))
            .await
            .expect("create person")
            .entity_id
            .expect("entity id");

        let update = apply(
            &pool,
            "update_habit",
            &serde_json::json!({
                "entity_id": person_id,
                "name": "Hijacked",
                "cadence": { "interval": 1, "unit": "day" }
            }),
        )
        .await;
        assert!(
            matches!(update, Err(MutateError::Invalid(_))),
            "update_habit against a Person is Invalid: {update:?}"
        );

        let delete = apply(
            &pool,
            "delete_habit",
            &serde_json::json!({ "entity_id": person_id }),
        )
        .await;
        assert!(
            matches!(delete, Err(MutateError::Invalid(_))),
            "delete_habit against a Person is Invalid: {delete:?}"
        );

        let stored: String =
            sqlx::query_scalar("SELECT data FROM entities WHERE id = ?1 AND type = 'person'")
                .bind(&person_id)
                .fetch_one(&pool)
                .await
                .expect("person row survives");
        let stored: serde_json::Value = serde_json::from_str(&stored).expect("data is JSON");
        assert_eq!(
            stored.get("name").and_then(serde_json::Value::as_str),
            Some("Al"),
            "the wrong-type target survives untouched: {stored}"
        );
    }
}
