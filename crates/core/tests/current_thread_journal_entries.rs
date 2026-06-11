//! `read_current_thread_journal_entries`: a synchronous Core tool reads the
//! current Run's Thread from tier 2, then returns only accepted Journal Entries
//! originally created from that Thread, newest latest-revision first.

use std::path::Path;

use futures_util::SinkExt;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Executor, SqlitePool};
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

mod common;
use common::{CoreHandle, Workspace, next_text};

const TOOL_NAME: &str = "read_current_thread_journal_entries";

fn write_workflow(dir: &Path) {
    std::fs::create_dir_all(dir).expect("create workflows dir");
    std::fs::write(
        dir.join("default.toml"),
        format!(
            r#"
name = "default"
version = "1.0.0"
provider = "faux"
model = "fake-model"
thinking_level = "off"
system_prompt = "test"
tools = ["{TOOL_NAME}"]
"#
        ),
    )
    .expect("write workflow");
}

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
    entity_id: Uuid,
    occurred_at: &str,
    ended_at: Option<&str>,
    body_text: &str,
    created_at: i64,
) {
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
        payload["ended_at"] = serde_json::json!(ended_at);
    }
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
}

async fn add_later_revision(
    pool: &SqlitePool,
    entity_id: Uuid,
    occurred_at: &str,
    body_text: &str,
    created_at: i64,
) {
    let payload = serde_json::json!({
        "occurred_at": occurred_at,
        "body": [{ "type": "text", "text": body_text }]
    });
    let payload_str = payload.to_string();

    let mut tx = pool.begin().await.expect("begin revision tx");
    tx.execute(
        sqlx::query("UPDATE entities SET data = ?1, updated_at = ?2 WHERE id = ?3")
            .bind(&payload_str)
            .bind(created_at)
            .bind(entity_id.to_string()),
    )
    .await
    .expect("update entity current data");
    tx.execute(
        sqlx::query(
            "INSERT INTO entity_revisions (entity_id, seq, data, proposal_id, created_at) \
         VALUES (?1, 2, ?2, NULL, ?3)",
        )
        .bind(entity_id.to_string())
        .bind(&payload_str)
        .bind(created_at),
    )
    .await
    .expect("insert later revision");
    tx.commit().await.expect("commit revision tx");
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

async fn run_tool_from_thread(core: &CoreHandle, thread_id: Uuid) -> serde_json::Value {
    let resp = rpc(
        core,
        1,
        "run/post_message",
        serde_json::json!({
            "thread_id": thread_id,
            "prompt": "What journal entries did we just discuss?"
        }),
    )
    .await;
    let run_id = resp["result"]["run_id"]
        .as_str()
        .unwrap_or_else(|| panic!("result.run_id is a string - body: {resp}"))
        .to_string();

    let mut ws = core.connect().await;
    ws.send(Message::Text(
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "run/subscribe",
            "params": { "run_id": run_id }
        })
        .to_string()
        .into(),
    ))
    .await
    .expect("send subscribe frame");
    let _sub_response = next_text(&mut ws).await;

    let mut text = String::new();
    loop {
        let body = next_text(&mut ws).await;
        let v: serde_json::Value = serde_json::from_str(&body)
            .unwrap_or_else(|e| panic!("event is JSON: {e} - body: {body}"));
        match v["params"]["event"]["kind"].as_str() {
            Some("text_delta") => {
                if let Some(delta) = v["params"]["event"]["delta"].as_str() {
                    text.push_str(delta);
                }
            }
            Some("done") => break,
            Some("error") => panic!("run errored unexpectedly - body: {body}"),
            _ => {}
        }
    }
    ws.close(None).await.ok();

    let marker = "tool_outcome=ok:";
    let payload = text
        .strip_prefix(marker)
        .unwrap_or_else(|| panic!("tool returned ok payload - got {text:?}"));
    serde_json::from_str(payload)
        .unwrap_or_else(|e| panic!("tool payload is JSON: {e} - payload: {payload}"))
}

#[test]
fn returns_current_thread_entries_in_latest_revision_order() {
    let workspace = Workspace::new();
    let workflows_dir = workspace.path().join("workflows");
    write_workflow(&workflows_dir);

    let thread_a = Uuid::now_v7();
    let thread_b = Uuid::now_v7();
    let revised_entry = Uuid::now_v7();
    let older_entry = Uuid::now_v7();
    let other_thread_entry = Uuid::now_v7();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let pool = migrated_pool(&workspace).await;
        seed_thread(&pool, thread_a, "Thread A", 1_000).await;
        seed_thread(&pool, thread_b, "Thread B", 1_000).await;
        seed_accepted_journal_entry(
            &pool,
            thread_a,
            revised_entry,
            "2026-06-10T09:00:00",
            None,
            "Original wording.",
            2_000,
        )
        .await;
        seed_accepted_journal_entry(
            &pool,
            thread_a,
            older_entry,
            "2026-06-10T10:00:00",
            Some("2026-06-10T10:30:00"),
            "Still second after the revision.",
            3_000,
        )
        .await;
        seed_accepted_journal_entry(
            &pool,
            thread_b,
            other_thread_entry,
            "2026-06-10T11:00:00",
            None,
            "Other thread should stay out.",
            5_000,
        )
        .await;
        add_later_revision(
            &pool,
            revised_entry,
            "2026-06-10T09:05:00",
            "Revised wording.",
            6_000,
        )
        .await;
        pool.close().await;

        let core = workspace
            .core()
            .worker_fixture("tool-worker.ts")
            .env("INKSTONE_TOOLWORKER_TOOL", TOOL_NAME)
            .env("INKSTONE_WORKFLOWS_DIR", &workflows_dir)
            .spawn();

        let payload = run_tool_from_thread(&core, thread_a).await;
        let entries = payload["entries"]
            .as_array()
            .unwrap_or_else(|| panic!("entries is an array - payload: {payload}"));

        assert_eq!(
            entries.len(),
            2,
            "same Thread entries only - payload: {payload}"
        );
        assert_eq!(
            entries[0]["entity_id"].as_str(),
            Some(revised_entry.to_string().as_str()),
            "entry with newest revision sorts first - payload: {payload}"
        );
        assert_eq!(
            entries[0]["occurred_at"].as_str(),
            Some("2026-06-10T09:05:00"),
            "latest revision data is returned - payload: {payload}"
        );
        assert_eq!(
            entries[0]["body"][0]["text"].as_str(),
            Some("Revised wording."),
            "latest revision body is returned - payload: {payload}"
        );
        assert_eq!(
            entries[1]["entity_id"].as_str(),
            Some(older_entry.to_string().as_str()),
            "older same-Thread entry sorts second - payload: {payload}"
        );
        assert_eq!(
            entries[1]["ended_at"].as_str(),
            Some("2026-06-10T10:30:00"),
            "ended_at is preserved when present - payload: {payload}"
        );
        assert!(
            !payload
                .to_string()
                .contains(&other_thread_entry.to_string()),
            "other Thread entry is excluded - payload: {payload}"
        );

        for entry in entries {
            let object = entry
                .as_object()
                .unwrap_or_else(|| panic!("entry is an object - entry: {entry}"));
            for key in object.keys() {
                assert!(
                    matches!(
                        key.as_str(),
                        "entity_id" | "occurred_at" | "ended_at" | "body"
                    ),
                    "entry contains only the compact tool fields - entry: {entry}"
                );
            }
        }
    });
}
