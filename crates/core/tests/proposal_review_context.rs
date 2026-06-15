use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use futures_util::SinkExt;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Executor, SqlitePool};
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

mod common;
use common::{CoreHandle, Workspace, next_text};

async fn migrated_pool(workspace: &Workspace) -> SqlitePool {
    let options = SqliteConnectOptions::new()
        .filename(workspace.db_path())
        .create_if_missing(true)
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("open sqlite pool");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("run migrations");
    pool
}

async fn seed_thread(pool: &SqlitePool, thread_id: Uuid, title: &str, now_ms: i64) {
    sqlx::query(
        "INSERT INTO threads (id, title, created_at, last_activity_at) VALUES (?1, ?2, ?3, ?3)",
    )
    .bind(thread_id.to_string())
    .bind(title)
    .bind(now_ms)
    .execute(pool)
    .await
    .expect("insert thread");
}

async fn seed_accepted_journal_entry(
    pool: &SqlitePool,
    thread_id: Uuid,
    occurred_at: &str,
    ended_at: Option<&str>,
    body_text: &str,
    created_at: i64,
) -> Uuid {
    let entity_id = Uuid::now_v7();
    let run_id = Uuid::now_v7();
    let user_message_id = Uuid::now_v7();
    let assistant_message_id = Uuid::now_v7();
    let tool_call_id = format!("tc_{entity_id}");
    let proposal_id = Uuid::now_v7().to_string();
    let source_id = Uuid::now_v7().to_string();
    let mut payload = serde_json::json!({
        "occurred_at": occurred_at,
        "body": [{ "type": "text", "text": body_text }]
    });
    if let Some(ended_at) = ended_at {
        payload["ended_at"] = serde_json::Value::String(ended_at.to_string());
    }
    let payload_str = payload.to_string();

    let mut tx = pool.begin().await.expect("begin seed tx");
    tx.execute(sqlx::query(
        "INSERT INTO runs \
         (id, thread_id, workflow_name, workflow_version, provider, model, thinking_level, user_message_id, status, started_at, ended_at, terminal_reason) \
         VALUES (?1, ?2, 'default', '1.0.0', 'faux', 'fake-model', 'off', ?3, 'completed', ?4, ?4, 'completed')",
    )
    .bind(run_id.to_string())
    .bind(thread_id.to_string())
    .bind(user_message_id.to_string())
    .bind(created_at))
    .await
    .expect("insert run");
    tx.execute(
        sqlx::query(
            "INSERT INTO messages (id, thread_id, run_id, role, status, created_at, updated_at) \
             VALUES (?1, ?2, ?3, 'user', 'completed', ?4, ?4)",
        )
        .bind(user_message_id.to_string())
        .bind(thread_id.to_string())
        .bind(run_id.to_string())
        .bind(created_at),
    )
    .await
    .expect("insert user message");
    tx.execute(
        sqlx::query(
            "INSERT INTO messages (id, thread_id, run_id, role, status, created_at, updated_at) \
             VALUES (?1, ?2, ?3, 'assistant', 'completed', ?4, ?4)",
        )
        .bind(assistant_message_id.to_string())
        .bind(thread_id.to_string())
        .bind(run_id.to_string())
        .bind(created_at),
    )
    .await
    .expect("insert assistant message");
    tx.execute(
        sqlx::query(
            "INSERT INTO message_parts (message_id, seq, type, text) VALUES (?1, 0, 'text', ?2)",
        )
        .bind(user_message_id.to_string())
        .bind(body_text),
    )
    .await
    .expect("insert user text");
    tx.execute(
        sqlx::query(
            "INSERT INTO message_parts (message_id, seq, type, text) VALUES (?1, 0, 'text', '')",
        )
        .bind(assistant_message_id.to_string()),
    )
    .await
    .expect("insert assistant text");
    tx.execute(sqlx::query(
        "INSERT INTO tool_calls (id, run_id, name, request_payload, status, result_payload, requested_at, resolved_at) \
         VALUES (?1, ?2, 'propose_workspace_mutation', ?3, 'completed', '{}', ?4, ?4)",
    )
    .bind(&tool_call_id)
    .bind(run_id.to_string())
    .bind(serde_json::json!({ "mutation_kind": "create_journal_entry", "payload": payload }).to_string())
    .bind(created_at))
    .await
    .expect("insert tool call");
    tx.execute(sqlx::query(
        "INSERT INTO proposals (id, tool_call_id, mutation_kind, status, decided_by, decided_at, applied_at) \
         VALUES (?1, ?2, 'create_journal_entry', 'accepted', 'user', ?3, ?3)",
    )
    .bind(&proposal_id)
    .bind(&tool_call_id)
    .bind(created_at))
    .await
    .expect("insert proposal");
    tx.execute(sqlx::query(
        "INSERT INTO entities (id, type, schema_version, data, created_by, created_via_proposal_id, created_at, updated_at) \
         VALUES (?1, 'journal_entry', 1, ?2, 'proposal', ?3, ?4, ?4)",
    )
    .bind(entity_id.to_string())
    .bind(&payload_str)
    .bind(&proposal_id)
    .bind(created_at))
    .await
    .expect("insert entity");
    tx.execute(
        sqlx::query(
            "INSERT INTO entity_revisions (entity_id, seq, data, proposal_id, created_at) \
             VALUES (?1, 1, ?2, ?3, ?4)",
        )
        .bind(entity_id.to_string())
        .bind(&payload_str)
        .bind(&proposal_id)
        .bind(created_at),
    )
    .await
    .expect("insert entity revision");
    tx.execute(
        sqlx::query(
            "INSERT INTO entity_sources (id, entity_id, source_message_id, relation, created_at) \
             VALUES (?1, ?2, ?3, 'created_from', ?4)",
        )
        .bind(&source_id)
        .bind(entity_id.to_string())
        .bind(user_message_id.to_string())
        .bind(created_at),
    )
    .await
    .expect("insert entity source");

    tx.commit().await.expect("commit seed tx");
    entity_id
}

fn write_params(path: &Path, json: serde_json::Value) {
    std::fs::write(path, json.to_string()).expect("write params file");
}

async fn rpc(
    core: &CoreHandle,
    id: u64,
    method: &str,
    params: serde_json::Value,
) -> serde_json::Value {
    let mut ws = core.connect().await;
    let req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    ws.send(Message::Text(req.to_string().into()))
        .await
        .expect("send request frame");
    let body = next_text(&mut ws).await;
    ws.close(None).await.ok();
    serde_json::from_str(&body).unwrap_or_else(|e| panic!("response is JSON: {e} - body: {body}"))
}

async fn await_run_status(core: &CoreHandle, run_id: &str, status: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if Instant::now() > deadline {
            panic!("timed out waiting for run status {status}");
        }
        let resp = rpc(
            core,
            90,
            "run/subscribe",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        if resp["result"]["status"].as_str() == Some(status) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

async fn park_proposal(
    core: &CoreHandle,
    thread_id: Uuid,
    prompt: &str,
) -> (String, serde_json::Value) {
    let resp = rpc(
        core,
        1,
        "run/post_message",
        serde_json::json!({ "thread_id": thread_id, "prompt": prompt }),
    )
    .await;
    let run_id = resp["result"]["run_id"]
        .as_str()
        .unwrap_or_else(|| panic!("result.run_id is a string - body: {resp}"))
        .to_string();
    await_run_status(core, &run_id, "parked").await;

    let proposal = rpc(
        core,
        3,
        "proposal/get",
        serde_json::json!({ "run_id": run_id }),
    )
    .await;
    (run_id, proposal)
}

async fn open_readonly_pool(db_path: PathBuf) -> SqlitePool {
    let url = format!("sqlite://{}?mode=ro", db_path.display());
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .expect("connect to migrated DB")
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

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let entity_id = rt.block_on(async {
        let pool = migrated_pool(&workspace).await;
        seed_thread(&pool, thread_id, "Journal thread", 1).await;
        let entity_id = seed_accepted_journal_entry(
            &pool,
            thread_id,
            "2026-06-10T10:30:00",
            Some("2026-06-10T10:45:00"),
            "Bought milk after daycare pickup.",
            2,
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
            park_proposal(&core, thread_id, "Delete that mistaken Journal Entry.").await;
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
            park_proposal(&core, thread_id, "Log the package return too.").await;
        assert!(
            create_resp["result"].get("review_context").is_none(),
            "create proposal omits review_context - body: {create_resp}"
        );

        let pool = open_readonly_pool(workspace.db_path().to_path_buf()).await;

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

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let entity_id = rt.block_on(async {
        let pool = migrated_pool(&workspace).await;
        seed_thread(&pool, thread_id, "Journal thread", 1).await;
        let entity_id = seed_accepted_journal_entry(
            &pool,
            thread_id,
            "2026-06-10T10:30:00",
            None,
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
            park_proposal(&core, thread_id, "Actually, mention Bob too.").await;
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

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let entity_id = rt.block_on(async {
        let pool = migrated_pool(&workspace).await;
        seed_thread(&pool, source_thread_id, "Journal thread", 1).await;
        seed_thread(&pool, other_thread_id, "Other thread", 2).await;
        let entity_id = seed_accepted_journal_entry(
            &pool,
            source_thread_id,
            "2026-06-10T10:30:00",
            None,
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
        )
        .await;
        assert!(
            delete_resp["result"].get("review_context").is_none(),
            "cross-thread delete proposal/get must not expose current entry context - body: {delete_resp}"
        );
    });
}
