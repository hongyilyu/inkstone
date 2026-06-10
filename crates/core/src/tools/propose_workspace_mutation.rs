//! The `propose_workspace_mutation` tool (ADR-0016, ADR-0025). A Proposal is
//! a Tool Request whose Tool Result is a user Decision. Proposal tools have no
//! `execute`: Core's Worker run loop intercepts them before dispatch, persists
//! a pending Proposal, parks the Run, and resumes once the Decision arrives.

use schemars::JsonSchema;
use serde::Deserialize;

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
    CoreToolDescriptor {
        name: NAME.to_string(),
        description: DESCRIPTION.to_string(),
        label: LABEL.to_string(),
        json_schema: serde_json::to_value(schemars::schema_for!(Input))
            .expect("propose_workspace_mutation Input schema serializes"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
