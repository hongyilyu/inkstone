//! `run/*` wire types (post_message, subscribe, cancel, retry, get_history)
//! plus the streaming [`RunEvent`] union they carry (ADR-0009 hand-mirror).

use serde::{Deserialize, Serialize};

/// `run/post_message` params: add a message (and its Run) to an existing Thread
/// (ADR-0022). Minting a new Thread is `thread/create`'s job, so `thread_id` is
/// required; malformed → `invalid_params` (-32602), unknown → `unknown_thread`
/// (-32001). `attachment_ids` are media ids from prior `media/upload` calls to
/// link to the user Message (ADR-0058); `#[serde(default)]` keeps the field
/// optional on the wire (the TS side is `S.optional`) — an unknown id rejects
/// `invalid_params` with zero rows.
#[derive(Debug, Deserialize)]
pub struct PostMessageParams {
    pub thread_id: uuid::Uuid,
    pub prompt: String,
    #[serde(default)]
    pub attachment_ids: Vec<String>,
}

/// `run/subscribe` params: the Run to attach to. Snapshot-then-tail (ADR-0022) —
/// Core replies with the cumulative text as a `text_delta`, then forwards the
/// live tail until `done`.
#[derive(Debug, Deserialize)]
pub struct SubscribeParams {
    pub run_id: uuid::Uuid,
}

/// `run/subscribe` result (ADR-0022, ADR-0025): the Run's `status` at subscribe
/// time — `running` while a live stream exists, else the persisted
/// `runs.status` (notably `parked`, which a refreshed Client must not mistake
/// for terminal).
#[derive(Debug, Serialize)]
pub struct SubscribeResult {
    pub run_id: String,
    pub status: String,
}

/// `run/cancel` params (ADR-0014): the Run to cancel.
#[derive(Debug, Deserialize)]
pub struct RunCancelParams {
    pub run_id: uuid::Uuid,
}

/// `run/cancel` result (ADR-0014): `accepted` (live/parked, now cancelling),
/// `already_terminal` (finished before the cancel arrived), or `unknown_run`.
#[derive(Debug, Serialize)]
pub struct RunCancelResult {
    pub outcome: String,
}

/// `run/retry` params (ADR-0028 retry amendment, #230): the errored Run to
/// re-drive in place. Malformed → `invalid_params`, mirroring `run/cancel`.
#[derive(Debug, Deserialize)]
pub struct RunRetryParams {
    pub run_id: uuid::Uuid,
}

/// `run/retry` result (ADR-0028 retry amendment, #230): `accepted` (the errored
/// Run won the `errored → running` flip and is re-driving), `not_errored` (the
/// Run was not in `errored` — a normal response value, not an error frame, like
/// `RunCancelResult`'s `already_terminal`), or `unknown_run`.
#[derive(Debug, Serialize)]
pub struct RunRetryResult {
    pub outcome: String,
}

#[derive(Debug, Serialize)]
pub struct PostMessageResult {
    pub run_id: String,
}

/// `run/get_history` params: an optional `limit` on how many recent Runs to
/// return (Core defaults to `RUN_HISTORY_DEFAULT_LIMIT` when omitted/null).
#[derive(Debug, Default, Deserialize)]
pub struct RunGetHistoryParams {
    #[serde(default)]
    pub limit: Option<i64>,
}

/// One Run in the `run/get_history` recent-Runs feed (ADR-0028 as-built). `kind`
/// is the Run's *latest* Run Log milestone verbatim — one of the seven Run Log
/// kinds, deliberately not folded into `runs.status` (a resumed-still-working
/// Run reads `proposal_decided`, since `resume` writes no Run Log row). `title`
/// is the owning Thread's title; `at` is the milestone's ms-epoch `created_at`,
/// which is also the recency key. Hand-authored wire struct (not a `PayloadSpec`
/// kind), so it sits outside the schema-parity gate — like `ThreadSummary`.
#[derive(Debug, Serialize)]
pub struct RunHistoryItem {
    pub run_id: String,
    pub thread_id: String,
    pub title: String,
    pub kind: String,
    pub at: i64,
}

/// `run/get_history` result: recent Runs, newest-first. Object-wrapper shape
/// (`{runs: [...]}`) keeps the result forward-extensible, mirroring
/// `ThreadListResult`.
#[derive(Debug, Serialize)]
pub struct RunHistoryResult {
    pub runs: Vec<RunHistoryItem>,
}

/// Lifecycle status of a tool call on the Run Event stream (ADR-0006).
/// `Started` is published on the `tool_request`; `Completed`/`Error` mirror the
/// dispatch outcome. Serializes snake_case.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallStatus {
    Started,
    Completed,
    Error,
}

/// Run Event forwarded to Clients as a `run/event` Notification (ADR-0006). Most
/// variants come from the Worker's stdout NDJSON stream. `ToolCall` and
/// `Cancelled` are the exceptions: Core synthesizes them (from `tool_request`s
/// and the guarded cancellation transition, respectively) — both are ephemeral.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RunEvent {
    TextDelta {
        delta: String,
    },
    ToolCall {
        tool_call_id: String,
        name: String,
        status: ToolCallStatus,
        /// The tool's display argument (ADR-0043), e.g. a `search_entities`
        /// query. Omitted for tools that expose none; carried on the live row so
        /// it matches the rehydrated `ToolCallView`.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        arg: Option<String>,
    },
    Done,
    Cancelled,
    Error {
        message: String,
    },
    /// A reasoning (thinking) delta, mirroring `TextDelta` (ADR-0045 reasoning
    /// amendment, #202): Core republishes it from `WorkerStdout::ReasoningDelta`. The
    /// segment boundary is inferred from the interleaved stream — no position field.
    ReasoningDelta {
        delta: String,
    },
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

    #[test]
    fn run_cancel_result_encodes_outcome() {
        for outcome in ["accepted", "already_terminal", "unknown_run"] {
            let r = RunCancelResult {
                outcome: outcome.to_string(),
            };
            assert_eq!(
                serde_json::to_value(&r).unwrap(),
                json!({ "outcome": outcome }),
            );
        }
    }

    #[test]
    fn run_retry_params_decodes_run_id() {
        let wire = json!({ "run_id": UUID_A });
        let p: RunRetryParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.run_id.to_string(), UUID_A);
        // A non-UUID run_id is rejected at decode → invalid_params (ADR-0029).
        assert!(serde_json::from_value::<RunRetryParams>(json!({ "run_id": "nope" })).is_err());
    }

    #[test]
    fn run_retry_result_encodes_outcome() {
        for outcome in ["accepted", "not_errored", "unknown_run"] {
            let r = RunRetryResult {
                outcome: outcome.to_string(),
            };
            assert_eq!(
                serde_json::to_value(&r).unwrap(),
                json!({ "outcome": outcome }),
            );
        }
    }

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
    fn run_event_cancelled_round_trips() {
        let wire = json!({ "kind": "cancelled" });
        let ev: RunEvent = serde_json::from_value(wire.clone()).unwrap();
        assert!(matches!(ev, RunEvent::Cancelled));
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

    #[test]
    fn run_event_tool_call_round_trips_each_status() {
        for (status, wire_status) in [
            (ToolCallStatus::Started, "started"),
            (ToolCallStatus::Completed, "completed"),
            (ToolCallStatus::Error, "error"),
        ] {
            let wire = json!({
                "kind": "tool_call",
                "tool_call_id": "tc_01",
                "name": "read_thread",
                "status": wire_status,
            });
            let ev: RunEvent = serde_json::from_value(wire.clone()).unwrap();
            match &ev {
                RunEvent::ToolCall {
                    tool_call_id,
                    name,
                    status: got,
                    arg,
                } => {
                    assert_eq!(tool_call_id, "tc_01");
                    assert_eq!(name, "read_thread");
                    assert_eq!(*got, status);
                    assert_eq!(*arg, None, "argless tool omits arg");
                }
                other => panic!("expected ToolCall, got {other:?}"),
            }
            // No `arg` key when absent (skip_serializing_if).
            assert_eq!(serde_json::to_value(&ev).unwrap(), wire);
        }
    }

    #[test]
    fn run_event_tool_call_round_trips_with_arg() {
        let wire = json!({
            "kind": "tool_call",
            "tool_call_id": "tc_02",
            "name": "search_entities",
            "status": "started",
            "arg": "Lev",
        });
        let ev: RunEvent = serde_json::from_value(wire.clone()).unwrap();
        match &ev {
            RunEvent::ToolCall { name, arg, .. } => {
                assert_eq!(name, "search_entities");
                assert_eq!(arg.as_deref(), Some("Lev"));
            }
            other => panic!("expected ToolCall, got {other:?}"),
        }
        assert_eq!(serde_json::to_value(&ev).unwrap(), wire);
    }
}
