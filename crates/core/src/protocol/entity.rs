//! `entity/*`, `journal_entry/rescan`, and `message/search` wire types
//! (ADR-0009 hand-mirror).

use serde::{Deserialize, Serialize};

use crate::mutation::{DirectMutationKind, EntityTypeName};

/// `entity/list` params: the Entity `type` to list, one per call (e.g.
/// `"person"`). `r#type` serializes as the wire field `"type"`.
#[derive(Debug, Deserialize)]
pub struct EntityListParams {
    pub r#type: EntityTypeName,
}

/// One Entity row in `entity/list` (ADR-0004 tier-2 `entities` columns).
/// `r#type` serializes as `"type"`; `data` is the opaque entity JSON;
/// `created_at`/`updated_at` are ms-epoch stamps.
#[derive(Debug, Serialize)]
pub struct EntityRow {
    pub id: String,
    pub r#type: String,
    pub data: serde_json::Value,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub refs: Vec<ResolvedEntityRef>,
    /// The Entity's origin provenance ("Captured from", ADR-0030). Omitted for a
    /// user-authored Entity (a direct Library write records no source row).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<EntitySourceView>,
}

/// One Entity's origin provenance on an `entity/list` row (ADR-0030). A FLAT
/// optional shape, safe because Core is the sole producer and fills the fields
/// from one `entity_sources` row whose CHECK guarantees exactly one source kind:
/// a user Message source carries `thread_id` + `thread_title` (link back to the
/// Thread) plus the capturing `message_id` (so the Client can deep-link to the
/// exact message, #184); a Journal-Entry source carries `journal_entry_id` (link
/// to it in the Library). The Client reads `journal_entry_id` first, else the
/// Thread fields (`message_id` rides along with them).
#[derive(Debug, Serialize)]
pub struct EntitySourceView {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub journal_entry_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ResolvedEntityRef {
    pub id: String,
    pub source_entity_id: String,
    pub target_entity_id: String,
    pub target_entity_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label_snapshot: Option<String>,
}

/// `entity/list` result: the accepted Entities of the requested type,
/// newest-first. Object-wrapper shape (`{entities: [...]}`) keeps it
/// forward-extensible.
#[derive(Debug, Serialize)]
pub struct EntityListResult {
    pub entities: Vec<EntityRow>,
}

/// `entity/backlinks` params (ADR-0050): the Entity whose reverse relations the
/// detail Inspector wants. Only Person/Project are `entity_ref` targets, so
/// only those fire the read.
#[derive(Debug, Deserialize)]
pub struct EntityBacklinksParams {
    pub entity_id: String,
}

/// `entity/backlinks` result (ADR-0050): the reverse set Core resolves
/// authoritatively for the detail Inspector — `mentioned_in` (distinct Journal
/// Entries referencing this Entity, newest-occurred first). Reuses `EntityRow`
/// (ADR-0032), so the section parses through the existing entity codec. The
/// array is ALWAYS present (possibly empty `[]`); object-wrapper shape modeled
/// like `EntityListResult` for forward-extensibility.
#[derive(Debug, Serialize)]
pub struct EntityBacklinksResult {
    pub mentioned_in: Vec<EntityRow>,
}

/// `entity/mutate` params (ADR-0033): a user-initiated CRUD request. `payload` is
/// the same discriminated `{mutation_kind, payload}` envelope the Worker's
/// `propose_workspace_mutation` tool uses (minus `rationale`), so it stays opaque
/// at the wire boundary — Core validates it per `mutation_kind`.
#[derive(Debug, Deserialize)]
pub struct EntityMutateParams {
    pub mutation_kind: DirectMutationKind,
    pub payload: serde_json::Value,
}

/// `entity/mutate` result: the affected Entity id — present on create/update,
/// absent on delete (which leaves no row).
#[derive(Debug, Serialize)]
pub struct EntityMutateResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<String>,
}

/// `journal_entry/rescan` params (ADR-0042): the Journal Entry to re-scan for
/// people/projects/tasks mentioned but not yet captured. Core resolves the JE's
/// origin Thread and starts an ordinary agent Run there.
#[derive(Debug, Deserialize)]
pub struct JournalEntryRescanParams {
    pub je_id: String,
}

/// `journal_entry/rescan` result: the spawned Run and the origin Thread it runs
/// in (so the Client can follow `run/subscribe(run_id)` and navigate to the
/// Thread). Mirror of TS `JournalEntryRescanResult`.
#[derive(Debug, Serialize)]
pub struct JournalEntryRescanResult {
    pub run_id: String,
    pub thread_id: String,
}

/// `message/search` params (ADR-0035): a substring query over completed Message
/// text. Mirror of TS `MessageSearchParams`.
#[derive(Debug, Deserialize)]
pub struct MessageSearchParams {
    pub query: String,
}

/// One `message/search` hit (ADR-0035): a completed Message matching the
/// substring query, with a SQL-rendered snippet and its Thread title for
/// navigation. Mirror of TS `MessageHit` (field-for-field, snake_case wire);
/// aligns with `db::MessageHit`. `role` is `"user"`/`"assistant"` on the wire;
/// `created_at` is a ms-epoch stamp.
#[derive(Debug, Serialize)]
pub struct MessageHit {
    pub message_id: String,
    pub thread_id: String,
    pub run_id: String,
    pub role: String,
    pub snippet: String,
    pub thread_title: String,
    pub created_at: i64,
}

/// `message/search` result: the matching hits, newest-first. Object-wrapper
/// shape (`{hits: [...]}`) keeps it forward-extensible. Mirror of TS
/// `MessageSearchResult`.
#[derive(Debug, Serialize)]
pub struct MessageSearchResult {
    pub hits: Vec<MessageHit>,
}

/// Mirror tests: lock the Rust serde shapes to the canonical snake_case wire
/// JSON the TS `Schema` definitions in `packages/protocol` produce (ADR-0009).
/// Each test asserts agreement in the type's available direction; a renamed
/// field or changed type fails the matching test. This is the reconciliation
/// point that guards against TS/Rust divergence.
#[cfg(test)]
mod mirror_tests {
    use super::*;
    use serde_json::json;

    // A fixed UUID-shaped string; the wire carries ids as plain strings.
    const UUID_A: &str = "0190d3c1-0000-7000-8000-000000000001";
    const UUID_B: &str = "0190d3c1-0000-7000-8000-000000000002";
    const UUID_RUN: &str = "0190d3c1-0000-7000-8000-000000000003";

    #[test]
    fn entity_params_reject_values_outside_their_closed_domains() {
        assert!(serde_json::from_value::<EntityListParams>(json!({ "type": "todo" })).is_err());
        assert!(
            serde_json::from_value::<EntityMutateParams>(json!({
                "mutation_kind": "create_todo",
                "payload": {}
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<EntityMutateParams>(json!({
                "mutation_kind": "apply_intent_graph",
                "payload": {}
            }))
            .is_err()
        );
    }

    #[test]
    fn message_search_params_rejects_missing_and_non_string_query() {
        assert!(serde_json::from_value::<MessageSearchParams>(json!({})).is_err());
        assert!(serde_json::from_value::<MessageSearchParams>(json!({ "query": 42 })).is_err());
    }

    #[test]
    fn message_search_result_encodes_hits_wrapper_and_empty() {
        let one = MessageSearchResult {
            hits: vec![MessageHit {
                message_id: UUID_A.to_string(),
                thread_id: UUID_B.to_string(),
                run_id: UUID_RUN.to_string(),
                role: "user".to_string(),
                snippet: "hi".to_string(),
                thread_title: "T".to_string(),
                created_at: 1,
            }],
        };
        let value = serde_json::to_value(&one).unwrap();
        assert_eq!(value["hits"].as_array().unwrap().len(), 1);
        assert_eq!(value["hits"][0]["role"], json!("user"));

        let empty = MessageSearchResult { hits: vec![] };
        assert_eq!(serde_json::to_value(&empty).unwrap(), json!({ "hits": [] }));
    }
}
