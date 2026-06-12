//! Workspace mutation schemas (ADR-0016, ADR-0025). A Proposal's payload is
//! validated by `mutation_kind` before it is durably applied. Supported
//! mutations create/update/delete a `journal_entry` Entity (plus provenance)
//! and add inline references from Journal Entries to existing Entities.

use serde_json::Value;
use uuid::Uuid;

/// The schema version stamped onto a freshly-created Journal Entry + its first
/// revision.
pub const JOURNAL_ENTRY_SCHEMA_VERSION: i64 = 1;

/// Validate a proposed mutation payload against its schema (ADR-0016),
/// dispatched on `mutation_kind`. An unsupported mutation is a validation
/// failure. `Err(reason)` is surfaced as the `invalid_params` message on
/// `proposal/decide`.
pub(crate) fn validate(mutation_kind: &str, payload: &Value) -> Result<(), String> {
    match mutation_kind {
        "create_journal_entry" => validate_journal_entry(payload),
        "update_journal_entry" => validate_update_journal_entry(payload),
        "delete_journal_entry" => validate_delete_journal_entry(payload),
        "reference_existing_entity_from_journal_entry" => {
            validate_reference_existing_entity_from_journal_entry(payload)
        }
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
        other => unreachable!("schema_version for unvalidated mutation_kind {other:?}"),
    }
}

pub(crate) fn entity_type(mutation_kind: &str) -> &'static str {
    match mutation_kind {
        "create_journal_entry"
        | "update_journal_entry"
        | "delete_journal_entry"
        | "reference_existing_entity_from_journal_entry" => "journal_entry",
        other => unreachable!("entity_type for unvalidated mutation_kind {other:?}"),
    }
}

pub(crate) fn source_relation_from_user_message(mutation_kind: &str) -> Option<&'static str> {
    match mutation_kind {
        "create_journal_entry" => Some("created_from"),
        "update_journal_entry" | "reference_existing_entity_from_journal_entry" => {
            Some("updated_from")
        }
        "delete_journal_entry" => None,
        other => unreachable!("source relation for unvalidated mutation_kind {other:?}"),
    }
}

pub(crate) fn target_entity_id<'a>(mutation_kind: &str, payload: &'a Value) -> Option<&'a str> {
    match mutation_kind {
        "update_journal_entry" | "delete_journal_entry" => {
            payload.get("entity_id").and_then(Value::as_str)
        }
        "reference_existing_entity_from_journal_entry" => {
            payload.get("source_entity_id").and_then(Value::as_str)
        }
        "create_journal_entry" => None,
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

fn validate_delete_journal_entry(payload: &Value) -> Result<(), String> {
    let obj = payload
        .as_object()
        .ok_or_else(|| "delete_journal_entry payload must be a JSON object".to_string())?;

    let entity_id = match obj.get("entity_id") {
        Some(Value::String(value)) if !value.trim().is_empty() => value,
        Some(Value::String(_)) => return Err("entity_id must not be empty".to_string()),
        Some(_) => return Err("entity_id must be a string".to_string()),
        None => return Err("entity_id is required".to_string()),
    };
    Uuid::parse_str(entity_id).map_err(|_| "entity_id must be a UUID".to_string())?;

    for key in obj.keys() {
        if key != "entity_id" {
            return Err(format!("unsupported delete_journal_entry field {key:?}"));
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
    fn validate_rejects_unsupported_mutation_kind() {
        let reason = validate("create_project", &json!({ "name": "Roadmap" }))
            .expect_err("project mutation is unsupported");
        assert!(
            reason.contains("create_project") && reason.contains("not supported"),
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
}
