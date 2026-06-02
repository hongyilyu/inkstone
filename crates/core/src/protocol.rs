//! Wire protocol types: JSON-RPC 2.0 envelope and serde mirrors of the
//! TypeScript schemas in `packages/protocol`. Mirrored by hand per
//! ADR-0009.

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct JsonRpcRequest {
    #[allow(dead_code)] // validated implicitly by deserialize; not branched on yet
    pub jsonrpc: String,
    pub id: serde_json::Value,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: &'static str,
    pub id: serde_json::Value,
    pub result: serde_json::Value,
}

/// `run/post_message` params: add a message (and its Run) to an EXISTING
/// Thread. Existing-thread-only (ADR-0022) — `thread_id` is required and
/// never optional; minting a new Thread is `thread/create`'s job. A
/// malformed `thread_id` is rejected with `invalid_params` (-32602); a
/// well-formed id for a Thread that does not exist with `unknown_thread`
/// (-32001). Field order is cosmetic (serde matches by name; `thread_id` is
/// snake_case to mirror the TS schema, slice 7).
#[derive(Debug, Deserialize)]
pub struct PostMessageParams {
    pub thread_id: String,
    pub prompt: String,
}

/// `run/subscribe` params: the Run to attach to. Snapshot-then-tail
/// (ADR-0022) — Core replies with the cumulative assistant text as a
/// `text_delta` snapshot, then forwards the live tail until `done`.
#[derive(Debug, Deserialize)]
pub struct SubscribeParams {
    pub run_id: String,
}

#[derive(Debug, Serialize)]
pub struct PostMessageResult {
    pub run_id: String,
}

/// `thread/create` params: the first user message. Message-first thread
/// creation (ADR-0022) — a Thread is born only with its first message, so
/// `prompt` is required. An empty/whitespace prompt is rejected with
/// `invalid_params` before any row is written (the trim-empty guard lives
/// in [`crate::runs::handle_thread_create`], not here).
#[derive(Debug, Deserialize)]
pub struct ThreadCreateParams {
    pub prompt: String,
}

/// `thread/create` result: the freshly-minted Thread and its first Run.
/// Pure-subscribe (ADR-0022) — the response carries only these ids; the
/// Client follows with `run/subscribe(run_id)` to receive events.
#[derive(Debug, Serialize)]
pub struct ThreadCreateResult {
    pub thread_id: String,
    pub run_id: String,
}

/// A single Thread row in a `thread/list` result: the sidebar's view of a
/// Thread (ADR-0017 `threads` columns). `last_activity_at` is the ms-epoch
/// the Thread was last touched (bumped on each new Run); the list orders by
/// it, newest-first.
#[derive(Debug, Serialize)]
pub struct ThreadSummary {
    pub id: String,
    pub title: String,
    pub last_activity_at: i64,
}

/// `thread/list` result: every Thread, ordered most-recent-activity-first.
/// Object-wrapper shape (`{threads: [...]}`) rather than a bare array so the
/// result stays forward-extensible and the TS mirror (slice 7) is a
/// `Schema.Struct`.
#[derive(Debug, Serialize)]
pub struct ThreadListResult {
    pub threads: Vec<ThreadSummary>,
}

/// `thread/get` params: the Thread to rehydrate. A malformed `thread_id` is
/// rejected with `invalid_params` (-32602); a well-formed id for a Thread
/// that does not exist with `unknown_thread` (-32001), same as
/// `run/post_message`.
#[derive(Debug, Deserialize)]
pub struct ThreadGetParams {
    pub thread_id: String,
}

/// A single Message in a `thread/get` result. Flat assembled `text`
/// (ADR-0017/Q15): NO `parts[]` array on the wire until attachments exist —
/// `text` is the concatenation of the Message's text parts in `seq` order.
/// `run_id` lets a refreshed Client resubscribe to a `streaming` Message's
/// Run (the rehydration source for refresh-durability).
#[derive(Debug, Serialize)]
pub struct MessageView {
    pub id: String,
    pub role: String,
    pub status: String,
    pub run_id: String,
    pub text: String,
}

/// `thread/get` result: the Thread header (`thread_id`, `title`) plus its
/// Messages in chronological order (`messages`). A completed Run yields full
/// user + assistant text; a mid-stream Run yields a `streaming` assistant
/// Message with its partial text and `run_id`.
#[derive(Debug, Serialize)]
pub struct ThreadGetResult {
    pub thread_id: String,
    pub title: String,
    pub messages: Vec<MessageView>,
}

/// Run Event emitted by the Worker over its stdout NDJSON stream
/// (per ADR-0006). Core deserializes each line into this enum, takes
/// the appropriate persistence action, and forwards it as a `run/event`
/// Notification.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RunEvent {
    TextDelta { delta: String },
    Done,
    Error { message: String },
}

/// Single line written to the Worker's stdin at spawn time, carrying the
/// user prompt the Worker should act on.
#[derive(Debug, Serialize)]
pub struct WorkerInbound<'a> {
    pub prompt: &'a str,
}

/// Mirror tests: lock the Rust serde shapes to the canonical wire JSON the
/// TypeScript `Schema` definitions in `packages/protocol/src/index.ts`
/// produce (hand-mirrored per ADR-0009). Each `#[test]` asserts agreement in
/// the type's available direction — Deserialize-only params decode from the
/// wire literal; Serialize-only results encode to it; `RunEvent` (both)
/// round-trips. The JSON literals are the exact snake_case wire form the TS
/// schemas encode; if a Rust type ever drifts (a renamed field, a changed
/// type), the matching test fails. This is the reconciliation point that
/// guards against future TS/Rust divergence — the mirror of the TS suite's
/// snake_case-preservation cases.
#[cfg(test)]
mod mirror_tests {
    use super::*;
    use serde_json::json;

    // A fixed UUID-shaped string; the wire carries ids as plain strings.
    const UUID_A: &str = "0190d3c1-0000-7000-8000-000000000001";
    const UUID_B: &str = "0190d3c1-0000-7000-8000-000000000002";

    // --- Deserialize-only params: decode the canonical wire JSON. ---

    #[test]
    fn post_message_params_decodes_thread_id_and_prompt() {
        let wire = json!({ "thread_id": UUID_A, "prompt": "hi" });
        let p: PostMessageParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.thread_id, UUID_A);
        assert_eq!(p.prompt, "hi");
    }

    #[test]
    fn subscribe_params_decodes_run_id() {
        let wire = json!({ "run_id": UUID_A });
        let p: SubscribeParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.run_id, UUID_A);
    }

    #[test]
    fn thread_create_params_decodes_prompt() {
        let wire = json!({ "prompt": "hi" });
        let p: ThreadCreateParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.prompt, "hi");
    }

    #[test]
    fn thread_get_params_decodes_thread_id() {
        let wire = json!({ "thread_id": UUID_A });
        let p: ThreadGetParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.thread_id, UUID_A);
    }

    // --- Serialize-only results: encode to the canonical snake_case wire JSON. ---

    #[test]
    fn thread_create_result_encodes_snake_case() {
        let r = ThreadCreateResult {
            thread_id: UUID_A.to_string(),
            run_id: UUID_B.to_string(),
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({ "thread_id": UUID_A, "run_id": UUID_B }),
        );
    }

    #[test]
    fn thread_summary_encodes_with_numeric_last_activity_at() {
        let r = ThreadSummary {
            id: UUID_A.to_string(),
            title: "Title".to_string(),
            last_activity_at: 1_700_000_000_000,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(
            v,
            json!({ "id": UUID_A, "title": "Title", "last_activity_at": 1_700_000_000_000_i64 }),
        );
        // `last_activity_at` must be a bare JSON number (i64 ms-epoch), not a
        // string — the TS mirror is `S.Number`.
        assert!(v["last_activity_at"].is_number());
    }

    #[test]
    fn thread_list_result_encodes_threads_array() {
        let r = ThreadListResult {
            threads: vec![ThreadSummary {
                id: UUID_A.to_string(),
                title: "Title".to_string(),
                last_activity_at: 42,
            }],
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({
                "threads": [
                    { "id": UUID_A, "title": "Title", "last_activity_at": 42 }
                ]
            }),
        );
    }

    #[test]
    fn message_view_encodes_all_string_fields() {
        let r = MessageView {
            id: UUID_A.to_string(),
            role: "assistant".to_string(),
            status: "complete".to_string(),
            run_id: UUID_B.to_string(),
            text: "hello".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({
                "id": UUID_A,
                "role": "assistant",
                "status": "complete",
                "run_id": UUID_B,
                "text": "hello"
            }),
        );
    }

    #[test]
    fn thread_get_result_encodes_header_and_messages() {
        let r = ThreadGetResult {
            thread_id: UUID_A.to_string(),
            title: "Title".to_string(),
            messages: vec![MessageView {
                id: UUID_B.to_string(),
                role: "user".to_string(),
                status: "complete".to_string(),
                run_id: UUID_A.to_string(),
                text: "hi".to_string(),
            }],
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({
                "thread_id": UUID_A,
                "title": "Title",
                "messages": [
                    {
                        "id": UUID_B,
                        "role": "user",
                        "status": "complete",
                        "run_id": UUID_A,
                        "text": "hi"
                    }
                ]
            }),
        );
    }

    // --- RunEvent (Serialize + Deserialize): round-trip both variants (frozen). ---

    #[test]
    fn run_event_text_delta_round_trips() {
        let wire = json!({ "kind": "text_delta", "delta": "x" });
        let ev: RunEvent = serde_json::from_value(wire.clone()).unwrap();
        match &ev {
            RunEvent::TextDelta { delta } => assert_eq!(delta, "x"),
            other => panic!("expected TextDelta, got {other:?}"),
        }
        assert_eq!(serde_json::to_value(&ev).unwrap(), wire);
    }

    #[test]
    fn run_event_done_round_trips() {
        let wire = json!({ "kind": "done" });
        let ev: RunEvent = serde_json::from_value(wire.clone()).unwrap();
        assert!(matches!(ev, RunEvent::Done));
        assert_eq!(serde_json::to_value(&ev).unwrap(), wire);
    }

    #[test]
    fn run_event_error_round_trips() {
        let wire = json!({ "kind": "error", "message": "boom" });
        let ev: RunEvent = serde_json::from_value(wire.clone()).unwrap();
        match &ev {
            RunEvent::Error { message } => assert_eq!(message, "boom"),
            other => panic!("expected Error, got {other:?}"),
        }
        assert_eq!(serde_json::to_value(&ev).unwrap(), wire);
    }
}
