use std::path::{Path, PathBuf};
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
             VALUES (?1, ?2, ?3, ?4, 'completed', ?5, ?5)",
        )
        .bind(user_message_id.to_string())
        .bind(thread_id.to_string())
        .bind(run_id.to_string())
        .bind(source_role)
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

fn write_update_params(path: &Path, entity_id: Uuid, body_text: &str) {
    write_update_params_body(
        path,
        entity_id,
        serde_json::json!([{ "type": "text", "text": body_text }]),
    );
}

fn write_update_params_body(path: &Path, entity_id: Uuid, body: serde_json::Value) {
    std::fs::write(
        path,
        serde_json::json!({
            "mutation_kind": "update_journal_entry",
            "payload": {
                "entity_id": entity_id.to_string(),
                "occurred_at": "2026-06-10T10:45:00",
                "body": body
            },
            "rationale": "the user corrected a Journal Entry from this Thread"
        })
        .to_string(),
    )
    .expect("write update params");
}

async fn seed_entity_ref(
    pool: &SqlitePool,
    source_entity_id: Uuid,
    target_entity_id: Uuid,
    created_at: i64,
) -> Uuid {
    let ref_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO entity_refs \
         (id, source_entity_id, target_entity_id, label_snapshot, created_at) \
         VALUES (?1, ?2, ?3, 'Target snapshot', ?4)",
    )
    .bind(ref_id.to_string())
    .bind(source_entity_id.to_string())
    .bind(target_entity_id.to_string())
    .bind(created_at)
    .execute(pool)
    .await
    .expect("insert entity_ref");
    ref_id
}

async fn seed_accepted_entity(
    pool: &SqlitePool,
    thread_id: Uuid,
    entity_type: &str,
    data: serde_json::Value,
    created_at: i64,
) -> Uuid {
    let entity_id = Uuid::now_v7();
    let run_id = Uuid::now_v7();
    let user_message_id = Uuid::now_v7();
    let tool_call_id = format!("tc_{entity_id}");
    let proposal_id = Uuid::now_v7().to_string();
    let data_str = data.to_string();

    let mut tx = pool.begin().await.expect("begin seed entity tx");
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
    .expect("insert seed entity run");
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
    .expect("insert seed entity user message");
    tx.execute(sqlx::query(
        "INSERT INTO tool_calls (id, run_id, name, request_payload, status, result_payload, requested_at, resolved_at) \
         VALUES (?1, ?2, 'propose_workspace_mutation', '{}', 'completed', '{}', ?3, ?3)",
    )
    .bind(&tool_call_id)
    .bind(run_id.to_string())
    .bind(created_at))
    .await
    .expect("insert seed entity tool call");
    tx.execute(sqlx::query(
        "INSERT INTO proposals (id, tool_call_id, mutation_kind, status, decided_by, decided_at, applied_at) \
         VALUES (?1, ?2, 'seed_entity', 'accepted', 'user', ?3, ?3)",
    )
    .bind(&proposal_id)
    .bind(&tool_call_id)
    .bind(created_at))
    .await
    .expect("insert seed entity proposal");
    tx.execute(sqlx::query(
        "INSERT INTO entities (id, type, schema_version, data, created_by, created_via_proposal_id, created_at, updated_at) \
         VALUES (?1, ?2, 1, ?3, 'proposal', ?4, ?5, ?5)",
    )
    .bind(entity_id.to_string())
    .bind(entity_type)
    .bind(&data_str)
    .bind(&proposal_id)
    .bind(created_at))
    .await
    .expect("insert seed entity");
    tx.execute(
        sqlx::query(
            "INSERT INTO entity_revisions (entity_id, seq, data, proposal_id, created_at) \
             VALUES (?1, 1, ?2, ?3, ?4)",
        )
        .bind(entity_id.to_string())
        .bind(&data_str)
        .bind(&proposal_id)
        .bind(created_at),
    )
    .await
    .expect("insert seed entity revision");
    tx.commit().await.expect("commit seed entity tx");

    entity_id
}

fn write_reference_params(path: &Path, source_entity_id: Uuid, target_entity_id: Uuid) {
    std::fs::write(
        path,
        serde_json::json!({
            "mutation_kind": "reference_existing_entity_from_journal_entry",
            "payload": {
                "source_entity_id": source_entity_id.to_string(),
                "target_entity_id": target_entity_id.to_string(),
                "label_snapshot": "Ada snapshot",
                "body": [
                    { "type": "text", "text": "Met " },
                    { "type": "entity_ref" },
                    { "type": "text", "text": " at school." }
                ]
            },
            "rationale": "link the accepted Person from this Journal Entry"
        })
        .to_string(),
    )
    .expect("write reference params");
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

async fn await_parked(core: &CoreHandle, run_id: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if Instant::now() > deadline {
            panic!("timed out waiting for run to park");
        }
        let resp = rpc(
            core,
            2,
            "run/subscribe",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        if resp["result"]["status"].as_str() == Some("parked") {
            return;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

async fn await_completed(core: &CoreHandle, run_id: &str) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if Instant::now() > deadline {
            panic!("timed out waiting for run to complete");
        }
        let resp = rpc(
            core,
            9,
            "run/subscribe",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        if resp["result"]["status"].as_str() == Some("completed") {
            return;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

async fn park_update_proposal(
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
    await_parked(core, &run_id).await;

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
        Some("update_journal_entry"),
        "parked Proposal is an update - body: {resp}"
    );
    (run_id, proposal_id)
}

async fn park_reference_proposal(
    core: &CoreHandle,
    thread_id: Uuid,
    prompt: &str,
) -> (String, String) {
    let resp = rpc(
        core,
        21,
        "run/post_message",
        serde_json::json!({ "thread_id": thread_id, "prompt": prompt }),
    )
    .await;
    let run_id = resp["result"]["run_id"]
        .as_str()
        .unwrap_or_else(|| panic!("result.run_id is a string - body: {resp}"))
        .to_string();
    await_parked(core, &run_id).await;

    let resp = rpc(
        core,
        22,
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
        Some("reference_existing_entity_from_journal_entry"),
        "parked Proposal references an existing Entity - body: {resp}"
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

async fn entity_data(pool: &SqlitePool, entity_id: Uuid) -> serde_json::Value {
    serde_json::from_str(&raw_entity_data(pool, entity_id).await).expect("entity data is JSON")
}

async fn raw_entity_data(pool: &SqlitePool, entity_id: Uuid) -> String {
    let data: String = sqlx::query_scalar("SELECT data FROM entities WHERE id = ?1")
        .bind(entity_id.to_string())
        .fetch_one(pool)
        .await
        .expect("entity row exists");
    data
}

async fn max_revision_seq(pool: &SqlitePool, entity_id: Uuid) -> i64 {
    sqlx::query_scalar("SELECT MAX(seq) FROM entity_revisions WHERE entity_id = ?1")
        .bind(entity_id.to_string())
        .fetch_one(pool)
        .await
        .expect("max revision seq")
}

async fn revision_text(pool: &SqlitePool, entity_id: Uuid, seq: i64) -> String {
    let data: String =
        sqlx::query_scalar("SELECT data FROM entity_revisions WHERE entity_id = ?1 AND seq = ?2")
            .bind(entity_id.to_string())
            .bind(seq)
            .fetch_one(pool)
            .await
            .expect("revision row exists");
    serde_json::from_str::<serde_json::Value>(&data).expect("revision data JSON")["body"][0]["text"]
        .as_str()
        .expect("revision body text")
        .to_string()
}

async fn revision_data(pool: &SqlitePool, entity_id: Uuid, seq: i64) -> serde_json::Value {
    let data: String =
        sqlx::query_scalar("SELECT data FROM entity_revisions WHERE entity_id = ?1 AND seq = ?2")
            .bind(entity_id.to_string())
            .bind(seq)
            .fetch_one(pool)
            .await
            .expect("revision row exists");
    serde_json::from_str(&data).expect("revision data JSON")
}

async fn updated_from_count_for_run(pool: &SqlitePool, entity_id: Uuid, run_id: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM entity_sources es \
         JOIN runs r ON r.user_message_id = es.source_message_id \
         WHERE es.entity_id = ?1 AND r.id = ?2 AND es.relation = 'updated_from'",
    )
    .bind(entity_id.to_string())
    .bind(run_id)
    .fetch_one(pool)
    .await
    .expect("count updated_from sources")
}

async fn entity_ref_count(
    pool: &SqlitePool,
    source_entity_id: Uuid,
    target_entity_id: Uuid,
) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM entity_refs WHERE source_entity_id = ?1 AND target_entity_id = ?2",
    )
    .bind(source_entity_id.to_string())
    .bind(target_entity_id.to_string())
    .fetch_one(pool)
    .await
    .expect("count entity refs")
}

async fn target_entity_source_count(pool: &SqlitePool, target_entity_id: Uuid) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM entity_sources WHERE entity_id = ?1")
        .bind(target_entity_id.to_string())
        .fetch_one(pool)
        .await
        .expect("count target entity sources")
}

async fn proposal_and_tool_status_for_run(pool: &SqlitePool, run_id: &str) -> (String, String) {
    let row = sqlx::query(
        "SELECT p.status, tc.status AS tool_status \
         FROM proposals p JOIN tool_calls tc ON tc.id = p.tool_call_id \
         WHERE tc.run_id = ?1",
    )
    .bind(run_id)
    .fetch_one(pool)
    .await
    .expect("proposal row exists");
    (row.get("status"), row.get("tool_status"))
}

#[test]
fn same_thread_update_accept_and_edit_replace_payload() {
    let workspace = Workspace::new();
    let params_path = workspace.path().join("update-params.json");
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

    write_update_params(
        &params_path,
        entity_id,
        "Bought milk and bread after daycare pickup.",
    );
    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    let (first_run_id, second_run_id) = rt.block_on(async {
        let (run_id, proposal_id) = park_update_proposal(
            &core,
            thread_id,
            "Actually, that entry should mention bread too.",
        )
        .await;
        let resp = rpc(
            &core,
            4,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "update-accept",
            }),
        )
        .await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "update accept result - body: {resp}"
        );
        assert_eq!(
            resp["result"]["entity_id"].as_str(),
            Some(entity_id.to_string().as_str()),
            "update returns the target entity id - body: {resp}"
        );
        await_completed(&core, &run_id).await;

        write_update_params(&params_path, entity_id, "This worker payload should be replaced.");
        let (edit_run_id, edit_proposal_id) =
            park_update_proposal(&core, thread_id, "Make that correction more precise.").await;
        let resp = rpc(
            &core,
            5,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": edit_proposal_id,
                "decision": "edit",
                "edited_payload": {
                    "entity_id": entity_id.to_string(),
                    "occurred_at": "2026-06-10T10:45:00",
                    "body": [{ "type": "text", "text": "Bought oat milk and bread after daycare pickup." }]
                },
                "decision_idempotency_key": "update-edit",
            }),
        )
        .await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "update edit result - body: {resp}"
        );
        assert_eq!(
            resp["result"]["entity_id"].as_str(),
            Some(entity_id.to_string().as_str()),
            "update edit returns the target entity id - body: {resp}"
        );
        await_completed(&core, &edit_run_id).await;
        (run_id, edit_run_id)
    });

    rt.block_on(async {
        let pool = open_readonly_pool(workspace.db_path().to_path_buf()).await;

        let data = entity_data(&pool, entity_id).await;
        assert_eq!(
            data["body"][0]["text"].as_str(),
            Some("Bought oat milk and bread after daycare pickup."),
            "entity current data is the edited full payload"
        );
        assert!(
            data.get("entity_id").is_none(),
            "entity current data does not persist the update target id"
        );
        assert_eq!(
            max_revision_seq(&pool, entity_id).await,
            3,
            "accept adds seq 2 and edit adds seq 3"
        );
        assert!(
            revision_data(&pool, entity_id, 2)
                .await
                .get("entity_id")
                .is_none(),
            "accepted update revision data does not persist the target id"
        );
        assert!(
            revision_data(&pool, entity_id, 3)
                .await
                .get("entity_id")
                .is_none(),
            "edited update revision data does not persist the target id"
        );
        assert_eq!(
            revision_text(&pool, entity_id, 2).await,
            "Bought milk and bread after daycare pickup.",
            "accepted update appends the next revision"
        );
        assert_eq!(
            revision_text(&pool, entity_id, 3).await,
            "Bought oat milk and bread after daycare pickup.",
            "edited update appends the edited full payload"
        );
        assert_eq!(
            updated_from_count_for_run(&pool, entity_id, &first_run_id).await,
            1,
            "accepted update sources from the current user Message"
        );
        assert_eq!(
            updated_from_count_for_run(&pool, entity_id, &second_run_id).await,
            1,
            "edited update sources from the current user Message"
        );

        let row = sqlx::query(
            "SELECT p.status, p.edited_payload, tc.status AS tool_status \
             FROM proposals p JOIN tool_calls tc ON tc.id = p.tool_call_id \
             WHERE tc.run_id = ?1",
        )
        .bind(&second_run_id)
        .fetch_one(&pool)
        .await
        .expect("edit proposal row exists");
        let proposal_status: String = row.get("status");
        let tool_status: String = row.get("tool_status");
        let edited_payload: Option<String> = row.get("edited_payload");
        assert_eq!(proposal_status, "accepted", "edit proposal accepted");
        assert_eq!(tool_status, "completed", "edit tool call resolved");
        let edited_payload =
            serde_json::from_str::<serde_json::Value>(&edited_payload.expect("edit recorded"))
                .expect("edited_payload JSON");
        assert_eq!(
            edited_payload["body"][0]["text"].as_str(),
            Some("Bought oat milk and bread after daycare pickup."),
            "edit records only the replacement payload"
        );
    });
}

#[test]
fn edit_update_preserves_target_entity_id_when_payload_omits_it() {
    let workspace = Workspace::new();
    let params_path = workspace.path().join("update-params.json");
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

    write_update_params(
        &params_path,
        entity_id,
        "This worker payload should be replaced.",
    );
    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    let run_id = rt.block_on(async {
        let (run_id, proposal_id) =
            park_update_proposal(&core, thread_id, "Tighten that earlier entry.").await;

        let proposal = rpc(
            &core,
            8,
            "proposal/get",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        assert_eq!(
            proposal["result"]["payload"]["entity_id"].as_str(),
            Some(entity_id.to_string().as_str()),
            "parked update Proposal still carries its target entity_id - body: {proposal}"
        );

        let resp = rpc(
            &core,
            9,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "edit",
                "edited_payload": {
                    "occurred_at": "2026-06-10T10:45:00",
                    "body": [{ "type": "text", "text": "Bought oat milk after daycare pickup." }]
                },
                "decision_idempotency_key": "update-edit-preserve-target",
            }),
        )
        .await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "update edit without entity_id still accepts against the original target - body: {resp}"
        );
        assert_eq!(
            resp["result"]["entity_id"].as_str(),
            Some(entity_id.to_string().as_str()),
            "update edit returns the preserved target entity id - body: {resp}"
        );
        await_completed(&core, &run_id).await;
        run_id
    });

    rt.block_on(async {
        let pool = open_readonly_pool(workspace.db_path().to_path_buf()).await;

        let data = entity_data(&pool, entity_id).await;
        assert_eq!(
            data["body"][0]["text"].as_str(),
            Some("Bought oat milk after daycare pickup."),
            "entity current data uses the edited payload"
        );
        assert_eq!(
            max_revision_seq(&pool, entity_id).await,
            2,
            "edit appends exactly one new revision"
        );

        let row = sqlx::query(
            "SELECT p.status, p.edited_payload \
             FROM proposals p JOIN tool_calls tc ON tc.id = p.tool_call_id \
             WHERE tc.run_id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("edit proposal row exists");
        let proposal_status: String = row.get("status");
        let edited_payload: Option<String> = row.get("edited_payload");
        assert_eq!(proposal_status, "accepted", "edit proposal accepted");
        let edited_payload =
            serde_json::from_str::<serde_json::Value>(&edited_payload.expect("edit recorded"))
                .expect("edited_payload JSON");
        assert_eq!(
            edited_payload["entity_id"].as_str(),
            Some(entity_id.to_string().as_str()),
            "accepted proposal records the preserved target entity_id"
        );
        assert_eq!(
            edited_payload["body"][0]["text"].as_str(),
            Some("Bought oat milk after daycare pickup."),
            "accepted proposal records the edited body"
        );
    });
}

#[test]
fn edit_update_rejects_retargeting_to_another_entry() {
    let workspace = Workspace::new();
    let params_path = workspace.path().join("update-params.json");
    let thread_id = Uuid::now_v7();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let (target_entity_id, other_entity_id) = rt.block_on(async {
        let pool = migrated_pool(&workspace).await;
        seed_thread(&pool, thread_id, "Journal thread", 1).await;
        let target_entity_id = seed_accepted_journal_entry(
            &pool,
            thread_id,
            "2026-06-10T10:30:00",
            "Bought milk after daycare pickup.",
            2,
        )
        .await;
        let other_entity_id = seed_accepted_journal_entry(
            &pool,
            thread_id,
            "2026-06-10T11:30:00",
            "Picked up bread after work.",
            3,
        )
        .await;
        pool.close().await;
        (target_entity_id, other_entity_id)
    });

    write_update_params(
        &params_path,
        target_entity_id,
        "This worker payload should be replaced.",
    );
    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    let run_id = rt.block_on(async {
        let (run_id, proposal_id) =
            park_update_proposal(&core, thread_id, "Tighten that earlier entry.").await;

        let resp = rpc(
            &core,
            10,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "edit",
                "edited_payload": {
                    "entity_id": other_entity_id.to_string(),
                    "occurred_at": "2026-06-10T10:45:00",
                    "body": [{ "type": "text", "text": "Bought oat milk after daycare pickup." }]
                },
                "decision_idempotency_key": "update-edit-retarget",
            }),
        )
        .await;
        assert_eq!(
            resp["error"]["code"].as_i64(),
            Some(-32602),
            "retargeting edit is invalid_params - body: {resp}"
        );
        assert!(
            resp["error"]["message"]
                .as_str()
                .unwrap_or_default()
                .contains("cannot change entity_id"),
            "invalid reason names immutable update target - body: {resp}"
        );
        run_id
    });

    rt.block_on(async {
        let pool = open_readonly_pool(workspace.db_path().to_path_buf()).await;

        assert_eq!(
            entity_data(&pool, target_entity_id).await["body"][0]["text"].as_str(),
            Some("Bought milk after daycare pickup."),
            "invalid retarget leaves original target unchanged"
        );
        assert_eq!(
            entity_data(&pool, other_entity_id).await["body"][0]["text"].as_str(),
            Some("Picked up bread after work."),
            "invalid retarget leaves edited target unchanged"
        );
        assert_eq!(
            max_revision_seq(&pool, target_entity_id).await,
            1,
            "invalid retarget writes no target revision"
        );
        assert_eq!(
            max_revision_seq(&pool, other_entity_id).await,
            1,
            "invalid retarget writes no other-entry revision"
        );

        let row = sqlx::query(
            "SELECT p.status, tc.status AS tool_status \
             FROM proposals p JOIN tool_calls tc ON tc.id = p.tool_call_id \
             WHERE tc.run_id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("retarget proposal row exists");
        let proposal_status: String = row.get("status");
        let tool_status: String = row.get("tool_status");
        assert_eq!(
            proposal_status, "pending",
            "invalid edit leaves proposal pending"
        );
        assert_eq!(
            tool_status, "pending",
            "invalid edit leaves tool call unresolved"
        );
    });
}

#[test]
fn update_accepts_mixed_body_when_ref_belongs_to_target_entry() {
    let workspace = Workspace::new();
    let params_path = workspace.path().join("update-params.json");
    let thread_id = Uuid::now_v7();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let (entity_id, ref_id) = rt.block_on(async {
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
        let target_id = seed_accepted_journal_entry(
            &pool,
            thread_id,
            "2026-06-10T09:30:00",
            "Alice exists as a referenced entity stand-in.",
            3,
        )
        .await;
        let ref_id = seed_entity_ref(&pool, entity_id, target_id, 4).await;
        pool.close().await;
        (entity_id, ref_id)
    });

    write_update_params_body(
        &params_path,
        entity_id,
        serde_json::json!([
            { "type": "text", "text": "Met " },
            { "type": "entity_ref", "ref_id": ref_id.to_string() },
            { "type": "text", "text": " at school." }
        ]),
    );
    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    let run_id = rt.block_on(async {
        let (run_id, proposal_id) =
            park_update_proposal(&core, thread_id, "Link Alice in the earlier entry.").await;
        let resp = rpc(
            &core,
            11,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "update-mixed-body-ref",
            }),
        )
        .await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "mixed body update accepts - body: {resp}"
        );
        assert_eq!(
            resp["result"]["entity_id"].as_str(),
            Some(entity_id.to_string().as_str()),
            "mixed body update returns target entity id - body: {resp}"
        );
        await_completed(&core, &run_id).await;
        run_id
    });

    rt.block_on(async {
        let pool = open_readonly_pool(workspace.db_path().to_path_buf()).await;

        let data = entity_data(&pool, entity_id).await;
        assert_eq!(
            data["body"][0]["text"].as_str(),
            Some("Met "),
            "text node remains strict text"
        );
        assert_eq!(
            data["body"][1]["type"].as_str(),
            Some("entity_ref"),
            "entity_ref node is persisted in the Journal Entry body"
        );
        assert_eq!(
            data["body"][1]["ref_id"].as_str(),
            Some(ref_id.to_string().as_str()),
            "entity_ref body node keeps the ref id"
        );
        assert!(
            data.get("entity_id").is_none(),
            "entity current data does not persist the update target id"
        );
        assert_eq!(
            max_revision_seq(&pool, entity_id).await,
            2,
            "mixed update appends exactly one revision"
        );
        assert_eq!(
            updated_from_count_for_run(&pool, entity_id, &run_id).await,
            1,
            "mixed update still sources from the current user Message"
        );
    });
}

#[test]
fn update_rejects_entity_ref_that_does_not_exist() {
    let workspace = Workspace::new();
    let params_path = workspace.path().join("update-params.json");
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
            "Met Alice at school.",
            2,
        )
        .await;
        pool.close().await;
        entity_id
    });

    write_update_params_body(
        &params_path,
        entity_id,
        serde_json::json!([
            { "type": "text", "text": "Met " },
            { "type": "entity_ref", "ref_id": Uuid::now_v7().to_string() }
        ]),
    );
    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    let invalid_run_id = rt.block_on(async {
        let (run_id, proposal_id) =
            park_update_proposal(&core, thread_id, "Link Alice in the earlier entry.").await;
        let resp = rpc(
            &core,
            12,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "update-missing-ref",
            }),
        )
        .await;
        assert_eq!(
            resp["error"]["code"].as_i64(),
            Some(-32602),
            "missing entity_ref is invalid_params - body: {resp}"
        );
        assert!(
            resp["error"]["message"]
                .as_str()
                .unwrap_or_default()
                .contains("entity_ref"),
            "invalid reason names entity_ref - body: {resp}"
        );
        run_id
    });

    rt.block_on(async {
        let pool = open_readonly_pool(workspace.db_path().to_path_buf()).await;
        assert_eq!(
            entity_data(&pool, entity_id).await["body"][0]["text"].as_str(),
            Some("Met Alice at school."),
            "invalid ref update leaves entity unchanged"
        );
        assert_eq!(
            max_revision_seq(&pool, entity_id).await,
            1,
            "invalid ref update writes no new revision"
        );
        assert_eq!(
            updated_from_count_for_run(&pool, entity_id, &invalid_run_id).await,
            0,
            "invalid ref update writes no updated_from source"
        );
        let (proposal_status, tool_status) =
            proposal_and_tool_status_for_run(&pool, &invalid_run_id).await;
        assert_eq!(
            proposal_status, "pending",
            "invalid ref update leaves proposal pending"
        );
        assert_eq!(
            tool_status, "pending",
            "invalid ref update leaves tool call unresolved"
        );
    });
}

#[test]
fn update_rejects_entity_ref_that_belongs_to_another_entry() {
    let workspace = Workspace::new();
    let params_path = workspace.path().join("update-params.json");
    let thread_id = Uuid::now_v7();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let (entity_id, other_ref_id) = rt.block_on(async {
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
        let other_entry_id = seed_accepted_journal_entry(
            &pool,
            thread_id,
            "2026-06-10T11:30:00",
            "Talked with Bob after lunch.",
            3,
        )
        .await;
        let target_id = seed_accepted_journal_entry(
            &pool,
            thread_id,
            "2026-06-10T09:30:00",
            "Alice exists as a referenced entity stand-in.",
            4,
        )
        .await;
        let other_ref_id = seed_entity_ref(&pool, other_entry_id, target_id, 5).await;
        pool.close().await;
        (entity_id, other_ref_id)
    });

    write_update_params_body(
        &params_path,
        entity_id,
        serde_json::json!([
            { "type": "text", "text": "Met " },
            { "type": "entity_ref", "ref_id": other_ref_id.to_string() }
        ]),
    );
    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    let invalid_run_id = rt.block_on(async {
        let (run_id, proposal_id) =
            park_update_proposal(&core, thread_id, "Link Alice in the earlier entry.").await;
        let resp = rpc(
            &core,
            13,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "update-wrong-source-ref",
            }),
        )
        .await;
        assert_eq!(
            resp["error"]["code"].as_i64(),
            Some(-32602),
            "wrong-source entity_ref is invalid_params - body: {resp}"
        );
        assert!(
            resp["error"]["message"]
                .as_str()
                .unwrap_or_default()
                .contains("target Journal Entry"),
            "invalid reason names the target Journal Entry ownership invariant - body: {resp}"
        );
        run_id
    });

    rt.block_on(async {
        let pool = open_readonly_pool(workspace.db_path().to_path_buf()).await;
        assert_eq!(
            entity_data(&pool, entity_id).await["body"][0]["text"].as_str(),
            Some("Met Alice at school."),
            "wrong-source ref update leaves entity unchanged"
        );
        assert_eq!(
            max_revision_seq(&pool, entity_id).await,
            1,
            "wrong-source ref update writes no new revision"
        );
        assert_eq!(
            updated_from_count_for_run(&pool, entity_id, &invalid_run_id).await,
            0,
            "wrong-source ref update writes no updated_from source"
        );
        let (proposal_status, tool_status) =
            proposal_and_tool_status_for_run(&pool, &invalid_run_id).await;
        assert_eq!(
            proposal_status, "pending",
            "wrong-source ref update leaves proposal pending"
        );
        assert_eq!(
            tool_status, "pending",
            "wrong-source ref update leaves tool call unresolved"
        );
    });
}

#[test]
fn reference_existing_entity_accept_creates_ref_and_updates_journal_entry() {
    let workspace = Workspace::new();
    let params_path = workspace.path().join("reference-params.json");
    let thread_id = Uuid::now_v7();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let (source_entity_id, target_entity_id) = rt.block_on(async {
        let pool = migrated_pool(&workspace).await;
        seed_thread(&pool, thread_id, "Journal thread", 1).await;
        let source_entity_id = seed_accepted_journal_entry(
            &pool,
            thread_id,
            "2026-06-10T10:30:00",
            "Met Ada at school.",
            2,
        )
        .await;
        let target_entity_id = seed_accepted_entity(
            &pool,
            thread_id,
            "person",
            serde_json::json!({ "name": "Ada Lovelace" }),
            3,
        )
        .await;
        pool.close().await;
        (source_entity_id, target_entity_id)
    });

    write_reference_params(&params_path, source_entity_id, target_entity_id);
    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    let run_id = rt.block_on(async {
        let (run_id, proposal_id) =
            park_reference_proposal(&core, thread_id, "Link Ada in that entry.").await;
        let resp = rpc(
            &core,
            23,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "reference-existing-accept",
            }),
        )
        .await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "reference accept result - body: {resp}"
        );
        assert_eq!(
            resp["result"]["entity_id"].as_str(),
            Some(source_entity_id.to_string().as_str()),
            "reference accept returns the source Journal Entry id - body: {resp}"
        );
        await_completed(&core, &run_id).await;
        let list = rpc(
            &core,
            27,
            "entity/list",
            serde_json::json!({ "type": "journal_entry" }),
        )
        .await;
        let listed_entry = list["result"]["entities"]
            .as_array()
            .and_then(|entities| {
                entities.iter().find(|entity| {
                    entity["id"].as_str() == Some(source_entity_id.to_string().as_str())
                })
            })
            .unwrap_or_else(|| panic!("entity/list includes source entry - body: {list}"));
        assert_eq!(
            listed_entry["refs"][0]["target_entity_id"].as_str(),
            Some(target_entity_id.to_string().as_str()),
            "entity/list resolves the Journal Entry ref target - body: {list}"
        );
        assert_eq!(
            listed_entry["refs"][0]["target_title"].as_str(),
            Some("Ada Lovelace"),
            "entity/list resolves the current target title - body: {list}"
        );
        run_id
    });

    rt.block_on(async {
        let pool = open_readonly_pool(workspace.db_path().to_path_buf()).await;

        assert_eq!(
            entity_ref_count(&pool, source_entity_id, target_entity_id).await,
            1,
            "accept creates exactly one EntityRef"
        );
        let ref_row = sqlx::query(
            "SELECT id, label_snapshot FROM entity_refs \
             WHERE source_entity_id = ?1 AND target_entity_id = ?2",
        )
        .bind(source_entity_id.to_string())
        .bind(target_entity_id.to_string())
        .fetch_one(&pool)
        .await
        .expect("entity_ref row exists");
        let ref_id: String = ref_row.get("id");
        let label_snapshot: Option<String> = ref_row.get("label_snapshot");
        assert_eq!(
            label_snapshot.as_deref(),
            Some("Ada snapshot"),
            "EntityRef stores the render fallback"
        );

        let data = entity_data(&pool, source_entity_id).await;
        assert_eq!(
            data["occurred_at"].as_str(),
            Some("2026-06-10T10:30:00"),
            "reference accept preserves the Journal Entry occurred_at"
        );
        assert_eq!(data["body"][0]["text"].as_str(), Some("Met "));
        assert_eq!(data["body"][1]["type"].as_str(), Some("entity_ref"));
        assert_eq!(data["body"][1]["ref_id"].as_str(), Some(ref_id.as_str()));
        assert_eq!(data["body"][2]["text"].as_str(), Some(" at school."));
        assert_eq!(
            max_revision_seq(&pool, source_entity_id).await,
            2,
            "reference accept appends a Journal Entry revision"
        );
        assert_eq!(
            updated_from_count_for_run(&pool, source_entity_id, &run_id).await,
            1,
            "reference update sources from the current user Message"
        );
        assert_eq!(
            target_entity_source_count(&pool, target_entity_id).await,
            0,
            "referencing an existing target creates no EntitySource for the target"
        );
    });
}

#[test]
fn reference_existing_entity_reject_creates_nothing_and_leaves_body() {
    let workspace = Workspace::new();
    let params_path = workspace.path().join("reference-params.json");
    let thread_id = Uuid::now_v7();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let (source_entity_id, target_entity_id) = rt.block_on(async {
        let pool = migrated_pool(&workspace).await;
        seed_thread(&pool, thread_id, "Journal thread", 1).await;
        let source_entity_id = seed_accepted_journal_entry(
            &pool,
            thread_id,
            "2026-06-10T10:30:00",
            "Met Ada at school.",
            2,
        )
        .await;
        let target_entity_id = seed_accepted_entity(
            &pool,
            thread_id,
            "person",
            serde_json::json!({ "name": "Ada Lovelace" }),
            3,
        )
        .await;
        pool.close().await;
        (source_entity_id, target_entity_id)
    });

    write_reference_params(&params_path, source_entity_id, target_entity_id);
    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    rt.block_on(async {
        let (run_id, proposal_id) =
            park_reference_proposal(&core, thread_id, "Link Ada in that entry.").await;
        let resp = rpc(
            &core,
            24,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "reject",
                "decision_idempotency_key": "reference-existing-reject",
            }),
        )
        .await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("rejected"),
            "reference reject result - body: {resp}"
        );
        assert!(
            resp["result"].get("entity_id").is_none(),
            "reject result carries no entity id - body: {resp}"
        );
        await_completed(&core, &run_id).await;
    });

    rt.block_on(async {
        let pool = open_readonly_pool(workspace.db_path().to_path_buf()).await;
        assert_eq!(
            entity_ref_count(&pool, source_entity_id, target_entity_id).await,
            0,
            "reject creates no EntityRef"
        );
        assert_eq!(
            entity_data(&pool, source_entity_id).await["body"][0]["text"].as_str(),
            Some("Met Ada at school."),
            "reject leaves the Journal Entry body unchanged"
        );
        assert_eq!(
            max_revision_seq(&pool, source_entity_id).await,
            1,
            "reject writes no Journal Entry revision"
        );
    });
}

#[test]
fn reference_existing_entity_reuses_existing_ref_for_duplicate_pair() {
    let workspace = Workspace::new();
    let params_path = workspace.path().join("reference-params.json");
    let thread_id = Uuid::now_v7();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let (source_entity_id, target_entity_id, existing_ref_id) = rt.block_on(async {
        let pool = migrated_pool(&workspace).await;
        seed_thread(&pool, thread_id, "Journal thread", 1).await;
        let source_entity_id = seed_accepted_journal_entry(
            &pool,
            thread_id,
            "2026-06-10T10:30:00",
            "Met Ada at school.",
            2,
        )
        .await;
        let target_entity_id = seed_accepted_entity(
            &pool,
            thread_id,
            "person",
            serde_json::json!({ "name": "Ada Lovelace" }),
            3,
        )
        .await;
        let existing_ref_id = seed_entity_ref(&pool, source_entity_id, target_entity_id, 4).await;
        pool.close().await;
        (source_entity_id, target_entity_id, existing_ref_id)
    });

    write_reference_params(&params_path, source_entity_id, target_entity_id);
    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    rt.block_on(async {
        let (run_id, proposal_id) =
            park_reference_proposal(&core, thread_id, "Link Ada in that entry.").await;
        let resp = rpc(
            &core,
            25,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "reference-existing-duplicate",
            }),
        )
        .await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "duplicate reference pair still accepts by reusing the existing ref - body: {resp}"
        );
        await_completed(&core, &run_id).await;
    });

    rt.block_on(async {
        let pool = open_readonly_pool(workspace.db_path().to_path_buf()).await;
        assert_eq!(
            entity_ref_count(&pool, source_entity_id, target_entity_id).await,
            1,
            "duplicate accept does not create a second EntityRef"
        );
        let data = entity_data(&pool, source_entity_id).await;
        assert_eq!(
            data["body"][1]["ref_id"].as_str(),
            Some(existing_ref_id.to_string().as_str()),
            "duplicate accept rewrites the body with the existing EntityRef id"
        );
    });
}

#[test]
fn reference_existing_entity_accept_rejects_invalid_current_entry_snapshot() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    for (stored_data, expected_message, label) in [
        ("not-json", "malformed JSON", "malformed-json"),
        ("[]", "must be a JSON object", "non-object-json"),
    ] {
        let workspace = Workspace::new();
        let params_path = workspace.path().join("reference-params.json");
        let thread_id = Uuid::now_v7();

        let (source_entity_id, target_entity_id) = rt.block_on(async {
            let pool = migrated_pool(&workspace).await;
            seed_thread(&pool, thread_id, "Journal thread", 1).await;
            let source_entity_id = seed_accepted_journal_entry(
                &pool,
                thread_id,
                "2026-06-10T10:30:00",
                "Met Ada at school.",
                2,
            )
            .await;
            let target_entity_id = seed_accepted_entity(
                &pool,
                thread_id,
                "person",
                serde_json::json!({ "name": "Ada Lovelace" }),
                3,
            )
            .await;
            sqlx::query("UPDATE entities SET data = ?1 WHERE id = ?2")
                .bind(stored_data)
                .bind(source_entity_id.to_string())
                .execute(&pool)
                .await
                .expect("corrupt current Journal Entry snapshot");
            pool.close().await;
            (source_entity_id, target_entity_id)
        });

        write_reference_params(&params_path, source_entity_id, target_entity_id);
        let core = workspace
            .core()
            .worker_fixture("propose-worker.ts")
            .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
            .spawn();

        let run_id = rt.block_on(async {
            let (run_id, proposal_id) =
                park_reference_proposal(&core, thread_id, "Link Ada in that entry.").await;
            let resp = rpc(
                &core,
                28,
                "proposal/decide",
                serde_json::json!({
                    "proposal_id": proposal_id,
                    "decision": "accept",
                    "decision_idempotency_key": format!("reference-invalid-current-{label}"),
                }),
            )
            .await;
            assert_eq!(
                resp["error"]["code"].as_i64(),
                Some(-32602),
                "{label} is invalid_params - body: {resp}"
            );
            assert!(
                resp["error"]["message"]
                    .as_str()
                    .unwrap_or_default()
                    .contains(expected_message),
                "{label} invalid reason names {expected_message} - body: {resp}"
            );
            run_id
        });

        rt.block_on(async {
            let pool = open_readonly_pool(workspace.db_path().to_path_buf()).await;
            assert_eq!(
                entity_ref_count(&pool, source_entity_id, target_entity_id).await,
                0,
                "{label} rolls back EntityRef creation"
            );
            assert_eq!(
                raw_entity_data(&pool, source_entity_id).await,
                stored_data,
                "{label} leaves the stored Journal Entry snapshot unchanged"
            );
            assert_eq!(
                max_revision_seq(&pool, source_entity_id).await,
                1,
                "{label} writes no Journal Entry revision"
            );
            let (proposal_status, tool_status) =
                proposal_and_tool_status_for_run(&pool, &run_id).await;
            assert_eq!(
                proposal_status, "pending",
                "{label} leaves proposal pending"
            );
            assert_eq!(tool_status, "pending", "{label} leaves tool call pending");
        });
    }
}

#[test]
fn reference_existing_entity_rejects_invalid_source_target_type_and_thread() {
    let workspace = Workspace::new();
    let params_path = workspace.path().join("reference-params.json");
    let source_thread_id = Uuid::now_v7();
    let other_thread_id = Uuid::now_v7();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let (source_entity_id, valid_target_id, wrong_type_target_id) = rt.block_on(async {
        let pool = migrated_pool(&workspace).await;
        seed_thread(&pool, source_thread_id, "Source thread", 1).await;
        seed_thread(&pool, other_thread_id, "Other thread", 2).await;
        let source_entity_id = seed_accepted_journal_entry(
            &pool,
            source_thread_id,
            "2026-06-10T10:30:00",
            "Met Ada at school.",
            3,
        )
        .await;
        let valid_target_id = seed_accepted_entity(
            &pool,
            source_thread_id,
            "person",
            serde_json::json!({ "name": "Ada Lovelace" }),
            4,
        )
        .await;
        let wrong_type_target_id = seed_accepted_journal_entry(
            &pool,
            source_thread_id,
            "2026-06-10T11:30:00",
            "Wrong target type.",
            5,
        )
        .await;
        pool.close().await;
        (source_entity_id, valid_target_id, wrong_type_target_id)
    });

    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    let invalid_cases = [
        // A GONE source Journal Entry is the reference's PRIMARY anchor → a
        // delete-race (ADR-0033): NotDecidable (-32002), not invalid_params.
        (
            Uuid::now_v7(),
            valid_target_id,
            source_thread_id,
            "missing source",
            -32002,
            "proposal target no longer exists",
        ),
        (
            source_entity_id,
            Uuid::now_v7(),
            source_thread_id,
            "missing target",
            -32602,
            "existing accepted Entity",
        ),
        (
            source_entity_id,
            wrong_type_target_id,
            source_thread_id,
            "wrong target type",
            -32602,
            "person, project, or todo",
        ),
        (
            source_entity_id,
            valid_target_id,
            other_thread_id,
            "cross thread source",
            -32602,
            "current Thread",
        ),
    ];

    rt.block_on(async {
        for (source, target, thread, label, expected_code, expected_message) in invalid_cases {
            write_reference_params(&params_path, source, target);
            let (run_id, proposal_id) =
                park_reference_proposal(&core, thread, "Link Ada in that entry.").await;
            let resp = rpc(
                &core,
                26,
                "proposal/decide",
                serde_json::json!({
                    "proposal_id": proposal_id,
                    "decision": "accept",
                    "decision_idempotency_key": format!("reference-invalid-{label}"),
                }),
            )
            .await;
            assert_eq!(
                resp["error"]["code"].as_i64(),
                Some(expected_code),
                "{label} error code - body: {resp}"
            );
            assert!(
                resp["error"]["message"]
                    .as_str()
                    .unwrap_or_default()
                    .contains(expected_message),
                "{label} invalid reason names {expected_message} - body: {resp}"
            );

            let pool = open_readonly_pool(workspace.db_path().to_path_buf()).await;
            assert_eq!(
                entity_ref_count(&pool, source_entity_id, valid_target_id).await,
                0,
                "{label} writes no EntityRef"
            );
            assert_eq!(
                entity_data(&pool, source_entity_id).await["body"][0]["text"].as_str(),
                Some("Met Ada at school."),
                "{label} leaves the Journal Entry unchanged"
            );
            let (proposal_status, tool_status) =
                proposal_and_tool_status_for_run(&pool, &run_id).await;
            assert_eq!(
                proposal_status, "pending",
                "{label} leaves proposal pending"
            );
            assert_eq!(tool_status, "pending", "{label} leaves tool call pending");
            pool.close().await;
        }
    });
}

#[test]
fn cross_thread_update_is_invalid_and_leaves_entry_unchanged() {
    let workspace = Workspace::new();
    let params_path = workspace.path().join("update-params.json");
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

    write_update_params(
        &params_path,
        entity_id,
        "Bought milk and bread after daycare pickup.",
    );
    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    let invalid_run_id = rt.block_on(async {
        let (run_id, proposal_id) = park_update_proposal(
            &core,
            other_thread_id,
            "Actually, update that earlier entry from the other thread.",
        )
        .await;
        let resp = rpc(
            &core,
            6,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "cross-thread-update",
            }),
        )
        .await;
        assert_eq!(
            resp["error"]["code"].as_i64(),
            Some(-32602),
            "cross-thread update is invalid_params - body: {resp}"
        );
        assert!(
            resp["error"]["message"]
                .as_str()
                .unwrap_or_default()
                .contains("current Thread"),
            "cross-thread invalid reason names current Thread - body: {resp}"
        );
        run_id
    });

    rt.block_on(async {
        let pool = open_readonly_pool(workspace.db_path().to_path_buf()).await;

        let data = entity_data(&pool, entity_id).await;
        assert_eq!(
            data["body"][0]["text"].as_str(),
            Some("Bought milk after daycare pickup."),
            "invalid update leaves the current entity data unchanged"
        );
        assert_eq!(
            max_revision_seq(&pool, entity_id).await,
            1,
            "invalid update writes no new revision"
        );
        assert_eq!(
            updated_from_count_for_run(&pool, entity_id, &invalid_run_id).await,
            0,
            "invalid update writes no updated_from source"
        );

        let row = sqlx::query(
            "SELECT p.status, tc.status AS tool_status \
             FROM proposals p JOIN tool_calls tc ON tc.id = p.tool_call_id \
             WHERE tc.run_id = ?1",
        )
        .bind(&invalid_run_id)
        .fetch_one(&pool)
        .await
        .expect("cross-thread proposal row exists");
        let proposal_status: String = row.get("status");
        let tool_status: String = row.get("tool_status");
        assert_eq!(
            proposal_status, "pending",
            "invalid decide leaves proposal pending"
        );
        assert_eq!(
            tool_status, "pending",
            "invalid decide leaves tool call unresolved"
        );
    });
}

#[test]
fn non_user_created_from_update_is_invalid_and_leaves_entry_unchanged() {
    let workspace = Workspace::new();
    let params_path = workspace.path().join("update-params.json");
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

    write_update_params(
        &params_path,
        entity_id,
        "Bought milk and bread after daycare pickup.",
    );
    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    let invalid_run_id = rt.block_on(async {
        let (run_id, proposal_id) =
            park_update_proposal(&core, thread_id, "Update that earlier entry.").await;
        let resp = rpc(
            &core,
            7,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "non-user-created-from-update",
            }),
        )
        .await;
        assert_eq!(
            resp["error"]["code"].as_i64(),
            Some(-32602),
            "non-user created_from update is invalid_params - body: {resp}"
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

        let data = entity_data(&pool, entity_id).await;
        assert_eq!(
            data["body"][0]["text"].as_str(),
            Some("Bought milk after daycare pickup."),
            "non-user created_from invalid update leaves entity data unchanged"
        );
        assert_eq!(
            max_revision_seq(&pool, entity_id).await,
            1,
            "non-user created_from invalid update writes no new revision"
        );
        assert_eq!(
            updated_from_count_for_run(&pool, entity_id, &invalid_run_id).await,
            0,
            "non-user created_from invalid update writes no updated_from source"
        );

        let row = sqlx::query(
            "SELECT p.status, tc.status AS tool_status \
             FROM proposals p JOIN tool_calls tc ON tc.id = p.tool_call_id \
             WHERE tc.run_id = ?1",
        )
        .bind(&invalid_run_id)
        .fetch_one(&pool)
        .await
        .expect("non-user created_from proposal row exists");
        let proposal_status: String = row.get("status");
        let tool_status: String = row.get("tool_status");
        assert_eq!(
            proposal_status, "pending",
            "invalid decide leaves proposal pending"
        );
        assert_eq!(
            tool_status, "pending",
            "invalid decide leaves tool call unresolved"
        );
    });
}
