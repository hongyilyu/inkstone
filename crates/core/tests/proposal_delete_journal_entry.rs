use sqlx::{Row, SqlitePool};
use uuid::Uuid;

mod common;
use common::{
    Workspace, await_completed, migrated_pool, open_readonly_pool, park_proposal,
    proposal_id_of, rpc, rt, seed_accepted_journal_entry, seed_accepted_journal_entry_full,
    seed_thread,
};

fn write_delete_params(path: &std::path::Path, entity_id: Uuid) {
    std::fs::write(
        path,
        serde_json::json!({
            "mutation_kind": "delete_journal_entry",
            "payload": {
                "entity_id": entity_id.to_string()
            },
            "rationale": "the user wants to remove a mistaken Journal Entry"
        })
        .to_string(),
    )
    .expect("write delete params");
}

async fn entity_exists(pool: &SqlitePool, entity_id: Uuid) -> bool {
    let row: Option<String> = sqlx::query_scalar("SELECT id FROM entities WHERE id = ?1")
        .bind(entity_id.to_string())
        .fetch_optional(pool)
        .await
        .expect("query entity exists");
    row.is_some()
}

async fn revision_count(pool: &SqlitePool, entity_id: Uuid) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM entity_revisions WHERE entity_id = ?1")
        .bind(entity_id.to_string())
        .fetch_one(pool)
        .await
        .expect("count revisions")
}

async fn source_count(pool: &SqlitePool, entity_id: Uuid) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM entity_sources WHERE entity_id = ?1")
        .bind(entity_id.to_string())
        .fetch_one(pool)
        .await
        .expect("count sources")
}

#[test]
fn same_thread_delete_accept_hard_deletes_entry_and_cascades() {
    let workspace = Workspace::new();
    let params_path = workspace.path().join("delete-params.json");
    let thread_id = Uuid::now_v7();

    let rt = rt();

    let entity_id = rt.block_on(async {
        let pool = migrated_pool(&workspace).await;
        seed_thread(&pool, thread_id, "Journal thread", 1).await;
        let entity_id = seed_accepted_journal_entry(
            &pool,
            thread_id,
            "2026-06-10T10:30:00",
            "Bought milk after daycare pickup.",
            2,
        )
        .await;
        pool.close().await;
        entity_id
    });

    write_delete_params(&params_path, entity_id);
    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    let run_id = rt.block_on(async {
        let (run_id, proposal) = park_proposal(
            &core,
            thread_id,
            "Delete that mistaken Journal Entry.",
            Some("delete_journal_entry"),
        )
        .await;
        let proposal_id = proposal_id_of(&proposal);
        let resp = rpc(
            &core,
            4,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "delete-accept",
            }),
        )
        .await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "delete accept result - body: {resp}"
        );
        assert_eq!(
            resp["result"]["entity_id"].as_str(),
            Some(entity_id.to_string().as_str()),
            "delete accept returns the deleted entity id - body: {resp}"
        );
        await_completed(&core, &run_id).await;
        let replay = rpc(
            &core,
            5,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "delete-accept",
            }),
        )
        .await;
        assert_eq!(
            replay["result"]["status"].as_str(),
            Some("accepted"),
            "delete accept replay returns the prior outcome - body: {replay}"
        );
        assert_eq!(
            replay["result"]["entity_id"].as_str(),
            Some(entity_id.to_string().as_str()),
            "delete accept replay recovers the deleted target id - body: {replay}"
        );
        run_id
    });

    rt.block_on(async {
        let pool = open_readonly_pool(&workspace).await;
        assert!(
            !entity_exists(&pool, entity_id).await,
            "accepted delete removes the Journal Entry"
        );
        assert_eq!(
            revision_count(&pool, entity_id).await,
            0,
            "accepted delete relies on cascade cleanup for revisions"
        );
        assert_eq!(
            source_count(&pool, entity_id).await,
            0,
            "accepted delete relies on cascade cleanup for sources"
        );

        let row = sqlx::query(
            "SELECT p.status, tc.status AS tool_status \
             FROM proposals p JOIN tool_calls tc ON tc.id = p.tool_call_id \
             WHERE tc.run_id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("delete proposal row exists");
        let proposal_status: String = row.get("status");
        let tool_status: String = row.get("tool_status");
        assert_eq!(proposal_status, "accepted", "delete proposal accepted");
        assert_eq!(tool_status, "completed", "delete tool call resolved");
    });
}

#[test]
fn delete_reject_leaves_entry_unchanged() {
    let workspace = Workspace::new();
    let params_path = workspace.path().join("delete-params.json");
    let thread_id = Uuid::now_v7();

    let rt = rt();

    let entity_id = rt.block_on(async {
        let pool = migrated_pool(&workspace).await;
        seed_thread(&pool, thread_id, "Journal thread", 1).await;
        let entity_id = seed_accepted_journal_entry(
            &pool,
            thread_id,
            "2026-06-10T10:30:00",
            "Bought milk after daycare pickup.",
            2,
        )
        .await;
        pool.close().await;
        entity_id
    });

    write_delete_params(&params_path, entity_id);
    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    let run_id = rt.block_on(async {
        let (run_id, proposal) = park_proposal(
            &core,
            thread_id,
            "Actually keep that Journal Entry.",
            Some("delete_journal_entry"),
        )
        .await;
        let proposal_id = proposal_id_of(&proposal);
        let resp = rpc(
            &core,
            5,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "reject",
                "decision_idempotency_key": "delete-reject",
            }),
        )
        .await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("rejected"),
            "delete reject result - body: {resp}"
        );
        assert!(
            resp["result"].get("entity_id").is_none(),
            "reject omits entity_id - body: {resp}"
        );
        await_completed(&core, &run_id).await;
        run_id
    });

    rt.block_on(async {
        let pool = open_readonly_pool(&workspace).await;
        assert!(
            entity_exists(&pool, entity_id).await,
            "rejected delete leaves the Journal Entry in place"
        );
        assert_eq!(
            revision_count(&pool, entity_id).await,
            1,
            "rejected delete writes no new revisions"
        );
        assert_eq!(
            source_count(&pool, entity_id).await,
            1,
            "rejected delete writes no source changes"
        );

        let row = sqlx::query(
            "SELECT p.status, tc.status AS tool_status \
             FROM proposals p JOIN tool_calls tc ON tc.id = p.tool_call_id \
             WHERE tc.run_id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("delete proposal row exists");
        let proposal_status: String = row.get("status");
        let tool_status: String = row.get("tool_status");
        assert_eq!(proposal_status, "rejected", "delete proposal rejected");
        assert_eq!(tool_status, "completed", "delete tool call resolved");
    });
}

#[test]
fn delete_edit_is_invalid_and_leaves_proposal_pending() {
    let workspace = Workspace::new();
    let params_path = workspace.path().join("delete-params.json");
    let thread_id = Uuid::now_v7();

    let rt = rt();

    let entity_id = rt.block_on(async {
        let pool = migrated_pool(&workspace).await;
        seed_thread(&pool, thread_id, "Journal thread", 1).await;
        let entity_id = seed_accepted_journal_entry(
            &pool,
            thread_id,
            "2026-06-10T10:30:00",
            "Bought milk after daycare pickup.",
            2,
        )
        .await;
        pool.close().await;
        entity_id
    });

    write_delete_params(&params_path, entity_id);
    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    let run_id = rt.block_on(async {
        let (run_id, proposal) = park_proposal(
            &core,
            thread_id,
            "Edit that delete proposal.",
            Some("delete_journal_entry"),
        )
        .await;
        let proposal_id = proposal_id_of(&proposal);
        let resp = rpc(
            &core,
            6,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "edit",
                "edited_payload": { "entity_id": entity_id.to_string() },
                "decision_idempotency_key": "delete-edit-invalid",
            }),
        )
        .await;
        assert_eq!(
            resp["error"]["code"].as_i64(),
            Some(-32602),
            "delete edit is invalid_params - body: {resp}"
        );
        assert!(
            resp["error"]["message"]
                .as_str()
                .unwrap_or_default()
                .contains("delete_journal_entry"),
            "invalid reason names delete_journal_entry - body: {resp}"
        );
        let parked = rpc(
            &core,
            7,
            "run/subscribe",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        assert_eq!(
            parked["result"]["status"].as_str(),
            Some("parked"),
            "invalid delete edit leaves the Run parked - body: {parked}"
        );
        run_id
    });

    rt.block_on(async {
        let pool = open_readonly_pool(&workspace).await;
        assert!(
            entity_exists(&pool, entity_id).await,
            "invalid delete edit leaves the Journal Entry in place"
        );

        let row = sqlx::query(
            "SELECT p.status, tc.status AS tool_status \
             FROM proposals p JOIN tool_calls tc ON tc.id = p.tool_call_id \
             WHERE tc.run_id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("delete proposal row exists");
        let proposal_status: String = row.get("status");
        let tool_status: String = row.get("tool_status");
        assert_eq!(
            proposal_status, "pending",
            "invalid delete edit leaves proposal pending"
        );
        assert_eq!(
            tool_status, "pending",
            "invalid delete edit leaves tool call unresolved"
        );
    });
}

#[test]
fn cross_thread_delete_is_invalid_and_leaves_entry_unchanged() {
    let workspace = Workspace::new();
    let params_path = workspace.path().join("delete-params.json");
    let source_thread_id = Uuid::now_v7();
    let other_thread_id = Uuid::now_v7();

    let rt = rt();

    let entity_id = rt.block_on(async {
        let pool = migrated_pool(&workspace).await;
        seed_thread(&pool, source_thread_id, "Source thread", 1).await;
        seed_thread(&pool, other_thread_id, "Other thread", 2).await;
        let entity_id = seed_accepted_journal_entry(
            &pool,
            source_thread_id,
            "2026-06-10T10:30:00",
            "Bought milk after daycare pickup.",
            3,
        )
        .await;
        pool.close().await;
        entity_id
    });

    write_delete_params(&params_path, entity_id);
    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    let run_id = rt.block_on(async {
        let (run_id, proposal) = park_proposal(
            &core,
            other_thread_id,
            "Delete the earlier Journal Entry from the other thread.",
            Some("delete_journal_entry"),
        )
        .await;
        let proposal_id = proposal_id_of(&proposal);
        let resp = rpc(
            &core,
            8,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "delete-cross-thread-invalid",
            }),
        )
        .await;
        assert_eq!(
            resp["error"]["code"].as_i64(),
            Some(-32602),
            "cross-thread delete is invalid_params - body: {resp}"
        );
        assert!(
            resp["error"]["message"]
                .as_str()
                .unwrap_or_default()
                .contains("current Thread"),
            "invalid reason names current Thread - body: {resp}"
        );
        run_id
    });

    rt.block_on(async {
        let pool = open_readonly_pool(&workspace).await;
        assert!(
            entity_exists(&pool, entity_id).await,
            "cross-thread invalid delete leaves the Journal Entry in place"
        );

        let row = sqlx::query(
            "SELECT p.status, tc.status AS tool_status \
             FROM proposals p JOIN tool_calls tc ON tc.id = p.tool_call_id \
             WHERE tc.run_id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("delete proposal row exists");
        let proposal_status: String = row.get("status");
        let tool_status: String = row.get("tool_status");
        assert_eq!(
            proposal_status, "pending",
            "cross-thread invalid delete leaves proposal pending"
        );
        assert_eq!(
            tool_status, "pending",
            "cross-thread invalid delete leaves tool call unresolved"
        );
    });
}

#[test]
fn non_user_created_from_delete_is_invalid_and_leaves_entry_unchanged() {
    let workspace = Workspace::new();
    let params_path = workspace.path().join("delete-params.json");
    let thread_id = Uuid::now_v7();

    let rt = rt();

    let entity_id = rt.block_on(async {
        let pool = migrated_pool(&workspace).await;
        seed_thread(&pool, thread_id, "Journal thread", 1).await;
        let entity_id = seed_accepted_journal_entry_full(
            &pool,
            thread_id,
            Uuid::now_v7(),
            "2026-06-10T10:30:00",
            None,
            "Bought milk after daycare pickup.",
            2,
            "assistant",
        )
        .await;
        pool.close().await;
        entity_id
    });

    write_delete_params(&params_path, entity_id);
    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    let run_id = rt.block_on(async {
        let (run_id, proposal) = park_proposal(
            &core,
            thread_id,
            "Delete that earlier entry.",
            Some("delete_journal_entry"),
        )
        .await;
        let proposal_id = proposal_id_of(&proposal);
        let resp = rpc(
            &core,
            9,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "delete-non-user-created-from-invalid",
            }),
        )
        .await;
        assert_eq!(
            resp["error"]["code"].as_i64(),
            Some(-32602),
            "non-user created_from delete is invalid_params - body: {resp}"
        );
        assert!(
            resp["error"]["message"]
                .as_str()
                .unwrap_or_default()
                .contains("created_from a user Message"),
            "invalid reason names the created_from user Message requirement - body: {resp}"
        );
        run_id
    });

    rt.block_on(async {
        let pool = open_readonly_pool(&workspace).await;
        assert!(
            entity_exists(&pool, entity_id).await,
            "non-user created_from invalid delete leaves the Journal Entry in place"
        );

        let row = sqlx::query(
            "SELECT p.status, tc.status AS tool_status \
             FROM proposals p JOIN tool_calls tc ON tc.id = p.tool_call_id \
             WHERE tc.run_id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("delete proposal row exists");
        let proposal_status: String = row.get("status");
        let tool_status: String = row.get("tool_status");
        assert_eq!(
            proposal_status, "pending",
            "non-user created_from invalid delete leaves proposal pending"
        );
        assert_eq!(
            tool_status, "pending",
            "non-user created_from invalid delete leaves tool call unresolved"
        );
    });
}
