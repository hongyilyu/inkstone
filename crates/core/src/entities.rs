//! Workspace mutation schemas (ADR-0016, ADR-0025). A Proposal's payload is
//! validated by its [`MutationKind`] before it is durably applied. Supported
//! mutations create/update/delete a `journal_entry` Entity (plus provenance)
//! and add inline references from Journal Entries to existing Entities.
//!
//! The closed Entity-Type taxonomy ([`MutationKind`]/[`ProposableMutation`] and
//! the descriptor) lives in [`crate::mutation`]; this module is the per-kind
//! *schema* layer — the validator bodies plus the accept-text rendering. Both
//! `validate` and `render_accept` dispatch on the typed kind, so a new kind is a
//! compile error here, not a runtime panic.

use serde_json::Value;
use uuid::Uuid;

use crate::mutation::{todo_data_spec, Mode, MutationKind, ProposableMutation};

/// Validate a proposed mutation payload against its schema (ADR-0016),
/// dispatched on the typed [`MutationKind`]. `Err(reason)` is surfaced as the
/// `invalid_params` message on `proposal/decide` / `entity/mutate`. Total over
/// the closed kind set — an unknown wire string is rejected at the edge by
/// [`MutationKind::from_wire`], so this never sees one.
pub(crate) fn validate(kind: MutationKind, payload: &Value) -> Result<(), String> {
    match kind {
        MutationKind::CreateJournalEntry => validate_journal_entry(payload),
        MutationKind::UpdateJournalEntry => validate_update_journal_entry(payload),
        MutationKind::ReferenceExistingEntityFromJournalEntry => {
            validate_reference_existing_entity_from_journal_entry(payload)
        }
        MutationKind::DeleteJournalEntry
        | MutationKind::DeletePerson
        | MutationKind::DeleteProject
        | MutationKind::DeleteTodo
        | MutationKind::DeleteBookmark
        // A user-path-only review touch (ADR-0034): `{entity_id}` only — Core reads
        // the Project and recomputes the review fields, so the client sends no data.
        // Deliberately absent from the agent `propose_workspace_mutation` schema; it
        // can only arrive via `entity/mutate`.
        | MutationKind::MarkProjectReviewed => validate_entity_id_only(kind, payload),
        // Create routes the FULL payload (entity data + the `source_journal_entry_id`
        // provenance directive) through its single-source spec, so that field's
        // shape is owned by `mutation.rs` like every other — no separate strip.
        MutationKind::CreatePerson => MutationKind::CreatePerson.payload_spec().check(payload),
        MutationKind::UpdatePerson => validate_update_person(payload),
        MutationKind::CreateProject => {
            MutationKind::CreateProject.payload_spec().check(payload)?;
            project_status_timestamp_invariant(payload.as_object().expect("check accepted an object"))
        }
        MutationKind::UpdateProject => validate_update_project(payload),
        MutationKind::CreateTodo => validate_todo(payload),
        MutationKind::UpdateTodo => validate_update_todo(payload),
        MutationKind::CreateBookmark => validate_bookmark(payload),
        MutationKind::UpdateBookmark => validate_update_bookmark(payload),
    }
}

/// Render the human-readable Decision text the model reads on resume as the
/// awaited tool's result (ADR-0025). An inherent method on [`ProposableMutation`]
/// (declared in [`crate::mutation`]) so it is total over exactly the 13 kinds
/// that can reach the agent accept path — the 4 user-only kinds are not in the
/// type, so there is no `unreachable!` to forget. Defined here, alongside the
/// private body-text helpers it uses.
pub(crate) fn render_accept(
    kind: ProposableMutation,
    payload: &Value,
    entity_id: Option<&str>,
) -> String {
    use ProposableMutation as P;
    match kind {
        P::CreateJournalEntry => {
            let entity_id = entity_id.expect("create accept rendering requires entity_id");
            let occurred_at = payload
                .get("occurred_at")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let body = journal_body_text(payload);
            format!(
                "Accepted. Created Journal Entry (entity_id={entity_id}, occurred_at={occurred_at}, body={body})."
            )
        }
        P::UpdateJournalEntry => {
            let occurred_at = payload
                .get("occurred_at")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let body = journal_body_text(payload);
            format!("Accepted. Updated Journal Entry (occurred_at={occurred_at}, body={body}).")
        }
        P::DeleteJournalEntry => {
            let entity_id = payload
                .get("entity_id")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            format!("Accepted. Deleted Journal Entry (entity_id={entity_id}).")
        }
        P::ReferenceExistingEntityFromJournalEntry => {
            let source_entity_id = payload
                .get("source_entity_id")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let target_entity_id = payload
                .get("target_entity_id")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let body = journal_body_text(payload);
            format!(
                "Accepted. Referenced Entity (source_entity_id={source_entity_id}, target_entity_id={target_entity_id}, body={body})."
            )
        }
        P::DeletePerson => {
            let entity_id = payload
                .get("entity_id")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            format!("Accepted. Deleted Person (entity_id={entity_id}).")
        }
        P::DeleteProject => {
            let entity_id = payload
                .get("entity_id")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            format!("Accepted. Deleted Project (entity_id={entity_id}).")
        }
        P::DeleteTodo => {
            let entity_id = payload
                .get("entity_id")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            format!("Accepted. Deleted Todo (entity_id={entity_id}).")
        }
        P::CreatePerson => {
            let entity_id = entity_id.expect("create accept rendering requires entity_id");
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            format!("Accepted. Created Person (entity_id={entity_id}, name={name}).")
        }
        P::UpdatePerson => {
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            format!("Accepted. Updated Person (name={name}).")
        }
        P::CreateProject => {
            let entity_id = entity_id.expect("create accept rendering requires entity_id");
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let status = payload
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("active");
            format!(
                "Accepted. Created Project (entity_id={entity_id}, name={name}, status={status})."
            )
        }
        P::UpdateProject => {
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let status = payload
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            format!("Accepted. Updated Project (name={name}, status={status}).")
        }
        P::CreateTodo => {
            let entity_id = entity_id.expect("create accept rendering requires entity_id");
            let todo = payload.get("todo");
            let title = todo
                .and_then(|t| t.get("title"))
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let status = todo
                .and_then(|t| t.get("status"))
                .and_then(Value::as_str)
                .unwrap_or("active");
            format!(
                "Accepted. Created Todo (entity_id={entity_id}, title={title}, status={status})."
            )
        }
        P::UpdateTodo => {
            let todo_id = payload
                .get("todo_id")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            format!("Accepted. Updated Todo (todo_id={todo_id}).")
        }
    }
}

fn journal_body_text(payload: &Value) -> String {
    let Some(body) = payload.get("body").and_then(Value::as_array) else {
        return "unknown".to_string();
    };
    let text = body
        .iter()
        .filter_map(journal_body_node_text)
        .collect::<String>();
    if text.trim().is_empty() {
        "unknown".to_string()
    } else {
        text
    }
}

fn journal_body_node_text(node: &Value) -> Option<String> {
    match node.get("type").and_then(Value::as_str) {
        Some("text") => node.get("text").and_then(Value::as_str).map(str::to_string),
        Some("entity_ref") => Some(
            node.get("ref_id")
                .and_then(Value::as_str)
                .map(|ref_id| format!("[entity_ref:{ref_id}]"))
                .unwrap_or_else(|| "[entity_ref]".to_string()),
        ),
        _ => None,
    }
}

/// The `target_entity_id` of a reference weave — the EXISTING Entity the new
/// inline reference points at (distinct from the `source_entity_id` Journal
/// Entry the reference is woven into, which is the mutation's target key).
pub(crate) fn reference_target_entity_id(payload: &Value) -> Option<&str> {
    payload.get("target_entity_id").and_then(Value::as_str)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum BodyNodePolicy {
    TextOnly,
    TextOrExistingEntityRef,
    TextOrNewEntityRef,
}

fn validate_journal_entry(payload: &Value) -> Result<(), String> {
    // Flat shell (occurred_at/ended_at presence + datetime parse, the body-union
    // schema) from the single source; the ended_at≥occurred_at + body-content
    // invariants are the hook.
    MutationKind::CreateJournalEntry
        .payload_spec()
        .check(payload)?;
    validate_journal_body_and_times(payload, BodyNodePolicy::TextOnly)
}

/// The Journal-Entry cross-field invariants the flat spec walk cannot express:
/// `ended_at >= occurred_at` (both already parse-validated by the spec) and the
/// body's array/non-empty/per-node/policy checks (the `body` field is a schema-only
/// `Body` union in the spec, so its content is validated here). `occurred_at` is
/// present + parseable by the time this runs (the spec enforced it), so the
/// comparison re-parses cheaply.
fn validate_journal_body_and_times(
    payload: &Value,
    body_policy: BodyNodePolicy,
) -> Result<(), String> {
    let obj = payload.as_object().expect("check accepted an object");

    if let (Some(occurred_at), Some(ended_at)) = (
        obj.get("occurred_at").and_then(Value::as_str),
        obj.get("ended_at").and_then(Value::as_str),
    ) {
        let occurred = parse_local_datetime(occurred_at, "occurred_at")?;
        let ended = parse_local_datetime(ended_at, "ended_at")?;
        if ended < occurred {
            return Err("ended_at must be greater than or equal to occurred_at".to_string());
        }
    }

    validate_journal_body(obj, body_policy)
}

/// Validate a Journal-Entry `body`: a non-empty array of node objects, each valid
/// under `body_policy`. Shared by the create/update validators and the reference
/// weave (which adds the exactly-one-entity_ref invariant on top).
fn validate_journal_body(
    obj: &serde_json::Map<String, Value>,
    body_policy: BodyNodePolicy,
) -> Result<(), String> {
    let body = obj
        .get("body")
        .and_then(Value::as_array)
        .ok_or_else(|| "body must be an array".to_string())?;
    if body.is_empty() {
        return Err("body must not be empty".to_string());
    }
    for node in body {
        let node = node
            .as_object()
            .ok_or_else(|| "body nodes must be objects".to_string())?;
        validate_body_node(node, body_policy)?;
    }
    Ok(())
}

fn validate_body_node(
    node: &serde_json::Map<String, Value>,
    body_policy: BodyNodePolicy,
) -> Result<(), String> {
    let node_type = match node.get("type") {
        Some(Value::String(t)) => t.as_str(),
        Some(_) => return Err("body node type must be a string".to_string()),
        None => return Err("body node type is required".to_string()),
    };

    match node_type {
        "text" => validate_text_body_node(node),
        "entity_ref" if body_policy == BodyNodePolicy::TextOrExistingEntityRef => {
            validate_entity_ref_body_node(node)
        }
        "entity_ref" if body_policy == BodyNodePolicy::TextOrNewEntityRef => {
            validate_new_entity_ref_body_node(node)
        }
        "entity_ref" => Err("body supports only text nodes on create_journal_entry".to_string()),
        _ if body_policy != BodyNodePolicy::TextOnly => {
            Err("body node type must be text or entity_ref".to_string())
        }
        _ => Err("body supports only text nodes on create_journal_entry".to_string()),
    }
}

fn validate_text_body_node(node: &serde_json::Map<String, Value>) -> Result<(), String> {
    required_body_node_string(node, &["type", "text"], "text", "body text")?;
    Ok(())
}

fn validate_entity_ref_body_node(node: &serde_json::Map<String, Value>) -> Result<(), String> {
    let ref_id =
        required_body_node_string(node, &["type", "ref_id"], "ref_id", "entity_ref ref_id")?;
    Uuid::parse_str(ref_id).map_err(|_| "entity_ref ref_id must be a UUID".to_string())?;
    Ok(())
}

fn validate_new_entity_ref_body_node(node: &serde_json::Map<String, Value>) -> Result<(), String> {
    for key in node.keys() {
        if key != "type" {
            return Err(format!("unsupported body node field {key:?}"));
        }
    }
    Ok(())
}

fn required_body_node_string<'a>(
    node: &'a serde_json::Map<String, Value>,
    allowed_keys: &[&str],
    field: &str,
    label: &str,
) -> Result<&'a str, String> {
    for key in node.keys() {
        if !allowed_keys.contains(&key.as_str()) {
            return Err(format!("unsupported body node field {key:?}"));
        }
    }
    match node.get(field) {
        Some(Value::String(value)) if !value.trim().is_empty() => Ok(value),
        Some(Value::String(_)) => Err(format!("{label} must not be empty")),
        Some(_) => Err(format!("{label} must be a string")),
        None => Err(format!("{label} is required")),
    }
}

fn validate_update_journal_entry(payload: &Value) -> Result<(), String> {
    // Flat shell (entity_id target + occurred_at/ended_at + body-union schema)
    // from the single source; the cross-field invariants are the hook. The body
    // policy admits an `entity_ref` carrying a `ref_id`.
    MutationKind::UpdateJournalEntry
        .payload_spec()
        .check(payload)?;
    validate_journal_body_and_times(payload, BodyNodePolicy::TextOrExistingEntityRef)
}

fn validate_reference_existing_entity_from_journal_entry(payload: &Value) -> Result<(), String> {
    // Flat shell (source/target UUIDs, optional label_snapshot, body-union schema)
    // from the single source; the body content + exactly-one-entity_ref invariant
    // are the hook.
    MutationKind::ReferenceExistingEntityFromJournalEntry
        .payload_spec()
        .check(payload)?;
    let obj = payload.as_object().expect("check accepted an object");

    validate_journal_body(obj, BodyNodePolicy::TextOrNewEntityRef)?;

    let body = obj
        .get("body")
        .and_then(Value::as_array)
        .expect("body validated");
    let ref_count = body
        .iter()
        .filter(|node| node.get("type").and_then(Value::as_str) == Some("entity_ref"))
        .count();
    if ref_count != 1 {
        return Err("body must contain exactly one entity_ref node".to_string());
    }

    Ok(())
}

pub(crate) fn reference_existing_entity_data_payload(
    current_data: &Value,
    payload: &Value,
    ref_id: &str,
) -> Value {
    let mut data = current_data.as_object().cloned().unwrap_or_default();
    let Some(obj) = payload.as_object() else {
        return Value::Object(data);
    };

    let body = obj
        .get("body")
        .and_then(Value::as_array)
        .map(|nodes| {
            nodes
                .iter()
                .map(|node| {
                    if node.get("type").and_then(Value::as_str) == Some("entity_ref") {
                        serde_json::json!({ "type": "entity_ref", "ref_id": ref_id })
                    } else {
                        node.clone()
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    data.insert("body".to_string(), Value::Array(body));

    Value::Object(data)
}

pub(crate) fn body_entity_ref_ids(payload: &Value) -> Vec<&str> {
    payload
        .get("body")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|node| node.get("type").and_then(Value::as_str) == Some("entity_ref"))
        .filter_map(|node| node.get("ref_id").and_then(Value::as_str))
        .collect()
}

/// Validate an `{entity_id}`-only payload (the deletes + `mark_project_reviewed`)
/// against the kind's id-only spec: a single required UUID `entity_id` and no
/// other field. A delete carries no entity data, so the spec is the whole schema.
fn validate_entity_id_only(kind: MutationKind, payload: &Value) -> Result<(), String> {
    kind.payload_spec().check(payload)
}

#[cfg(test)]
fn validate_person(payload: &Value) -> Result<(), String> {
    // PersonData has no cross-field invariant — the spec walk is the whole
    // validator. `note`/`aliases` are clearable optional fields (ADR-0033): a
    // `null` value is the sentinel-clear directive (the apply path drops the key),
    // accepted by the clearable string / nullable-array specs.
    MutationKind::CreatePerson
        .payload_data_spec()
        .check(payload)
}

/// Validate an `update_person` payload against the kind's full spec: the
/// `entity_id` target prepended to the `PersonData` core (the single source).
/// PersonData has no cross-field invariant, so the spec walk is the whole
/// validator.
fn validate_update_person(payload: &Value) -> Result<(), String> {
    MutationKind::UpdatePerson.payload_spec().check(payload)
}

/// Validate a `BookmarkData` object (ADR-0036): a required non-empty `title`;
/// clearable string `url`/`note`; clearable `tags` (an array of non-empty strings).
/// BookmarkData has no cross-field invariant — the spec walk is the whole
/// validator. Each optional field is CLEARABLE: a `null` value is the ADR-0033
/// sentinel-clear directive (accepted; the apply path drops null keys).
fn validate_bookmark(payload: &Value) -> Result<(), String> {
    MutationKind::CreateBookmark
        .payload_data_spec()
        .check(payload)
}

/// Validate an `update_bookmark` payload against the kind's full spec: the
/// `entity_id` target prepended to the `BookmarkData` core (the single source).
/// Update is a full-document replace (like person/project), so the data is a
/// complete BookmarkData (ADR-0036); it has no cross-field invariant, so the
/// spec walk is the whole validator.
fn validate_update_bookmark(payload: &Value) -> Result<(), String> {
    MutationKind::UpdateBookmark.payload_spec().check(payload)
}

#[cfg(test)]
fn validate_project(payload: &Value) -> Result<(), String> {
    validate_project_data(payload)
}

/// Validate a complete Project `data` object against the Project schema (ADR-0031).
/// Shared by the create validator and the `mark_project_reviewed` apply path,
/// which re-validates the recomputed whole before persisting it (ADR-0034).
pub(crate) fn validate_project_data(payload: &Value) -> Result<(), String> {
    // Flat shape (fields, types, the status enum, datetime parse, review_every
    // sub-object) from the single source; the status↔timestamp invariant — which
    // a flat walk cannot express — stays a hand-written hook.
    MutationKind::CreateProject
        .payload_data_spec()
        .check(payload)?;
    project_status_timestamp_invariant(payload.as_object().expect("check accepted an object"))
}

/// The Project status↔timestamp invariant (ADR-0031): completed requires
/// `completed_at` and forbids `dropped_at`; dropped is the mirror; active/on_hold
/// forbid both. An absent status defaults to active. A `null` timestamp is the
/// ADR-0033 clear directive, so it counts as ABSENT here ([`present_non_null`]) —
/// distinct from the Todo invariant, which treats a (already-rejected) null as
/// present.
fn project_status_timestamp_invariant(obj: &serde_json::Map<String, Value>) -> Result<(), String> {
    let status = obj
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("active");
    let has_completed_at = present_non_null(obj, "completed_at");
    let has_dropped_at = present_non_null(obj, "dropped_at");
    match status {
        "active" | "on_hold" => {
            if has_completed_at {
                return Err(format!("{status} project must not have completed_at"));
            }
            if has_dropped_at {
                return Err(format!("{status} project must not have dropped_at"));
            }
        }
        "completed" => {
            if !has_completed_at {
                return Err("completed project requires completed_at".to_string());
            }
            if has_dropped_at {
                return Err("completed project must not have dropped_at".to_string());
            }
        }
        "dropped" => {
            if !has_dropped_at {
                return Err("dropped project requires dropped_at".to_string());
            }
            if has_completed_at {
                return Err("dropped project must not have completed_at".to_string());
            }
        }
        _ => unreachable!("status validated by the spec"),
    }
    Ok(())
}

/// Whether `key` is present in `obj` with a non-`null` value. A `null` value is
/// the sentinel-clear directive (ADR-0033), so it counts as absent for the
/// status↔timestamp invariants (the apply path drops null keys from stored data).
fn present_non_null(obj: &serde_json::Map<String, Value>, key: &str) -> bool {
    matches!(obj.get(key), Some(v) if !v.is_null())
}

/// Validate an `update_project` payload against the kind's full spec: the
/// `entity_id` target prepended to the `ProjectData` core (the single source),
/// then the status↔timestamp invariant — same hook order as create dispatch and
/// [`validate_project_data`]. The spec tolerates an absent status, which is fine
/// for an update (status optional on update).
fn validate_update_project(payload: &Value) -> Result<(), String> {
    MutationKind::UpdateProject.payload_spec().check(payload)?;
    project_status_timestamp_invariant(payload.as_object().expect("check accepted an object"))
}

/// The optional `source_journal_entry_id` provenance directive (ADR-0030/0031) on
/// a `create_{person,project,todo}` payload, read from the top level (the
/// person/project payload, or the todo envelope). When present, the accept path
/// sources the new Entity `created_from` this Journal Entry rather than the user
/// Message. Decide verifies it names an actual Journal Entry.
pub(crate) fn source_journal_entry_id(payload: &Value) -> Option<&str> {
    payload
        .get("source_journal_entry_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
}

/// Validate a Todo's `recurrence` rule in ISOLATION (ADR-0037): every invariant
/// that needs only the rule itself. The cross-field `anchor` presence check —
/// the Todo must carry the date field the `anchor` names — needs the whole Todo
/// and lives in [`validate_todo_data`], not here.
fn validate_recurrence(value: &Value) -> Result<(), String> {
    let obj = value
        .as_object()
        .ok_or_else(|| "recurrence must be an object".to_string())?;

    for key in obj.keys() {
        match key.as_str() {
            "interval" | "unit" | "anchor" | "end" => {}
            other => return Err(format!("unsupported recurrence field {other:?}")),
        }
    }

    match obj.get("interval") {
        Some(Value::Number(n)) => match n.as_u64() {
            Some(interval) if interval >= 1 => {}
            _ => return Err("recurrence interval must be a positive integer".to_string()),
        },
        Some(_) => return Err("recurrence interval must be a positive integer".to_string()),
        None => return Err("recurrence interval is required".to_string()),
    }

    match obj.get("unit") {
        Some(Value::String(unit)) => match unit.as_str() {
            "minute" | "hour" | "day" | "week" | "month" | "year" => {}
            _ => {
                return Err(
                    "recurrence unit must be one of minute, hour, day, week, month, year"
                        .to_string(),
                );
            }
        },
        Some(_) => return Err("recurrence unit must be a string".to_string()),
        None => return Err("recurrence unit is required".to_string()),
    };

    match obj.get("anchor") {
        Some(Value::String(anchor)) => match anchor.as_str() {
            "defer_at" | "due_at" => {}
            _ => return Err("recurrence anchor must be one of defer_at, due_at".to_string()),
        },
        Some(_) => return Err("recurrence anchor must be a string".to_string()),
        None => return Err("recurrence anchor is required".to_string()),
    }

    if let Some(end) = obj.get("end") {
        validate_recurrence_end(end)?;
    }

    Ok(())
}

/// Validate `recurrence.end` (ADR-0037): a non-empty object carrying at most one
/// of `until` (a parseable `YYYY-MM-DDTHH:MM:SS` wall clock) or `after_count`
/// (an integer `>= 1`).
fn validate_recurrence_end(value: &Value) -> Result<(), String> {
    let obj = value
        .as_object()
        .ok_or_else(|| "recurrence end must be an object".to_string())?;

    for key in obj.keys() {
        match key.as_str() {
            "until" | "after_count" => {}
            other => return Err(format!("unsupported recurrence end field {other:?}")),
        }
    }

    let has_until = obj.contains_key("until");
    let has_after_count = obj.contains_key("after_count");
    if !has_until && !has_after_count {
        return Err("recurrence end must carry until or after_count".to_string());
    }
    if has_until && has_after_count {
        return Err("recurrence end must carry at most one of until, after_count".to_string());
    }

    if let Some(until) = obj.get("until") {
        match until {
            Value::String(t) if !t.trim().is_empty() => {
                parse_local_datetime(t, "recurrence end until")?;
            }
            Value::String(_) => return Err("recurrence end until must not be empty".to_string()),
            _ => return Err("recurrence end until must be a string".to_string()),
        }
    }

    if let Some(after_count) = obj.get("after_count") {
        match after_count {
            Value::Number(n) => match n.as_u64() {
                Some(count) if count >= 1 => {}
                _ => {
                    return Err("recurrence end after_count must be a positive integer".to_string());
                }
            },
            _ => return Err("recurrence end after_count must be a positive integer".to_string()),
        }
    }

    Ok(())
}

/// Validate a `create_todo` payload: an ENVELOPE `{todo: TodoData, person_refs?}`
/// (ADR-0031). `todo` is required and validated as `TodoData`; `person_refs`, when
/// present, must be an array of refs, each an object with a required non-empty
/// `person_id` and an optional `role` ∈ {waiting_on, related} (a missing role
/// defaults to `related` at apply-time). Any other top-level key is rejected.
/// `person_id` existence (an Accepted Person) is checked at decide-time, not here.
fn validate_todo(payload: &Value) -> Result<(), String> {
    // Envelope shape (`{todo, person_refs?, source_journal_entry_id?}`) from the
    // single source — including the person_refs element shape, now spec-driven —
    // then the TodoData hook validates the `todo` value (its cross-field
    // invariants exceed a flat walk).
    MutationKind::CreateTodo.payload_spec().check(payload)?;
    let obj = payload.as_object().expect("check accepted an object");
    let todo = obj
        .get("todo")
        .ok_or_else(|| "todo is required".to_string())?;
    validate_todo_data(todo)
}

/// Validate the `TodoData` sub-object (ADR-0031): a required non-empty `title`;
/// optional string `note`/`project_id` (`project_id` existence is checked at
/// decide-time, not here); an optional `status` ∈ {active, completed, dropped}
/// defaulting to active when absent (Todo has NO `on_hold`); concrete
/// `defer_at`/`due_at`/`completed_at`/`dropped_at` timestamps; and the
/// status↔timestamp invariants. Any other field is rejected. `pub(crate)` so the
/// apply path can re-validate a MERGED `update_todo` result as a whole.
pub(crate) fn validate_todo_data(payload: &Value) -> Result<(), String> {
    // Flat shape (fields, title, note, project_id, status enum, datetime parse)
    // from the single source; the status↔timestamp + recurrence (rule-in-isolation
    // and anchor-presence) invariants — which exceed a flat walk — stay hooks.
    todo_data_spec(Mode::Full).check(payload)?;
    let obj = payload.as_object().expect("check accepted an object");
    todo_status_timestamp_invariant(obj)?;
    todo_recurrence_invariant(obj)
}

/// The Todo status↔timestamp invariant (ADR-0031): completed requires
/// `completed_at` and forbids `dropped_at`; dropped is the mirror; active forbids
/// both. Absent status defaults to active. Unlike Project, Todo timestamps reject
/// `null` (the spec already did), so a present key is a concrete timestamp —
/// hence `contains_key`, not `present_non_null`.
fn todo_status_timestamp_invariant(obj: &serde_json::Map<String, Value>) -> Result<(), String> {
    let status = obj
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("active");
    let has_completed_at = obj.contains_key("completed_at");
    let has_dropped_at = obj.contains_key("dropped_at");
    match status {
        "active" => {
            if has_completed_at {
                return Err("active todo must not have completed_at".to_string());
            }
            if has_dropped_at {
                return Err("active todo must not have dropped_at".to_string());
            }
        }
        "completed" => {
            if !has_completed_at {
                return Err("completed todo requires completed_at".to_string());
            }
            if has_dropped_at {
                return Err("completed todo must not have dropped_at".to_string());
            }
        }
        "dropped" => {
            if !has_dropped_at {
                return Err("dropped todo requires dropped_at".to_string());
            }
            if has_completed_at {
                return Err("dropped todo must not have completed_at".to_string());
            }
        }
        _ => unreachable!("status validated by the spec"),
    }
    Ok(())
}

/// The Todo `recurrence` invariant (ADR-0037): validate the rule in isolation
/// (the `HookValidated` spec leaves it to us), then enforce anchor-presence — the
/// Todo must carry a non-empty date at the field the rule's `anchor` names. Holds
/// for any valid stored Todo, so the apply-time re-validation of a merged
/// `update_todo` enforces it too.
fn todo_recurrence_invariant(obj: &serde_json::Map<String, Value>) -> Result<(), String> {
    if let Some(recurrence) = obj.get("recurrence") {
        validate_recurrence(recurrence)?;
        if let Some(Value::String(anchor)) = recurrence.get("anchor") {
            let present =
                matches!(obj.get(anchor.as_str()), Some(Value::String(t)) if !t.trim().is_empty());
            if !present {
                return Err(format!(
                    "recurrence anchor {anchor:?} requires the todo to have {anchor}"
                ));
            }
        }
    }
    Ok(())
}

/// Validate an `update_todo` envelope (ADR-0031): a required UUID `todo_id` (the
/// TARGET key, NOT `entity_id`); an optional `todo` Partial<TodoData> whose keys
/// are a SUBSET of TodoData fields with each SUPPLIED field individually valid
/// (title if present non-empty; status if present ∈ {active, completed, dropped};
/// timestamps parseable) — the status↔timestamp invariants are NOT enforced here
/// because the pure validator lacks the current Todo state; the apply path
/// re-validates the MERGED whole via [`validate_todo_data`]. Optional
/// `set_person_refs`/`add_person_refs` (each a ref array) and `remove_person_ids`
/// (an array of non-empty strings). Any other top-level key is rejected.
fn validate_update_todo(payload: &Value) -> Result<(), String> {
    // Envelope shape (`todo_id`, set/add `person_refs`, `remove_person_ids`) from
    // the single source; the partial `todo` value's recurrence rule (a non-null
    // value validated in isolation) is the one cross-field bit the spec defers.
    MutationKind::UpdateTodo.payload_spec().check(payload)?;
    let obj = payload.as_object().expect("check accepted an object");
    if let Some(todo) = obj.get("todo") {
        validate_partial_todo_data(todo)?;
    }
    Ok(())
}

/// Validate a `Partial<TodoData>` (ADR-0031, ADR-0033): each SUPPLIED key must be
/// a TodoData field and individually valid (title non-empty; status enum;
/// note/project_id strings; timestamps parseable). No field is required and the
/// status↔timestamp invariants are deferred to the apply-time re-validation of
/// the merged whole, so a partial that supplies only `status` or only a
/// timestamp is accepted here. A `null` value on a CLEARABLE optional field
/// (`note`, `project_id`, `defer_at`, `due_at`, `completed_at`, `dropped_at`) is
/// the sentinel-clear directive — accepted here and translated to remove-the-key
/// by the apply-time merge. `null` on the required, non-clearable `title`/`status`
/// stays rejected (clearing them is meaningless).
fn validate_partial_todo_data(payload: &Value) -> Result<(), String> {
    // Flat partial shape from the single source (Mode::Partial: every field
    // optional; `note`/`project_id`/timestamps/`recurrence` clearable via `null`;
    // `title`/`status` optional-but-not-clearable). The recurrence rule, when a
    // non-null value is supplied, is validated in isolation here — the
    // anchor-presence cross-check is NOT done (a partial lacks the whole Todo; the
    // apply-time re-validation of the merged whole enforces it).
    todo_data_spec(Mode::Partial).check(payload)?;
    let obj = payload.as_object().expect("check accepted an object");
    match obj.get("recurrence") {
        Some(Value::Null) | None => Ok(()),
        Some(recurrence) => validate_recurrence(recurrence),
    }
}

pub(crate) fn parse_local_datetime(
    value: &str,
    field: &str,
) -> Result<(u32, u32, u32, u32, u32, u32), String> {
    let bytes = value.as_bytes();
    if bytes.len() != 19
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return Err(format!("{field} must use YYYY-MM-DDTHH:MM:SS"));
    }

    let year = parse_digits(value, 0, 4, field)?;
    let month = parse_digits(value, 5, 7, field)?;
    let day = parse_digits(value, 8, 10, field)?;
    let hour = parse_digits(value, 11, 13, field)?;
    let minute = parse_digits(value, 14, 16, field)?;
    let second = parse_digits(value, 17, 19, field)?;

    if month == 0 || month > 12 {
        return Err(format!("{field} month must be between 01 and 12"));
    }
    let max_day = days_in_month(year, month);
    if day == 0 || day > max_day {
        return Err(format!("{field} day must be valid for its month"));
    }
    if hour > 23 {
        return Err(format!("{field} hour must be between 00 and 23"));
    }
    if minute > 59 {
        return Err(format!("{field} minute must be between 00 and 59"));
    }
    if second > 59 {
        return Err(format!("{field} second must be between 00 and 59"));
    }

    Ok((year, month, day, hour, minute, second))
}

fn parse_digits(value: &str, start: usize, end: usize, field: &str) -> Result<u32, String> {
    let part = &value[start..end];
    if !part.as_bytes().iter().all(u8::is_ascii_digit) {
        return Err(format!("{field} must use YYYY-MM-DDTHH:MM:SS"));
    }
    part.parse::<u32>()
        .map_err(|_| format!("{field} must use YYYY-MM-DDTHH:MM:SS"))
}

/// The number of days in a civil month (proleptic Gregorian), `0` for an
/// out-of-range month. `pub(crate)` so the recurrence date math (ADR-0039) can
/// clamp a month/year advance to the target month's last valid day.
pub(crate) fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn is_leap_year(year: u32) -> bool {
    (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400)
}

/// Decompose an epoch-ms instant into a local (review-anchor) wall clock as
/// `(days_since_1970, secs_of_day)`. `offset_minutes` shifts UTC to the anchor
/// local clock. `div_euclid`/`rem_euclid` floor toward negative infinity, so
/// `secs_of_day` stays in `[0, 86399]` even for pre-1970 instants. Shared by the
/// review-date helpers and [`now_local`] so they decompose time identically.
fn local_day_and_secs(now_ms: i64, offset_minutes: i64) -> (i64, i64) {
    let local_secs = (now_ms + offset_minutes * 60_000).div_euclid(1000);
    (local_secs.div_euclid(86_400), local_secs.rem_euclid(86_400))
}

/// The Sunday-20:00 review anchor at or after the given local day, formatted
/// `YYYY-MM-DDTHH:MM:SS` (ADR-0031), used to SEED a new active Project's first
/// review. A Sunday strictly before 20:00 resolves to the SAME day (a new
/// Project should not wait up to a week for its first review); at or after 20:00
/// it rolls to the following Sunday. NOT for advancing after a review — that
/// must always move strictly forward (see [`advance_review_at_local`], ADR-0034).
pub(crate) fn next_review_at_local(now_ms: i64, offset_minutes: i64) -> String {
    let (days, secs_of_day) = local_day_and_secs(now_ms, offset_minutes);
    // 1970-01-01 is a Thursday; with Sunday=0 that is weekday 4.
    let weekday = (days.rem_euclid(7) + 4).rem_euclid(7);
    let delta = if weekday == 0 && secs_of_day < 20 * 3_600 {
        0
    } else if weekday == 0 {
        7
    } else {
        7 - weekday
    };
    sunday_anchor(days + delta)
}

/// The NEXT Sunday-20:00 review anchor strictly after the given instant (ADR-0034),
/// used to ADVANCE `next_review_at` when a Project is marked reviewed. Unlike
/// [`next_review_at_local`] (which seeds to the *same* Sunday before 20:00), this
/// always rolls forward: reviewing on a Sunday — at any time — schedules the
/// FOLLOWING Sunday, so a just-reviewed Project never re-enters the Review view
/// the same day. Every non-Sunday day lands on the coming Sunday.
pub(crate) fn advance_review_at_local(now_ms: i64, offset_minutes: i64) -> String {
    let (days, _) = local_day_and_secs(now_ms, offset_minutes);
    let weekday = (days.rem_euclid(7) + 4).rem_euclid(7);
    // Today-if-Sunday counts as a full week out (delta 7), so the next review is
    // always a strictly-future Sunday regardless of the review time of day.
    let delta = if weekday == 0 { 7 } else { 7 - weekday };
    sunday_anchor(days + delta)
}

/// Format a day-count (days since 1970-01-01) as the `…T20:00:00` Sunday review
/// anchor. The caller guarantees `day` lands on a Sunday.
fn sunday_anchor(day: i64) -> String {
    let (year, month, day) = civil_from_days(day);
    format!("{year:04}-{month:02}-{day:02}T20:00:00")
}

/// The current instant as a local wall-clock `YYYY-MM-DDTHH:MM:SS` (ADR-0034),
/// used to stamp `last_reviewed_at` when a Project is marked reviewed. `now_ms`
/// is epoch milliseconds (UTC); `offset_minutes` shifts it to the review-anchor
/// local wall clock, the same anchor the review-date helpers use, so the stamped
/// "last reviewed" and computed "next review" share one clock.
pub(crate) fn now_local(now_ms: i64, offset_minutes: i64) -> String {
    let (days, secs_of_day) = local_day_and_secs(now_ms, offset_minutes);
    let (year, month, day) = civil_from_days(days);
    format_local_datetime(
        year,
        month,
        day,
        (secs_of_day / 3_600) as u32,
        ((secs_of_day % 3_600) / 60) as u32,
        (secs_of_day % 60) as u32,
    )
}

/// Format a civil date + time as the `YYYY-MM-DDTHH:MM:SS` wall-clock string —
/// the one owner of the wall-clock format used by [`now_local`] and the
/// recurrence date math (ADR-0039). `pub(crate)` so the recurrence module shares
/// this string rather than re-deriving it.
pub(crate) fn format_local_datetime(
    year: i64,
    month: i64,
    day: i64,
    hour: u32,
    minute: u32,
    second: u32,
) -> String {
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}")
}

/// Civil (year, month, day) for a count of days since 1970-01-01, proleptic
/// Gregorian (Howard Hinnant's `civil_from_days`). `pub(crate)` so the recurrence
/// date math (ADR-0039) shares one civil calendar with the review-date helpers.
pub(crate) fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (y + if m <= 2 { 1 } else { 0 }, m, d)
}

/// Days since 1970-01-01 for a civil (year, month, day), proleptic Gregorian
/// (Howard Hinnant's `days_from_civil`); the inverse of [`civil_from_days`].
/// `pub(crate)` so the recurrence date math (ADR-0039) can convert a clamped
/// civil date back to a day count for the day/week advance.
pub(crate) fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = year - if month <= 2 { 1 } else { 0 };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

// ─── Derived GTD facets (ADR-0031) ─────────────────────────────────────────
//
// Pure predicates over a Todo's already-loaded fields — no DB, no ambient clock
// (`now`/`horizon` are caller-supplied). Timestamps are compared as STRINGS: the
// `YYYY-MM-DDTHH:MM:SS` wall-clock format sorts lexicographically exactly as it
// sorts chronologically (fixed-width, zero-padded, most-significant-first), so
// `defer_at <= Some(now)` is a correct chronological test. `status` is the Todo's
// stored value (`"active"` | `"completed"` | `"dropped"`). The ref-dependent
// facets (`is_waiting`, `is_inbox_todo`) take booleans the caller derives from
// `person_refs_by_todo`, keeping these trivially unit-testable. Core-internal in
// V0 (V1 wires them to client APIs), hence `#[allow(dead_code)]`.

/// Whether an active Todo is available now: active and either has no `defer_at`
/// or it is at-or-before `now` (ADR-0031).
#[allow(dead_code)]
pub fn is_available(status: &str, defer_at: Option<&str>, now: &str) -> bool {
    status == "active" && (defer_at.is_none() || defer_at <= Some(now))
}

/// Whether an active Todo is overdue: active with a `due_at` strictly before
/// `now` (ADR-0031).
#[allow(dead_code)]
pub fn is_overdue(status: &str, due_at: Option<&str>, now: &str) -> bool {
    status == "active" && due_at.is_some_and(|d| d < now)
}

/// Whether an active Todo is due soon: active with a `due_at` at-or-before
/// `horizon` (ADR-0031).
#[allow(dead_code)]
pub fn is_due_soon(status: &str, due_at: Option<&str>, horizon: &str) -> bool {
    status == "active" && due_at.is_some_and(|d| d <= horizon)
}

/// Whether an active Todo is in a waiting/follow-up perspective: active with at
/// least one `waiting_on` Todo Person Reference (ADR-0031). `waiting_on` does not
/// change availability.
#[allow(dead_code)]
pub fn is_waiting(status: &str, has_waiting_ref: bool) -> bool {
    status == "active" && has_waiting_ref
}

/// Whether an active Todo falls in the derived Inbox: active with no project, no
/// due date, and no Todo Person References (ADR-0031).
#[allow(dead_code)]
pub fn is_inbox_todo(status: &str, has_project: bool, has_due: bool, has_any_ref: bool) -> bool {
    status == "active" && !has_project && !has_due && !has_any_ref
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mutation::{BOOKMARK_SCHEMA_VERSION, JOURNAL_ENTRY_SCHEMA_VERSION};
    use serde_json::json;

    /// Test shim: validate by wire string, mirroring the pre-refactor
    /// `validate(&str, _)` signature so the schema tests stay string-driven. An
    /// unknown kind is the from_wire-None case the edge maps to Invalid; here it
    /// surfaces as the same "not supported" reason the old `_` arm returned.
    fn validate(kind: &str, payload: &Value) -> Result<(), String> {
        match MutationKind::from_wire(kind) {
            Some(k) => super::validate(k, payload),
            None => Err(format!("mutation_kind {kind:?} not supported")),
        }
    }

    /// Test shim: render the accept text by wire string (the kind must be
    /// agent-proposable, as only those reach `render_accept`).
    fn render_accept(kind: &str, payload: &Value) -> String {
        let kind = MutationKind::from_wire(kind).expect("known mutation_kind");
        let proposable = ProposableMutation::try_from(kind).expect("agent-proposable kind");
        super::render_accept(proposable, payload, Some("test-entity-id"))
    }

    /// Test shim: the schema version for a wire kind, via its Entity Type — the
    /// pre-refactor `schema_version(&str)` the version tests assert against.
    fn schema_version(kind: &str) -> i64 {
        MutationKind::from_wire(kind)
            .expect("known mutation_kind")
            .describe()
            .entity_type
            .schema_version()
    }

    // ─── derived predicates (Slice 11, ADR-0031 "Derived Facets") ──────────

    #[test]
    fn buy_milk_todo_is_inbox() {
        // active, no project, no due, no person refs → Inbox.
        assert!(is_inbox_todo("active", false, false, false));
    }

    #[test]
    fn due_or_project_or_ref_leaves_inbox() {
        assert!(!is_inbox_todo("active", false, true, false), "a due date");
        assert!(!is_inbox_todo("active", true, false, false), "a project");
        assert!(!is_inbox_todo("active", false, false, true), "a person ref");
    }

    #[test]
    fn non_active_is_never_inbox() {
        assert!(!is_inbox_todo("completed", false, false, false));
        assert!(!is_inbox_todo("dropped", false, false, false));
    }

    #[test]
    fn waiting_ref_is_waiting_but_does_not_change_availability() {
        // A waiting_on ref makes the Todo "waiting" but, with no future defer, it
        // is still available (ADR-0031: waiting_on does not change availability).
        assert!(is_waiting("active", true));
        assert!(!is_waiting("active", false));
        assert!(is_available("active", None, "2026-06-12T00:00:00"));
    }

    #[test]
    fn non_active_is_never_waiting() {
        assert!(!is_waiting("completed", true));
        assert!(!is_waiting("dropped", true));
    }

    #[test]
    fn future_defer_is_not_available_else_available() {
        let now = "2026-06-12T00:00:00";
        assert!(
            !is_available("active", Some("2026-06-13T00:00:00"), now),
            "defer in the future"
        );
        assert!(
            is_available("active", Some("2026-06-12T00:00:00"), now),
            "defer at now is available"
        );
        assert!(
            is_available("active", Some("2026-06-11T00:00:00"), now),
            "defer in the past"
        );
        assert!(is_available("active", None, now), "no defer is available");
    }

    #[test]
    fn completed_or_dropped_is_never_available() {
        let now = "2026-06-12T00:00:00";
        assert!(!is_available("completed", None, now));
        assert!(!is_available("dropped", None, now));
    }

    #[test]
    fn overdue_is_active_and_due_strictly_before_now() {
        let now = "2026-06-12T00:00:00";
        assert!(is_overdue("active", Some("2026-06-11T23:59:59"), now));
        assert!(
            !is_overdue("active", Some("2026-06-12T00:00:00"), now),
            "due == now is not overdue"
        );
        assert!(!is_overdue("active", Some("2026-06-13T00:00:00"), now));
        assert!(
            !is_overdue("active", None, now),
            "no due date is never overdue"
        );
        assert!(!is_overdue("completed", Some("2026-06-11T00:00:00"), now));
        assert!(!is_overdue("dropped", Some("2026-06-11T00:00:00"), now));
    }

    #[test]
    fn due_soon_is_active_and_due_at_or_before_horizon() {
        let horizon = "2026-06-15T00:00:00";
        assert!(is_due_soon("active", Some("2026-06-14T00:00:00"), horizon));
        assert!(
            is_due_soon("active", Some("2026-06-15T00:00:00"), horizon),
            "due == horizon is due soon"
        );
        assert!(!is_due_soon("active", Some("2026-06-16T00:00:00"), horizon));
        assert!(
            !is_due_soon("active", None, horizon),
            "no due date is not due soon"
        );
        assert!(!is_due_soon(
            "completed",
            Some("2026-06-14T00:00:00"),
            horizon
        ));
        assert!(!is_due_soon(
            "dropped",
            Some("2026-06-14T00:00:00"),
            horizon
        ));
    }

    #[test]
    fn accepts_minimal_journal_entry() {
        assert!(validate_journal_entry(&json!({
            "occurred_at": "2026-06-10T10:30:00",
            "body": [{ "type": "text", "text": "Talked to Alice." }]
        }))
        .is_ok());
    }

    #[test]
    fn accepts_equal_or_later_ended_at() {
        assert!(validate_journal_entry(&json!({
            "occurred_at": "2026-06-10T10:30:00",
            "ended_at": "2026-06-10T10:30:00",
            "body": [{ "type": "text", "text": "Talked to Alice." }]
        }))
        .is_ok());
        assert!(validate_journal_entry(&json!({
            "occurred_at": "2026-06-10T10:30:00",
            "ended_at": "2026-06-10T11:00:00",
            "body": [{ "type": "text", "text": "Talked to Alice." }]
        }))
        .is_ok());
    }

    #[test]
    fn rejects_missing_or_empty_occurred_at() {
        assert!(
            validate_journal_entry(&json!({ "body": [{ "type": "text", "text": "x" }] })).is_err()
        );
        assert!(validate_journal_entry(
            &json!({ "occurred_at": "", "body": [{ "type": "text", "text": "x" }] })
        )
        .is_err());
    }

    #[test]
    fn rejects_invalid_or_reversed_times() {
        let reason = validate_journal_entry(&json!({
            "occurred_at": "banana",
            "body": [{ "type": "text", "text": "Talked to Alice." }]
        }))
        .expect_err("occurred_at must be parseable");
        assert!(
            reason.contains("occurred_at"),
            "reason names occurred_at: {reason}"
        );

        let reason = validate_journal_entry(&json!({
            "occurred_at": "2026-06-10T10:30:00",
            "ended_at": "2026-06-10T10:29:59",
            "body": [{ "type": "text", "text": "Talked to Alice." }]
        }))
        .expect_err("ended_at cannot be before occurred_at");
        assert!(
            reason.contains("ended_at"),
            "reason names ended_at: {reason}"
        );
    }

    #[test]
    fn rejects_unknown_fields() {
        let reason = validate_journal_entry(&json!({
            "occurred_at": "2026-06-10T10:30:00",
            "body": [{ "type": "text", "text": "Talked to Alice." }],
            "status": "draft"
        }))
        .expect_err("unknown payload fields are not part of the first slice");
        assert!(
            reason.contains("status"),
            "reason names the unsupported field: {reason}"
        );
    }

    #[test]
    fn rejects_non_text_body_nodes() {
        let reason = validate_journal_entry(&json!({
            "occurred_at": "2026-06-10T10:30:00",
            "body": [{ "type": "entity_ref" }]
        }))
        .expect_err("fresh Journal Entry creates cannot include entity_ref nodes");
        assert!(
            reason.contains("text nodes"),
            "reason names text-only body: {reason}"
        );
    }

    #[test]
    fn update_accepts_mixed_text_and_entity_ref_body_nodes() {
        assert!(validate(
            "update_journal_entry",
            &json!({
                "entity_id": Uuid::now_v7().to_string(),
                "occurred_at": "2026-06-10T10:30:00",
                "body": [
                    { "type": "text", "text": "Met " },
                    { "type": "entity_ref", "ref_id": Uuid::now_v7().to_string() },
                    { "type": "text", "text": " at school." }
                ]
            })
        )
        .is_ok());
    }

    #[test]
    fn update_rejects_entity_ref_nodes_without_ref_id() {
        let reason = validate(
            "update_journal_entry",
            &json!({
                "entity_id": Uuid::now_v7().to_string(),
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "entity_ref" }]
            }),
        )
        .expect_err("entity_ref nodes require ref_id");
        assert!(
            reason.contains("ref_id"),
            "reason names missing ref_id: {reason}"
        );

        let reason = validate(
            "update_journal_entry",
            &json!({
                "entity_id": Uuid::now_v7().to_string(),
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "entity_ref", "ref_id": "  " }]
            }),
        )
        .expect_err("entity_ref ref_id cannot be empty");
        assert!(
            reason.contains("ref_id"),
            "reason names empty ref_id: {reason}"
        );
    }

    #[test]
    fn update_rejects_entity_ref_nodes_with_malformed_ref_id() {
        let reason = validate(
            "update_journal_entry",
            &json!({
                "entity_id": Uuid::now_v7().to_string(),
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "entity_ref", "ref_id": "not-a-uuid" }]
            }),
        )
        .expect_err("entity_ref ref_id must be a UUID");
        assert!(
            reason.contains("UUID"),
            "reason names malformed ref_id: {reason}"
        );
    }

    #[test]
    fn reference_existing_entity_accepts_one_new_entity_ref_placeholder() {
        assert!(validate(
            "reference_existing_entity_from_journal_entry",
            &json!({
                "source_entity_id": Uuid::now_v7().to_string(),
                "target_entity_id": Uuid::now_v7().to_string(),
                "label_snapshot": "Ada",
                "body": [
                    { "type": "text", "text": "Met " },
                    { "type": "entity_ref" },
                    { "type": "text", "text": " at school." }
                ]
            })
        )
        .is_ok());
    }

    #[test]
    fn reference_existing_entity_rejects_missing_or_multiple_placeholders() {
        let reason = validate(
            "reference_existing_entity_from_journal_entry",
            &json!({
                "source_entity_id": Uuid::now_v7().to_string(),
                "target_entity_id": Uuid::now_v7().to_string(),
                "body": [{ "type": "text", "text": "Met Ada." }]
            }),
        )
        .expect_err("reference mutation needs one placeholder");
        assert!(
            reason.contains("exactly one entity_ref"),
            "reason names the placeholder count: {reason}"
        );

        let reason = validate(
            "reference_existing_entity_from_journal_entry",
            &json!({
                "source_entity_id": Uuid::now_v7().to_string(),
                "target_entity_id": Uuid::now_v7().to_string(),
                "body": [
                    { "type": "entity_ref" },
                    { "type": "entity_ref" }
                ]
            }),
        )
        .expect_err("reference mutation allows one reference per payload");
        assert!(
            reason.contains("exactly one entity_ref"),
            "reason names the placeholder count: {reason}"
        );
    }

    #[test]
    fn reference_existing_entity_data_payload_rewrites_placeholder() {
        let ref_id = Uuid::now_v7().to_string();
        let data = reference_existing_entity_data_payload(
            &json!({
                "occurred_at": "2026-06-10T10:00:00",
                "ended_at": "2026-06-10T10:15:00",
                "body": [{ "type": "text", "text": "Old body." }]
            }),
            &json!({
                "source_entity_id": Uuid::now_v7().to_string(),
                "target_entity_id": Uuid::now_v7().to_string(),
                "label_snapshot": "Ada",
                "body": [
                    { "type": "text", "text": "Met " },
                    { "type": "entity_ref" }
                ]
            }),
            &ref_id,
        );
        assert!(data.get("source_entity_id").is_none());
        assert!(data.get("target_entity_id").is_none());
        assert!(data.get("label_snapshot").is_none());
        assert_eq!(data["occurred_at"].as_str(), Some("2026-06-10T10:00:00"));
        assert_eq!(data["ended_at"].as_str(), Some("2026-06-10T10:15:00"));
        assert_eq!(data["body"][1]["ref_id"].as_str(), Some(ref_id.as_str()));
    }

    #[test]
    fn rejects_extra_body_node_fields_and_empty_ended_at() {
        let reason = validate_journal_entry(&json!({
            "occurred_at": "2026-06-10T10:30:00",
            "ended_at": "  ",
            "body": [{ "type": "text", "text": "Talked to Alice." }]
        }))
        .expect_err("ended_at must be concrete when present");
        assert!(
            reason.contains("ended_at"),
            "reason names ended_at: {reason}"
        );

        let reason = validate_journal_entry(&json!({
            "occurred_at": "2026-06-10T10:30:00",
            "body": [{ "type": "text", "text": "Talked to Alice.", "ref_id": "r1" }]
        }))
        .expect_err("text body nodes have only type and text");
        assert!(
            reason.contains("ref_id"),
            "reason names unsupported body field: {reason}"
        );
    }

    #[test]
    fn validate_dispatches_journal_entry_ok() {
        assert!(validate(
            "create_journal_entry",
            &json!({
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "text", "text": "Talked to Alice." }]
            })
        )
        .is_ok());
        assert!(validate(
            "delete_journal_entry",
            &json!({
                "entity_id": Uuid::now_v7().to_string()
            })
        )
        .is_ok());
    }

    #[test]
    fn validate_delete_person_and_todo_accept_a_uuid_entity_id() {
        for kind in ["delete_person", "delete_todo"] {
            assert!(
                validate(kind, &json!({ "entity_id": Uuid::now_v7().to_string() })).is_ok(),
                "{kind} with a UUID entity_id validates"
            );
        }
    }

    #[test]
    fn validate_delete_person_and_todo_reject_unsupported_field() {
        for kind in ["delete_person", "delete_todo"] {
            let reason = validate(
                kind,
                &json!({ "entity_id": Uuid::now_v7().to_string(), "name": "Alice" }),
            )
            .expect_err("an extra field on a delete payload is unsupported");
            assert!(
                reason.contains(kind) && reason.contains("name"),
                "{kind} names the unsupported field: {reason}"
            );
        }
    }

    #[test]
    fn validate_delete_person_and_todo_reject_missing_entity_id() {
        for kind in ["delete_person", "delete_todo"] {
            let reason =
                validate(kind, &json!({})).expect_err("a delete requires an entity_id target");
            assert!(
                reason.contains("entity_id"),
                "{kind} names the required entity_id: {reason}"
            );
        }
    }

    #[test]
    fn validate_delete_person_and_todo_reject_non_uuid_entity_id() {
        for kind in ["delete_person", "delete_todo"] {
            let reason = validate(kind, &json!({ "entity_id": "not-a-uuid" }))
                .expect_err("a delete entity_id must be a UUID");
            assert!(
                reason.contains("UUID"),
                "{kind} names the malformed entity_id: {reason}"
            );
        }
    }

    #[test]
    fn validate_rejects_unsupported_mutation_kind() {
        let reason = validate("create_widget", &json!({ "title": "Buy milk" }))
            .expect_err("widget mutation is unsupported");
        assert!(
            reason.contains("create_widget") && reason.contains("not supported"),
            "unsupported reason names the mutation kind: {reason}"
        );
    }

    #[test]
    fn render_accept_journal_entry_confirms_creation() {
        let text = render_accept(
            "create_journal_entry",
            &json!({
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "text", "text": "Bought milk." }]
            }),
        );
        assert!(
            text.contains("Journal Entry")
                && text.contains("2026-06-10T10:30:00")
                && text.contains("Bought milk."),
            "confirmation names the created Journal Entry fields: {text}"
        );
    }

    #[test]
    fn render_accept_journal_entry_includes_entity_ref_placeholders() {
        let ref_id = Uuid::now_v7().to_string();
        let text = render_accept(
            "update_journal_entry",
            &json!({
                "entity_id": Uuid::now_v7().to_string(),
                "occurred_at": "2026-06-10T10:30:00",
                "body": [
                    { "type": "text", "text": "Met " },
                    { "type": "entity_ref", "ref_id": ref_id },
                    { "type": "text", "text": " at school." }
                ]
            }),
        );
        assert!(
            text.contains("[entity_ref:") && text.contains(" at school."),
            "confirmation keeps entity_ref nodes visible: {text}"
        );
    }

    #[test]
    fn render_accept_delete_journal_entry_confirms_deletion() {
        let entity_id = Uuid::now_v7().to_string();
        let text = render_accept(
            "delete_journal_entry",
            &json!({
                "entity_id": entity_id
            }),
        );
        assert!(
            text.contains("Deleted Journal Entry") && text.contains("entity_id="),
            "confirmation names the deleted Journal Entry target: {text}"
        );
    }

    #[test]
    fn schema_version_journal_entry_is_one() {
        assert_eq!(
            schema_version("create_journal_entry"),
            JOURNAL_ENTRY_SCHEMA_VERSION
        );
        assert_eq!(
            schema_version("delete_journal_entry"),
            JOURNAL_ENTRY_SCHEMA_VERSION
        );
        assert_eq!(
            schema_version("reference_existing_entity_from_journal_entry"),
            JOURNAL_ENTRY_SCHEMA_VERSION
        );
        assert_eq!(schema_version("create_journal_entry"), 1);
    }

    #[test]
    fn accepts_minimal_person() {
        assert!(validate_person(&json!({ "name": "Alice" })).is_ok());
    }

    #[test]
    fn accepts_person_with_note_and_aliases() {
        assert!(validate_person(&json!({
            "name": "Alice",
            "note": "daycare coordinator",
            "aliases": ["Al", "Ali"]
        }))
        .is_ok());
    }

    #[test]
    fn rejects_missing_or_blank_name() {
        assert!(validate_person(&json!({ "note": "no name" })).is_err());
        let reason =
            validate_person(&json!({ "name": "   " })).expect_err("blank name is not a name");
        assert!(
            reason.contains("name"),
            "reason names the name field: {reason}"
        );
    }

    #[test]
    fn rejects_blank_alias() {
        let reason = validate_person(&json!({ "name": "Alice", "aliases": ["Al", "  "] }))
            .expect_err("blank aliases are not allowed");
        assert!(reason.contains("alias"), "reason names the alias: {reason}");
    }

    #[test]
    fn rejects_non_array_aliases() {
        let reason = validate_person(&json!({ "name": "Alice", "aliases": "Al" }))
            .expect_err("aliases must be an array");
        assert!(reason.contains("aliases"), "reason names aliases: {reason}");
    }

    #[test]
    fn rejects_unsupported_person_field() {
        let reason = validate_person(&json!({ "name": "Alice", "status": "active" }))
            .expect_err("person has no status field");
        assert!(
            reason.contains("status"),
            "reason names the unsupported field: {reason}"
        );
    }

    #[test]
    fn update_person_validates_payload_minus_entity_id() {
        // entity_id + a valid PersonData body is ok.
        assert!(validate(
            "update_person",
            &json!({ "entity_id": Uuid::now_v7().to_string(), "name": "Alice", "note": "x" })
        )
        .is_ok());
        // The PersonData rules still apply to the rest (no status field).
        let reason = validate(
            "update_person",
            &json!({ "entity_id": Uuid::now_v7().to_string(), "status": "active" }),
        )
        .expect_err("person has no status field");
        assert!(
            reason.contains("status"),
            "reason names the unsupported person field: {reason}"
        );
    }

    #[test]
    fn update_person_requires_a_uuid_entity_id() {
        let reason = validate("update_person", &json!({ "name": "Alice" }))
            .expect_err("update requires a target entity_id");
        assert!(
            reason.contains("entity_id"),
            "reason names the missing entity_id: {reason}"
        );
        let reason = validate(
            "update_person",
            &json!({ "entity_id": "nope", "name": "Alice" }),
        )
        .expect_err("entity_id must be a UUID");
        assert!(
            reason.contains("UUID"),
            "reason names the malformed entity_id: {reason}"
        );
    }

    #[test]
    fn accepts_project_without_status() {
        assert!(validate_project(&json!({ "name": "Ship API v2 migration" })).is_ok());
    }

    #[test]
    fn rejects_null_project_status() {
        // `status` is optional (absent ⇒ active) but NOT clearable: an explicit
        // `null` is rejected, matching Todo `status` and the pre-spec validator.
        // Clearing a status is meaningless, so `null` must not slip through as a
        // silent "active".
        let reason = validate_project(&json!({ "name": "Roadmap", "status": null }))
            .expect_err("a null status is not a valid status");
        assert!(
            reason.contains("status"),
            "reason names the status field: {reason}"
        );
    }

    #[test]
    fn accepts_project_with_active_or_on_hold_status() {
        assert!(validate_project(&json!({ "name": "Roadmap", "status": "active" })).is_ok());
        assert!(validate_project(&json!({ "name": "Roadmap", "status": "on_hold" })).is_ok());
    }

    #[test]
    fn accepts_completed_project_with_completed_at() {
        assert!(validate_project(&json!({
            "name": "Roadmap",
            "status": "completed",
            "completed_at": "2026-06-10T10:00:00"
        }))
        .is_ok());
    }

    #[test]
    fn rejects_completed_project_without_completed_at() {
        let reason = validate_project(&json!({ "name": "Roadmap", "status": "completed" }))
            .expect_err("completed requires completed_at");
        assert!(
            reason.contains("completed_at"),
            "reason names completed_at: {reason}"
        );
    }

    #[test]
    fn rejects_active_project_with_completed_at() {
        let reason = validate_project(&json!({
            "name": "Roadmap",
            "status": "active",
            "completed_at": "2026-06-10T10:00:00"
        }))
        .expect_err("active forbids completed_at");
        assert!(
            reason.contains("completed_at"),
            "reason names completed_at: {reason}"
        );
    }

    #[test]
    fn rejects_dropped_project_with_completed_at() {
        let reason = validate_project(&json!({
            "name": "Roadmap",
            "status": "dropped",
            "completed_at": "2026-06-10T10:00:00"
        }))
        .expect_err("dropped forbids completed_at and requires dropped_at");
        assert!(
            reason.contains("completed_at") || reason.contains("dropped_at"),
            "reason names the violated timestamp: {reason}"
        );
    }

    #[test]
    fn rejects_missing_or_blank_project_name() {
        assert!(validate_project(&json!({ "status": "active" })).is_err());
        let reason =
            validate_project(&json!({ "name": "   " })).expect_err("blank name is not a name");
        assert!(
            reason.contains("name"),
            "reason names the name field: {reason}"
        );
    }

    #[test]
    fn rejects_unparseable_due_at() {
        let reason = validate_project(&json!({ "name": "Roadmap", "due_at": "banana" }))
            .expect_err("due_at must be parseable");
        assert!(reason.contains("due_at"), "reason names due_at: {reason}");
    }

    #[test]
    fn rejects_bad_review_every() {
        let reason = validate_project(&json!({
            "name": "Roadmap",
            "review_every": { "interval": 0, "unit": "week" }
        }))
        .expect_err("interval must be positive");
        assert!(
            reason.contains("interval"),
            "reason names interval: {reason}"
        );

        let reason = validate_project(&json!({
            "name": "Roadmap",
            "review_every": { "interval": 1, "unit": "fortnight" }
        }))
        .expect_err("unit must be a known unit");
        assert!(reason.contains("unit"), "reason names unit: {reason}");
    }

    #[test]
    fn accepts_valid_review_every() {
        assert!(validate_project(&json!({
            "name": "Roadmap",
            "review_every": { "interval": 1, "unit": "week" }
        }))
        .is_ok());
    }

    #[test]
    fn mark_project_reviewed_validates_entity_id_only() {
        // A bare UUID `entity_id` is the whole payload (Core recomputes the rest).
        assert!(validate(
            "mark_project_reviewed",
            &json!({ "entity_id": Uuid::now_v7().to_string() })
        )
        .is_ok());
        // Missing id, non-UUID id, and any extra field are all rejected.
        assert!(validate("mark_project_reviewed", &json!({})).is_err());
        assert!(validate("mark_project_reviewed", &json!({ "entity_id": "nope" })).is_err());
        let reason = validate(
            "mark_project_reviewed",
            &json!({ "entity_id": Uuid::now_v7().to_string(), "next_review_at": "2026-01-01T20:00:00" }),
        )
        .expect_err("client may not send review fields");
        assert!(
            reason.contains("next_review_at"),
            "reason names the unsupported field: {reason}"
        );
    }

    #[test]
    fn now_local_formats_full_wall_clock() {
        // 1_749_470_400_000 ms = 2025-06-09T12:00:00Z (a Monday); offset 0 ⇒ UTC.
        assert_eq!(now_local(1_749_470_400_000, 0), "2025-06-09T12:00:00");
        // A +60-minute anchor shifts the wall clock forward one hour.
        assert_eq!(now_local(1_749_470_400_000, 60), "2025-06-09T13:00:00");
        // Non-zero minute AND second, so the minute/second arithmetic is actually
        // exercised (a hardcoded :00:00 or swapped /60 and %60 would fail here).
        // 1_749_458_231_000 ms = 2025-06-09T08:37:11Z.
        assert_eq!(now_local(1_749_458_231_000, 0), "2025-06-09T08:37:11");
        // A +90-minute anchor rolls the hour (and only the hour) forward by 1:30.
        assert_eq!(now_local(1_749_458_231_000, 90), "2025-06-09T10:07:11");
    }

    #[test]
    fn advance_review_at_local_always_rolls_strictly_forward() {
        // A non-Sunday lands on the coming Sunday (2025-06-09 Mon → 06-15 Sun).
        assert_eq!(
            advance_review_at_local(1_749_470_400_000, 0),
            "2025-06-15T20:00:00"
        );
        // Reviewing ON a Sunday (2025-06-15) advances to the FOLLOWING Sunday,
        // regardless of time of day — both before AND after the 20:00 anchor.
        // 1_749_988_800_000 = 2025-06-15T12:00:00Z (before 20:00).
        assert_eq!(
            advance_review_at_local(1_749_988_800_000, 0),
            "2025-06-22T20:00:00"
        );
        // 1_750_021_200_000 = 2025-06-15T21:00:00Z (after 20:00) — still next week,
        // matching next_review_at_local's after-20:00 roll for the same instant.
        assert_eq!(
            advance_review_at_local(1_750_021_200_000, 0),
            "2025-06-22T20:00:00"
        );
        assert_eq!(
            next_review_at_local(1_750_021_200_000, 0),
            "2025-06-22T20:00:00"
        );
    }

    #[test]
    fn next_review_at_local_seeds_same_sunday_before_anchor() {
        // The SEED variant keeps the same-day shortcut: a Sunday before 20:00 seeds
        // to that same evening (a new Project shouldn't wait a week for review 1).
        // This is the behavior advance_review_at_local deliberately does NOT share.
        // 1_749_988_800_000 = 2025-06-15T12:00:00Z (Sunday, before 20:00).
        assert_eq!(
            next_review_at_local(1_749_988_800_000, 0),
            "2025-06-15T20:00:00"
        );
    }

    #[test]
    fn rejects_disallowed_project_fields() {
        for field in ["type", "person_ids", "todo_ids", "tags"] {
            let reason = validate_project(&json!({ "name": "Roadmap", field: "x" }))
                .expect_err("disallowed ProjectData field");
            assert!(
                reason.contains(field),
                "reason names the unsupported field {field}: {reason}"
            );
        }
    }

    #[test]
    fn update_project_validates_payload_minus_entity_id() {
        // entity_id + a valid status transition is ok; status is optional on update.
        assert!(
            validate(
                "update_project",
                &json!({ "entity_id": Uuid::now_v7().to_string(), "name": "Roadmap", "status": "on_hold" })
            )
            .is_ok()
        );
        assert!(
            validate(
                "update_project",
                &json!({ "entity_id": Uuid::now_v7().to_string(), "name": "Roadmap" })
            )
            .is_ok(),
            "status is optional on an update"
        );
        // The completed↔completed_at invariant still applies to the rest.
        let reason = validate(
            "update_project",
            &json!({ "entity_id": Uuid::now_v7().to_string(), "name": "Roadmap", "status": "completed" }),
        )
        .expect_err("completed requires completed_at");
        assert!(
            reason.contains("completed_at"),
            "reason names completed_at: {reason}"
        );
    }

    #[test]
    fn update_project_requires_a_uuid_entity_id() {
        // All four `entity_id` failure modes are pinned on one update kind — the
        // three update kinds share `entity_id_target()`/`FieldSpec::Uuid`, so one
        // suffices to gate the spec path the validators now route through.
        let reason = validate("update_project", &json!({ "name": "Roadmap" }))
            .expect_err("update requires a target entity_id");
        assert!(
            reason.contains("entity_id") && reason.contains("required"),
            "reason names the missing entity_id: {reason}"
        );
        let reason = validate(
            "update_project",
            &json!({ "entity_id": "", "name": "Roadmap" }),
        )
        .expect_err("a blank entity_id is not a target");
        assert!(
            reason.contains("must not be empty"),
            "reason rejects the empty entity_id: {reason}"
        );
        let reason = validate(
            "update_project",
            &json!({ "entity_id": 42, "name": "Roadmap" }),
        )
        .expect_err("a non-string entity_id is not a target");
        assert!(
            reason.contains("must be a string"),
            "reason rejects the non-string entity_id: {reason}"
        );
        let reason = validate(
            "update_project",
            &json!({ "entity_id": "nope", "name": "Roadmap" }),
        )
        .expect_err("entity_id must be a UUID");
        assert!(
            reason.contains("UUID"),
            "reason names the malformed entity_id: {reason}"
        );
    }

    #[test]
    fn render_accept_update_person_and_project() {
        let person = render_accept(
            "update_person",
            &json!({ "entity_id": Uuid::now_v7().to_string(), "name": "Alice" }),
        );
        assert!(
            person.contains("Updated Person") && person.contains("Alice"),
            "confirmation names the updated Person: {person}"
        );
        let project = render_accept(
            "update_project",
            &json!({ "entity_id": Uuid::now_v7().to_string(), "name": "Roadmap", "status": "on_hold" }),
        );
        assert!(
            project.contains("Updated Project")
                && project.contains("Roadmap")
                && project.contains("on_hold"),
            "confirmation names the updated Project: {project}"
        );
    }

    #[test]
    fn accepts_minimal_todo_without_status() {
        assert!(validate_todo(&json!({ "todo": { "title": "buy milk" } })).is_ok());
    }

    #[test]
    fn accepts_todo_with_each_valid_status() {
        assert!(validate_todo(&json!({ "todo": { "title": "x", "status": "active" } })).is_ok());
        assert!(validate_todo(&json!({
            "todo": { "title": "x", "status": "completed", "completed_at": "2026-06-10T10:00:00" }
        }))
        .is_ok());
        assert!(validate_todo(&json!({
            "todo": { "title": "x", "status": "dropped", "dropped_at": "2026-06-10T10:00:00" }
        }))
        .is_ok());
    }

    #[test]
    fn accepts_todo_with_project_link_and_person_refs_array() {
        // project_id existence is a decide-time check, not the pure validator's.
        assert!(validate_todo(&json!({
            "todo": { "title": "x", "project_id": "some-id" },
            "person_refs": [{ "person_id": "alice", "role": "waiting_on" }]
        }))
        .is_ok());
    }

    #[test]
    fn rejects_blank_todo_project_id() {
        // A blank project_id would slip past the decide-time Accepted-Project
        // check (which filters empty ids) and persist "" into Todo JSON, leaving
        // the Todo neither projectless nor linked. Reject it at validate.
        let reason = validate_todo(&json!({ "todo": { "title": "x", "project_id": "" } }))
            .expect_err("blank project_id is rejected");
        assert!(
            reason.contains("project_id"),
            "reason names project_id: {reason}"
        );
        let reason = validate_todo(&json!({ "todo": { "title": "x", "project_id": "   " } }))
            .expect_err("whitespace project_id is rejected");
        assert!(
            reason.contains("project_id"),
            "reason names project_id: {reason}"
        );
        // The same guard on the update_todo partial path.
        let reason = validate_partial_todo_data(&json!({ "project_id": "" }))
            .expect_err("blank project_id is rejected on update");
        assert!(
            reason.contains("project_id"),
            "reason names project_id: {reason}"
        );
    }

    #[test]
    fn rejects_missing_or_blank_todo_title() {
        let reason = validate_todo(&json!({ "todo": { "note": "no title" } }))
            .expect_err("title is required");
        assert!(reason.contains("title"), "reason names title: {reason}");
        let reason = validate_todo(&json!({ "todo": { "title": "   " } }))
            .expect_err("blank title is not a title");
        assert!(reason.contains("title"), "reason names title: {reason}");
    }

    #[test]
    fn rejects_completed_todo_without_completed_at_and_active_with_completed_at() {
        let reason = validate_todo(&json!({ "todo": { "title": "x", "status": "completed" } }))
            .expect_err("completed requires completed_at");
        assert!(
            reason.contains("completed_at"),
            "reason names completed_at: {reason}"
        );
        let reason = validate_todo(&json!({
            "todo": { "title": "x", "status": "active", "completed_at": "2026-06-10T10:00:00" }
        }))
        .expect_err("active forbids completed_at");
        assert!(
            reason.contains("completed_at"),
            "reason names completed_at: {reason}"
        );
    }

    #[test]
    fn rejects_unparseable_todo_timestamps() {
        let reason = validate_todo(&json!({ "todo": { "title": "x", "defer_at": "banana" } }))
            .expect_err("defer_at must be parseable");
        assert!(
            reason.contains("defer_at"),
            "reason names defer_at: {reason}"
        );
        let reason = validate_todo(&json!({ "todo": { "title": "x", "due_at": "soon" } }))
            .expect_err("due_at must be parseable");
        assert!(reason.contains("due_at"), "reason names due_at: {reason}");
    }

    #[test]
    fn rejects_on_hold_status_value() {
        let reason = validate_todo(&json!({ "todo": { "title": "x", "status": "on_hold" } }))
            .expect_err("todo has no on_hold status");
        assert!(reason.contains("status"), "reason names status: {reason}");
    }

    #[test]
    fn rejects_disallowed_todo_fields() {
        for field in [
            "repeat",
            "inbox",
            "standalone",
            "blocked",
            "on_hold",
            "subtasks",
            "tags",
            "person_ids",
        ] {
            let reason = validate_todo(&json!({ "todo": { "title": "x", field: "v" } }))
                .expect_err("disallowed TodoData field");
            assert!(
                reason.contains(field),
                "reason names the unsupported field {field}: {reason}"
            );
        }
    }

    #[test]
    fn rejects_create_todo_envelope_violations() {
        // Missing todo.
        let reason = validate_todo(&json!({ "person_refs": [] })).expect_err("todo is required");
        assert!(reason.contains("todo"), "reason names todo: {reason}");
        // person_refs must be an array when present.
        let reason = validate_todo(&json!({
            "todo": { "title": "x" },
            "person_refs": "alice"
        }))
        .expect_err("person_refs must be an array");
        assert!(
            reason.contains("person_refs"),
            "reason names person_refs: {reason}"
        );
    }

    #[test]
    fn validates_create_todo_person_ref_elements() {
        // Valid: a ref with an explicit role, and a ref with role omitted (the
        // missing role is friendly — defaulted to related at apply-time).
        assert!(validate_todo(&json!({
            "todo": { "title": "x" },
            "person_refs": [
                { "person_id": "alice", "role": "waiting_on" },
                { "person_id": "bob" }
            ]
        }))
        .is_ok());

        // Missing person_id.
        let reason = validate_todo(&json!({
            "todo": { "title": "x" },
            "person_refs": [{ "role": "related" }]
        }))
        .expect_err("person_id is required");
        assert!(
            reason.contains("person_id"),
            "reason names missing person_id: {reason}"
        );

        // Bad role value.
        let reason = validate_todo(&json!({
            "todo": { "title": "x" },
            "person_refs": [{ "person_id": "alice", "role": "blocking" }]
        }))
        .expect_err("role must be a known enum");
        assert!(reason.contains("role"), "reason names bad role: {reason}");

        // Extra key in a ref element.
        let reason = validate_todo(&json!({
            "todo": { "title": "x" },
            "person_refs": [{ "person_id": "alice", "note": "hi" }]
        }))
        .expect_err("extra person_refs keys are rejected");
        assert!(
            reason.contains("note"),
            "reason names the unsupported ref field: {reason}"
        );
    }

    #[test]
    fn create_accepts_valid_source_journal_entry_id_and_validates_the_rest() {
        let je = Uuid::now_v7().to_string();
        // A valid source rides alongside the entity fields and the rest validates.
        assert!(validate(
            "create_person",
            &json!({ "name": "Alice", "source_journal_entry_id": je })
        )
        .is_ok());
        assert!(validate(
            "create_project",
            &json!({ "name": "Roadmap", "source_journal_entry_id": je })
        )
        .is_ok());
        assert!(validate(
            "create_todo",
            &json!({ "todo": { "title": "follow up" }, "source_journal_entry_id": je })
        )
        .is_ok());
    }

    #[test]
    fn create_rejects_non_uuid_source_journal_entry_id() {
        for kind in ["create_person", "create_project"] {
            let reason = validate(
                kind,
                &json!({ "name": "x", "source_journal_entry_id": "not-a-uuid" }),
            )
            .expect_err("source must be a UUID");
            assert!(
                reason.contains("source_journal_entry_id") && reason.contains("UUID"),
                "{kind} names the malformed source: {reason}"
            );
        }
        let reason = validate(
            "create_todo",
            &json!({ "todo": { "title": "x" }, "source_journal_entry_id": "not-a-uuid" }),
        )
        .expect_err("source must be a UUID");
        assert!(
            reason.contains("source_journal_entry_id") && reason.contains("UUID"),
            "create_todo names the malformed source: {reason}"
        );
    }

    #[test]
    fn create_person_with_only_source_still_requires_name() {
        let reason = validate(
            "create_person",
            &json!({ "source_journal_entry_id": Uuid::now_v7().to_string() }),
        )
        .expect_err("source is provenance, not a name");
        assert!(
            reason.contains("name"),
            "reason names the missing name: {reason}"
        );
    }

    #[test]
    fn render_accept_create_todo_confirms_creation() {
        let text = render_accept(
            "create_todo",
            &json!({ "todo": { "title": "Ship it", "status": "active" } }),
        );
        assert!(
            text.contains("Created Todo") && text.contains("Ship it") && text.contains("active"),
            "confirmation names the created Todo fields: {text}"
        );
    }

    #[test]
    fn update_todo_accepts_partial_todo_and_ref_ops() {
        // A partial `todo` may omit title; ref arrays + remove ids are shape-valid.
        assert!(validate(
            "update_todo",
            &json!({
                "todo_id": Uuid::now_v7().to_string(),
                "todo": { "due_at": "2026-07-01T09:00:00" },
                "set_person_refs": [{ "person_id": "alice", "role": "related" }],
                "add_person_refs": [{ "person_id": "bob" }],
                "remove_person_ids": ["carol"]
            })
        )
        .is_ok());
        // A lone status (no completed_at) is fine for the PURE validator — the
        // invariant is checked on the merged whole at apply-time.
        assert!(validate(
            "update_todo",
            &json!({ "todo_id": Uuid::now_v7().to_string(), "todo": { "status": "completed" } })
        )
        .is_ok());
        // A bare todo_id (no changes) is also valid.
        assert!(validate(
            "update_todo",
            &json!({ "todo_id": Uuid::now_v7().to_string() })
        )
        .is_ok());
    }

    #[test]
    fn update_todo_requires_a_uuid_todo_id() {
        let reason = validate(
            "update_todo",
            &json!({ "todo": { "due_at": "2026-07-01T09:00:00" } }),
        )
        .expect_err("update requires a target todo_id");
        assert!(
            reason.contains("todo_id"),
            "reason names the missing todo_id: {reason}"
        );
        let reason = validate("update_todo", &json!({ "todo_id": "nope" }))
            .expect_err("todo_id must be a UUID");
        assert!(
            reason.contains("UUID"),
            "reason names the malformed todo_id: {reason}"
        );
    }

    #[test]
    fn update_todo_rejects_unknown_top_level_key_and_bad_partial_field() {
        let reason = validate(
            "update_todo",
            &json!({ "todo_id": Uuid::now_v7().to_string(), "entity_id": "x" }),
        )
        .expect_err("update_todo's target key is todo_id, not entity_id");
        assert!(
            reason.contains("entity_id"),
            "reason names the unsupported top-level field: {reason}"
        );
        // The partial todo still rejects non-TodoData fields and a blank title.
        let reason = validate(
            "update_todo",
            &json!({ "todo_id": Uuid::now_v7().to_string(), "todo": { "on_hold": true } }),
        )
        .expect_err("todo has no on_hold field");
        assert!(
            reason.contains("on_hold"),
            "reason names the unsupported todo field: {reason}"
        );
        let reason = validate(
            "update_todo",
            &json!({ "todo_id": Uuid::now_v7().to_string(), "todo": { "title": "   " } }),
        )
        .expect_err("a supplied title must be non-empty");
        assert!(
            reason.contains("title"),
            "reason names the blank title: {reason}"
        );
    }

    #[test]
    fn update_todo_rejects_malformed_ref_ops() {
        let reason = validate(
            "update_todo",
            &json!({ "todo_id": Uuid::now_v7().to_string(), "set_person_refs": "alice" }),
        )
        .expect_err("set_person_refs must be an array");
        assert!(
            reason.contains("set_person_refs"),
            "reason names set_person_refs: {reason}"
        );
        let reason = validate(
            "update_todo",
            &json!({ "todo_id": Uuid::now_v7().to_string(), "remove_person_ids": [""] }),
        )
        .expect_err("remove_person_ids entries must be non-empty");
        assert!(
            reason.contains("remove_person_ids"),
            "reason names remove_person_ids: {reason}"
        );
    }

    #[test]
    fn render_accept_update_todo_confirms_update() {
        let todo_id = Uuid::now_v7().to_string();
        let text = render_accept(
            "update_todo",
            &json!({ "todo_id": todo_id, "todo": { "due_at": "2026-07-01T09:00:00" } }),
        );
        assert!(
            text.contains("Updated Todo") && text.contains("todo_id="),
            "confirmation names the updated Todo target: {text}"
        );
    }

    // Anchors below are hand-derived from concrete UTC instants. 2026-06-14 is a
    // Sunday (epoch-days 20618; weekday formula ((20618 % 7) + 4) % 7 == 0).

    #[test]
    fn next_review_mid_week_targets_upcoming_sunday() {
        // 2026-06-10T09:30:00 UTC = Wednesday (weekday 3), offset 0.
        // Upcoming Sunday is 2026-06-14.
        assert_eq!(
            next_review_at_local(1_781_083_800_000, 0),
            "2026-06-14T20:00:00"
        );
    }

    #[test]
    fn next_review_sunday_before_2000_targets_same_day() {
        // 2026-06-14T09:00:00 UTC = Sunday before 20:00 local, offset 0.
        // Target is the same Sunday at 20:00.
        assert_eq!(
            next_review_at_local(1_781_427_600_000, 0),
            "2026-06-14T20:00:00"
        );
    }

    #[test]
    fn next_review_sunday_at_2000_targets_following_sunday() {
        // 2026-06-14T20:00:00 UTC = Sunday at exactly 20:00 local, offset 0.
        // At-or-after 20:00 ⇒ the following Sunday 2026-06-21.
        assert_eq!(
            next_review_at_local(1_781_467_200_000, 0),
            "2026-06-21T20:00:00"
        );
    }

    #[test]
    fn next_review_offset_crosses_day_boundary() {
        // 2026-06-13T23:30:00 UTC = Saturday in UTC, but with +60 min offset the
        // local wall clock is 2026-06-14T00:30:00 (Sunday before 20:00).
        // Target is the local Sunday 2026-06-14 at 20:00.
        assert_eq!(
            next_review_at_local(1_781_393_400_000, 60),
            "2026-06-14T20:00:00"
        );
    }

    #[test]
    fn civil_days_round_trip() {
        for (y, m, d) in [(1970, 1, 1), (2026, 6, 14), (2026, 6, 21), (2000, 2, 29)] {
            let days = days_from_civil(y, m, d);
            assert_eq!(civil_from_days(days), (y, m, d), "round-trips {y}-{m}-{d}");
        }
        assert_eq!(days_from_civil(1970, 1, 1), 0, "epoch is day 0");
    }

    // ─── Bookmark (ADR-0036) ───────────────────────────────────────────────

    #[test]
    fn accepts_minimal_bookmark() {
        assert!(validate_bookmark(&json!({ "title": "Effect docs" })).is_ok());
    }

    #[test]
    fn accepts_bookmark_with_url_note_and_tags() {
        assert!(validate_bookmark(&json!({
            "title": "Effect docs",
            "url": "https://effect.website",
            "note": "read later",
            "tags": ["fp", "ts"]
        }))
        .is_ok());
    }

    #[test]
    fn rejects_missing_or_blank_bookmark_title() {
        assert!(validate_bookmark(&json!({ "url": "https://x" })).is_err());
        let reason =
            validate_bookmark(&json!({ "title": "   " })).expect_err("blank title is not a title");
        assert!(
            reason.contains("title"),
            "reason names the title field: {reason}"
        );
    }

    #[test]
    fn rejects_unsupported_bookmark_field() {
        let reason = validate_bookmark(&json!({ "title": "x", "servings": 4 }))
            .expect_err("bookmark has no servings field");
        assert!(
            reason.contains("servings"),
            "reason names the unsupported field: {reason}"
        );
    }

    #[test]
    fn accepts_null_clear_on_bookmark_optional_fields() {
        // `null` is the ADR-0033 sentinel-clear directive on every optional field.
        assert!(validate_bookmark(&json!({
            "title": "x",
            "url": null,
            "note": null,
            "tags": null
        }))
        .is_ok());
    }

    #[test]
    fn rejects_non_string_bookmark_url_or_note() {
        let reason = validate_bookmark(&json!({ "title": "x", "url": 42 }))
            .expect_err("url must be a string");
        assert!(reason.contains("url"), "reason names url: {reason}");
        let reason = validate_bookmark(&json!({ "title": "x", "note": 42 }))
            .expect_err("note must be a string");
        assert!(reason.contains("note"), "reason names note: {reason}");
    }

    #[test]
    fn rejects_non_array_or_blank_bookmark_tags() {
        let reason = validate_bookmark(&json!({ "title": "x", "tags": "fp" }))
            .expect_err("tags must be an array");
        assert!(reason.contains("tags"), "reason names tags: {reason}");
        let reason = validate_bookmark(&json!({ "title": "x", "tags": ["fp", "  "] }))
            .expect_err("blank tags are not allowed");
        assert!(reason.contains("tag"), "reason names the tag: {reason}");
    }

    #[test]
    fn update_bookmark_validates_payload_minus_entity_id() {
        // entity_id + a valid BookmarkData body is ok.
        assert!(validate(
            "update_bookmark",
            &json!({ "entity_id": Uuid::now_v7().to_string(), "title": "x", "note": "n" })
        )
        .is_ok());
        // The BookmarkData rules still apply to the rest (no unknown field).
        let reason = validate(
            "update_bookmark",
            &json!({ "entity_id": Uuid::now_v7().to_string(), "servings": 4 }),
        )
        .expect_err("bookmark has no servings field");
        assert!(
            reason.contains("servings"),
            "reason names the unsupported bookmark field: {reason}"
        );
    }

    #[test]
    fn update_bookmark_requires_a_uuid_entity_id() {
        let reason = validate("update_bookmark", &json!({ "title": "x" }))
            .expect_err("update requires a target entity_id");
        assert!(
            reason.contains("entity_id"),
            "reason names the missing entity_id: {reason}"
        );
        let reason = validate(
            "update_bookmark",
            &json!({ "entity_id": "nope", "title": "x" }),
        )
        .expect_err("entity_id must be a UUID");
        assert!(
            reason.contains("UUID"),
            "reason names the malformed entity_id: {reason}"
        );
    }

    #[test]
    fn validate_delete_bookmark_accepts_uuid_and_rejects_extras() {
        assert!(validate(
            "delete_bookmark",
            &json!({ "entity_id": Uuid::now_v7().to_string() })
        )
        .is_ok());
        let reason = validate(
            "delete_bookmark",
            &json!({ "entity_id": Uuid::now_v7().to_string(), "title": "x" }),
        )
        .expect_err("an extra field on a delete payload is unsupported");
        assert!(
            reason.contains("delete_bookmark") && reason.contains("title"),
            "reason names the unsupported field: {reason}"
        );
    }

    #[test]
    fn schema_version_bookmark_is_one() {
        assert_eq!(schema_version("create_bookmark"), BOOKMARK_SCHEMA_VERSION);
        assert_eq!(schema_version("update_bookmark"), BOOKMARK_SCHEMA_VERSION);
        assert_eq!(schema_version("delete_bookmark"), BOOKMARK_SCHEMA_VERSION);
        assert_eq!(schema_version("create_bookmark"), 1);
    }

    // ─── recurrence rule (ADR-0037) ────────────────────────────────────────

    /// A `create_todo` envelope carrying a Todo with both anchor dates present
    /// (so any `anchor` choice satisfies anchor-presence) plus the given rule.
    fn todo_with_recurrence(recurrence: Value) -> Value {
        json!({
            "todo": {
                "title": "water the plants",
                "defer_at": "2026-06-14T09:00:00",
                "due_at": "2026-06-14T18:00:00",
                "recurrence": recurrence
            }
        })
    }

    #[test]
    fn accepts_recurrence_rules() {
        // The slimmed shape (ADR-0039): interval + unit across all six units, both
        // anchors, and the two end conditions.
        let rules = [
            json!({ "interval": 1, "unit": "minute", "anchor": "due_at" }),
            json!({ "interval": 2, "unit": "hour", "anchor": "due_at" }),
            json!({ "interval": 3, "unit": "day", "anchor": "defer_at" }),
            json!({ "interval": 1, "unit": "week", "anchor": "due_at" }),
            json!({ "interval": 6, "unit": "month", "anchor": "due_at" }),
            json!({ "interval": 1, "unit": "year", "anchor": "defer_at" }),
            // end via until.
            json!({
                "interval": 1, "unit": "day", "anchor": "due_at",
                "end": { "until": "2026-12-31T23:59:59" }
            }),
            // end via after_count.
            json!({
                "interval": 1, "unit": "day", "anchor": "due_at",
                "end": { "after_count": 10 }
            }),
        ];
        for rule in rules {
            assert!(
                validate("create_todo", &todo_with_recurrence(rule.clone())).is_ok(),
                "valid recurrence rule should be accepted: {rule}"
            );
        }
    }

    #[test]
    fn rejects_recurrence_invariant_violations() {
        // Each entry: (rule, substring the reason must contain). The Todo carries
        // both anchor dates so only the rule's own invariant trips.
        let cases: [(Value, &str); 8] = [
            // interval must be an integer >= 1.
            (
                json!({ "interval": 0, "unit": "day", "anchor": "due_at" }),
                "interval",
            ),
            (
                json!({ "interval": 1.5, "unit": "day", "anchor": "due_at" }),
                "interval",
            ),
            // unit must be one of the six.
            (
                json!({ "interval": 1, "unit": "fortnight", "anchor": "due_at" }),
                "unit",
            ),
            // anchor enum.
            (
                json!({ "interval": 1, "unit": "day", "anchor": "planned_at" }),
                "anchor",
            ),
            // anchor is required.
            (json!({ "interval": 1, "unit": "day" }), "anchor"),
            // end carrying both keys.
            (
                json!({
                    "interval": 1, "unit": "day", "anchor": "due_at",
                    "end": { "until": "2026-12-31T23:59:59", "after_count": 5 }
                }),
                "end",
            ),
            // end.until unparseable.
            (
                json!({
                    "interval": 1, "unit": "day", "anchor": "due_at",
                    "end": { "until": "next year" }
                }),
                "until",
            ),
            // empty end object.
            (
                json!({
                    "interval": 1, "unit": "day", "anchor": "due_at",
                    "end": {}
                }),
                "end",
            ),
        ];
        for (rule, needle) in cases {
            let reason = validate("create_todo", &todo_with_recurrence(rule.clone()))
                .expect_err("invalid recurrence rule should be rejected");
            assert!(
                reason.contains(needle),
                "reason should name {needle:?}: {reason} (rule {rule})"
            );
        }
    }

    #[test]
    fn rejects_removed_recurrence_fields() {
        // schedule/catch_up/only_on were removed from the durable shape (ADR-0039
        // amendment). A rule carrying any of them is now an unknown-field error —
        // proves a stored/proposed rule can't smuggle a dead field back in.
        for field in ["schedule", "catch_up", "only_on"] {
            let mut rule = serde_json::Map::new();
            rule.insert("interval".into(), json!(1));
            rule.insert("unit".into(), json!("week"));
            rule.insert("anchor".into(), json!("due_at"));
            rule.insert(field.into(), json!("regular"));
            let reason = validate("create_todo", &todo_with_recurrence(Value::Object(rule)))
                .expect_err("a removed recurrence field is rejected as unknown");
            assert!(
                reason.contains(field),
                "reason names the removed field {field:?}: {reason}"
            );
        }
    }

    #[test]
    fn rejects_recurrence_unknown_fields() {
        // Unknown key on the rule and on end.
        let reason = validate(
            "create_todo",
            &todo_with_recurrence(json!({
                "interval": 1, "unit": "day", "anchor": "due_at",
                "timezone": "UTC"
            })),
        )
        .expect_err("unknown recurrence field is rejected");
        assert!(
            reason.contains("timezone"),
            "names the unknown field: {reason}"
        );

        let reason = validate(
            "create_todo",
            &todo_with_recurrence(json!({
                "interval": 1, "unit": "day", "anchor": "due_at",
                "end": { "after_count": 3, "grace": 1 }
            })),
        )
        .expect_err("unknown end field is rejected");
        assert!(
            reason.contains("grace"),
            "names the unknown end field: {reason}"
        );
    }

    #[test]
    fn rejects_recurrence_anchor_naming_an_absent_date() {
        // anchor names due_at but the Todo has only defer_at → rejected as a
        // cross-field check against the whole Todo.
        let reason = validate(
            "create_todo",
            &json!({
                "todo": {
                    "title": "water the plants",
                    "defer_at": "2026-06-14T09:00:00",
                    "recurrence": {
                        "interval": 1, "unit": "day", "anchor": "due_at"
                    }
                }
            }),
        )
        .expect_err("anchor must name a date the Todo has");
        assert!(
            reason.contains("anchor") && reason.contains("due_at"),
            "reason names the missing anchor date: {reason}"
        );
        // The mirror: anchor defer_at with only due_at present.
        let reason = validate(
            "create_todo",
            &json!({
                "todo": {
                    "title": "water the plants",
                    "due_at": "2026-06-14T18:00:00",
                    "recurrence": {
                        "interval": 1, "unit": "day", "anchor": "defer_at"
                    }
                }
            }),
        )
        .expect_err("anchor must name a date the Todo has");
        assert!(
            reason.contains("anchor") && reason.contains("defer_at"),
            "reason names the missing anchor date: {reason}"
        );
    }

    #[test]
    fn update_todo_partial_accepts_recurrence_and_null_clear() {
        // A supplied valid rule is accepted; `null` is the sentinel-clear directive
        // (ADR-0037). The anchor-presence cross-check is NOT done here — the partial
        // lacks the whole Todo; the merged-whole re-validation in apply enforces it.
        assert!(validate(
            "update_todo",
            &json!({
                "todo_id": Uuid::now_v7().to_string(),
                "todo": {
                    "recurrence": {
                        "interval": 1, "unit": "week", "anchor": "due_at"
                    }
                }
            })
        )
        .is_ok());
        assert!(
            validate(
                "update_todo",
                &json!({ "todo_id": Uuid::now_v7().to_string(), "todo": { "recurrence": null } })
            )
            .is_ok(),
            "recurrence: null is the sentinel-clear directive"
        );
    }

    #[test]
    fn update_todo_partial_rejects_invalid_recurrence_rule() {
        // The standalone rule check still runs on a supplied (non-null) rule.
        let reason = validate(
            "update_todo",
            &json!({
                "todo_id": Uuid::now_v7().to_string(),
                "todo": {
                    "recurrence": {
                        "interval": 1, "unit": "fortnight", "anchor": "due_at"
                    }
                }
            }),
        )
        .expect_err("an invalid unit is rejected in the partial");
        assert!(
            reason.contains("unit"),
            "reason names the bad unit: {reason}"
        );
        // A removed field (only_on) is an unknown-field error in the partial too.
        let reason = validate(
            "update_todo",
            &json!({
                "todo_id": Uuid::now_v7().to_string(),
                "todo": {
                    "recurrence": {
                        "interval": 1, "unit": "week", "anchor": "due_at",
                        "only_on": { "weekdays": ["mon"] }
                    }
                }
            }),
        )
        .expect_err("a removed recurrence field is rejected in the partial");
        assert!(reason.contains("only_on"), "reason names only_on: {reason}");
    }
}
