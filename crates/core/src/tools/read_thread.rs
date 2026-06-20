//! The `read_thread` tool (ADR-0018). Reads another Thread's messages by id.

use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::ToolError;
use crate::protocol::{AgentToolResult, CoreToolDescriptor, ToolTextContent};

pub const NAME: &str = "read_thread";
const DESCRIPTION: &str =
    "Read the messages of another thread by its id. Returns the thread's title and its messages in order.";
const LABEL: &str = "Read thread";

/// `read_thread`'s arguments. Core re-validates the model's args against this
/// struct on receipt (ADR-0018).
#[derive(Debug, Deserialize, JsonSchema)]
pub struct Input {
    pub thread_id: String,
}

/// The manifest descriptor for this tool.
pub fn descriptor() -> CoreToolDescriptor {
    CoreToolDescriptor {
        name: NAME.to_string(),
        description: DESCRIPTION.to_string(),
        label: LABEL.to_string(),
        json_schema: serde_json::to_value(schemars::schema_for!(Input))
            .expect("read_thread Input schema serializes"),
    }
}

/// Read the Thread's messages as a JSON payload
/// `{ thread_id, title, messages: [{ role, text }, …] }` in one text block,
/// reusing [`crate::db::get_thread_with_messages`]. A malformed or unknown
/// `thread_id` is a `not_found` ToolError (the Run continues; ADR-0018).
pub async fn execute(pool: &SqlitePool, params: Value) -> Result<AgentToolResult, ToolError> {
    let input: Input = serde_json::from_value(params).map_err(|e| ToolError {
        code: "invalid_params".to_string(),
        message: e.to_string(),
    })?;

    let thread_uuid = Uuid::parse_str(&input.thread_id).map_err(|_| ToolError {
        code: "not_found".to_string(),
        message: format!("no thread with id {:?}", input.thread_id),
    })?;

    let (title, messages) = crate::db::get_thread_with_messages(pool, thread_uuid)
        .await
        .map_err(|e| ToolError {
            code: "internal".to_string(),
            message: e.to_string(),
        })?
        .ok_or_else(|| ToolError {
            code: "not_found".to_string(),
            message: format!("no thread with id {:?}", input.thread_id),
        })?;

    let payload = serde_json::json!({
        "thread_id": input.thread_id,
        "title": title,
        "messages": messages
            .iter()
            .map(|m| serde_json::json!({ "role": m.role, "text": m.text() }))
            .collect::<Vec<_>>(),
    });

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
    fn descriptor_has_name_and_object_schema() {
        let d = descriptor();
        assert_eq!(d.name, "read_thread");
        assert_eq!(d.label, "Read thread");
        assert_eq!(d.json_schema["type"], serde_json::json!("object"));
        assert!(
            d.json_schema["properties"]["thread_id"].is_object(),
            "schema describes thread_id, got {}",
            d.json_schema
        );
    }
}
