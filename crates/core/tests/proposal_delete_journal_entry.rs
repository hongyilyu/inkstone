use std::path::PathBuf;
use std::time::{Duration, Instant};

use futures_util::SinkExt;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Executor, Row, SqlitePool};
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
    body_text: &str,
    created_at: i64,
) -> Uuid {
    seed_accepted_journal_entry_with_source_role(
        pool,
        thread_id,
        occurred_at,
        body_text,
        created_at,
        "user",
    )
    .await
}

async fn seed_accepted_journal_entry_with_source_role(
    pool: &SqlitePool,
    thread_id: Uuid,
    occurred_at: &str,
    body_text: &str,
    created_at: i64,
    source_role: &str,
) -> Uuid {
    let entity_id = Uuid::now_v7();
    let run_id = Uuid::now_v7();
    let user_message_id = Uuid::now_v7();
    let assistant_message_id = Uuid::now_v7();
    let tool_call_id = format!("tc_{entity_id}");
    let proposal_id = Uuid::now_v7().to_string();
    let source_id = Uuid::now_v7().to_string();
    let payload = serde_json::json!({
        "occurred_at": occurred_at,
        "body": [{ "type": "text", "text": body_text }]
    });
    let payload_str = payload.to_string();

    let mut tx = pool.begin().await.expect("begin seed tx");
    tx.execute(sqlx::query(
        "INSERT INTO runs \
         (id, thread_id, workflow_name, workflow_version, provider, model, user_message_id, status, started_at, ended_at, terminal_reason) \
         VALUES (?1, ?2, 'default', '1.0.0', 'faux', 'fake-model', ?3, 'completed', ?4, ?4, 'completed')",
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
             VALUES (?1, ?2, ?3, ?4, 'completed', ?5, ?5)",
        )
        .bind(user_message_id.to_string())
        .bind(thread_id.to_string())
        .bind(run_id.to_string())
        .bind(source_role)
        .bind(created_at),
    )
    .await
    .expect("insert source message");
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
    .expect("insert source text");
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
    let deadline = Instant::now() + Duration::from_secs(15);
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

async fn park_delete_proposal(
    core: &CoreHandle,
    thread_id: Uuid,
    prompt: &str,
) -> (String, String) {
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

    let resp = rpc(
        core,
        3,
        "proposal/get",
        serde_json::json!({ "run_id": run_id }),
    )
    .await;
    let proposal_id = resp["result"]["proposal_id"]
        .as_str()
        .unwrap_or_else(|| panic!("proposal_id is a string - body: {resp}"))
        .to_string();
    assert_eq!(
        resp["result"]["mutation_kind"].as_str(),
        Some("delete_journal_entry"),
        "parked Proposal is a delete - body: {resp}"
    );
    (run_id, proposal_id)
}

async fn open_readonly_pool(db_path: PathBuf) -> SqlitePool {
    let url = format!("sqlite://{}?mode=ro", db_path.display());
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .expect("connect to migrated DB")
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
        let (run_id, proposal_id) =
            park_delete_proposal(&core, thread_id, "Delete that mistaken Journal Entry.").await;
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
        await_run_status(&core, &run_id, "completed").await;
        run_id
    });

    rt.block_on(async {
        let pool = open_readonly_pool(workspace.db_path().to_path_buf()).await;
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
        let (run_id, proposal_id) =
            park_delete_proposal(&core, thread_id, "Actually keep that Journal Entry.").await;
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
        await_run_status(&core, &run_id, "completed").await;
        run_id
    });

    rt.block_on(async {
        let pool = open_readonly_pool(workspace.db_path().to_path_buf()).await;
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
        let (run_id, proposal_id) =
            park_delete_proposal(&core, thread_id, "Edit that delete proposal.").await;
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
        let pool = open_readonly_pool(workspace.db_path().to_path_buf()).await;
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

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

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
        let (run_id, proposal_id) = park_delete_proposal(
            &core,
            other_thread_id,
            "Delete the earlier Journal Entry from the other thread.",
        )
        .await;
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
        let pool = open_readonly_pool(workspace.db_path().to_path_buf()).await;
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

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let entity_id = rt.block_on(async {
        let pool = migrated_pool(&workspace).await;
        seed_thread(&pool, thread_id, "Journal thread", 1).await;
        let entity_id = seed_accepted_journal_entry_with_source_role(
            &pool,
            thread_id,
            "2026-06-10T10:30:00",
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
        let (run_id, proposal_id) =
            park_delete_proposal(&core, thread_id, "Delete that earlier entry.").await;
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
        let pool = open_readonly_pool(workspace.db_path().to_path_buf()).await;
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
