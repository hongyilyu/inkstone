//! `read_current_thread_journal_entries`: a synchronous Core tool reads the
//! current Run's Thread from tier 2, then returns only accepted Journal Entries
//! originally created from that Thread, newest revision first.

use std::path::Path;

use futures_util::SinkExt;
use sqlx::{Executor, SqlitePool};
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

mod common;
use common::{
    CoreHandle, Workspace, migrated_pool, next_text, rpc, rt,
    seed_accepted_journal_entry_full, seed_thread,
};

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
    let assistant_sourced_entry = Uuid::now_v7();

    let rt = rt();

    rt.block_on(async {
        let pool = migrated_pool(&workspace).await;
        seed_thread(&pool, thread_a, "Thread A", 1_000).await;
        seed_thread(&pool, thread_b, "Thread B", 1_000).await;
        seed_accepted_journal_entry_full(
            &pool,
            thread_a,
            revised_entry,
            "2026-06-10T09:00:00",
            None,
            "Original wording.",
            2_000,
            "user",
        )
        .await;
        seed_accepted_journal_entry_full(
            &pool,
            thread_a,
            older_entry,
            "2026-06-10T10:00:00",
            Some("2026-06-10T10:30:00"),
            "Still second after the revision.",
            3_000,
            "user",
        )
        .await;
        seed_accepted_journal_entry_full(
            &pool,
            thread_b,
            other_thread_entry,
            "2026-06-10T11:00:00",
            None,
            "Other thread should stay out.",
            5_000,
            "user",
        )
        .await;
        seed_accepted_journal_entry_full(
            &pool,
            thread_a,
            assistant_sourced_entry,
            "2026-06-10T12:00:00",
            None,
            "Assistant-sourced entry should stay out.",
            7_000,
            "user",
        )
        .await;
        sqlx::query(
            "UPDATE messages SET role = 'assistant' \
             WHERE id = ( \
               SELECT source_message_id FROM entity_sources \
               WHERE entity_id = ?1 AND relation = 'created_from' \
             )",
        )
        .bind(assistant_sourced_entry.to_string())
        .execute(&pool)
        .await
        .expect("make source message assistant-authored");
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
        assert!(
            !payload
                .to_string()
                .contains(&assistant_sourced_entry.to_string()),
            "non-user created_from entry is excluded - payload: {payload}"
        );

        for entry in entries {
            let object = entry
                .as_object()
                .unwrap_or_else(|| panic!("entry is an object - entry: {entry}"));
            for key in object.keys() {
                assert!(
                    matches!(
                        key.as_str(),
                        "entity_id" | "occurred_at" | "ended_at" | "body" | "anchored_entities"
                    ),
                    "entry contains only the compact tool fields - entry: {entry}"
                );
            }
        }
    });
}
