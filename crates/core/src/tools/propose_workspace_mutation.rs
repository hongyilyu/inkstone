//! The `propose_workspace_mutation` tool (ADR-0016, ADR-0025). A Proposal is a
//! Tool Request whose Tool Result is a user Decision, so it has no `execute`:
//! Core persists a pending Proposal, parks the Run, and resumes on Decision.

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
    UpdateJournalEntry,
    DeleteJournalEntry,
    ReferenceExistingEntityFromJournalEntry,
}

/// Wire arguments: `mutation_kind` names the mutation; `payload` is its body,
/// validated by Core on Decision.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "mutation_kind", rename_all = "snake_case")]
#[allow(dead_code)]
pub enum Input {
    CreateJournalEntry {
        payload: CreateJournalEntryPayload,
        #[serde(default)]
        rationale: Option<String>,
    },
    UpdateJournalEntry {
        payload: UpdateJournalEntryPayload,
        #[serde(default)]
        rationale: Option<String>,
    },
    DeleteJournalEntry {
        payload: DeleteJournalEntryPayload,
        #[serde(default)]
        rationale: Option<String>,
    },
    ReferenceExistingEntityFromJournalEntry {
        payload: ReferenceExistingEntityFromJournalEntryPayload,
        #[serde(default)]
        rationale: Option<String>,
    },
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
    pub body: Vec<CreateJournalEntryBodyNode>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(deny_unknown_fields)]
#[allow(dead_code)]
pub struct UpdateJournalEntryPayload {
    pub entity_id: String,
    /// Local wall-clock time in YYYY-MM-DDTHH:MM:SS format.
    #[schemars(regex(pattern = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$"))]
    pub occurred_at: String,
    /// Optional local wall-clock end time in YYYY-MM-DDTHH:MM:SS format.
    #[serde(default)]
    #[schemars(regex(pattern = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$"))]
    pub ended_at: Option<String>,
    #[schemars(length(min = 1))]
    pub body: Vec<UpdateJournalEntryBodyNode>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(deny_unknown_fields)]
#[allow(dead_code)]
pub struct DeleteJournalEntryPayload {
    pub entity_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(deny_unknown_fields)]
#[allow(dead_code)]
pub struct ReferenceExistingEntityFromJournalEntryPayload {
    #[schemars(
        length(min = 36, max = 36),
        regex(
            pattern = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
        )
    )]
    pub source_entity_id: String,
    #[schemars(
        length(min = 36, max = 36),
        regex(
            pattern = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
        )
    )]
    pub target_entity_id: String,
    #[serde(default)]
    #[schemars(length(min = 1))]
    pub label_snapshot: Option<String>,
    #[schemars(length(min = 1))]
    pub body: Vec<ReferenceExistingEntityFromJournalEntryBodyNode>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(deny_unknown_fields)]
#[allow(dead_code)]
pub enum CreateJournalEntryBodyNode {
    Text {
        #[schemars(length(min = 1))]
        text: String,
    },
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(deny_unknown_fields)]
#[allow(dead_code)]
pub enum UpdateJournalEntryBodyNode {
    Text {
        #[schemars(length(min = 1))]
        text: String,
    },
    EntityRef {
        #[schemars(length(min = 1))]
        ref_id: String,
    },
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(deny_unknown_fields)]
#[allow(dead_code)]
pub enum ReferenceExistingEntityFromJournalEntryBodyNode {
    Text {
        #[schemars(length(min = 1))]
        text: String,
    },
    /// Placeholder rewritten by Core to the generated or reused EntityRef id.
    EntityRef {},
}

pub fn descriptor() -> CoreToolDescriptor {
    let mut json_schema = serde_json::to_value(schemars::schema_for!(Input))
        .expect("propose_workspace_mutation Input schema serializes");
    disallow_null_for_property(&mut json_schema, "ended_at");
    disallow_null_for_property(&mut json_schema, "label_snapshot");
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
        assert!(
            d.json_schema["oneOf"].is_array(),
            "schema binds mutation_kind at the top level, got {}",
            d.json_schema
        );
        assert!(
            d.json_schema.to_string().contains("create_journal_entry"),
            "schema exposes the closed mutation_kind set, got {}",
            d.json_schema
        );
        assert!(
            d.json_schema
                .to_string()
                .contains("reference_existing_entity_from_journal_entry"),
            "schema exposes the reference mutation kind, got {}",
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

    fn top_level_variant<'a>(schema: &'a Value, kind: &str) -> Option<&'a Value> {
        schema
            .get("oneOf")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|variant| {
                variant["properties"]["mutation_kind"]["enum"]
                    .as_array()
                    .is_some_and(|values| values.iter().any(|value| value == kind))
            })
    }

    fn payload_schema<'a>(schema: &'a Value, variant: &'a Value) -> &'a Value {
        let payload = &variant["properties"]["payload"];
        let Some(reference) = payload.get("$ref").and_then(Value::as_str) else {
            return payload;
        };
        let Some(definition_name) = reference.strip_prefix("#/definitions/") else {
            panic!("payload ref must target a local definition: {reference}");
        };
        &schema["definitions"][definition_name]
    }

    fn resolve_ref<'a>(schema: &'a Value, value: &'a Value) -> &'a Value {
        let Some(reference) = value.get("$ref").and_then(Value::as_str) else {
            return value;
        };
        let Some(definition_name) = reference.strip_prefix("#/definitions/") else {
            panic!("schema ref must target a local definition: {reference}");
        };
        &schema["definitions"][definition_name]
    }

    fn body_item_schema<'a>(schema: &'a Value, payload: &'a Value) -> &'a Value {
        resolve_ref(schema, &payload["properties"]["body"]["items"])
    }

    fn schema_tree_contains(schema: &Value, value: &Value, needle: &str) -> bool {
        match value {
            Value::String(text) => text == needle,
            Value::Array(items) => items
                .iter()
                .any(|item| schema_tree_contains(schema, item, needle)),
            Value::Object(obj) => {
                if value.get("$ref").is_some() {
                    return schema_tree_contains(schema, resolve_ref(schema, value), needle);
                }
                obj.values()
                    .any(|item| schema_tree_contains(schema, item, needle))
            }
            _ => false,
        }
    }

    fn reference_payload_schema(schema: &Value) -> &Value {
        let reference = top_level_variant(schema, "reference_existing_entity_from_journal_entry")
            .unwrap_or_else(|| {
                panic!(
                    "schema must bind reference_existing_entity_from_journal_entry at top level: {}",
                    schema
                )
            });
        payload_schema(schema, reference)
    }

    #[test]
    fn descriptor_binds_entity_target_only_for_update_and_delete() {
        let d = descriptor();

        let create =
            top_level_variant(&d.json_schema, "create_journal_entry").unwrap_or_else(|| {
                panic!(
                    "schema must bind create_journal_entry at top level: {}",
                    d.json_schema
                )
            });
        let update =
            top_level_variant(&d.json_schema, "update_journal_entry").unwrap_or_else(|| {
                panic!(
                    "schema must bind update_journal_entry at top level: {}",
                    d.json_schema
                )
            });
        let delete =
            top_level_variant(&d.json_schema, "delete_journal_entry").unwrap_or_else(|| {
                panic!(
                    "schema must bind delete_journal_entry at top level: {}",
                    d.json_schema
                )
            });

        let create_required = payload_schema(&d.json_schema, create)["required"]
            .as_array()
            .unwrap_or_else(|| {
                panic!(
                    "create payload must declare required fields: {}",
                    d.json_schema
                )
            });
        assert!(
            !create_required
                .iter()
                .any(|field| field.as_str() == Some("entity_id")),
            "create_journal_entry payload must remain valid without entity_id: {}",
            d.json_schema
        );

        let update_required = payload_schema(&d.json_schema, update)["required"]
            .as_array()
            .unwrap_or_else(|| {
                panic!(
                    "update payload must declare required fields: {}",
                    d.json_schema
                )
            });
        assert!(
            update_required
                .iter()
                .any(|field| field.as_str() == Some("entity_id")),
            "update_journal_entry payload must require entity_id: {}",
            d.json_schema
        );

        let delete_required = payload_schema(&d.json_schema, delete)["required"]
            .as_array()
            .unwrap_or_else(|| {
                panic!(
                    "delete payload must declare required fields: {}",
                    d.json_schema
                )
            });
        assert!(
            delete_required
                .iter()
                .any(|field| field.as_str() == Some("entity_id")),
            "delete_journal_entry payload must require entity_id: {}",
            d.json_schema
        );
    }

    #[test]
    fn descriptor_keeps_create_text_only_but_allows_update_and_reference_entity_refs() {
        let d = descriptor();

        let create =
            top_level_variant(&d.json_schema, "create_journal_entry").unwrap_or_else(|| {
                panic!(
                    "schema must bind create_journal_entry at top level: {}",
                    d.json_schema
                )
            });
        let update =
            top_level_variant(&d.json_schema, "update_journal_entry").unwrap_or_else(|| {
                panic!(
                    "schema must bind update_journal_entry at top level: {}",
                    d.json_schema
                )
            });
        let reference = top_level_variant(
            &d.json_schema,
            "reference_existing_entity_from_journal_entry",
        )
        .unwrap_or_else(|| {
            panic!(
                "schema must bind reference_existing_entity_from_journal_entry at top level: {}",
                d.json_schema
            )
        });

        let create_body = body_item_schema(&d.json_schema, payload_schema(&d.json_schema, create));
        let update_body = body_item_schema(&d.json_schema, payload_schema(&d.json_schema, update));
        let reference_payload = payload_schema(&d.json_schema, reference);
        let reference_body = body_item_schema(&d.json_schema, reference_payload);

        assert!(
            !schema_tree_contains(&d.json_schema, create_body, "entity_ref"),
            "create_journal_entry body must stay text-only: {}",
            d.json_schema
        );
        assert!(
            schema_tree_contains(&d.json_schema, update_body, "entity_ref"),
            "update_journal_entry body must allow entity_ref nodes: {}",
            d.json_schema
        );
        assert!(
            schema_tree_contains(&d.json_schema, reference_body, "entity_ref"),
            "reference_existing_entity_from_journal_entry body must allow an entity_ref placeholder: {}",
            d.json_schema
        );
        let required = reference_payload["required"].as_array().unwrap_or_else(|| {
            panic!(
                "reference payload must declare required fields: {}",
                d.json_schema
            )
        });
        assert!(
            required
                .iter()
                .any(|field| field.as_str() == Some("source_entity_id"))
                && required
                    .iter()
                    .any(|field| field.as_str() == Some("target_entity_id")),
            "reference payload must require source and target ids: {}",
            d.json_schema
        );
    }

    #[test]
    fn descriptor_constrains_reference_payload_ids_and_label_snapshot() {
        let d = descriptor();
        let reference_payload = reference_payload_schema(&d.json_schema);

        for field in ["source_entity_id", "target_entity_id"] {
            let property = &reference_payload["properties"][field];
            assert_eq!(
                property["minLength"],
                serde_json::json!(36),
                "{field} must be exactly UUID-length: {}",
                d.json_schema
            );
            assert_eq!(
                property["maxLength"],
                serde_json::json!(36),
                "{field} must be exactly UUID-length: {}",
                d.json_schema
            );
            assert!(
                property["pattern"]
                    .as_str()
                    .is_some_and(|pattern| pattern.contains("[0-9a-fA-F]{8}")),
                "{field} must carry a UUID pattern: {}",
                d.json_schema
            );
        }

        let label_snapshot = &reference_payload["properties"]["label_snapshot"];
        assert_eq!(
            label_snapshot["minLength"],
            serde_json::json!(1),
            "label_snapshot must be non-empty when present: {}",
            d.json_schema
        );
        assert!(
            !mentions_null(label_snapshot),
            "label_snapshot may be omitted, but must not be nullable: {label_snapshot}"
        );
    }
}
