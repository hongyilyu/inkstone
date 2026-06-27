//! The `read_current_thread_journal_entries` tool. Reads accepted Journal
//! Entries created from the current Run's Thread; the Run, not the model,
//! supplies the Thread context.

use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Map, Value};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::ToolError;
use crate::protocol::{AgentToolResult, CoreToolDescriptor, ToolTextContent};

pub const NAME: &str = "read_current_thread_journal_entries";
const DESCRIPTION: &str = "Read accepted Journal Entries originally created from the current thread, newest revision first.";
const LABEL: &str = "Read current thread journal entries";

/// Takes no model-supplied arguments; Core derives the Thread from `run_id`.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct Input {}

pub fn descriptor() -> CoreToolDescriptor {
    CoreToolDescriptor {
        name: NAME.to_string(),
        description: DESCRIPTION.to_string(),
        label: LABEL.to_string(),
        json_schema: serde_json::to_value(schemars::schema_for!(Input))
            .expect("read_current_thread_journal_entries Input schema serializes"),
    }
}

pub async fn execute(
    pool: &SqlitePool,
    run_id: Uuid,
    params: Value,
) -> Result<AgentToolResult, ToolError> {
    let _input: Input = serde_json::from_value(params).map_err(|e| ToolError {
        code: "invalid_params".to_string(),
        message: e.to_string(),
    })?;

    let rows = crate::db::current_thread_journal_entries(pool, run_id)
        .await
        .map_err(|e| ToolError {
            code: "internal".to_string(),
            message: e.to_string(),
        })?;

    let entries = rows
        .into_iter()
        .map(|row| {
            let mut entry = Map::new();
            entry.insert("entity_id".to_string(), Value::String(row.entity_id));
            entry.insert(
                "occurred_at".to_string(),
                row.data.get("occurred_at").cloned().unwrap_or(Value::Null),
            );
            if let Some(ended_at) = row.data.get("ended_at").filter(|v| !v.is_null()) {
                entry.insert("ended_at".to_string(), ended_at.clone());
            }
            entry.insert(
                "body".to_string(),
                row.data.get("body").cloned().unwrap_or(Value::Null),
            );
            // The People/Projects/Todos ALREADY captured from this entry, by label —
            // the re-scan recognition prompt reads this to suppress re-proposing an
            // already-chipped entity (ADR-0042).
            entry.insert(
                "anchored_entities".to_string(),
                Value::Array(
                    row.anchored_entities
                        .into_iter()
                        .map(Value::String)
                        .collect(),
                ),
            );
            Value::Object(entry)
        })
        .collect::<Vec<_>>();

    let payload = serde_json::json!({ "entries": entries });
    Ok(AgentToolResult {
        content: vec![ToolTextContent {
            r#type: "text".to_string(),
            text: payload.to_string(),
        }],
        details: None,
        terminate: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    #[test]
    fn descriptor_has_name_and_empty_object_schema() {
        let d = descriptor();
        assert_eq!(d.name, "read_current_thread_journal_entries");
        assert_eq!(d.label, "Read current thread journal entries");
        assert_eq!(d.json_schema["type"], serde_json::json!("object"));
    }

    /// A migrated in-memory pool, mirroring `db::tests::memory_pool`.
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

    /// Seed a thread + a completed Run + its user Message. The runs↔messages FKs
    /// are mutually deferred, so all three inserts ride ONE transaction (the
    /// deferred check fires at commit, like the e2e seed helpers).
    async fn seed_run(pool: &SqlitePool, thread_id: &str, run_id: &str, user_msg_id: &str) {
        let mut tx = pool.begin().await.expect("begin");
        sqlx::query(
            "INSERT INTO threads (id, title, created_at, last_activity_at) VALUES (?, 'T', 1, 1)",
        )
        .bind(thread_id)
        .execute(&mut *tx)
        .await
        .expect("seed thread");
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, thinking_level, \
              user_message_id, status, started_at, ended_at, terminal_reason) \
             VALUES (?, ?, 'default', '1.0.0', 'faux', 'm', 'off', ?, 'completed', 1, 1, 'completed')",
        )
        .bind(run_id)
        .bind(thread_id)
        .bind(user_msg_id)
        .execute(&mut *tx)
        .await
        .expect("seed run");
        sqlx::query(
            "INSERT INTO messages (id, thread_id, run_id, role, status, created_at, updated_at) \
             VALUES (?, ?, ?, 'user', 'completed', 1, 1)",
        )
        .bind(user_msg_id)
        .bind(thread_id)
        .bind(run_id)
        .execute(&mut *tx)
        .await
        .expect("seed user message");
        tx.commit().await.expect("commit seed");
    }

    async fn seed_entity(pool: &SqlitePool, id: &str, r#type: &str, data: &str) {
        sqlx::query(
            "INSERT INTO entities \
             (id, type, schema_version, data, created_by, created_via_proposal_id, created_at, updated_at) \
             VALUES (?, ?, 1, ?, 'user', NULL, 1, 1)",
        )
        .bind(id)
        .bind(r#type)
        .bind(data)
        .execute(pool)
        .await
        .expect("seed entity");
        sqlx::query("INSERT INTO entity_revisions (entity_id, seq, data, proposal_id, created_at) VALUES (?, 1, ?, NULL, 1)")
            .bind(id)
            .bind(data)
            .execute(pool)
            .await
            .expect("seed revision");
    }

    fn entries(out: &AgentToolResult) -> Vec<Value> {
        let payload: Value = serde_json::from_str(&out.content[0].text).expect("payload is JSON");
        payload["entries"]
            .as_array()
            .expect("entries array")
            .clone()
    }

    /// A re-scan needs to SEE what is already chipped: the read result must surface
    /// each JE's already-captured entities by LABEL (its outgoing `entity_ref`s,
    /// resolved to names), so the model can suppress re-proposing them. A JE with
    /// no refs returns an empty `anchored_entities` array (the field is always
    /// present so the prompt can read it unconditionally).
    #[tokio::test]
    async fn entries_carry_already_anchored_entity_labels() {
        let pool = memory_pool().await;
        let thread = "01900000-0000-7000-8000-0000000000a0";
        let run = "01900000-0000-7000-8000-0000000000a1";
        let user_msg = "01900000-0000-7000-8000-0000000000a2";
        seed_run(&pool, thread, run, user_msg).await;

        let je = "je-1";
        seed_entity(
            &pool,
            je,
            "journal_entry",
            r#"{"occurred_at":"2026-06-10T10:30:00","body":[{"type":"text","text":"Met Ada."}]}"#,
        )
        .await;
        // The JE is created_from the run's user Message — so it lists for this Run.
        sqlx::query("INSERT INTO entity_sources (id, entity_id, source_message_id, relation, created_at) VALUES ('es-1', ?, ?, 'created_from', 1)")
            .bind(je)
            .bind(user_msg)
            .execute(&pool)
            .await
            .expect("seed created_from source");
        // An already-captured Person, chipped into the JE via an entity_ref.
        seed_entity(&pool, "p-1", "person", r#"{"name":"Ada Lovelace"}"#).await;
        sqlx::query("INSERT INTO entity_refs (id, source_entity_id, target_entity_id, label_snapshot, created_at) VALUES ('er-1', ?, 'p-1', NULL, 1)")
            .bind(je)
            .execute(&pool)
            .await
            .expect("seed entity_ref");

        let out = execute(&pool, Uuid::parse_str(run).unwrap(), serde_json::json!({}))
            .await
            .expect("read succeeds");
        let entries = entries(&out);
        assert_eq!(entries.len(), 1, "the JE created_from this thread lists");
        assert_eq!(entries[0]["entity_id"], serde_json::json!(je));
        assert_eq!(
            entries[0]["anchored_entities"],
            serde_json::json!(["Ada Lovelace"]),
            "the already-chipped Person surfaces by current name so the model suppresses it"
        );
    }

    /// A JE with no outgoing refs surfaces an EMPTY `anchored_entities` array — the
    /// field is always present, never null/absent.
    #[tokio::test]
    async fn entry_without_refs_has_empty_anchored_entities() {
        let pool = memory_pool().await;
        let thread = "01900000-0000-7000-8000-0000000000b0";
        let run = "01900000-0000-7000-8000-0000000000b1";
        let user_msg = "01900000-0000-7000-8000-0000000000b2";
        seed_run(&pool, thread, run, user_msg).await;

        let je = "je-2";
        seed_entity(
            &pool,
            je,
            "journal_entry",
            r#"{"occurred_at":"2026-06-10T10:30:00","body":[{"type":"text","text":"Solo entry."}]}"#,
        )
        .await;
        sqlx::query("INSERT INTO entity_sources (id, entity_id, source_message_id, relation, created_at) VALUES ('es-2', ?, ?, 'created_from', 1)")
            .bind(je)
            .bind(user_msg)
            .execute(&pool)
            .await
            .expect("seed created_from source");

        let out = execute(&pool, Uuid::parse_str(run).unwrap(), serde_json::json!({}))
            .await
            .expect("read succeeds");
        let entries = entries(&out);
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0]["anchored_entities"],
            serde_json::json!([]),
            "no refs → empty array, always present"
        );
    }
}
