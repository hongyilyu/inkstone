//! Workspace mutation schemas (ADR-0016, ADR-0025). A Proposal's payload is
//! validated by `mutation_kind` before it is durably applied. The first
//! supported mutation is `create_journal_entry`; it creates a `journal_entry`
//! Entity plus provenance from the source user Message.

use serde_json::Value;

/// The schema version stamped onto a freshly-created Journal Entry + its first
/// revision.
pub const JOURNAL_ENTRY_SCHEMA_VERSION: i64 = 1;

/// Validate a proposed mutation payload against its schema (ADR-0016),
/// dispatched on `mutation_kind`. An unsupported mutation is itself a
/// validation failure. Returns `Err(reason)` describing the first
/// violation — surfaced as the `invalid_params` message on `proposal/decide`.
pub(crate) fn validate(mutation_kind: &str, payload: &Value) -> Result<(), String> {
    match mutation_kind {
        "create_journal_entry" => validate_journal_entry(payload),
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
        other => unreachable!("render_accept for unvalidated mutation_kind {other:?}"),
    }
}

fn journal_body_text(payload: &Value) -> String {
    let Some(body) = payload.get("body").and_then(Value::as_array) else {
        return "unknown".to_string();
    };
    let text = body
        .iter()
        .filter_map(|node| node.get("text").and_then(Value::as_str))
        .collect::<String>();
    if text.trim().is_empty() {
        "unknown".to_string()
    } else {
        text
    }
}

/// The schema version to stamp onto a freshly-created entity of this Entity
/// Type + its first revision, dispatched on `mutation_kind`.
pub(crate) fn schema_version(mutation_kind: &str) -> i64 {
    match mutation_kind {
        "create_journal_entry" => JOURNAL_ENTRY_SCHEMA_VERSION,
        other => unreachable!("schema_version for unvalidated mutation_kind {other:?}"),
    }
}

pub(crate) fn entity_type(mutation_kind: &str) -> &'static str {
    match mutation_kind {
        "create_journal_entry" => "journal_entry",
        other => unreachable!("entity_type for unvalidated mutation_kind {other:?}"),
    }
}

pub(crate) fn source_relation_from_user_message(mutation_kind: &str) -> Option<&'static str> {
    match mutation_kind {
        "create_journal_entry" => Some("created_from"),
        other => unreachable!("source relation for unvalidated mutation_kind {other:?}"),
    }
}

fn validate_journal_entry(payload: &Value) -> Result<(), String> {
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
        for key in node.keys() {
            if key != "type" && key != "text" {
                return Err(format!("unsupported body node field {key:?}"));
            }
        }
        match node.get("type") {
            Some(Value::String(t)) if t == "text" => {}
            Some(Value::String(_)) => {
                return Err("body supports only text nodes in this slice".to_string());
            }
            Some(_) => return Err("body node type must be a string".to_string()),
            None => return Err("body node type is required".to_string()),
        }
        match node.get("text") {
            Some(Value::String(t)) if !t.trim().is_empty() => {}
            Some(Value::String(_)) => return Err("body text must not be empty".to_string()),
            Some(_) => return Err("body text must be a string".to_string()),
            None => return Err("body text is required".to_string()),
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
        .expect_err("entity_ref nodes are not persisted in this slice");
        assert!(
            reason.contains("text nodes"),
            "reason names text-only body: {reason}"
        );
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
    fn schema_version_journal_entry_is_one() {
        assert_eq!(
            schema_version("create_journal_entry"),
            JOURNAL_ENTRY_SCHEMA_VERSION
        );
        assert_eq!(schema_version("create_journal_entry"), 1);
    }
}
