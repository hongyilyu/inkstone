//! The `propose_workspace_mutation` tool (ADR-0016, ADR-0025). A Proposal is
//! a Tool Request whose Tool Result is a user Decision. Proposal tools have no
//! `execute`: Core's Worker run loop intercepts them before dispatch, persists
//! a pending Proposal, parks the Run, and resumes once the Decision arrives.

use schemars::JsonSchema;
use serde::Deserialize;

use crate::protocol::CoreToolDescriptor;

pub const NAME: &str = "propose_workspace_mutation";
const DESCRIPTION: &str = "Propose a Workspace mutation for user review before anything is saved.";
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
#[allow(dead_code)]
pub struct Input {
    pub mutation_kind: WorkspaceMutationKind,
    pub payload: serde_json::Value,
    #[serde(default)]
    pub rationale: Option<String>,
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
}
