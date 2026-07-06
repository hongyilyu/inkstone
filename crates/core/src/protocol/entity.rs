//! `entity/*`, `journal_entry/rescan`, `message/search`, and
//! `recurrence/preview` wire types (ADR-0009 hand-mirror).

use serde::{Deserialize, Serialize};

/// `recurrence/preview` params (ADR-0039 amendment, #227): a draft Recurrence
/// Rule + the editing Todo's current `defer_at`/`due_at`. Read-only — the editor
/// sends an in-progress rule to preview when the next occurrence would land.
/// `recurrence` is the opaque rule object (validated only by the date math's
/// fail-safe `None`, never rejected here); the dates are optional because a Todo
/// may carry only one anchor. Hand-authored wire struct (Deserialize-only).
#[derive(Debug, Deserialize)]
pub struct RecurrencePreviewParams {
    pub recurrence: serde_json::Value,
    #[serde(default)]
    pub defer_at: Option<String>,
    #[serde(default)]
    pub due_at: Option<String>,
}

/// `recurrence/preview` result (ADR-0039 amendment, #227): the next occurrence's
/// dates, or `ended: true` when completing the Todo would spawn no successor
/// (end condition reached, or a malformed/partial draft rule — `next_occurrence`
/// is fail-safe). `ended: true` is a normal result, NOT a JSON-RPC error: a
/// bounded series ending is expected, and an in-flight draft must never surface
/// as an error in the editor. When `ended` is false, `defer_at`/`due_at` mirror
/// the input's anchor presence (a date absent on input stays absent).
#[derive(Debug, Serialize)]
pub struct RecurrencePreviewResult {
    pub ended: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub defer_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_at: Option<String>,
}

/// `entity/list` params: the Entity `type` to list, one per call (e.g. `"todo"`,
/// `"person"`). `r#type` serializes as the wire field `"type"`.
#[derive(Debug, Deserialize)]
pub struct EntityListParams {
    pub r#type: String,
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
    /// A Todo row's Person References (ADR-0031, ADR-0032). Empty (and omitted)
    /// for non-Todo rows and Todos with no references.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub person_refs: Vec<TodoPersonRefView>,
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

/// One Todo Person Reference on a Todo `entity/list` row (ADR-0032). `role` is
/// `waiting_on` or `related` (`waiting_on` ⊇ `related`).
#[derive(Debug, Serialize)]
pub struct TodoPersonRefView {
    pub person_id: String,
    pub role: String,
}

/// `entity/list` result: the accepted Entities of the requested type,
/// newest-first. Object-wrapper shape (`{entities: [...]}`) keeps it
/// forward-extensible.
#[derive(Debug, Serialize)]
pub struct EntityListResult {
    pub entities: Vec<EntityRow>,
}

/// `entity/backlinks` params (ADR-0050): the Entity whose reverse relations the
/// detail Inspector wants. Only Person/Project/Todo are `entity_ref` targets, so
/// only those fire the read.
#[derive(Debug, Deserialize)]
pub struct EntityBacklinksParams {
    pub entity_id: String,
}

/// `entity/backlinks` result (ADR-0050): the two reverse sets Core resolves
/// authoritatively for the detail Inspector — `mentioned_in` (distinct Journal
/// Entries referencing this Entity, newest-occurred first) and `linked_todos`
/// (Todos linked via `project_id` / `person_refs`, newest first). Reuses
/// `EntityRow` (ADR-0032), so each section parses through the existing entity
/// codec. Both arrays are ALWAYS present (possibly empty `[]`); object-wrapper
/// shape modeled like `EntityListResult` for forward-extensibility.
#[derive(Debug, Serialize)]
pub struct EntityBacklinksResult {
    pub mentioned_in: Vec<EntityRow>,
    pub linked_todos: Vec<EntityRow>,
}

/// `entity/mutate` params (ADR-0033): a user-initiated CRUD request. `payload` is
/// the same discriminated `{mutation_kind, payload}` envelope the Worker's
/// `propose_workspace_mutation` tool uses (minus `rationale`), so it stays opaque
/// at the wire boundary — Core validates it per `mutation_kind`.
#[derive(Debug, Deserialize)]
pub struct EntityMutateParams {
    pub mutation_kind: String,
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

#[cfg(test)]
mod mirror_tests {
    use super::*;
    use serde_json::json;

    // A fixed UUID-shaped string; the wire carries ids as plain strings.
    const UUID_A: &str = "0190d3c1-0000-7000-8000-000000000001";
    const UUID_B: &str = "0190d3c1-0000-7000-8000-000000000002";
    const UUID_RUN: &str = "0190d3c1-0000-7000-8000-000000000003";

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
