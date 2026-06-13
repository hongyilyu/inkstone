//! Workspace mutation schemas (ADR-0016, ADR-0025). A Proposal's payload is
//! validated by `mutation_kind` before it is durably applied. Supported
//! mutations create/update/delete a `journal_entry` Entity (plus provenance)
//! and add inline references from Journal Entries to existing Entities.

use serde_json::Value;
use uuid::Uuid;

/// The schema version stamped onto a freshly-created Journal Entry + its first
/// revision.
pub const JOURNAL_ENTRY_SCHEMA_VERSION: i64 = 1;

/// The schema version stamped onto a freshly-created Person + its first revision.
pub const PERSON_SCHEMA_VERSION: i64 = 1;

/// The schema version stamped onto a freshly-created Project + its first revision.
pub const PROJECT_SCHEMA_VERSION: i64 = 1;

/// The schema version stamped onto a freshly-created Todo + its first revision.
pub const TODO_SCHEMA_VERSION: i64 = 1;

/// Validate a proposed mutation payload against its schema (ADR-0016),
/// dispatched on `mutation_kind`. An unsupported mutation is a validation
/// failure. `Err(reason)` is surfaced as the `invalid_params` message on
/// `proposal/decide`.
pub(crate) fn validate(mutation_kind: &str, payload: &Value) -> Result<(), String> {
    match mutation_kind {
        "create_journal_entry" => validate_journal_entry(payload),
        "update_journal_entry" => validate_update_journal_entry(payload),
        "delete_journal_entry" => validate_delete_entity(payload, "delete_journal_entry"),
        "reference_existing_entity_from_journal_entry" => {
            validate_reference_existing_entity_from_journal_entry(payload)
        }
        "delete_person" => validate_delete_entity(payload, "delete_person"),
        "delete_project" => validate_delete_entity(payload, "delete_project"),
        "delete_todo" => validate_delete_entity(payload, "delete_todo"),
        "create_person" => validate_person(&strip_source_journal_entry_id(payload)?),
        "update_person" => validate_update_person(payload),
        "create_project" => validate_project(&strip_source_journal_entry_id(payload)?),
        "update_project" => validate_update_project(payload),
        "create_todo" => validate_todo(payload),
        "update_todo" => validate_update_todo(payload),
        _ => Err(format!("mutation_kind {mutation_kind:?} not supported")),
    }
}

/// Render the human-readable Decision text the model reads on resume as the
/// awaited tool's result (ADR-0025), dispatched on mutation kind.
pub(crate) fn render_accept(mutation_kind: &str, payload: &Value) -> String {
    match mutation_kind {
        "create_journal_entry" => {
            let occurred_at = payload
                .get("occurred_at")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let body = journal_body_text(payload);
            format!("Accepted. Created Journal Entry (occurred_at={occurred_at}, body={body}).")
        }
        "update_journal_entry" => {
            let occurred_at = payload
                .get("occurred_at")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let body = journal_body_text(payload);
            format!("Accepted. Updated Journal Entry (occurred_at={occurred_at}, body={body}).")
        }
        "delete_journal_entry" => {
            let entity_id = payload
                .get("entity_id")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            format!("Accepted. Deleted Journal Entry (entity_id={entity_id}).")
        }
        "reference_existing_entity_from_journal_entry" => {
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
        "delete_person" => {
            let entity_id = payload
                .get("entity_id")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            format!("Accepted. Deleted Person (entity_id={entity_id}).")
        }
        "delete_project" => {
            let entity_id = payload
                .get("entity_id")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            format!("Accepted. Deleted Project (entity_id={entity_id}).")
        }
        "delete_todo" => {
            let entity_id = payload
                .get("entity_id")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            format!("Accepted. Deleted Todo (entity_id={entity_id}).")
        }
        "create_person" => {
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            format!("Accepted. Created Person (name={name}).")
        }
        "update_person" => {
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            format!("Accepted. Updated Person (name={name}).")
        }
        "create_project" => {
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let status = payload
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("active");
            format!("Accepted. Created Project (name={name}, status={status}).")
        }
        "update_project" => {
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
        "create_todo" => {
            let todo = payload.get("todo");
            let title = todo
                .and_then(|t| t.get("title"))
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let status = todo
                .and_then(|t| t.get("status"))
                .and_then(Value::as_str)
                .unwrap_or("active");
            format!("Accepted. Created Todo (title={title}, status={status}).")
        }
        "update_todo" => {
            let todo_id = payload
                .get("todo_id")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            format!("Accepted. Updated Todo (todo_id={todo_id}).")
        }
        other => unreachable!("render_accept for unvalidated mutation_kind {other:?}"),
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

/// The schema version to stamp onto a freshly-created entity of this Entity
/// Type + its first revision, dispatched on `mutation_kind`.
pub(crate) fn schema_version(mutation_kind: &str) -> i64 {
    match mutation_kind {
        "create_journal_entry"
        | "update_journal_entry"
        | "delete_journal_entry"
        | "reference_existing_entity_from_journal_entry" => JOURNAL_ENTRY_SCHEMA_VERSION,
        "create_person" | "update_person" | "delete_person" => PERSON_SCHEMA_VERSION,
        "create_project" | "update_project" | "delete_project" => PROJECT_SCHEMA_VERSION,
        "create_todo" | "update_todo" | "delete_todo" => TODO_SCHEMA_VERSION,
        other => unreachable!("schema_version for unvalidated mutation_kind {other:?}"),
    }
}

pub(crate) fn entity_type(mutation_kind: &str) -> &'static str {
    match mutation_kind {
        "create_journal_entry"
        | "update_journal_entry"
        | "delete_journal_entry"
        | "reference_existing_entity_from_journal_entry" => "journal_entry",
        "create_person" | "update_person" | "delete_person" => "person",
        "create_project" | "update_project" | "delete_project" => "project",
        "create_todo" | "update_todo" | "delete_todo" => "todo",
        other => unreachable!("entity_type for unvalidated mutation_kind {other:?}"),
    }
}

pub(crate) fn source_relation_from_user_message(mutation_kind: &str) -> Option<&'static str> {
    match mutation_kind {
        "create_journal_entry" => Some("created_from"),
        "update_journal_entry" | "reference_existing_entity_from_journal_entry" => {
            Some("updated_from")
        }
        "delete_journal_entry" | "delete_person" | "delete_project" | "delete_todo" => None,
        "create_person" => Some("created_from"),
        "update_person" => Some("updated_from"),
        "create_project" => Some("created_from"),
        "update_project" => Some("updated_from"),
        "create_todo" => Some("created_from"),
        "update_todo" => Some("updated_from"),
        other => unreachable!("source relation for unvalidated mutation_kind {other:?}"),
    }
}

pub(crate) fn target_entity_id<'a>(mutation_kind: &str, payload: &'a Value) -> Option<&'a str> {
    match mutation_kind {
        "update_journal_entry" | "delete_journal_entry" | "update_person" | "update_project"
        | "delete_person" | "delete_project" | "delete_todo" => {
            payload.get("entity_id").and_then(Value::as_str)
        }
        "reference_existing_entity_from_journal_entry" => {
            payload.get("source_entity_id").and_then(Value::as_str)
        }
        // update_todo's target key is `todo_id`, NOT `entity_id` (its envelope
        // wraps a Partial<TodoData> under `todo`). delete_todo, by contrast,
        // targets a plain `{entity_id}` like every other delete.
        "update_todo" => payload.get("todo_id").and_then(Value::as_str),
        "create_journal_entry" | "create_person" | "create_project" | "create_todo" => None,
        other => unreachable!("target entity for unvalidated mutation_kind {other:?}"),
    }
}

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
    validate_journal_entry_payload(payload, BodyNodePolicy::TextOnly)
}

fn validate_journal_entry_payload(
    payload: &Value,
    body_policy: BodyNodePolicy,
) -> Result<(), String> {
    let obj = payload
        .as_object()
        .ok_or_else(|| "journal entry payload must be a JSON object".to_string())?;

    for key in obj.keys() {
        if key != "occurred_at" && key != "ended_at" && key != "body" {
            return Err(format!("unsupported journal entry field {key:?}"));
        }
    }

    let occurred_at = match obj.get("occurred_at") {
        Some(Value::String(t)) if !t.trim().is_empty() => parse_local_datetime(t, "occurred_at")?,
        Some(Value::String(_)) => return Err("occurred_at must not be empty".to_string()),
        Some(_) => return Err("occurred_at must be a string".to_string()),
        None => return Err("occurred_at is required".to_string()),
    };

    if let Some(ended_at) = obj.get("ended_at") {
        let ended_at = match ended_at {
            Value::String(t) if !t.trim().is_empty() => parse_local_datetime(t, "ended_at")?,
            Value::String(_) => return Err("ended_at must not be empty".to_string()),
            _ => return Err("ended_at must be a string".to_string()),
        };
        if ended_at < occurred_at {
            return Err("ended_at must be greater than or equal to occurred_at".to_string());
        }
    }

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
    let obj = payload
        .as_object()
        .ok_or_else(|| "journal entry payload must be a JSON object".to_string())?;

    let entity_id = match obj.get("entity_id") {
        Some(Value::String(value)) if !value.trim().is_empty() => value,
        Some(Value::String(_)) => return Err("entity_id must not be empty".to_string()),
        Some(_) => return Err("entity_id must be a string".to_string()),
        None => return Err("entity_id is required".to_string()),
    };
    Uuid::parse_str(entity_id).map_err(|_| "entity_id must be a UUID".to_string())?;

    let mut journal_payload = serde_json::Map::with_capacity(obj.len().saturating_sub(1));
    for (key, value) in obj {
        if key != "entity_id" {
            journal_payload.insert(key.clone(), value.clone());
        }
    }
    validate_journal_entry_payload(
        &Value::Object(journal_payload),
        BodyNodePolicy::TextOrExistingEntityRef,
    )
}

fn validate_reference_existing_entity_from_journal_entry(payload: &Value) -> Result<(), String> {
    let obj = payload
        .as_object()
        .ok_or_else(|| "reference payload must be a JSON object".to_string())?;

    for key in obj.keys() {
        if !matches!(
            key.as_str(),
            "source_entity_id" | "target_entity_id" | "label_snapshot" | "body"
        ) {
            return Err(format!("unsupported reference field {key:?}"));
        }
    }

    for field in ["source_entity_id", "target_entity_id"] {
        let value = match obj.get(field) {
            Some(Value::String(value)) if !value.trim().is_empty() => value,
            Some(Value::String(_)) => return Err(format!("{field} must not be empty")),
            Some(_) => return Err(format!("{field} must be a string")),
            None => return Err(format!("{field} is required")),
        };
        Uuid::parse_str(value).map_err(|_| format!("{field} must be a UUID"))?;
    }

    if let Some(label_snapshot) = obj.get("label_snapshot") {
        match label_snapshot {
            Value::String(value) if !value.trim().is_empty() => {}
            Value::String(_) => return Err("label_snapshot must not be empty".to_string()),
            _ => return Err("label_snapshot must be a string".to_string()),
        }
    }

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
        validate_body_node(node, BodyNodePolicy::TextOrNewEntityRef)?;
    }

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

/// Validate a delete payload (`delete_journal_entry`/`delete_person`/
/// `delete_todo`): a single required UUID `entity_id` (the target) and no other
/// field. A delete carries no entity data, so this is the whole schema.
fn validate_delete_entity(payload: &Value, mutation_kind: &str) -> Result<(), String> {
    let obj = payload
        .as_object()
        .ok_or_else(|| format!("{mutation_kind} payload must be a JSON object"))?;

    let entity_id = match obj.get("entity_id") {
        Some(Value::String(value)) if !value.trim().is_empty() => value,
        Some(Value::String(_)) => return Err("entity_id must not be empty".to_string()),
        Some(_) => return Err("entity_id must be a string".to_string()),
        None => return Err("entity_id is required".to_string()),
    };
    Uuid::parse_str(entity_id).map_err(|_| "entity_id must be a UUID".to_string())?;

    for key in obj.keys() {
        if key != "entity_id" {
            return Err(format!("unsupported {mutation_kind} field {key:?}"));
        }
    }

    Ok(())
}

fn validate_person(payload: &Value) -> Result<(), String> {
    let obj = payload
        .as_object()
        .ok_or_else(|| "person payload must be a JSON object".to_string())?;

    for key in obj.keys() {
        if key != "name" && key != "note" && key != "aliases" {
            return Err(format!("unsupported person field {key:?}"));
        }
    }

    match obj.get("name") {
        Some(Value::String(name)) if !name.trim().is_empty() => {}
        Some(Value::String(_)) => return Err("name must not be empty".to_string()),
        Some(_) => return Err("name must be a string".to_string()),
        None => return Err("name is required".to_string()),
    }

    // `note`/`aliases` are clearable optional fields (ADR-0033): a `null` value is
    // the sentinel-clear directive (the apply path drops the key), accepted here.
    if let Some(note) = obj.get("note")
        && !note.is_null()
        && !note.is_string()
    {
        return Err("note must be a string".to_string());
    }

    if let Some(aliases) = obj.get("aliases")
        && !aliases.is_null()
    {
        let aliases = aliases
            .as_array()
            .ok_or_else(|| "aliases must be an array".to_string())?;
        for alias in aliases {
            match alias {
                Value::String(value) if !value.trim().is_empty() => {}
                Value::String(_) => return Err("alias must not be empty".to_string()),
                _ => return Err("alias must be a string".to_string()),
            }
        }
    }

    Ok(())
}

/// Validate an `update_person` payload: a required UUID `entity_id` (the target)
/// plus the rest validated as `PersonData` (mirrors `validate_update_journal_entry`).
fn validate_update_person(payload: &Value) -> Result<(), String> {
    let rest = strip_update_entity_id(payload)?;
    validate_person(&rest)
}

fn validate_project(payload: &Value) -> Result<(), String> {
    let obj = payload
        .as_object()
        .ok_or_else(|| "project payload must be a JSON object".to_string())?;

    for key in obj.keys() {
        match key.as_str() {
            "name" | "outcome" | "note" | "status" | "defer_at" | "due_at" | "completed_at"
            | "dropped_at" | "review_every" | "next_review_at" | "last_reviewed_at" => {}
            other => return Err(format!("unsupported project field {other:?}")),
        }
    }

    match obj.get("name") {
        Some(Value::String(name)) if !name.trim().is_empty() => {}
        Some(Value::String(_)) => return Err("name must not be empty".to_string()),
        Some(_) => return Err("name must be a string".to_string()),
        None => return Err("name is required".to_string()),
    }

    // `outcome`/`note` are clearable optional fields (ADR-0033): `null` is the
    // sentinel-clear directive (the apply path drops the key), accepted here.
    for field in ["outcome", "note"] {
        if let Some(value) = obj.get(field)
            && !value.is_null()
            && !value.is_string()
        {
            return Err(format!("{field} must be a string"));
        }
    }

    // Status is optional here (absent ⇒ defaults to active in the apply path).
    let status = match obj.get("status") {
        Some(Value::String(s)) => match s.as_str() {
            "active" | "on_hold" | "completed" | "dropped" => s.as_str(),
            _ => {
                return Err(
                    "status must be one of active, on_hold, completed, dropped".to_string(),
                );
            }
        },
        Some(_) => return Err("status must be a string".to_string()),
        None => "active",
    };

    // Timestamps are clearable optional fields: `null` is the sentinel-clear
    // directive (ADR-0033) and is treated as absent for the invariants below.
    for field in [
        "defer_at",
        "due_at",
        "completed_at",
        "dropped_at",
        "next_review_at",
        "last_reviewed_at",
    ] {
        if let Some(value) = obj.get(field) {
            match value {
                Value::Null => {}
                Value::String(t) if !t.trim().is_empty() => {
                    parse_local_datetime(t, field)?;
                }
                Value::String(_) => return Err(format!("{field} must not be empty")),
                _ => return Err(format!("{field} must be a string")),
            }
        }
    }

    // status↔timestamp invariants (absent status ⇒ treated as active). A `null`
    // timestamp is a clear directive, so it counts as ABSENT here.
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
        _ => unreachable!("status validated above"),
    }

    // `review_every` is a clearable optional field (ADR-0033): `null` clears it.
    if let Some(review_every) = obj.get("review_every")
        && !review_every.is_null()
    {
        validate_review_every(review_every)?;
    }

    Ok(())
}

/// Whether `key` is present in `obj` with a non-`null` value. A `null` value is
/// the sentinel-clear directive (ADR-0033), so it counts as absent for the
/// status↔timestamp invariants (the apply path drops null keys from stored data).
fn present_non_null(obj: &serde_json::Map<String, Value>, key: &str) -> bool {
    matches!(obj.get(key), Some(v) if !v.is_null())
}

/// Validate an `update_project` payload: a required UUID `entity_id` (the target)
/// plus the rest validated as `ProjectData`. `validate_project` tolerates an
/// absent status, which is fine for an update (status optional on update).
fn validate_update_project(payload: &Value) -> Result<(), String> {
    let rest = strip_update_entity_id(payload)?;
    validate_project(&rest)
}

/// Pull a required UUID `entity_id` off an update payload, returning the payload
/// MINUS `entity_id` (the entity data to validate/store). Shared by the
/// person/project update validators.
fn strip_update_entity_id(payload: &Value) -> Result<Value, String> {
    let obj = payload
        .as_object()
        .ok_or_else(|| "update payload must be a JSON object".to_string())?;

    let entity_id = match obj.get("entity_id") {
        Some(Value::String(value)) if !value.trim().is_empty() => value,
        Some(Value::String(_)) => return Err("entity_id must not be empty".to_string()),
        Some(_) => return Err("entity_id must be a string".to_string()),
        None => return Err("entity_id is required".to_string()),
    };
    Uuid::parse_str(entity_id).map_err(|_| "entity_id must be a UUID".to_string())?;

    let mut rest = serde_json::Map::with_capacity(obj.len().saturating_sub(1));
    for (key, value) in obj {
        if key != "entity_id" {
            rest.insert(key.clone(), value.clone());
        }
    }
    Ok(Value::Object(rest))
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

/// Pull an optional `source_journal_entry_id` off a create payload (the
/// provenance directive, ADR-0030/0031), returning the payload MINUS that field
/// (the entity data to validate/store). When present it must be a non-empty
/// string that parses as a UUID; its existence (that it names a Journal Entry) is
/// checked at decide-time. Used by `create_person`/`create_project`; `create_todo`
/// validates the field in place since its envelope is not the entity data.
fn strip_source_journal_entry_id(payload: &Value) -> Result<Value, String> {
    let obj = payload
        .as_object()
        .ok_or_else(|| "payload must be a JSON object".to_string())?;
    validate_source_journal_entry_id(obj)?;

    if !obj.contains_key("source_journal_entry_id") {
        return Ok(payload.clone());
    }
    let mut rest = serde_json::Map::with_capacity(obj.len().saturating_sub(1));
    for (key, value) in obj {
        if key != "source_journal_entry_id" {
            rest.insert(key.clone(), value.clone());
        }
    }
    Ok(Value::Object(rest))
}

/// Validate an optional `source_journal_entry_id` on a create payload/envelope: a
/// present value must be a non-empty string parseable as a UUID.
fn validate_source_journal_entry_id(
    obj: &serde_json::Map<String, Value>,
) -> Result<(), String> {
    match obj.get("source_journal_entry_id") {
        Some(Value::String(id)) if !id.trim().is_empty() => {
            Uuid::parse_str(id).map_err(|_| "source_journal_entry_id must be a UUID".to_string())?;
            Ok(())
        }
        Some(Value::String(_)) => Err("source_journal_entry_id must not be empty".to_string()),
        Some(_) => Err("source_journal_entry_id must be a string".to_string()),
        None => Ok(()),
    }
}

fn validate_review_every(value: &Value) -> Result<(), String> {
    let obj = value
        .as_object()
        .ok_or_else(|| "review_every must be an object".to_string())?;

    for key in obj.keys() {
        if key != "interval" && key != "unit" {
            return Err(format!("unsupported review_every field {key:?}"));
        }
    }

    match obj.get("interval") {
        Some(Value::Number(n)) => match n.as_u64() {
            Some(interval) if interval >= 1 => {}
            _ => return Err("review_every interval must be a positive integer".to_string()),
        },
        Some(_) => return Err("review_every interval must be a positive integer".to_string()),
        None => return Err("review_every interval is required".to_string()),
    }

    match obj.get("unit") {
        Some(Value::String(unit)) => match unit.as_str() {
            "day" | "week" | "month" | "year" => {}
            _ => return Err("review_every unit must be one of day, week, month, year".to_string()),
        },
        Some(_) => return Err("review_every unit must be a string".to_string()),
        None => return Err("review_every unit is required".to_string()),
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
    let obj = payload
        .as_object()
        .ok_or_else(|| "create_todo payload must be a JSON object".to_string())?;

    for key in obj.keys() {
        if key != "todo" && key != "person_refs" && key != "source_journal_entry_id" {
            return Err(format!("unsupported create_todo field {key:?}"));
        }
    }

    validate_source_journal_entry_id(obj)?;

    if let Some(person_refs) = obj.get("person_refs") {
        let refs = person_refs
            .as_array()
            .ok_or_else(|| "person_refs must be an array".to_string())?;
        for ref_value in refs {
            validate_person_ref(ref_value)?;
        }
    }

    let todo = obj
        .get("todo")
        .ok_or_else(|| "todo is required".to_string())?;
    validate_todo_data(todo)
}

/// Validate one `person_refs` element (ADR-0031): an object with a required
/// non-empty string `person_id` and an optional `role` ∈ {waiting_on, related}.
/// Any other key is rejected. A missing role is friendly — it defaults to
/// `related` at apply-time (per ADR-0031: UI/Worker may omit the role).
fn validate_person_ref(value: &Value) -> Result<(), String> {
    let obj = value
        .as_object()
        .ok_or_else(|| "person_refs element must be a JSON object".to_string())?;

    for key in obj.keys() {
        if key != "person_id" && key != "role" {
            return Err(format!("unsupported person_refs field {key:?}"));
        }
    }

    match obj.get("person_id") {
        Some(Value::String(id)) if !id.trim().is_empty() => {}
        Some(Value::String(_)) => return Err("person_refs person_id must not be empty".to_string()),
        Some(_) => return Err("person_refs person_id must be a string".to_string()),
        None => return Err("person_refs person_id is required".to_string()),
    }

    match obj.get("role") {
        Some(Value::String(role)) => match role.as_str() {
            "waiting_on" | "related" => {}
            _ => return Err("person_refs role must be one of waiting_on, related".to_string()),
        },
        Some(_) => return Err("person_refs role must be a string".to_string()),
        None => {}
    }

    Ok(())
}

/// Validate the `TodoData` sub-object (ADR-0031): a required non-empty `title`;
/// optional string `note`/`project_id` (`project_id` existence is checked at
/// decide-time, not here); an optional `status` ∈ {active, completed, dropped}
/// defaulting to active when absent (Todo has NO `on_hold`); concrete
/// `defer_at`/`due_at`/`completed_at`/`dropped_at` timestamps; and the
/// status↔timestamp invariants. Any other field is rejected. `pub(crate)` so the
/// apply path can re-validate a MERGED `update_todo` result as a whole.
pub(crate) fn validate_todo_data(payload: &Value) -> Result<(), String> {
    let obj = payload
        .as_object()
        .ok_or_else(|| "todo must be a JSON object".to_string())?;

    for key in obj.keys() {
        match key.as_str() {
            "title" | "note" | "status" | "project_id" | "defer_at" | "due_at" | "completed_at"
            | "dropped_at" => {}
            other => return Err(format!("unsupported todo field {other:?}")),
        }
    }

    match obj.get("title") {
        Some(Value::String(title)) if !title.trim().is_empty() => {}
        Some(Value::String(_)) => return Err("title must not be empty".to_string()),
        Some(_) => return Err("title must be a string".to_string()),
        None => return Err("title is required".to_string()),
    }

    if let Some(note) = obj.get("note")
        && !note.is_string()
    {
        return Err("note must be a string".to_string());
    }
    // `project_id`, when present, must be a non-empty string: a blank id would
    // bypass the Accepted-Project reference check at decide and persist an empty
    // string that is neither projectless nor a real link.
    match obj.get("project_id") {
        Some(Value::String(id)) if !id.trim().is_empty() => {}
        Some(Value::String(_)) => return Err("project_id must not be empty".to_string()),
        Some(_) => return Err("project_id must be a string".to_string()),
        None => {}
    }

    // Status is optional here (absent ⇒ defaults to active in the apply path).
    let status = match obj.get("status") {
        Some(Value::String(s)) => match s.as_str() {
            "active" | "completed" | "dropped" => s.as_str(),
            _ => return Err("status must be one of active, completed, dropped".to_string()),
        },
        Some(_) => return Err("status must be a string".to_string()),
        None => "active",
    };

    for field in ["defer_at", "due_at", "completed_at", "dropped_at"] {
        if let Some(value) = obj.get(field) {
            match value {
                Value::String(t) if !t.trim().is_empty() => {
                    parse_local_datetime(t, field)?;
                }
                Value::String(_) => return Err(format!("{field} must not be empty")),
                _ => return Err(format!("{field} must be a string")),
            }
        }
    }

    // status↔timestamp invariants (absent status ⇒ treated as active).
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
        _ => unreachable!("status validated above"),
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
    let obj = payload
        .as_object()
        .ok_or_else(|| "update_todo payload must be a JSON object".to_string())?;

    for key in obj.keys() {
        match key.as_str() {
            "todo_id" | "todo" | "set_person_refs" | "add_person_refs" | "remove_person_ids" => {}
            other => return Err(format!("unsupported update_todo field {other:?}")),
        }
    }

    let todo_id = match obj.get("todo_id") {
        Some(Value::String(value)) if !value.trim().is_empty() => value,
        Some(Value::String(_)) => return Err("todo_id must not be empty".to_string()),
        Some(_) => return Err("todo_id must be a string".to_string()),
        None => return Err("todo_id is required".to_string()),
    };
    Uuid::parse_str(todo_id).map_err(|_| "todo_id must be a UUID".to_string())?;

    if let Some(todo) = obj.get("todo") {
        validate_partial_todo_data(todo)?;
    }

    for field in ["set_person_refs", "add_person_refs"] {
        if let Some(refs) = obj.get(field) {
            let refs = refs
                .as_array()
                .ok_or_else(|| format!("{field} must be an array"))?;
            for ref_value in refs {
                validate_person_ref(ref_value)?;
            }
        }
    }

    if let Some(remove) = obj.get("remove_person_ids") {
        let remove = remove
            .as_array()
            .ok_or_else(|| "remove_person_ids must be an array".to_string())?;
        for person_id in remove {
            match person_id {
                Value::String(id) if !id.trim().is_empty() => {}
                Value::String(_) => return Err("remove_person_ids id must not be empty".to_string()),
                _ => return Err("remove_person_ids id must be a string".to_string()),
            }
        }
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
    let obj = payload
        .as_object()
        .ok_or_else(|| "todo must be a JSON object".to_string())?;

    for key in obj.keys() {
        match key.as_str() {
            "title" | "note" | "status" | "project_id" | "defer_at" | "due_at" | "completed_at"
            | "dropped_at" => {}
            other => return Err(format!("unsupported todo field {other:?}")),
        }
    }

    if let Some(title) = obj.get("title") {
        match title {
            Value::String(t) if !t.trim().is_empty() => {}
            Value::String(_) => return Err("title must not be empty".to_string()),
            _ => return Err("title must be a string".to_string()),
        }
    }

    if let Some(note) = obj.get("note")
        && !note.is_null()
        && !note.is_string()
    {
        return Err("note must be a string".to_string());
    }
    // A supplied `project_id` is `null` (clear, ADR-0033) or a non-empty string;
    // a blank string would bypass the Accepted-Project reference check.
    match obj.get("project_id") {
        Some(Value::Null) => {}
        Some(Value::String(id)) if !id.trim().is_empty() => {}
        Some(Value::String(_)) => return Err("project_id must not be empty".to_string()),
        Some(_) => return Err("project_id must be a string".to_string()),
        None => {}
    }

    if let Some(status) = obj.get("status") {
        match status {
            Value::String(s) => match s.as_str() {
                "active" | "completed" | "dropped" => {}
                _ => return Err("status must be one of active, completed, dropped".to_string()),
            },
            _ => return Err("status must be a string".to_string()),
        }
    }

    for field in ["defer_at", "due_at", "completed_at", "dropped_at"] {
        if let Some(value) = obj.get(field) {
            match value {
                // `null` is the sentinel-clear directive (ADR-0033).
                Value::Null => {}
                Value::String(t) if !t.trim().is_empty() => {
                    parse_local_datetime(t, field)?;
                }
                Value::String(_) => return Err(format!("{field} must not be empty")),
                _ => return Err(format!("{field} must be a string")),
            }
        }
    }

    Ok(())
}

fn parse_local_datetime(
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

fn days_in_month(year: u32, month: u32) -> u32 {
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

/// The next Sunday at 20:00:00 in local wall-clock, formatted
/// `YYYY-MM-DDTHH:MM:SS` (ADR-0031). `now_ms` is epoch milliseconds (UTC) and
/// `offset_minutes` shifts it to the review-anchor local wall clock. A Sunday
/// strictly before 20:00 local resolves to the same day; at or after 20:00 it
/// rolls to the following Sunday. Hand-rolled proleptic-Gregorian math (no date
/// crate), mirroring the file's existing wall-clock parser.
pub(crate) fn next_review_at_local(now_ms: i64, offset_minutes: i64) -> String {
    let local_ms = now_ms + offset_minutes * 60_000;
    let local_secs = local_ms.div_euclid(1000);
    let days = local_secs.div_euclid(86_400);
    let secs_of_day = local_secs.rem_euclid(86_400);

    // 1970-01-01 is a Thursday; with Sunday=0 that is weekday 4.
    let weekday = (days.rem_euclid(7) + 4).rem_euclid(7);
    let delta = if weekday == 0 && secs_of_day < 20 * 3_600 {
        0
    } else if weekday == 0 {
        7
    } else {
        7 - weekday
    };

    let (year, month, day) = civil_from_days(days + delta);
    format!("{year:04}-{month:02}-{day:02}T20:00:00")
}

/// Civil (year, month, day) for a count of days since 1970-01-01, proleptic
/// Gregorian (Howard Hinnant's `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
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
/// (Howard Hinnant's `days_from_civil`); the inverse of [`civil_from_days`],
/// used to cross-check the round trip in tests.
#[cfg(test)]
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
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
    use serde_json::json;

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
        assert!(!is_overdue("active", None, now), "no due date is never overdue");
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
        assert!(!is_due_soon("active", None, horizon), "no due date is not due soon");
        assert!(!is_due_soon("completed", Some("2026-06-14T00:00:00"), horizon));
        assert!(!is_due_soon("dropped", Some("2026-06-14T00:00:00"), horizon));
    }

    #[test]
    fn accepts_minimal_journal_entry() {
        assert!(
            validate_journal_entry(&json!({
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "text", "text": "Talked to Alice." }]
            }))
            .is_ok()
        );
    }

    #[test]
    fn accepts_equal_or_later_ended_at() {
        assert!(
            validate_journal_entry(&json!({
                "occurred_at": "2026-06-10T10:30:00",
                "ended_at": "2026-06-10T10:30:00",
                "body": [{ "type": "text", "text": "Talked to Alice." }]
            }))
            .is_ok()
        );
        assert!(
            validate_journal_entry(&json!({
                "occurred_at": "2026-06-10T10:30:00",
                "ended_at": "2026-06-10T11:00:00",
                "body": [{ "type": "text", "text": "Talked to Alice." }]
            }))
            .is_ok()
        );
    }

    #[test]
    fn rejects_missing_or_empty_occurred_at() {
        assert!(
            validate_journal_entry(&json!({ "body": [{ "type": "text", "text": "x" }] })).is_err()
        );
        assert!(
            validate_journal_entry(
                &json!({ "occurred_at": "", "body": [{ "type": "text", "text": "x" }] })
            )
            .is_err()
        );
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
        assert!(
            validate(
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
            .is_ok()
        );
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
        assert!(
            validate(
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
            .is_ok()
        );
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
        assert!(
            validate(
                "create_journal_entry",
                &json!({
                    "occurred_at": "2026-06-10T10:30:00",
                    "body": [{ "type": "text", "text": "Talked to Alice." }]
                })
            )
            .is_ok()
        );
        assert!(
            validate(
                "delete_journal_entry",
                &json!({
                    "entity_id": Uuid::now_v7().to_string()
                })
            )
            .is_ok()
        );
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
        assert!(
            validate_person(&json!({
                "name": "Alice",
                "note": "daycare coordinator",
                "aliases": ["Al", "Ali"]
            }))
            .is_ok()
        );
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
        assert!(
            validate(
                "update_person",
                &json!({ "entity_id": Uuid::now_v7().to_string(), "name": "Alice", "note": "x" })
            )
            .is_ok()
        );
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
        let reason = validate("update_person", &json!({ "entity_id": "nope", "name": "Alice" }))
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
    fn accepts_project_with_active_or_on_hold_status() {
        assert!(validate_project(&json!({ "name": "Roadmap", "status": "active" })).is_ok());
        assert!(validate_project(&json!({ "name": "Roadmap", "status": "on_hold" })).is_ok());
    }

    #[test]
    fn accepts_completed_project_with_completed_at() {
        assert!(
            validate_project(&json!({
                "name": "Roadmap",
                "status": "completed",
                "completed_at": "2026-06-10T10:00:00"
            }))
            .is_ok()
        );
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
        assert!(
            validate_project(&json!({
                "name": "Roadmap",
                "review_every": { "interval": 1, "unit": "week" }
            }))
            .is_ok()
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
        let reason = validate("update_project", &json!({ "name": "Roadmap" }))
            .expect_err("update requires a target entity_id");
        assert!(
            reason.contains("entity_id"),
            "reason names the missing entity_id: {reason}"
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
        assert!(
            validate_todo(&json!({
                "todo": { "title": "x", "status": "completed", "completed_at": "2026-06-10T10:00:00" }
            }))
            .is_ok()
        );
        assert!(
            validate_todo(&json!({
                "todo": { "title": "x", "status": "dropped", "dropped_at": "2026-06-10T10:00:00" }
            }))
            .is_ok()
        );
    }

    #[test]
    fn accepts_todo_with_project_link_and_person_refs_array() {
        // project_id existence is a decide-time check, not the pure validator's.
        assert!(
            validate_todo(&json!({
                "todo": { "title": "x", "project_id": "some-id" },
                "person_refs": [{ "person_id": "alice", "role": "waiting_on" }]
            }))
            .is_ok()
        );
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
        assert!(
            validate_todo(&json!({
                "todo": { "title": "x" },
                "person_refs": [
                    { "person_id": "alice", "role": "waiting_on" },
                    { "person_id": "bob" }
                ]
            }))
            .is_ok()
        );

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
        assert!(validate("create_person", &json!({ "name": "Alice", "source_journal_entry_id": je })).is_ok());
        assert!(
            validate("create_project", &json!({ "name": "Roadmap", "source_journal_entry_id": je }))
                .is_ok()
        );
        assert!(
            validate(
                "create_todo",
                &json!({ "todo": { "title": "follow up" }, "source_journal_entry_id": je })
            )
            .is_ok()
        );
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
        assert!(reason.contains("name"), "reason names the missing name: {reason}");
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
        assert!(
            validate(
                "update_todo",
                &json!({
                    "todo_id": Uuid::now_v7().to_string(),
                    "todo": { "due_at": "2026-07-01T09:00:00" },
                    "set_person_refs": [{ "person_id": "alice", "role": "related" }],
                    "add_person_refs": [{ "person_id": "bob" }],
                    "remove_person_ids": ["carol"]
                })
            )
            .is_ok()
        );
        // A lone status (no completed_at) is fine for the PURE validator — the
        // invariant is checked on the merged whole at apply-time.
        assert!(
            validate(
                "update_todo",
                &json!({ "todo_id": Uuid::now_v7().to_string(), "todo": { "status": "completed" } })
            )
            .is_ok()
        );
        // A bare todo_id (no changes) is also valid.
        assert!(
            validate("update_todo", &json!({ "todo_id": Uuid::now_v7().to_string() })).is_ok()
        );
    }

    #[test]
    fn update_todo_requires_a_uuid_todo_id() {
        let reason = validate("update_todo", &json!({ "todo": { "due_at": "2026-07-01T09:00:00" } }))
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
        assert!(reason.contains("title"), "reason names the blank title: {reason}");
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
}
