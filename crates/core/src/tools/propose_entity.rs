//! The `propose_entity` tool (ADR-0018, ADR-0025). A Proposal is a Tool
//! Request whose Tool Result is a human Decision. Unlike other tools,
//! `propose_entity` has NO `execute`: when the Worker emits a `propose_entity`
//! `tool_request`, Core's park path (in [`crate::worker`]) intercepts it
//! BEFORE dispatch — it persists a pending Proposal, sets the Run to `parked`,
//! and tears the Worker down. The model's continuation is the Decision,
//! delivered as the awaited tool's result on resume (a later slice).
//!
//! This module owns only the manifest descriptor: the tool's name, copy, and
//! the `schemars`-derived input schema Core ships to the Worker so the model
//! can call it.

use schemars::JsonSchema;
use serde::Deserialize;

use crate::protocol::CoreToolDescriptor;

pub const NAME: &str = "propose_entity";
const DESCRIPTION: &str =
    "Propose creating a structured entity (e.g. a todo) from the conversation. \
     The proposal is shown to the user for approval before anything is saved.";
const LABEL: &str = "Propose entity";

/// `propose_entity`'s arguments. `type` is the proposed entity type (e.g.
/// `todo`); `data` is the opaque proposed entity payload (validated against the
/// entity schema on Decision, not here); `rationale` is the model's optional
/// reason. `schemars` derives the Draft-07 JSON Schema Core ships to the
/// Worker. `r#type` maps to the wire field `type`. The fields are never read
/// directly — this struct exists to derive the manifest schema (the park path
/// reads the proposed payload from the persisted tool call, not this struct).
#[derive(Debug, Deserialize, JsonSchema)]
#[allow(dead_code)]
pub struct Input {
    pub r#type: String,
    pub data: serde_json::Value,
    #[serde(default)]
    pub rationale: Option<String>,
}

/// The manifest descriptor for this tool: name/description/label + the
/// `schemars`-derived input schema.
pub fn descriptor() -> CoreToolDescriptor {
    CoreToolDescriptor {
        name: NAME.to_string(),
        description: DESCRIPTION.to_string(),
        label: LABEL.to_string(),
        json_schema: serde_json::to_value(schemars::schema_for!(Input))
            .expect("propose_entity Input schema serializes"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptor_has_name_and_object_schema() {
        let d = descriptor();
        assert_eq!(d.name, "propose_entity");
        assert_eq!(d.label, "Propose entity");
        assert_eq!(d.json_schema["type"], serde_json::json!("object"));
        assert!(
            d.json_schema["properties"]["type"].is_object(),
            "schema describes type, got {}",
            d.json_schema
        );
        // `data` is `serde_json::Value` → schemars renders it as the
        // permissive `true` schema (any JSON). Assert it is present, not that
        // it is an object.
        assert!(
            d.json_schema["properties"].get("data").is_some(),
            "schema describes data, got {}",
            d.json_schema
        );
    }
}
