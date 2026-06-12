//! The `read_current_thread_journal_entries` tool. Reads accepted Journal
//! Entries whose `created_from` source Message belongs to the current Run's
//! Thread. The Run, not the model, supplies the Thread context.

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

/// Takes no model-supplied arguments. Serde's default unknown-field tolerance is
/// intentional here: the schema advertises `{}`, while Core still derives the
/// authoritative Thread from `run_id`.
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

    #[test]
    fn descriptor_has_name_and_empty_object_schema() {
        let d = descriptor();
        assert_eq!(d.name, "read_current_thread_journal_entries");
        assert_eq!(d.label, "Read current thread journal entries");
        assert_eq!(d.json_schema["type"], serde_json::json!("object"));
    }
}
