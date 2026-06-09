//! Entity schemas (ADR-0004 tier 2). A Proposal's proposed `data` is validated
//! against its Entity Type's schema before it is durably applied (ADR-0016 —
//! Core is the authority for what lands in tier 2). Callers reach this module
//! by Entity Type `kind` string through [`validate`], [`render_accept`], and
//! [`schema_version`], so neither the `proposal/decide` handler nor the db
//! layer names a specific Entity Type. Each dispatcher is a plain `match` over
//! the modelled types (`todo`, `person`) — directional toward a future
//! Entity-Type→validator registry (ADR-0025 as-built note) without building the
//! enum/trait yet.

use serde_json::Value;

/// The schema version stamped onto a freshly-created entity + its first
/// revision. Bump when the Todo `data` shape changes (none yet).
pub const TODO_SCHEMA_VERSION: i64 = 1;

/// The schema version stamped onto a freshly-created Person + its first
/// revision. Bump when the Person `data` shape changes (none yet).
pub const PERSON_SCHEMA_VERSION: i64 = 1;

/// Validate a proposed entity `data` payload against its Entity Type's schema
/// (ADR-0016), dispatched on the `kind` string. An unsupported Entity Type is
/// itself a validation failure. Returns `Err(reason)` describing the first
/// violation — surfaced as the `invalid_params` message on `proposal/decide`.
pub(crate) fn validate(kind: &str, data: &Value) -> Result<(), String> {
    match kind {
        "todo" => validate_todo(data),
        "person" => validate_person(data),
        _ => Err(format!("entity kind {kind:?} not supported")),
    }
}

/// Render the human-readable Decision text the model reads on resume as the
/// awaited tool's result (ADR-0025), dispatched on Entity Type. For an accepted
/// entity: a short confirmation naming the created entity.
pub(crate) fn render_accept(kind: &str, data: &Value) -> String {
    match kind {
        "todo" => {
            let title = data.get("title").and_then(|v| v.as_str()).unwrap_or("");
            format!("Accepted. Created Todo {title:?}.")
        }
        "person" => {
            let name = data.get("name").and_then(|v| v.as_str()).unwrap_or("");
            format!("Accepted. Created Person {name:?}.")
        }
        // `validate` rejects unknown Entity Types before any apply path reaches
        // here, so an unsupported kind is a Core bug — fail loud rather than
        // fabricate a confirmation for an unsupported type.
        other => unreachable!("render_accept for unvalidated entity kind {other:?}"),
    }
}

/// The schema version to stamp onto a freshly-created entity of this Entity
/// Type + its first revision, dispatched on `kind`.
pub(crate) fn schema_version(kind: &str) -> i64 {
    match kind {
        "todo" => TODO_SCHEMA_VERSION,
        "person" => PERSON_SCHEMA_VERSION,
        // `validate` rejects unknown Entity Types before any apply path reaches
        // here. Reaching this arm would persist a fabricated version (e.g. stamp
        // a Person as Todo v1), so it is a Core bug — fail loud, don't synthesize.
        other => unreachable!("schema_version for unvalidated entity kind {other:?}"),
    }
}

/// Validate a proposed Todo `data` payload (ADR-0016). The Todo shape:
/// - `title`: required, a non-empty string.
/// - `done`: optional bool (defaulted to `false` when absent — not enforced
///   here, the apply path defaults it).
/// - `due`: optional string.
///
/// Returns `Err(reason)` describing the first violation, used as the
/// `invalid_params` message on `proposal/decide`. Validation is shape-only:
/// it neither mutates nor defaults the payload.
fn validate_todo(data: &Value) -> Result<(), String> {
    let obj = data
        .as_object()
        .ok_or_else(|| "todo data must be a JSON object".to_string())?;

    match obj.get("title") {
        Some(Value::String(t)) if !t.trim().is_empty() => {}
        Some(Value::String(_)) => return Err("todo title must not be empty".to_string()),
        Some(_) => return Err("todo title must be a string".to_string()),
        None => return Err("todo title is required".to_string()),
    }

    if let Some(done) = obj.get("done")
        && !done.is_boolean()
    {
        return Err("todo done must be a boolean".to_string());
    }

    if let Some(due) = obj.get("due")
        && !due.is_string()
    {
        return Err("todo due must be a string".to_string());
    }

    Ok(())
}

/// Validate a proposed Person `data` payload (ADR-0016). The Person shape:
/// - `name`: required, a non-empty string.
/// - `note`: optional string (the freeform catch-all; structured fields evolve
///   via `schema_version` per ADR-0017).
///
/// Returns `Err(reason)` describing the first violation, used as the
/// `invalid_params` message on `proposal/decide`. Validation is shape-only:
/// it neither mutates nor defaults the payload.
fn validate_person(data: &Value) -> Result<(), String> {
    let obj = data
        .as_object()
        .ok_or_else(|| "person data must be a JSON object".to_string())?;

    match obj.get("name") {
        Some(Value::String(n)) if !n.trim().is_empty() => {}
        Some(Value::String(_)) => return Err("person name must not be empty".to_string()),
        Some(_) => return Err("person name must be a string".to_string()),
        None => return Err("person name is required".to_string()),
    }

    if let Some(note) = obj.get("note")
        && !note.is_string()
    {
        return Err("person note must be a string".to_string());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_minimal_todo() {
        assert!(validate_todo(&json!({ "title": "buy milk" })).is_ok());
    }

    #[test]
    fn accepts_full_todo() {
        assert!(
            validate_todo(&json!({ "title": "buy milk", "done": false, "due": "2026-01-01" }))
                .is_ok()
        );
    }

    #[test]
    fn rejects_missing_or_empty_title() {
        assert!(validate_todo(&json!({})).is_err());
        assert!(validate_todo(&json!({ "title": "" })).is_err());
        assert!(validate_todo(&json!({ "title": "   " })).is_err());
    }

    #[test]
    fn rejects_wrong_types() {
        assert!(validate_todo(&json!({ "title": 42 })).is_err());
        assert!(validate_todo(&json!({ "title": "x", "done": "yes" })).is_err());
        assert!(validate_todo(&json!({ "title": "x", "due": 5 })).is_err());
        assert!(validate_todo(&json!("not an object")).is_err());
    }

    #[test]
    fn validate_dispatches_todo_ok() {
        assert!(validate("todo", &json!({ "title": "buy milk" })).is_ok());
    }

    #[test]
    fn validate_dispatches_todo_bad_returns_reason() {
        let reason = validate("todo", &json!({})).expect_err("empty todo is invalid");
        assert!(reason.contains("title"), "reason names the missing field: {reason}");
    }

    #[test]
    fn validate_rejects_unsupported_kind() {
        let reason = validate("project", &json!({ "name": "Roadmap" }))
            .expect_err("project kind is unsupported");
        assert!(
            reason.contains("project") && reason.contains("not supported"),
            "unsupported reason names the kind: {reason}"
        );
    }

    #[test]
    fn render_accept_todo_confirms_creation() {
        let text = render_accept("todo", &json!({ "title": "buy milk" }));
        assert!(
            text.contains("Todo") && text.contains("buy milk"),
            "confirmation names the created Todo: {text}"
        );
    }

    #[test]
    fn schema_version_todo_is_one() {
        assert_eq!(schema_version("todo"), TODO_SCHEMA_VERSION);
        assert_eq!(schema_version("todo"), 1);
    }

    #[test]
    fn accepts_minimal_person() {
        assert!(validate_person(&json!({ "name": "Alice" })).is_ok());
    }

    #[test]
    fn accepts_person_with_note() {
        assert!(
            validate_person(&json!({ "name": "Alice", "note": "met at the daycare" })).is_ok()
        );
    }

    #[test]
    fn rejects_missing_or_empty_name() {
        assert!(validate_person(&json!({})).is_err());
        assert!(validate_person(&json!({ "name": "" })).is_err());
        assert!(validate_person(&json!({ "name": "   " })).is_err());
    }

    #[test]
    fn rejects_person_wrong_types() {
        assert!(validate_person(&json!({ "name": 42 })).is_err());
        assert!(validate_person(&json!({ "name": "Alice", "note": 5 })).is_err());
        assert!(validate_person(&json!("not an object")).is_err());
    }

    #[test]
    fn validate_dispatches_person_ok() {
        assert!(validate("person", &json!({ "name": "Alice" })).is_ok());
    }

    #[test]
    fn render_accept_person_confirms_creation() {
        let text = render_accept("person", &json!({ "name": "Alice" }));
        assert!(
            text.contains("Person") && text.contains("Alice"),
            "confirmation names the created Person: {text}"
        );
    }

    #[test]
    fn schema_version_person_is_one() {
        assert_eq!(schema_version("person"), PERSON_SCHEMA_VERSION);
        assert_eq!(schema_version("person"), 1);
    }
}
