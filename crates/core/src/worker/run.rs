//! The Worker run loop (ADR-0026). Reads Worker stdout frames through a
//! [`WorkerPort`], persists/publishes each `text_delta` under the ADR-0022
//! gate, dispatches or parks `tool_request`s, and commits the terminal
//! transaction. Generic over the port: production spawns a
//! [`super::child::ChildWorker`]; tests drive an in-memory `ScriptedWorker`.
//!
//! This is the former `stream_worker` body, unchanged in behavior — only the
//! `Child`/stdin/stdout are now reached through the [`WorkerPort`] seam.

use std::sync::Arc;

use sqlx::SqlitePool;
use tokio::sync::broadcast;
use uuid::Uuid;

use super::port::{Exit, WorkerPort};
use crate::db;
use crate::hub::Hubs;
use crate::protocol::{
    RunEvent, ToolCallStatus, ToolErrorWire, ToolOutcome, ToolResult, WorkerStdout,
};
use crate::workflow::Workflow;

/// Drive a spawned Worker to a terminal state through `worker` (the transport
/// seam). Appends each `text_delta` under the per-run gate (ADR-0022), executes
/// or parks `tool_request`s (ADR-0018/0025), commits the terminal tx
/// (`complete_run`/`error_run`/`error_run_with_message`) unless the Run parked,
/// publishes the terminal Run Event after the tx commits, and removes the hub.
/// Returns the [`Exit`] the loop took.
#[allow(clippy::too_many_arguments)]
pub(super) async fn run_loop<P: WorkerPort + Send>(
    mut worker: P,
    run_id: Uuid,
    workflow: Workflow,
    pool: SqlitePool,
    assistant_message_id: Uuid,
    hubs: Hubs,
    tx: broadcast::Sender<RunEvent>,
    gate: Arc<tokio::sync::Mutex<()>>,
) -> Exit {
    let mut saw_done = false;
    let mut worker_error: Option<String> = None;
    let mut parked = false;

    while let Some(msg) = worker.recv().await {
        match msg {
            // Per-event critical section (ADR-0022 exactly-once): hold the
            // per-run gate across persist + publish so a concurrent
            // `run/subscribe` snapshot/attach sees this delta either wholly in
            // the snapshot or wholly in the tail, never split or duplicated.
            WorkerStdout::TextDelta { delta } => {
                let guard = gate.lock().await;
                if let Err(e) = db::append_assistant_text(&pool, assistant_message_id, &delta).await
                {
                    eprintln!(
                        "text_delta append failed for assistant message {assistant_message_id}: {e}"
                    );
                }
                let _ = tx.send(RunEvent::TextDelta { delta });
                drop(guard);
            }
            // Terminal events are recorded as flags and published AFTER the
            // terminal tx commits (below). Shutting the Worker down sends it
            // EOF so its stdout closes and this loop can break.
            WorkerStdout::Done => {
                saw_done = true;
                worker.shutdown().await;
            }
            WorkerStdout::Error { message } => {
                worker_error = Some(message);
                worker.shutdown().await;
            }
            // Tool Request (ADR-0018). Proposal tools park the Run instead of
            // dispatching (ADR-0025): persist the tool_call + a pending
            // Proposal, set the Run `parked`, then break with the `parked` flag
            // so the post-loop branch runs neither `complete_run` nor
            // `error_run` and publishes no terminal Run Event. Non-Proposal
            // tools take the synchronous dispatch-and-reply path, bracketed by
            // two ephemeral `tool_call` Run Events for live "tool is running".
            WorkerStdout::ToolRequest {
                tool_call_id,
                name,
                params,
                ..
            } => {
                if crate::tools::is_proposal(&name) && !db::should_auto_approve() {
                    parked = park_on_proposal(&pool, run_id, &tool_call_id, &name, &params).await;
                    worker.shutdown().await;
                    break;
                }

                let _ = tx.send(RunEvent::ToolCall {
                    tool_call_id: tool_call_id.clone(),
                    name: name.clone(),
                    status: ToolCallStatus::Started,
                });
                let outcome =
                    handle_tool_request(&pool, run_id, &workflow, &tool_call_id, &name, params)
                        .await;
                let _ = tx.send(RunEvent::ToolCall {
                    tool_call_id: tool_call_id.clone(),
                    name,
                    status: match &outcome {
                        ToolOutcome::Ok { .. } => ToolCallStatus::Completed,
                        ToolOutcome::Err { .. } => ToolCallStatus::Error,
                    },
                });
                let result = ToolResult {
                    kind: "tool_result",
                    run_id: run_id.to_string(),
                    tool_call_id,
                    outcome,
                };
                worker.send_tool_result(result).await;
            }
        }
    }

    // Terminal-state tx (ADR-0017 atomic recovery). A worker-emitted `error`
    // takes precedence over the EOF-without-done path and carries its message.
    // Park (ADR-0025) short-circuits this entirely: a parked Run already
    // committed `status='parked'`, and park is NOT terminal.
    if !parked {
        let now_ms = db::now_ms();
        let result = if let Some(ref message) = worker_error {
            db::error_run_with_message(&pool, run_id, "errored", "worker_error", message, now_ms)
                .await
        } else if saw_done {
            db::complete_run(&pool, run_id, now_ms).await
        } else {
            db::error_run(&pool, run_id, now_ms).await
        };
        if let Err(e) = result {
            eprintln!("terminal tx failed for run {run_id}: {e}");
        }

        // Publish the terminal Run Event ONLY AFTER the terminal tx commits.
        match (&worker_error, saw_done) {
            (Some(message), _) => {
                let _ = tx.send(RunEvent::Error {
                    message: message.clone(),
                });
            }
            (None, true) => {
                let _ = tx.send(RunEvent::Done);
            }
            (None, false) => {}
        }
    }

    // Remove the hub entry after publishing the terminal event so attached
    // subscribers observe the channel close once they have drained the tail.
    // `worker` is dropped when this function returns; the child is spawned
    // `kill_on_drop`, so the Worker process is torn down then (the former
    // explicit `child.wait()`) — no orphan outlives the Run.
    crate::hub::remove(&hubs, run_id);

    if parked {
        Exit::Parked
    } else if let Some(message) = worker_error {
        Exit::Errored(message)
    } else if saw_done {
        Exit::Done
    } else {
        Exit::Disconnected
    }
}

/// Handle one Tool Request (ADR-0018): enforce the Workflow's allowlist,
/// persist the call, dispatch it to the Rust tool registry, persist the
/// outcome, and return the `ToolOutcome` to write back to the Worker. A
/// `tool_request` for a tool not in this Workflow's allowlist (or not
/// registered) is rejected with an `err` outcome and persists nothing.
async fn handle_tool_request(
    pool: &SqlitePool,
    run_id: Uuid,
    workflow: &Workflow,
    tool_call_id: &str,
    name: &str,
    params: serde_json::Value,
) -> ToolOutcome {
    let allowed =
        workflow.tools.iter().any(|t| t.as_str() == name) && crate::tools::is_registered(name);
    if !allowed {
        return ToolOutcome::Err {
            err: ToolErrorWire {
                code: "tool_not_allowed".to_string(),
                message: format!("tool {name:?} is not in this workflow's allowlist"),
            },
        };
    }

    // Persist the pending call + its run_step before executing, so the timeline
    // reflects an in-flight tool call (ADR-0017). A persistence failure is
    // logged but does not abort the call.
    let request_payload = params.to_string();
    if let Err(e) = db::persist_tool_call(
        pool,
        run_id,
        tool_call_id,
        name,
        &request_payload,
        db::now_ms(),
    )
    .await
    {
        eprintln!("persist_tool_call failed for {tool_call_id}: {e}");
    }

    match crate::tools::execute(pool, name, params).await {
        Ok(result) => {
            let payload = serde_json::to_string(&result).unwrap_or_else(|_| "{}".to_string());
            if let Err(e) =
                db::resolve_tool_call(pool, tool_call_id, "completed", &payload, db::now_ms()).await
            {
                eprintln!("resolve_tool_call (completed) failed for {tool_call_id}: {e}");
            }
            ToolOutcome::Ok { ok: result }
        }
        Err(te) => {
            let payload = serde_json::json!({ "code": te.code, "message": te.message }).to_string();
            if let Err(e) =
                db::resolve_tool_call(pool, tool_call_id, "errored", &payload, db::now_ms()).await
            {
                eprintln!("resolve_tool_call (errored) failed for {tool_call_id}: {e}");
            }
            ToolOutcome::Err {
                err: ToolErrorWire {
                    code: te.code,
                    message: te.message,
                },
            }
        }
    }
}

/// Park the Run on a Proposal tool request (ADR-0025). Persists the
/// `tool_calls` row (`pending`), the sidecar `proposals` row, the guarded
/// `running -> parked` move, and the `parked`/`proposal_pending` events in one
/// transaction. Returns whether the terminal branch should be skipped.
async fn park_on_proposal(
    pool: &SqlitePool,
    run_id: Uuid,
    tool_call_id: &str,
    name: &str,
    params: &serde_json::Value,
) -> bool {
    let now = db::now_ms();
    let request_payload = params.to_string();

    let mutation_kind = params
        .get("mutation_kind")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let proposal_id = Uuid::now_v7().to_string();

    match db::park_on_proposal(
        pool,
        run_id,
        &proposal_id,
        tool_call_id,
        name,
        &request_payload,
        mutation_kind,
        now,
    )
    .await
    {
        Ok(moved) => moved.won(),
        Err(e) => {
            eprintln!("park_on_proposal failed for run {run_id}, tool_call {tool_call_id}: {e}");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;

    /// A migrated in-memory tier-2 pool (mirrors `db::open`'s migration so the
    /// `runs` CHECK constraints are in force).
    async fn memory_pool() -> SqlitePool {
        let options = SqliteConnectOptions::new()
            .filename(":memory:")
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("open in-memory sqlite");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        pool
    }

    fn test_workflow(tools: &[&str]) -> Workflow {
        Workflow {
            name: "test".to_string(),
            version: "1".to_string(),
            provider: "faux".to_string(),
            model: Some("m".to_string()),
            system_prompt: "sp".to_string(),
            thinking_level: Some("off".to_string()),
            tools: tools.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// Seed a Thread + initial Run (so an assistant `message_parts` row exists
    /// at seq 0 for `run_loop` to append into). Returns `(run_id, thread_id,
    /// assistant_message_id)`.
    async fn seed_run(pool: &SqlitePool, workflow: &Workflow) -> (Uuid, Uuid, Uuid) {
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
            "t",
            1,
        )
        .await
        .expect("seed run");
        (run_id, thread_id, assistant_message_id)
    }

    /// In-memory [`WorkerPort`]: yields scripted frames in order, records the
    /// `tool_call_id` of every Tool Result the loop sends back, and never
    /// spawns a process. `sent`/`shutdowns` are shared so the test can inspect
    /// them after `run_loop` consumes the worker.
    struct ScriptedWorker {
        inbound: VecDeque<WorkerStdout>,
        sent: Arc<Mutex<Vec<String>>>,
        shutdowns: Arc<Mutex<u32>>,
    }

    impl ScriptedWorker {
        fn new(frames: Vec<WorkerStdout>) -> (Self, Arc<Mutex<Vec<String>>>, Arc<Mutex<u32>>) {
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

    fn fixtures() -> (
        Hubs,
        broadcast::Sender<RunEvent>,
        Arc<tokio::sync::Mutex<()>>,
    ) {
        let (tx, _rx) = broadcast::channel(64);
        (
            crate::hub::new_hubs(),
            tx,
            Arc::new(tokio::sync::Mutex::new(())),
        )
    }

    #[tokio::test]
    async fn done_marks_completed_and_persists_text() {
        let pool = memory_pool().await;
        let wf = test_workflow(&[]);
        let (run_id, _thread_id, amid) = seed_run(&pool, &wf).await;
        let (hubs, tx, gate) = fixtures();
        let (worker, _sent, _sd) = ScriptedWorker::new(vec![
            WorkerStdout::TextDelta {
                delta: "hi".to_string(),
            },
            WorkerStdout::Done,
        ]);

        let exit = run_loop(worker, run_id, wf, pool.clone(), amid, hubs, tx, gate).await;

        assert_eq!(exit, Exit::Done);
        assert_eq!(
            db::run_status(&pool, run_id).await.unwrap().as_deref(),
            Some("completed")
        );
        let snap = db::select_run_snapshot(&pool, run_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(snap.text, "hi");
    }

    #[tokio::test]
    async fn worker_error_marks_errored_with_message() {
        let pool = memory_pool().await;
        let wf = test_workflow(&[]);
        let (run_id, _t, _amid) = seed_run(&pool, &wf).await;
        let (hubs, tx, gate) = fixtures();
        let (worker, _sent, _sd) = ScriptedWorker::new(vec![WorkerStdout::Error {
            message: "boom".to_string(),
        }]);

        let exit = run_loop(worker, run_id, wf, pool.clone(), _amid, hubs, tx, gate).await;

        assert_eq!(exit, Exit::Errored("boom".to_string()));
        assert_eq!(
            db::run_status(&pool, run_id).await.unwrap().as_deref(),
            Some("errored")
        );
    }

    #[tokio::test]
    async fn eof_without_done_marks_errored() {
        let pool = memory_pool().await;
        let wf = test_workflow(&[]);
        let (run_id, _t, amid) = seed_run(&pool, &wf).await;
        let (hubs, tx, gate) = fixtures();
        // One delta, then the script is exhausted → recv returns None (EOF).
        let (worker, _sent, _sd) = ScriptedWorker::new(vec![WorkerStdout::TextDelta {
            delta: "x".to_string(),
        }]);

        let exit = run_loop(worker, run_id, wf, pool.clone(), amid, hubs, tx, gate).await;

        assert_eq!(exit, Exit::Disconnected);
        assert_eq!(
            db::run_status(&pool, run_id).await.unwrap().as_deref(),
            Some("errored")
        );
    }

    #[tokio::test]
    async fn tool_request_dispatches_and_replies() {
        let pool = memory_pool().await;
        let wf = test_workflow(&["read_thread"]);
        let (run_id, thread_id, amid) = seed_run(&pool, &wf).await;
        let (hubs, tx, gate) = fixtures();
        let (worker, sent, _sd) = ScriptedWorker::new(vec![
            WorkerStdout::ToolRequest {
                run_id: String::new(),
                tool_call_id: "tc1".to_string(),
                name: "read_thread".to_string(),
                params: serde_json::json!({ "thread_id": thread_id.to_string() }),
            },
            WorkerStdout::Done,
        ]);

        let exit = run_loop(worker, run_id, wf, pool.clone(), amid, hubs, tx, gate).await;

        assert_eq!(exit, Exit::Done);
        // The loop dispatched the tool and wrote a Tool Result back, correlated
        // by the same tool_call_id.
        assert_eq!(sent.lock().unwrap().as_slice(), &["tc1".to_string()]);
    }

    #[tokio::test]
    async fn proposal_request_parks_without_terminal_tx() {
        let pool = memory_pool().await;
        let wf = test_workflow(&["propose_workspace_mutation"]);
        let (run_id, _t, amid) = seed_run(&pool, &wf).await;
        let (hubs, tx, gate) = fixtures();
        let (worker, _sent, _sd) = ScriptedWorker::new(vec![WorkerStdout::ToolRequest {
            run_id: String::new(),
            tool_call_id: "tc-prop".to_string(),
            name: "propose_workspace_mutation".to_string(),
            params: serde_json::json!({
                "mutation_kind": "create_journal_entry",
                "payload": {
                    "occurred_at": "2026-06-10T10:30:00",
                    "body": [{ "type": "text", "text": "Bought milk." }]
                }
            }),
        }]);

        let exit = run_loop(worker, run_id, wf, pool.clone(), amid, hubs, tx, gate).await;

        assert_eq!(exit, Exit::Parked);
        assert_eq!(
            db::run_status(&pool, run_id).await.unwrap().as_deref(),
            Some("parked")
        );
        assert!(
            db::get_pending_proposal_for_run(&pool, run_id)
                .await
                .unwrap()
                .is_some(),
            "a pending Proposal is persisted on park"
        );
    }
}
