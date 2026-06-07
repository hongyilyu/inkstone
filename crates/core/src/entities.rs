//! Entity schemas (ADR-0004 tier 2). A Proposal's proposed `data` is validated
//! against its entity type's schema before it is durably applied (ADR-0016 —
//! Core is the authority for what lands in tier 2). Slice 3 models exactly one
//! type, `todo`; slice 5 (edit) reuses [`validate_todo`] for the edited payload.

use serde_json::Value;

/// The schema version stamped onto a freshly-created entity + its first
/// revision. Bump when the Todo `data` shape changes (none yet).
pub const TODO_SCHEMA_VERSION: i64 = 1;

/// Validate a proposed Todo `data` payload (ADR-0016). The Todo shape:
/// - `title`: required, a non-empty string.
/// - `done`: optional bool (defaulted to `false` when absent — not enforced
///   here, the apply path defaults it).
/// - `due`: optional string.
///
/// Returns `Err(reason)` describing the first violation, used as the
/// `invalid_params` message on `proposal/decide`. Validation is shape-only:
/// it neither mutates nor defaults the payload.
pub fn validate_todo(data: &Value) -> Result<(), String> {
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
}
