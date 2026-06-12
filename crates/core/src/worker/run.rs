//! The Worker run loop (ADR-0026). Reads Worker stdout frames through a
//! [`WorkerPort`], persists/publishes each `text_delta` under the ADR-0022
//! gate, dispatches or parks `tool_request`s, and commits the terminal
//! transaction. Generic over the port: production spawns a
//! [`super::child::ChildWorker`]; tests drive an in-memory `ScriptedWorker`.

use std::sync::Arc;

use sqlx::SqlitePool;
use tokio::sync::{broadcast, watch};
use uuid::Uuid;

use super::port::{Exit, WorkerPort};
use crate::db;
use crate::hub::Hubs;
use crate::protocol::{
    RunEvent, ToolCallStatus, ToolErrorWire, ToolOutcome, ToolResult, WorkerStdout,
};
use crate::workflow::Workflow;

/// Drive a spawned Worker to a terminal state. Appends each `text_delta` under
/// the per-run gate (ADR-0022), executes or parks `tool_request`s
/// (ADR-0018/0025), commits the terminal tx unless the Run parked, publishes
/// the terminal Run Event after the tx commits, removes the hub, and returns
/// the [`Exit`] taken.
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
    mut cancel_rx: watch::Receiver<bool>,
) -> Exit {
    let mut saw_done = false;
    let mut worker_error: Option<String> = None;
    let mut parked = false;
    let mut cancelled_by_core = false;

    if *cancel_rx.borrow() {
        worker.shutdown().await;
        cancelled_by_core = true;
    }

    while !cancelled_by_core {
        let Some(msg) = (tokio::select! {
            changed = cancel_rx.changed() => {
                if changed.is_ok() && *cancel_rx.borrow() {
                    worker.shutdown().await;
                    cancelled_by_core = true;
                    None
                } else {
                    continue;
                }
            }
            msg = worker.recv() => msg,
        }) else {
            break;
        };
        if *cancel_rx.borrow() {
            worker.shutdown().await;
            cancelled_by_core = true;
            break;
        }
        match msg {
            // Per-event critical section (ADR-0022 exactly-once): hold the
            // per-run gate across persist + publish so a concurrent
            // `run/subscribe` sees this delta wholly in the snapshot or wholly
            // in the tail, never split or duplicated.
            WorkerStdout::TextDelta { delta } => {
                let guard = gate.lock().await;
                match db::append_assistant_text(&pool, assistant_message_id, &delta).await {
                    Ok(true) => {
                        let _ = tx.send(RunEvent::TextDelta { delta });
                    }
                    Ok(false) => {}
                    Err(e) => {
                        eprintln!(
                            "text_delta append failed for assistant message {assistant_message_id}: {e}"
                        );
                    }
                }
                drop(guard);
            }
            // Terminal events: record a flag, publish AFTER the terminal tx
            // commits (below). Shutdown sends EOF so stdout closes and the loop
            // breaks.
            WorkerStdout::Done => {
                saw_done = true;
                worker.shutdown().await;
            }
            WorkerStdout::Error { message } => {
                worker_error = Some(message);
                worker.shutdown().await;
            }
            // Tool Request (ADR-0018). Proposal tools park the Run instead of
            // dispatching (ADR-0025), breaking with the `parked` flag so the
            // post-loop branch commits no terminal tx. Non-Proposal tools take
            // the synchronous dispatch-and-reply path, bracketed by two
            // ephemeral `tool_call` Run Events for live "tool is running".
            WorkerStdout::ToolRequest {
                tool_call_id,
                name,
                params,
                ..
            } => {
                if crate::tools::is_proposal(&name) && !db::should_auto_approve() {
                    let guard = gate.lock().await;
                    parked = park_on_proposal(&pool, run_id, &tool_call_id, &name, &params).await;
                    drop(guard);
                    worker.shutdown().await;
                    break;
                }

                let guard = gate.lock().await;
                if *cancel_rx.borrow() {
                    drop(guard);
                    worker.shutdown().await;
                    cancelled_by_core = true;
                    break;
                }
                let _ = tx.send(RunEvent::ToolCall {
                    tool_call_id: tool_call_id.clone(),
                    name: name.clone(),
                    status: ToolCallStatus::Started,
                });
                drop(guard);

                let outcome =
                    handle_tool_request(&pool, run_id, &workflow, &tool_call_id, &name, params)
                        .await;
                let guard = gate.lock().await;
                if *cancel_rx.borrow() {
                    drop(guard);
                    worker.shutdown().await;
                    cancelled_by_core = true;
                    break;
                }
                let _ = tx.send(RunEvent::ToolCall {
                    tool_call_id: tool_call_id.clone(),
                    name,
                    status: match &outcome {
                        ToolOutcome::Ok { .. } => ToolCallStatus::Completed,
                        ToolOutcome::Err { .. } => ToolCallStatus::Error,
                    },
                });
                drop(guard);

                let result = ToolResult {
                    kind: "tool_result",
                    run_id: run_id.to_string(),
                    tool_call_id,
                    outcome,
                };
                if *cancel_rx.borrow() {
                    worker.shutdown().await;
                    cancelled_by_core = true;
                    break;
                }
                worker.send_tool_result(result).await;
            }
        }
    }

    // Terminal-state tx (ADR-0017 atomic recovery). A worker-emitted `error`
    // takes precedence over EOF-without-done and carries its message. Park
    // (ADR-0025) short-circuits this entirely (it is non-terminal).
    if !parked && !cancelled_by_core {
        let now_ms = db::now_ms();
        let result = if let Some(ref message) = worker_error {
            db::error_run_with_message(&pool, run_id, "errored", "worker_error", message, now_ms)
                .await
        } else if saw_done {
            db::complete_run(&pool, run_id, now_ms).await
        } else {
            db::error_run(&pool, run_id, now_ms).await
        };
        if let Err(ref e) = result {
            eprintln!("terminal tx failed for run {run_id}: {e}");
        }

        // Publish the terminal Run Event ONLY AFTER this loop's terminal tx
        // wins. If cancellation already committed, the guarded transition loses
        // and `run/cancel` owns the terminal `cancelled` event.
        match result {
            Ok(moved) if moved.won() => match (&worker_error, saw_done) {
                (Some(message), _) => {
                    let _ = tx.send(RunEvent::Error {
                        message: message.clone(),
                    });
                }
                (None, true) => {
                    let _ = tx.send(RunEvent::Done);
                }
                (None, false) => {}
            },
            _ => {}
        }
    }

    // Remove the hub after publishing the terminal event so attached
    // subscribers observe the channel close once they have drained the tail.
    // `worker` drops on return; the child is `kill_on_drop`, so no orphan
    // outlives the Run.
    crate::hub::remove(&hubs, run_id);

    if cancelled_by_core {
        Exit::Cancelled
    } else if parked {
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
/// persist the call, dispatch to the tool registry, persist the outcome, and
/// return the `ToolOutcome`. A tool not allowlisted (or not registered) is
/// rejected with an `err` outcome and persists nothing.
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

    // Persist the pending call before executing so the timeline reflects an
    // in-flight tool call (ADR-0017). A persistence failure is logged, not
    // fatal.
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

    match crate::tools::execute(pool, run_id, name, params).await {
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

/// Park the Run on a Proposal tool request (ADR-0025). In one transaction:
/// persist the pending `tool_calls` row, the sidecar `proposals` row, the
/// guarded `running -> parked` move, and the `parked`/`proposal_pending`
/// events. Returns whether the terminal branch should be skipped.
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

    /// A migrated in-memory tier-2 pool (so the `runs` CHECK constraints hold).
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

    /// Seed a Thread + initial Run (so an assistant row at seq 0 exists for
    /// `run_loop` to append into). Returns `(run_id, thread_id, assistant_id)`.
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

    /// In-memory [`WorkerPort`]: yields scripted frames in order and records
    /// the `tool_call_id` of every Tool Result sent back. `sent`/`shutdowns`
    /// are shared so the test can inspect them after `run_loop` consumes it.
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

    /// A [`WorkerPort`] that flips the run's cancel signal just before yielding
    /// the frame at index `cancel_before`, forcing the loop's post-recv cancel
    /// check to trip — the live-cancel-mid-stream race. Otherwise behaves like
    /// [`ScriptedWorker`].
    struct CancelingWorker {
        inbound: VecDeque<WorkerStdout>,
        hub: crate::hub::RunHub,
        cancel_before: usize,
        idx: usize,
        sent: Arc<Mutex<Vec<String>>>,
        shutdowns: Arc<Mutex<u32>>,
    }

    impl CancelingWorker {
        fn new(
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
    fn drain(rx: &mut broadcast::Receiver<RunEvent>) -> Vec<RunEvent> {
        let mut events = Vec::new();
        while let Ok(event) = rx.try_recv() {
            events.push(event);
        }
        events
    }

    fn fixtures(run_id: Uuid) -> (Hubs, crate::hub::RunHub) {
        let hubs = crate::hub::new_hubs();
        let run_hub = crate::hub::create(&hubs, run_id);
        (hubs, run_hub)
    }

    #[tokio::test]
    async fn done_marks_completed_and_persists_text() {
        let pool = memory_pool().await;
        let wf = test_workflow(&[]);
        let (run_id, _thread_id, amid) = seed_run(&pool, &wf).await;
        let (hubs, run_hub) = fixtures(run_id);
        let (worker, _sent, _sd) = ScriptedWorker::new(vec![
            WorkerStdout::TextDelta {
                delta: "hi".to_string(),
            },
            WorkerStdout::Done,
        ]);

        let exit = run_loop(
            worker,
            run_id,
            wf,
            pool.clone(),
            amid,
            hubs,
            run_hub.tx.clone(),
            run_hub.gate.clone(),
            run_hub.cancel_rx(),
        )
        .await;

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
        let (hubs, run_hub) = fixtures(run_id);
        let (worker, _sent, _sd) = ScriptedWorker::new(vec![WorkerStdout::Error {
            message: "boom".to_string(),
        }]);

        let exit = run_loop(
            worker,
            run_id,
            wf,
            pool.clone(),
            _amid,
            hubs,
            run_hub.tx.clone(),
            run_hub.gate.clone(),
            run_hub.cancel_rx(),
        )
        .await;

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
        let (hubs, run_hub) = fixtures(run_id);
        // One delta, then the script is exhausted → recv returns None (EOF).
        let (worker, _sent, _sd) = ScriptedWorker::new(vec![WorkerStdout::TextDelta {
            delta: "x".to_string(),
        }]);

        let exit = run_loop(
            worker,
            run_id,
            wf,
            pool.clone(),
            amid,
            hubs,
            run_hub.tx.clone(),
            run_hub.gate.clone(),
            run_hub.cancel_rx(),
        )
        .await;

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
        let (hubs, run_hub) = fixtures(run_id);
        let (worker, sent, _sd) = ScriptedWorker::new(vec![
            WorkerStdout::ToolRequest {
                run_id: String::new(),
                tool_call_id: "tc1".to_string(),
                name: "read_thread".to_string(),
                params: serde_json::json!({ "thread_id": thread_id.to_string() }),
            },
            WorkerStdout::Done,
        ]);

        let exit = run_loop(
            worker,
            run_id,
            wf,
            pool.clone(),
            amid,
            hubs,
            run_hub.tx.clone(),
            run_hub.gate.clone(),
            run_hub.cancel_rx(),
        )
        .await;

        assert_eq!(exit, Exit::Done);
        // Tool dispatched and a Tool Result written back, correlated by id.
        assert_eq!(sent.lock().unwrap().as_slice(), &["tc1".to_string()]);
    }

    #[tokio::test]
    async fn proposal_request_parks_without_terminal_tx() {
        let pool = memory_pool().await;
        let wf = test_workflow(&["propose_workspace_mutation"]);
        let (run_id, _t, amid) = seed_run(&pool, &wf).await;
        let (hubs, run_hub) = fixtures(run_id);
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

        let exit = run_loop(
            worker,
            run_id,
            wf,
            pool.clone(),
            amid,
            hubs,
            run_hub.tx.clone(),
            run_hub.gate.clone(),
            run_hub.cancel_rx(),
        )
        .await;

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

    #[tokio::test]
    async fn cancel_signalled_before_loop_exits_cancelled_without_terminal_tx() {
        let pool = memory_pool().await;
        let wf = test_workflow(&[]);
        let (run_id, _t, _amid) = seed_run(&pool, &wf).await;
        let (hubs, run_hub) = fixtures(run_id);
        // run/cancel already won the guarded transition before the loop starts.
        run_hub.cancel();
        let mut tail = run_hub.tx.subscribe();
        let (worker, _sent, shutdowns) = ScriptedWorker::new(vec![
            WorkerStdout::TextDelta {
                delta: "late".to_string(),
            },
            WorkerStdout::Done,
        ]);

        let exit = run_loop(
            worker,
            run_id,
            wf,
            pool.clone(),
            _amid,
            hubs,
            run_hub.tx.clone(),
            run_hub.gate.clone(),
            run_hub.cancel_rx(),
        )
        .await;

        assert_eq!(exit, Exit::Cancelled);
        assert_eq!(*shutdowns.lock().unwrap(), 1, "the loop shut the Worker down");
        // The loop owns no terminal tx on cancel; here no transition ran at
        // all, so the run stays `running`.
        assert_eq!(
            db::run_status(&pool, run_id).await.unwrap().as_deref(),
            Some("running"),
            "the loop committed neither complete_run nor error_run"
        );
        // No terminal Run Event was published by the loop.
        assert!(
            drain(&mut tail).is_empty(),
            "the loop published no Done/Error after cancel"
        );
    }

    #[tokio::test]
    async fn cancel_mid_stream_suppresses_late_done() {
        let pool = memory_pool().await;
        let wf = test_workflow(&[]);
        let (run_id, _t, amid) = seed_run(&pool, &wf).await;
        let (hubs, run_hub) = fixtures(run_id);
        let mut tail = run_hub.tx.subscribe();
        // First delta streams; cancel flips before the Done recv, so the
        // post-recv check trips and Done is dropped.
        let (worker, _sent, shutdowns) = CancelingWorker::new(
            vec![
                WorkerStdout::TextDelta {
                    delta: "hi".to_string(),
                },
                WorkerStdout::Done,
            ],
            run_hub.clone(),
            1,
        );

        let exit = run_loop(
            worker,
            run_id,
            wf,
            pool.clone(),
            amid,
            hubs,
            run_hub.tx.clone(),
            run_hub.gate.clone(),
            run_hub.cancel_rx(),
        )
        .await;

        assert_eq!(exit, Exit::Cancelled);
        assert!(*shutdowns.lock().unwrap() >= 1, "the loop shut the Worker down");
        // The first delta was published; NO Done followed it.
        let events = drain(&mut tail);
        assert!(
            matches!(events.as_slice(), [RunEvent::TextDelta { delta }] if delta == "hi"),
            "only the pre-cancel delta is published, no terminal Done — got {events:?}"
        );
    }

    #[tokio::test]
    async fn loop_terminal_tx_loses_to_committed_cancel_and_publishes_nothing() {
        // The worker reaches `done`, but cancellation already committed
        // `cancelled`. The loop's guarded complete_run must lose and publish no
        // Done, so `cancelled` stays the one terminal outcome.
        let pool = memory_pool().await;
        let wf = test_workflow(&[]);
        let (run_id, _t, amid) = seed_run(&pool, &wf).await;
        let (hubs, run_hub) = fixtures(run_id);
        let mut tail = run_hub.tx.subscribe();
        // Pre-commit the cancellation (as run/cancel would, racing ahead).
        assert!(
            db::cancel_running_run(&pool, run_id, db::now_ms())
                .await
                .unwrap()
                .won(),
            "cancel commits the running -> cancelled transition first"
        );
        // The worker still runs to `done` (it never observed the signal).
        let (worker, _sent, _sd) = ScriptedWorker::new(vec![WorkerStdout::Done]);

        let exit = run_loop(
            worker,
            run_id,
            wf,
            pool.clone(),
            amid,
            hubs,
            run_hub.tx.clone(),
            run_hub.gate.clone(),
            run_hub.cancel_rx(),
        )
        .await;

        assert_eq!(exit, Exit::Done, "the loop saw `done`");
        // But the terminal tx lost the guard: status stays `cancelled`.
        assert_eq!(
            db::run_status(&pool, run_id).await.unwrap().as_deref(),
            Some("cancelled"),
            "a later completion does not overwrite a committed cancellation"
        );
        // And crucially, the loop published NO Done after losing the guard.
        assert!(
            drain(&mut tail).is_empty(),
            "the loop publishes no Done when its terminal transition lost"
        );
    }
}
