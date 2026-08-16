//! Shared `#[cfg(test)]` scaffolding for the Worker module: the scripted/cancel
//! `WorkerPort` fakes and the seed/inspect helpers used by BOTH the run-loop
//! frame-orchestration tests (worker/run.rs) and the external-call lifecycle
//! tests (worker/external.rs), so neither file re-derives them (review #3).
#![cfg(test)]

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use sqlx::SqlitePool;
use tokio::sync::broadcast;
use uuid::Uuid;

use super::port::WorkerPort;
use crate::db;
use crate::hub::Hubs;
use crate::protocol::{RunEvent, ToolResult, TranscriptToolResult, WorkerStdout};
use crate::workflow::Workflow;

pub(crate) fn test_workflow(tools: &[&str]) -> Workflow {
    Workflow {
        name: "test".to_string(),
        version: "1".to_string(),
        provider: "faux".to_string(),
        model: Some("m".to_string()),
        system_prompt: "sp".to_string(),
        thinking_level: Some("off".to_string()),
        tools: tools.iter().map(|s| s.to_string()).collect(),
        external_tools: false,
    }
}

/// Seed a Thread + initial Run (so an assistant row at seq 0 exists for
/// `run_loop` to append into). Returns `(run_id, thread_id, assistant_id)`.
pub(crate) async fn seed_run(pool: &SqlitePool, workflow: &Workflow) -> (Uuid, Uuid, Uuid) {
    let thread_id = Uuid::now_v7();
    let run_id = Uuid::now_v7();
    let user_message_id = Uuid::now_v7();
    let assistant_message_id = Uuid::now_v7();
    db::persist_thread_with_first_run(
        pool,
        thread_id,
        run_id,
        user_message_id,
        assistant_message_id,
        workflow,
        "prompt",
        &[],
        "t",
        1,
    )
    .await
    .expect("seed run");
    (run_id, thread_id, assistant_message_id)
}

/// In-memory [`WorkerPort`]: yields scripted frames in order and records
/// the `tool_call_id` of every Tool Result sent back. `sent`/`shutdowns`
/// are shared so the test can inspect them after `run_loop` consumes it.
pub(crate) struct ScriptedWorker {
    inbound: VecDeque<WorkerStdout>,
    sent: Arc<Mutex<Vec<String>>>,
    shutdowns: Arc<Mutex<u32>>,
}

impl ScriptedWorker {
    pub(crate) fn new(frames: Vec<WorkerStdout>) -> (Self, Arc<Mutex<Vec<String>>>, Arc<Mutex<u32>>) {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let shutdowns = Arc::new(Mutex::new(0));
        let worker = Self {
            inbound: frames.into(),
            sent: sent.clone(),
            shutdowns: shutdowns.clone(),
        };
        (worker, sent, shutdowns)
    }
}

impl WorkerPort for ScriptedWorker {
    async fn recv(&mut self) -> Option<WorkerStdout> {
        self.inbound.pop_front()
    }

    async fn send_tool_result(&mut self, result: ToolResult) {
        self.sent.lock().unwrap().push(result.tool_call_id);
    }

    async fn shutdown(&mut self) {
        *self.shutdowns.lock().unwrap() += 1;
    }
}

/// A [`WorkerPort`] that flips the run's cancel signal just before yielding
/// the frame at index `cancel_before`, forcing the loop's post-recv cancel
/// check to trip — the live-cancel-mid-stream race. Otherwise behaves like
/// [`ScriptedWorker`].
pub(crate) struct CancelingWorker {
    inbound: VecDeque<WorkerStdout>,
    hub: crate::hub::RunHub,
    cancel_before: usize,
    idx: usize,
    sent: Arc<Mutex<Vec<String>>>,
    shutdowns: Arc<Mutex<u32>>,
}

impl CancelingWorker {
    pub(crate) fn new(
        frames: Vec<WorkerStdout>,
        hub: crate::hub::RunHub,
        cancel_before: usize,
    ) -> (Self, Arc<Mutex<Vec<String>>>, Arc<Mutex<u32>>) {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let shutdowns = Arc::new(Mutex::new(0));
        let worker = Self {
            inbound: frames.into(),
            hub,
            cancel_before,
            idx: 0,
            sent: sent.clone(),
            shutdowns: shutdowns.clone(),
        };
        (worker, sent, shutdowns)
    }
}

impl WorkerPort for CancelingWorker {
    async fn recv(&mut self) -> Option<WorkerStdout> {
        if self.idx == self.cancel_before {
            self.hub.cancel();
        }
        self.idx += 1;
        self.inbound.pop_front()
    }

    async fn send_tool_result(&mut self, result: ToolResult) {
        self.sent.lock().unwrap().push(result.tool_call_id);
    }

    async fn shutdown(&mut self) {
        *self.shutdowns.lock().unwrap() += 1;
    }
}

/// Drain a broadcast receiver into a Vec without blocking.
pub(crate) fn drain(rx: &mut broadcast::Receiver<RunEvent>) -> Vec<RunEvent> {
    let mut events = Vec::new();
    while let Ok(event) = rx.try_recv() {
        events.push(event);
    }
    events
}

pub(crate) fn fixtures(run_id: Uuid) -> (Hubs, crate::hub::RunHub) {
    let hubs = crate::hub::new_hubs();
    let run_hub = crate::hub::register(&hubs, run_id).expect("fresh run registers");
    (hubs, run_hub)
}

pub(crate) fn external_started(id: &str, name: &str) -> WorkerStdout {
    WorkerStdout::ExternalToolStarted {
        tool_call_id: id.to_string(),
        name: name.to_string(),
        arguments: serde_json::json!({ "filter": { "status": [0] } }),
    }
}

pub(crate) fn external_finished(id: &str, text: &str, is_error: bool) -> WorkerStdout {
    WorkerStdout::ExternalToolFinished {
        tool_call_id: id.to_string(),
        result: TranscriptToolResult::text(text, is_error),
    }
}

pub(crate) async fn tool_call_row(
    pool: &SqlitePool,
    id: &str,
) -> Option<(String, String, Option<String>)> {
    sqlx::query_as("SELECT name, status, result_payload FROM tool_calls WHERE id = ?1")
        .bind(id)
        .fetch_optional(pool)
        .await
        .expect("read tool_call row")
}

/// The run's assistant text — all `message_parts` text concatenated in `seq`
/// order. `select_run_snapshot` returned this before the ordered segment
/// `Snapshot` superseded it (review P1 #2); tests still assert run_loop's
/// persisted text through it.
pub(crate) async fn run_text(pool: &SqlitePool, run_id: Uuid) -> String {
    sqlx::query_scalar::<_, Option<String>>(
        "SELECT group_concat(text, '') FROM ( \
           SELECT mp.text FROM message_parts mp \
           JOIN messages m ON m.id = mp.message_id \
           WHERE m.run_id = ?1 AND m.role = 'assistant' AND mp.type = 'text' \
           ORDER BY mp.seq )",
    )
    .bind(run_id.to_string())
    .fetch_one(pool)
    .await
    .expect("read run text")
    .unwrap_or_default()
}

pub(crate) async fn run_steps_kinds_and_content(pool: &SqlitePool, run_id: Uuid) -> Vec<(String, String)> {
    let rows: Vec<(String, Option<String>, Option<i64>, Option<String>)> = sqlx::query_as(
        "SELECT rs.kind, rs.message_id, rs.part_seq, tc.name \
         FROM run_steps rs \
         LEFT JOIN tool_calls tc ON tc.id = rs.tool_call_id \
         WHERE rs.run_id = ?1 ORDER BY rs.seq",
    )
    .bind(run_id.to_string())
    .fetch_all(pool)
    .await
    .expect("read run_steps");

    let mut out = Vec::with_capacity(rows.len());
    for (kind, message_id, part_seq, tc_name) in rows {
        match kind.as_str() {
            "message" => {
                let message_id = message_id.expect("message step has a message_id");
                let part_seq = part_seq.expect("message step resolves a specific text part");
                let text: String = sqlx::query_scalar(
                    "SELECT text FROM message_parts WHERE message_id = ?1 AND seq = ?2",
                )
                .bind(&message_id)
                .bind(part_seq)
                .fetch_one(pool)
                .await
                .expect("message step's part exists");
                out.push(("message".to_string(), text));
            }
            "tool_call" => out.push(("tool_call".to_string(), tc_name.unwrap_or_default())),
            other => panic!("unexpected run_step kind {other:?}"),
        }
    }
    out
}
