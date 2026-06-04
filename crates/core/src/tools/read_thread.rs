//! The `read_thread` tool (ADR-0018). Reads another Thread's messages by id.
//! Slice 2 ships a STUB `execute` (returns `{"messages":[]}`); slice 3
//! replaces the body with the real `messages` + `message_parts` query. The
//! `Input` struct's `schemars`-derived JSON Schema becomes the descriptor
//! Core ships in the manifest.

use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use sqlx::SqlitePool;

use super::ToolError;
use crate::protocol::{AgentToolResult, CoreToolDescriptor, ToolTextContent};

pub const NAME: &str = "read_thread";
const DESCRIPTION: &str =
    "Read the messages of another thread by its id. Returns the thread's title and its messages in order.";
const LABEL: &str = "Read thread";

/// `read_thread`'s arguments. The `thread_id` is the id of the Thread to read
/// (e.g. copied from the sidebar). `schemars` derives the Draft-07 JSON Schema
/// Core ships to the Worker; Core re-validates the model's args against this
/// struct on receipt (ADR-0018 "Argument validation").
#[derive(Debug, Deserialize, JsonSchema)]
pub struct Input {
    // Read by the real query in slice 3; the slice-2 stub only validates shape.
    #[allow(dead_code)]
    pub thread_id: String,
}

/// The manifest descriptor for this tool: name/description/label + the
/// `schemars`-derived input schema.
pub fn descriptor() -> CoreToolDescriptor {
    CoreToolDescriptor {
        name: NAME.to_string(),
        description: DESCRIPTION.to_string(),
        label: LABEL.to_string(),
        json_schema: serde_json::to_value(schemars::schema_for!(Input))
            .expect("read_thread Input schema serializes"),
    }
}

/// Slice 2 stub. Validates `params` against [`Input`] (malformed → an
/// `invalid_params` ToolError) then returns the empty `{"messages":[]}`
/// payload. Slice 3 replaces this body with the real query.
pub async fn execute(_pool: &SqlitePool, params: Value) -> Result<AgentToolResult, ToolError> {
    let _input: Input = serde_json::from_value(params).map_err(|e| ToolError {
        code: "invalid_params".to_string(),
        message: e.to_string(),
    })?;

    Ok(AgentToolResult {
        content: vec![ToolTextContent {
            r#type: "text".to_string(),
            text: r#"{"messages":[]}"#.to_string(),
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
        // schemars emits an object schema with a `thread_id` property.
        assert_eq!(d.json_schema["type"], serde_json::json!("object"));
        assert!(
            d.json_schema["properties"]["thread_id"].is_object(),
            "schema describes thread_id, got {}",
            d.json_schema
        );
    }
}
