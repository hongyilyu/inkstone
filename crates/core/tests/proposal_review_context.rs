use std::path::Path;

use sqlx::SqlitePool;
use uuid::Uuid;

mod common;
use common::{
    Workspace, migrated_pool, open_readonly_pool, park_proposal, rt,
    seed_accepted_journal_entry, seed_accepted_journal_entry_full, seed_thread,
};

fn write_params(path: &Path, json: serde_json::Value) {
    std::fs::write(path, json.to_string()).expect("write params file");
}

async fn request_payload_for_run(pool: &SqlitePool, run_id: &str) -> serde_json::Value {
    let payload: String =
        sqlx::query_scalar("SELECT request_payload FROM tool_calls WHERE run_id = ?1")
            .bind(run_id)
            .fetch_one(pool)
            .await
            .expect("tool_call request_payload exists");
    serde_json::from_str(&payload).expect("request_payload is JSON")
}

async fn replace_journal_entry_body(
    pool: &SqlitePool,
    entity_id: Uuid,
    body: serde_json::Value,
) {
    let data: String = sqlx::query_scalar("SELECT data FROM entities WHERE id = ?1")
        .bind(entity_id.to_string())
        .fetch_one(pool)
        .await
        .expect("entity row exists");
    let mut data = serde_json::from_str::<serde_json::Value>(&data).expect("entity data JSON");
    data["body"] = body;
    sqlx::query("UPDATE entities SET data = ?1 WHERE id = ?2")
        .bind(data.to_string())
        .bind(entity_id.to_string())
        .execute(pool)
        .await
        .expect("replace entity body");
}

#[test]
fn proposal_get_returns_display_only_current_context_for_journal_entry_reviews() {
    let workspace = Workspace::new();
    let params_path = workspace.path().join("proposal-params.json");
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
            Some("2026-06-10T10:45:00"),
            "Bought milk after daycare pickup.",
            2,
            "user",
        )
        .await;
        pool.close().await;
        entity_id
    });

    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    rt.block_on(async {
        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "update_journal_entry",
                "payload": {
                    "entity_id": entity_id.to_string(),
                    "occurred_at": "2026-06-10T11:00:00",
                    "body": [{ "type": "text", "text": "Bought milk and bread after daycare pickup." }]
                },
                "rationale": "the user corrected the note"
            }),
        );
        let (update_run_id, update_resp) = park_proposal(
            &core,
            thread_id,
            "Actually, that entry should mention bread too.",
            None,
        )
        .await;
        let update_result = &update_resp["result"];
        assert_eq!(
            update_result["review_context"]["current_journal_entry"]["entity_id"].as_str(),
            Some(entity_id.to_string().as_str()),
            "update proposal returns the current entry entity id - body: {update_resp}"
        );
        assert_eq!(
            update_result["review_context"]["current_journal_entry"]["occurred_at"].as_str(),
            Some("2026-06-10T10:30:00"),
            "update proposal returns the current entry timestamp - body: {update_resp}"
        );
        assert_eq!(
            update_result["review_context"]["current_journal_entry"]["ended_at"].as_str(),
            Some("2026-06-10T10:45:00"),
            "update proposal returns the current entry end timestamp - body: {update_resp}"
        );
        assert_eq!(
            update_result["review_context"]["current_journal_entry"]["body"][0]["text"].as_str(),
            Some("Bought milk after daycare pickup."),
            "update proposal returns the current entry body - body: {update_resp}"
        );
        assert!(
            update_result["payload"].get("review_context").is_none(),
            "update payload stays mutation-only - body: {update_resp}"
        );

        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "delete_journal_entry",
                "payload": {
                    "entity_id": entity_id.to_string()
                },
                "rationale": "the user wants to remove the mistaken note"
            }),
        );
        let (delete_run_id, delete_resp) =
            park_proposal(&core, thread_id, "Delete that mistaken Journal Entry.", None).await;
        let delete_result = &delete_resp["result"];
        assert_eq!(
            delete_result["review_context"]["current_journal_entry"]["entity_id"].as_str(),
            Some(entity_id.to_string().as_str()),
            "delete proposal returns the current entry entity id - body: {delete_resp}"
        );
        assert_eq!(
            delete_result["review_context"]["current_journal_entry"]["body"][0]["text"].as_str(),
            Some("Bought milk after daycare pickup."),
            "delete proposal returns the current entry body - body: {delete_resp}"
        );
        assert!(
            delete_result["payload"].get("review_context").is_none(),
            "delete payload stays mutation-only - body: {delete_resp}"
        );

        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "create_journal_entry",
                "payload": {
                    "occurred_at": "2026-06-11T08:00:00",
                    "body": [{ "type": "text", "text": "Dropped off the return package." }]
                },
                "rationale": "the user shared a new note"
            }),
        );
        let (create_run_id, create_resp) =
            park_proposal(&core, thread_id, "Log the package return too.", None).await;
        assert!(
            create_resp["result"].get("review_context").is_none(),
            "create proposal omits review_context - body: {create_resp}"
        );

        let pool = open_readonly_pool(&workspace).await;

        let update_request_payload = request_payload_for_run(&pool, &update_run_id).await;
        assert!(
            update_request_payload.get("review_context").is_none(),
            "stored update tool payload omits review_context"
        );
        assert_eq!(
            update_request_payload["payload"],
            serde_json::json!({
                "entity_id": entity_id.to_string(),
                "occurred_at": "2026-06-10T11:00:00",
                "body": [{ "type": "text", "text": "Bought milk and bread after daycare pickup." }]
            }),
            "stored update payload remains mutation-only"
        );

        let delete_request_payload = request_payload_for_run(&pool, &delete_run_id).await;
        assert!(
            delete_request_payload.get("review_context").is_none(),
            "stored delete tool payload omits review_context"
        );
        assert_eq!(
            delete_request_payload["payload"],
            serde_json::json!({ "entity_id": entity_id.to_string() }),
            "stored delete payload remains mutation-only"
        );

        let create_request_payload = request_payload_for_run(&pool, &create_run_id).await;
        assert!(
            create_request_payload.get("review_context").is_none(),
            "stored create tool payload omits review_context"
        );
    });
}

#[test]
fn proposal_get_review_context_preserves_entity_ref_body_nodes() {
    let workspace = Workspace::new();
    let params_path = workspace.path().join("proposal-params.json");
    let thread_id = Uuid::now_v7();
    let ref_id = Uuid::now_v7();

    let rt = rt();

    let entity_id = rt.block_on(async {
        let pool = migrated_pool(&workspace).await;
        seed_thread(&pool, thread_id, "Journal thread", 1).await;
        let entity_id = seed_accepted_journal_entry(
            &pool,
            thread_id,
            "2026-06-10T10:30:00",
            "Met Alice at school.",
            2,
        )
        .await;
        replace_journal_entry_body(
            &pool,
            entity_id,
            serde_json::json!([
                { "type": "text", "text": "Met " },
                { "type": "entity_ref", "ref_id": ref_id.to_string() },
                { "type": "text", "text": " at school." }
            ]),
        )
        .await;
        pool.close().await;
        entity_id
    });

    write_params(
        &params_path,
        serde_json::json!({
            "mutation_kind": "update_journal_entry",
            "payload": {
                "entity_id": entity_id.to_string(),
                "occurred_at": "2026-06-10T11:00:00",
                "body": [{ "type": "text", "text": "Met Alice and Bob at school." }]
            },
            "rationale": "the user corrected the note"
        }),
    );
    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    rt.block_on(async {
        let (_, resp) =
            park_proposal(&core, thread_id, "Actually, mention Bob too.", None).await;
        let body = &resp["result"]["review_context"]["current_journal_entry"]["body"];
        assert_eq!(
            body,
            &serde_json::json!([
                { "type": "text", "text": "Met " },
                { "type": "entity_ref", "ref_id": ref_id.to_string() },
                { "type": "text", "text": " at school." }
            ]),
            "review context keeps the full mixed body - body: {resp}"
        );
    });
}

#[test]
fn proposal_get_omits_review_context_for_cross_thread_journal_entry_targets() {
    let workspace = Workspace::new();
    let params_path = workspace.path().join("proposal-params.json");
    let source_thread_id = Uuid::now_v7();
    let other_thread_id = Uuid::now_v7();

    let rt = rt();

    let entity_id = rt.block_on(async {
        let pool = migrated_pool(&workspace).await;
        seed_thread(&pool, source_thread_id, "Journal thread", 1).await;
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

    write_params(
        &params_path,
        serde_json::json!({
            "mutation_kind": "update_journal_entry",
            "payload": {
                "entity_id": entity_id.to_string(),
                "occurred_at": "2026-06-10T11:00:00",
                "body": [{ "type": "text", "text": "Bought milk and bread after daycare pickup." }]
            },
            "rationale": "the user corrected a Journal Entry from another Thread"
        }),
    );
    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    rt.block_on(async {
        let (_run_id, resp) = park_proposal(
            &core,
            other_thread_id,
            "Actually, update that earlier entry from the other thread.",
            None,
        )
        .await;
        assert!(
            resp["result"].get("review_context").is_none(),
            "cross-thread update proposal/get must not expose current entry context - body: {resp}"
        );

        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "delete_journal_entry",
                "payload": {
                    "entity_id": entity_id.to_string()
                },
                "rationale": "the user wants to remove a Journal Entry from another Thread"
            }),
        );
        let (_delete_run_id, delete_resp) = park_proposal(
            &core,
            other_thread_id,
            "Actually, delete that earlier entry from the other thread.",
            None,
        )
        .await;
        assert!(
            delete_resp["result"].get("review_context").is_none(),
            "cross-thread delete proposal/get must not expose current entry context - body: {delete_resp}"
        );
    });
}
