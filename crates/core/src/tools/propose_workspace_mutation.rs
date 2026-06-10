//! The `propose_workspace_mutation` tool (ADR-0016, ADR-0025). A Proposal is
//! a Tool Request whose Tool Result is a user Decision. Proposal tools have no
//! `execute`: Core's Worker run loop intercepts them before dispatch, persists
//! a pending Proposal, parks the Run, and resumes once the Decision arrives.

use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

use crate::protocol::CoreToolDescriptor;

pub const NAME: &str = "propose_workspace_mutation";
const DESCRIPTION: &str = "Propose a Workspace mutation for user review before saving a journal-worthy lived event or reflection. Do not use for reminders, todos, tasks, or future obligations.";
const LABEL: &str = "Propose Workspace mutation";

/// Closed first-slice set of Core-known Workspace mutations.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub enum WorkspaceMutationKind {
    CreateJournalEntry,
}

/// Wire arguments for `propose_workspace_mutation`. `mutation_kind` names the
/// logical Workspace mutation; `payload` is the mutation-specific body Core
/// validates on Decision. The first supported kind is `create_journal_entry`.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(deny_unknown_fields)]
#[allow(dead_code)]
pub struct Input {
    pub mutation_kind: WorkspaceMutationKind,
    pub payload: CreateJournalEntryPayload,
    #[serde(default)]
    pub rationale: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(deny_unknown_fields)]
#[allow(dead_code)]
pub struct CreateJournalEntryPayload {
    /// Local wall-clock time in YYYY-MM-DDTHH:MM:SS format.
    #[schemars(regex(pattern = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$"))]
    pub occurred_at: String,
    /// Optional local wall-clock end time in YYYY-MM-DDTHH:MM:SS format.
    #[serde(default)]
    #[schemars(regex(pattern = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$"))]
    pub ended_at: Option<String>,
    #[schemars(length(min = 1))]
    pub body: Vec<JournalEntryBodyNode>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(deny_unknown_fields)]
#[allow(dead_code)]
pub struct JournalEntryBodyNode {
    pub r#type: JournalEntryBodyNodeType,
    #[schemars(length(min = 1))]
    pub text: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub enum JournalEntryBodyNodeType {
    Text,
}

pub fn descriptor() -> CoreToolDescriptor {
    let mut json_schema = serde_json::to_value(schemars::schema_for!(Input))
        .expect("propose_workspace_mutation Input schema serializes");
    disallow_null_for_property(&mut json_schema, "ended_at");
    CoreToolDescriptor {
        name: NAME.to_string(),
        description: DESCRIPTION.to_string(),
        label: LABEL.to_string(),
        json_schema,
    }
}

fn disallow_null_for_property(schema: &mut Value, property: &str) {
    match schema {
        Value::Object(obj) => {
            if let Some(properties) = obj.get_mut("properties").and_then(Value::as_object_mut) {
                if let Some(property_schema) = properties.get_mut(property) {
                    remove_null_type(property_schema);
                }
            }
            for child in obj.values_mut() {
                disallow_null_for_property(child, property);
            }
        }
        Value::Array(items) => {
            for child in items {
                disallow_null_for_property(child, property);
            }
        }
        _ => {}
    }
}

fn remove_null_type(schema: &mut Value) {
    let Some(obj) = schema.as_object_mut() else {
        return;
    };
    if let Some(schema_type) = obj.get_mut("type") {
        match schema_type {
            Value::Array(types) => {
                types.retain(|item| item != "null");
                if types.len() == 1 {
                    *schema_type = types[0].clone();
                }
            }
            Value::String(t) if t == "null" => {
                obj.remove("type");
            }
            _ => {}
        }
    }
    for key in ["anyOf", "oneOf"] {
        if let Some(Value::Array(variants)) = obj.get_mut(key) {
            variants.retain(|variant| variant.get("type").and_then(Value::as_str) != Some("null"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn property_schema<'a>(schema: &'a Value, property: &str) -> Option<&'a Value> {
        match schema {
            Value::Object(obj) => {
                if let Some(properties) = obj.get("properties").and_then(Value::as_object) {
                    if let Some(property_schema) = properties.get(property) {
                        return Some(property_schema);
                    }
                }
                obj.values()
                    .find_map(|child| property_schema(child, property))
            }
            Value::Array(items) => items
                .iter()
                .find_map(|child| property_schema(child, property)),
            _ => None,
        }
    }

    fn mentions_null(schema: &Value) -> bool {
        match schema {
            Value::String(s) => s == "null",
            Value::Array(items) => items.iter().any(mentions_null),
            Value::Object(obj) => obj.values().any(mentions_null),
            _ => false,
        }
    }

    #[test]
    fn descriptor_has_name_and_object_schema() {
        let d = descriptor();
        assert_eq!(d.name, "propose_workspace_mutation");
        assert_eq!(d.label, "Propose Workspace mutation");
        assert_eq!(d.json_schema["type"], serde_json::json!("object"));
        assert!(
            d.json_schema["properties"]["mutation_kind"].is_object(),
            "schema describes mutation_kind, got {}",
            d.json_schema
        );
        assert!(
            d.json_schema.to_string().contains("create_journal_entry"),
            "schema exposes the closed mutation_kind set, got {}",
            d.json_schema
        );
        assert!(
            d.json_schema["properties"].get("payload").is_some(),
            "schema describes payload, got {}",
            d.json_schema
        );
    }

    #[test]
    fn descriptor_describes_create_journal_entry_payload() {
        let d = descriptor();
        let schema = d.json_schema.to_string();
        assert!(
            schema.contains("occurred_at"),
            "schema must tell the worker to emit occurred_at, got {}",
            d.json_schema
        );
        assert!(
            schema.contains("YYYY-MM-DDTHH:MM:SS"),
            "schema must tell the worker to emit a full local timestamp, got {}",
            d.json_schema
        );
        assert!(
            schema.contains("minItems"),
            "schema must require at least one body text node, got {}",
            d.json_schema
        );
    }

    #[test]
    fn descriptor_disallows_null_ended_at() {
        let d = descriptor();
        let ended_at = property_schema(&d.json_schema, "ended_at")
            .expect("schema describes ended_at when present");
        assert!(
            !mentions_null(ended_at),
            "ended_at may be omitted, but must not be nullable: {ended_at}"
        );
    }

    #[test]
    fn descriptor_excludes_reminders_from_journal_entries() {
        let description = descriptor().description.to_lowercase();
        assert!(
            description.contains("journal-worthy")
                && description.contains("reminders")
                && description.contains("todos")
                && description.contains("tasks"),
            "tool description must keep reminders/tasks out of Journal Entry proposals, got {description:?}"
        );
    }
}
