//! The `propose_ticktick_task` proposal tool (ticktick-writes W-A2): the ONE
//! entry point of the ONE remote write. The model's propose call itself parks
//! as the Proposal (no wrapper, no second write path); on accept, Core — not
//! the Worker — executes one `POST /open/v1/task` (see
//! [`crate::ticktick_write`]). A dedicated tool, NOT a 13th
//! `ProposableMutation` kind: its exposure lever is the Workflow manifest's
//! `tools` list (ship dark until the W4 cutover), and its descriptor carries
//! the TickTick-specific guidance where the model reads it.

use serde_json::Value;

use crate::protocol::CoreToolDescriptor;
use crate::tools::ToolError;

pub const NAME: &str = "propose_ticktick_task";
const DESCRIPTION: &str = "Propose creating ONE task in the user's TickTick (their task \
    system) for user review. Use this when the user asks to be reminded of something or to \
    track a task (\"Remind me to buy milk\", \"I need to email Alice\"). The task lands in \
    TickTick's Inbox — no list, tags, or priority can be set. Propose one task per call; do \
    not propose a task the user did not ask to track, and never propose a Journal Entry for \
    a bare reminder. You cannot complete, edit, or delete TickTick tasks.";
const LABEL: &str = "Propose TickTick task";

/// The agent tool descriptor (ADR-0018): `{payload: {title, note?, due?},
/// rationale?}` — the same `{payload, rationale}` envelope every Proposal
/// card reads, minus a `mutation_kind` (the stored kind derives from the tool
/// name). Inlined Draft-07 (no `$ref`): Anthropic rejects refs.
pub fn descriptor() -> CoreToolDescriptor {
    let payload_schema = serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "title": {
                "type": "string",
                "minLength": 1,
                "description": "The task title, as the user would phrase it."
            },
            "note": {
                "type": "string",
                "description": "Optional context carried on the task's note."
            },
            "due": {
                "type": "object",
                "additionalProperties": false,
                "description": "Optional due. Include ONLY when the user gave one.",
                "properties": {
                    "date": {
                        "type": "string",
                        "description": "OFFSET-BEARING datetime \
                         YYYY-MM-DDTHH:MM:SS(Z|±HH:MM|±HHMM) — the user's local wall \
                         time WITH its UTC offset (never a bare local time). For an \
                         all-day due, local midnight in time_zone."
                    },
                    "is_all_day": { "type": "boolean", "default": false },
                    "time_zone": {
                        "type": "string",
                        "description": "IANA zone (e.g. America/Los_Angeles). Required \
                         for a timed due."
                    }
                },
                "required": ["date"]
            }
        },
        "required": ["title"]
    });

    CoreToolDescriptor {
        name: NAME.to_string(),
        description: DESCRIPTION.to_string(),
        label: LABEL.to_string(),
        json_schema: serde_json::json!({
            "title": "Input",
            "description": "Wire arguments: `payload` is the task to create, validated \
             by Core; `rationale` is your short explanation for the review card.",
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "payload": payload_schema,
                "rationale": { "type": ["string", "null"], "default": null },
            },
            "required": ["payload"],
        }),
    }
}

/// Pre-park request validation (W-A2, "full validation before park, like
/// RecordObservations"): the `{payload, rationale}` envelope shape plus the
/// task payload through the SAME validator phase A re-runs on the effective
/// payload.
pub(crate) fn validate_request(params: &Value) -> Result<(), String> {
    let obj = params
        .as_object()
        .ok_or_else(|| "propose_ticktick_task params must be a JSON object".to_string())?;
    for key in obj.keys() {
        if !matches!(key.as_str(), "payload" | "rationale") {
            return Err(format!("unsupported propose_ticktick_task field {key:?}"));
        }
    }
    let payload = obj
        .get("payload")
        .ok_or_else(|| "payload is required".to_string())?;
    crate::ticktick_write::validate_task_payload(payload)?;
    if let Some(rationale) = obj.get("rationale")
        && !rationale.is_string()
        && !rationale.is_null()
    {
        return Err("rationale must be a string or null".to_string());
    }
    Ok(())
}

/// The pre-park CONNECTION gate (W-A2): a propose on a missing or read-only
/// TickTick connection fails as a NORMAL tool error — the model redirects the
/// user to provisioning; nothing parks, no dead card. `None` = proceed to
/// park.
pub(crate) fn pre_park_refusal() -> Option<ToolError> {
    match crate::ticktick::connection() {
        None => Some(ToolError {
            code: "ticktick_not_connected".to_string(),
            message: "TickTick is not connected".to_string(),
        }),
        Some(conn) if !conn.writable => Some(ToolError {
            code: "ticktick_not_writable".to_string(),
            message: "the TickTick token lacks tasks:write".to_string(),
        }),
        Some(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptor_names_the_contract() {
        let d = descriptor();
        assert_eq!(d.name, "propose_ticktick_task");
        assert_eq!(d.label, "Propose TickTick task");
        // The name must NOT wear the reserved external prefix (the registry
        // sweep also pins this) — the call renders as a proposal card, never
        // an external expandable row.
        assert!(!d.name.starts_with(crate::tools::EXTERNAL_TOOL_PREFIX));
        let description = d.description.to_lowercase();
        assert!(
            description.contains("inbox")
                && description.contains("one task per call")
                && description.contains("cannot complete, edit, or delete"),
            "the description carries the TickTick-specific rules: {description:?}"
        );
        // Fully inlined (no $ref — Anthropic rejects refs).
        assert!(!d.json_schema.to_string().contains("$ref"));
        let required = d.json_schema["required"].as_array().unwrap();
        assert_eq!(required.len(), 1);
        assert_eq!(required[0], "payload");
    }

    #[test]
    fn validate_request_accepts_the_envelope_and_rejects_strays() {
        // Minimal.
        validate_request(&serde_json::json!({ "payload": { "title": "buy milk" } }))
            .expect("minimal payload validates");
        // Full, with rationale.
        validate_request(&serde_json::json!({
            "payload": {
                "title": "buy milk",
                "note": "2%",
                "due": {
                    "date": "2026-09-01T17:30:00-0700",
                    "is_all_day": false,
                    "time_zone": "America/Los_Angeles"
                }
            },
            "rationale": "the user asked for a reminder"
        }))
        .expect("full payload validates");

        // Envelope failures.
        assert!(validate_request(&serde_json::json!("nope")).is_err());
        assert!(validate_request(&serde_json::json!({})).is_err(), "payload required");
        assert!(
            validate_request(&serde_json::json!({
                "payload": { "title": "x" },
                "mutation_kind": "create_ticktick_task"
            }))
            .is_err(),
            "a stray mutation_kind field is rejected (the kind derives from the tool name)"
        );
        assert!(
            validate_request(&serde_json::json!({ "payload": { "title": "x" }, "rationale": 4 }))
                .is_err(),
            "a non-string rationale is rejected"
        );
        // Payload failures ride through the shared validator.
        assert!(
            validate_request(&serde_json::json!({ "payload": { "title": "   " } })).is_err(),
            "a whitespace title is rejected"
        );
    }

    /// The connection gate's three answers (W-A2): not connected / read-only
    /// scope → a NORMAL tool error naming the fix; writable → proceed.
    #[test]
    fn pre_park_refusal_gates_on_connection_and_scope() {
        let disconnected = crate::ticktick::token::test_override::install(None);
        let refusal = pre_park_refusal().expect("no connection refuses");
        assert_eq!(refusal.code, "ticktick_not_connected");
        drop(disconnected);

        let read_only = crate::ticktick::token::test_override::install(Some(
            crate::ticktick::token::test_override::test_connection_read_only("tok", "conn-ro"),
        ));
        let refusal = pre_park_refusal().expect("a read-only token refuses");
        assert_eq!(refusal.code, "ticktick_not_writable");
        assert!(refusal.message.contains("tasks:write"));
        drop(read_only);

        let writable = crate::ticktick::token::test_override::install(Some(
            crate::ticktick::token::test_override::test_connection("tok", "conn-rw"),
        ));
        assert!(pre_park_refusal().is_none(), "a writable connection proceeds");
        drop(writable);
    }
}
