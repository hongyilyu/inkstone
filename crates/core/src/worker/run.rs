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
use crate::db::TerminalReason;
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
    // The two currently-open assistant segment slots (ADR-0045 reasoning
    // amendment, #202): the open `text` part's `part_seq` and the open
    // `reasoning` part's, each `None` at a boundary. pi gives NO delta-contiguity
    // guarantee — a provider may interleave `text, thinking, text` with no tool
    // boundary (README:596) — so a delta opens/appends ITS-OWN-type slot and seals
    // the OTHER (a contiguous run of one type per `message_parts` row). The first
    // delta after a boundary opens a fresh part + run step; subsequent same-type
    // deltas append into it; a tool/park seals BOTH back to `None`. Resume starts
    // both at `None`, so the post-resume reply opens its own segment.
    let mut open_text_part: Option<i64> = None;
    let mut open_reasoning_part: Option<i64> = None;

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
            // A text/reasoning delta streams into ITS-OWN-type segment, sealing the
            // OTHER slot first (ADR-0045 reasoning amendment, #202). Both kinds share
            // one open-or-append-then-publish path under the exactly-once gate; only
            // the part type, the slot pair, and the republished event differ — see
            // [`stream_message_delta`].
            WorkerStdout::TextDelta { delta } => {
                stream_message_delta(
                    &pool,
                    run_id,
                    assistant_message_id,
                    &gate,
                    &tx,
                    db::PartType::Text,
                    &mut open_text_part,
                    &mut open_reasoning_part,
                    delta,
                )
                .await;
            }
            WorkerStdout::ReasoningDelta { delta } => {
                stream_message_delta(
                    &pool,
                    run_id,
                    assistant_message_id,
                    &gate,
                    &tx,
                    db::PartType::Reasoning,
                    &mut open_reasoning_part,
                    &mut open_text_part,
                    delta,
                )
                .await;
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
                // Seal BOTH open segments (ADR-0045): the tool's own `run_steps`
                // row lands at the next seq, so the next delta of either type opens
                // a fresh segment sequenced AFTER this tool. Holds for both the park
                // and dispatch branches below.
                open_text_part = None;
                open_reasoning_part = None;
                if crate::tools::is_proposal(&name) && !db::should_auto_approve() {
                    if let Err(message) = crate::tools::validate_proposal_request(&name, &params) {
                        worker_error = Some(message);
                        worker.shutdown().await;
                        break;
                    }
                    let guard = gate.lock().await;
                    parked = park_on_proposal(&pool, run_id, &tool_call_id, &name, &params).await;
                    drop(guard);
                    worker.shutdown().await;
                    break;
                }

                // The display arg (ADR-0043) is derived once from the params and
                // carried on both the started and terminal `tool_call` events, so
                // the live row matches the one `thread/get` rehydrates.
                let arg = crate::tools::display_arg(&name, &params);

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
                    arg: arg.clone(),
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
                    arg,
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
            db::error_run_with_message(
                &pool,
                run_id,
                TerminalReason::Errored,
                "worker_error",
                message,
                now_ms,
            )
            .await
        } else if saw_done {
            db::complete_run(&pool, run_id, now_ms).await
        } else {
            db::error_run(&pool, run_id, now_ms).await
        };
        if let Err(ref e) = result {
            tracing::error!(event = "worker.terminal_tx_failed", %run_id, error = ?e);
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
    // Dual gate (ADR-0018), ambient-aware (ADR-0036): a tool dispatches iff it is
    // registered AND (in this Workflow's allowlist OR ambient, e.g. `load_skill`).
    // Mirrors the manifest's `run_descriptors`, so the model never sees a tool it
    // can't call.
    let allowed = crate::tools::is_allowed(&workflow.tools, name);
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
        tracing::error!(event = "worker.persist_tool_call_failed", %run_id, tool_call_id, error = ?e);
    }

    match crate::tools::execute(pool, run_id, name, params).await {
        Ok(result) => {
            let payload = serde_json::to_string(&result).unwrap_or_else(|_| "{}".to_string());
            if let Err(e) =
                db::resolve_tool_call(pool, tool_call_id, "completed", &payload, db::now_ms()).await
            {
                tracing::error!(
                    event = "worker.resolve_tool_call_failed",
                    phase = "completed",
                    %run_id,
                    tool_call_id,
                    error = ?e
                );
            }
            ToolOutcome::Ok { ok: result }
        }
        Err(te) => {
            let payload = serde_json::json!({ "code": te.code, "message": te.message }).to_string();
            if let Err(e) =
                db::resolve_tool_call(pool, tool_call_id, "errored", &payload, db::now_ms()).await
            {
                tracing::error!(
                    event = "worker.resolve_tool_call_failed",
                    phase = "errored",
                    %run_id,
                    tool_call_id,
                    error = ?e
                );
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

/// Stream one assistant `text`/`reasoning` delta into its own-type segment under the
/// exactly-once gate (ADR-0022/0045). One path for both kinds: seal the OTHER slot
/// (the model switched content type — its part is complete), then open a fresh part on
/// the first delta after a boundary (caching the seq in `own_slot`) or append into the
/// open one, and republish the matching Run Event on a successful write. pi gives no
/// delta-contiguity guarantee, so each kind keeps its own slot and a type switch seals
/// the other (a contiguous run of one type per `message_parts` row). `own_slot` is this
/// kind's open-part cache; `other_slot` is the opposite kind's, sealed to `None` here.
#[allow(clippy::too_many_arguments)]
async fn stream_message_delta(
    pool: &SqlitePool,
    run_id: Uuid,
    assistant_message_id: Uuid,
    gate: &Arc<tokio::sync::Mutex<()>>,
    tx: &broadcast::Sender<RunEvent>,
    part_type: db::PartType,
    own_slot: &mut Option<i64>,
    other_slot: &mut Option<i64>,
    delta: String,
) {
    // A delta of this type seals any open segment of the OTHER type: the next
    // opposite-type delta opens a fresh part sequenced AFTER this one.
    *other_slot = None;
    let guard = gate.lock().await;
    // Open a fresh segment on the first delta after a boundary (ADR-0045), else
    // append into the open one. Either path advances only which part is "open" —
    // the gate's critical section is unchanged (ADR-0022). `own_slot` caches the
    // open seq so steady streaming is one UPDATE per delta, the part opening once.
    let written = match *own_slot {
        Some(part_seq) => {
            db::append_assistant_part(pool, assistant_message_id, part_seq, &delta).await
        }
        None => match db::open_assistant_part(
            pool,
            run_id,
            assistant_message_id,
            part_type,
            &delta,
            db::now_ms(),
        )
        .await
        {
            Ok(seq) => {
                *own_slot = seq;
                Ok(seq.is_some())
            }
            Err(e) => Err(e),
        },
    };
    match written {
        Ok(true) => {
            let event = match part_type {
                db::PartType::Text => RunEvent::TextDelta { delta },
                db::PartType::Reasoning => RunEvent::ReasoningDelta { delta },
            };
            let _ = tx.send(event);
        }
        Ok(false) => {}
        Err(e) => {
            let event = match part_type {
                db::PartType::Text => "worker.text_delta_append_failed",
                db::PartType::Reasoning => "worker.reasoning_delta_append_failed",
            };
            tracing::error!(event, %run_id, %assistant_message_id, error = ?e);
        }
    }
    drop(guard);
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
            tracing::error!(
                event = "worker.park_on_proposal_failed",
                %run_id,
                tool_call_id,
                error = ?e
            );
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
            db::run_status(&pool, run_id)
                .await
                .unwrap()
                .map(db::RunStatus::as_str),
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
            db::run_status(&pool, run_id)
                .await
                .unwrap()
                .map(db::RunStatus::as_str),
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
            db::run_status(&pool, run_id)
                .await
                .unwrap()
                .map(db::RunStatus::as_str),
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

    /// One `run_steps` row resolved to its kind + content, ordered by `seq`. A
    /// `message` step resolves its text from the specific `(message_id, part_seq)`
    /// part (ADR-0045); a `tool_call` step resolves the tool name. Read straight
    /// from tier 2 so the test pins the durable timeline, not a wire projection.
    async fn run_steps_kinds_and_content(pool: &SqlitePool, run_id: Uuid) -> Vec<(String, String)> {
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

    /// Within ONE Run, assistant text emitted AFTER a tool call is sequenced
    /// AFTER that tool call in `run_steps` (ADR-0045). A scripted Run streams
    /// text, calls a tool, then streams more text: the durable timeline must read
    /// `[message(user prompt), text("let me look "), tool_call(read_thread),
    /// text("found it")]` — TWO distinct assistant text parts, the second after
    /// the tool. The legacy concat read still returns the full reply, so the wire
    /// shape `thread/get` emits is unchanged.
    #[tokio::test]
    async fn run_steps_sequences_post_tool_text_after_tool_call() {
        let pool = memory_pool().await;
        let wf = test_workflow(&["read_thread"]);
        let (run_id, thread_id, amid) = seed_run(&pool, &wf).await;
        let (hubs, run_hub) = fixtures(run_id);
        let (worker, _sent, _sd) = ScriptedWorker::new(vec![
            WorkerStdout::TextDelta {
                delta: "let me look ".to_string(),
            },
            WorkerStdout::ToolRequest {
                run_id: String::new(),
                tool_call_id: "tc-look".to_string(),
                name: "read_thread".to_string(),
                params: serde_json::json!({ "thread_id": thread_id.to_string() }),
            },
            WorkerStdout::TextDelta {
                delta: "found it".to_string(),
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

        // The durable timeline interleaves the two text segments around the tool.
        let timeline = run_steps_kinds_and_content(&pool, run_id).await;
        assert_eq!(
            timeline,
            vec![
                ("message".to_string(), "prompt".to_string()),
                ("message".to_string(), "let me look ".to_string()),
                ("tool_call".to_string(), "read_thread".to_string()),
                ("message".to_string(), "found it".to_string()),
            ],
            "post-tool text is a distinct segment sequenced AFTER the tool call"
        );

        // The wire shape is unchanged: the snapshot/thread-get concat read still
        // returns the assistant's full reply across both parts, in order.
        let snap = db::select_run_snapshot(&pool, run_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(snap.text, "let me look found it");
    }

    /// One `run_steps` `message` row resolved to `(message_parts.type, text)`,
    /// ordered by `seq`. Like [`run_steps_kinds_and_content`] but exposes each
    /// message step's part TYPE so a test can assert text vs reasoning landed in
    /// distinct, correctly-typed parts (ADR-0045 reasoning amendment). Skips
    /// `tool_call` steps (they have no part).
    async fn message_steps_type_and_text(pool: &SqlitePool, run_id: Uuid) -> Vec<(String, String)> {
        let rows: Vec<(String, String, i64)> = sqlx::query_as(
            "SELECT rs.kind, rs.message_id, rs.part_seq \
             FROM run_steps rs \
             WHERE rs.run_id = ?1 AND rs.kind = 'message' ORDER BY rs.seq",
        )
        .bind(run_id.to_string())
        .fetch_all(pool)
        .await
        .expect("read message run_steps");

        let mut out = Vec::with_capacity(rows.len());
        for (_kind, message_id, part_seq) in rows {
            let (ty, text): (String, String) = sqlx::query_as(
                "SELECT type, text FROM message_parts WHERE message_id = ?1 AND seq = ?2",
            )
            .bind(&message_id)
            .bind(part_seq)
            .fetch_one(pool)
            .await
            .expect("message step's part exists");
            out.push((ty, text));
        }
        out
    }

    /// Reasoning (thinking) deltas open their OWN `message_parts.type='reasoning'`
    /// part, distinct from text, on the same `run_steps.kind='message'` machine
    /// (ADR-0045 reasoning amendment, #202). A scripted Run interleaves
    /// `text → reasoning → tool → reasoning → text`: each contiguous run of one
    /// type is its own correctly-typed part, the tool seals both open slots, and
    /// Core republishes a `RunEvent::ReasoningDelta` per reasoning delta. The
    /// text-only concat read (snapshot) is unchanged — reasoning never leaks into
    /// it.
    #[tokio::test]
    async fn reasoning_deltas_persist_as_typed_parts_and_republish() {
        let pool = memory_pool().await;
        let wf = test_workflow(&["read_thread"]);
        let (run_id, thread_id, amid) = seed_run(&pool, &wf).await;
        let (hubs, run_hub) = fixtures(run_id);
        let mut rx = run_hub.tx.subscribe();
        let (worker, _sent, _sd) = ScriptedWorker::new(vec![
            WorkerStdout::TextDelta {
                delta: "Plan: ".to_string(),
            },
            WorkerStdout::ReasoningDelta {
                delta: "thinking…".to_string(),
            },
            WorkerStdout::ToolRequest {
                run_id: String::new(),
                tool_call_id: "tc-look".to_string(),
                name: "read_thread".to_string(),
                params: serde_json::json!({ "thread_id": thread_id.to_string() }),
            },
            WorkerStdout::ReasoningDelta {
                delta: "more".to_string(),
            },
            WorkerStdout::TextDelta {
                delta: "Done".to_string(),
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

        // (a) The reasoning deltas were republished as Run Events, in order.
        let events = drain(&mut rx);
        let reasoning: Vec<&str> = events
            .iter()
            .filter_map(|e| match e {
                RunEvent::ReasoningDelta { delta } => Some(delta.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            reasoning,
            vec!["thinking…", "more"],
            "each reasoning delta is republished as RunEvent::ReasoningDelta"
        );

        // (b)+(c) The durable timeline keeps text and reasoning in distinct,
        // correctly-typed parts, each contiguous, sequenced around the tool: the
        // initial text seals when the reasoning delta opens; the tool seals the
        // reasoning slot; the post-tool reasoning seals when "Done" text opens.
        let message_steps = message_steps_type_and_text(&pool, run_id).await;
        assert_eq!(
            message_steps,
            vec![
                ("text".to_string(), "prompt".to_string()),
                ("text".to_string(), "Plan: ".to_string()),
                ("reasoning".to_string(), "thinking…".to_string()),
                ("reasoning".to_string(), "more".to_string()),
                ("text".to_string(), "Done".to_string()),
            ],
            "text and reasoning land as separate, correctly-typed, contiguous parts"
        );

        // The text-only concat read (snapshot) excludes reasoning entirely.
        let snap = db::select_run_snapshot(&pool, run_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(snap.text, "Plan: Done");
    }

    /// `text → reasoning → text → reasoning` with NO tool between: the type-switch
    /// alone must seal the open slot in BOTH directions, so the run produces four
    /// distinct contiguous parts rather than merging like-typed runs across the
    /// opposite type. The tool boundary in
    /// `reasoning_deltas_persist_as_typed_parts_and_republish` seals both slots
    /// regardless, so this is the only test exercising each arm's own seal: dropping
    /// the reasoning-arm's text-seal merges "A"+"C" → "AC"; dropping the text-arm's
    /// reasoning-seal merges "B"+"D" → "BD". Either ships undetected without this case.
    #[tokio::test]
    async fn type_switch_alone_seals_the_open_part() {
        let pool = memory_pool().await;
        let wf = test_workflow(&["read_thread"]);
        let (run_id, _thread_id, amid) = seed_run(&pool, &wf).await;
        let (hubs, run_hub) = fixtures(run_id);
        let (worker, _sent, _sd) = ScriptedWorker::new(vec![
            WorkerStdout::TextDelta {
                delta: "A".to_string(),
            },
            WorkerStdout::ReasoningDelta {
                delta: "B".to_string(),
            },
            WorkerStdout::TextDelta {
                delta: "C".to_string(),
            },
            WorkerStdout::ReasoningDelta {
                delta: "D".to_string(),
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

        // Four separate parts. Each arm seals the OTHER slot on a type switch:
        // - reasoning "B" seals text "A" (else "C" appends → "AC");
        // - text "C" seals reasoning "B" (else "D" appends → "BD");
        // - reasoning "D" seals text "C".
        let message_steps = message_steps_type_and_text(&pool, run_id).await;
        assert_eq!(
            message_steps,
            vec![
                ("text".to_string(), "prompt".to_string()),
                ("text".to_string(), "A".to_string()),
                ("reasoning".to_string(), "B".to_string()),
                ("text".to_string(), "C".to_string()),
                ("reasoning".to_string(), "D".to_string()),
            ],
            "a type switch alone (no tool) seals the open part both ways: A|B|C|D stay distinct"
        );

        // Reply text is the two text runs concatenated; reasoning excluded.
        let snap = db::select_run_snapshot(&pool, run_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(snap.text, "AC");
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
            db::run_status(&pool, run_id)
                .await
                .unwrap()
                .map(db::RunStatus::as_str),
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
    async fn invalid_proposal_request_errors_without_parking() {
        let pool = memory_pool().await;
        let wf = test_workflow(&["propose_workspace_mutation"]);
        let (run_id, _t, amid) = seed_run(&pool, &wf).await;
        let (hubs, run_hub) = fixtures(run_id);
        let (worker, _sent, _sd) = ScriptedWorker::new(vec![WorkerStdout::ToolRequest {
            run_id: String::new(),
            tool_call_id: "tc-bad-observation".to_string(),
            name: "propose_workspace_mutation".to_string(),
            params: serde_json::json!({
                "mutation_kind": "record_observations",
                "payload": {
                    "observations": [
                        {
                            "schema_key": "blood_pressure",
                            "occurred_at": "2026-06-10T10:30:00",
                            "values": { "kcal": 450 }
                        }
                    ]
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

        match exit {
            Exit::Errored(message) => assert!(
                message.contains("schema_key"),
                "invalid proposal error names schema_key: {message}"
            ),
            other => panic!("invalid proposal request must error, got {other:?}"),
        }
        assert_eq!(
            db::run_status(&pool, run_id)
                .await
                .unwrap()
                .map(db::RunStatus::as_str),
            Some("errored")
        );
        assert!(
            db::get_pending_proposal_for_run(&pool, run_id)
                .await
                .unwrap()
                .is_none(),
            "invalid proposal args must not create a pending Proposal"
        );
    }

    #[tokio::test]
    async fn invalid_editable_entity_proposal_still_parks() {
        let pool = memory_pool().await;
        let wf = test_workflow(&["propose_workspace_mutation"]);
        let (run_id, _t, amid) = seed_run(&pool, &wf).await;
        let (hubs, run_hub) = fixtures(run_id);
        let (worker, _sent, _sd) = ScriptedWorker::new(vec![WorkerStdout::ToolRequest {
            run_id: String::new(),
            tool_call_id: "tc-invalid-editable".to_string(),
            name: "propose_workspace_mutation".to_string(),
            params: serde_json::json!({
                "mutation_kind": "create_journal_entry",
                "payload": {
                    "occurred_at": "2026-06-10",
                    "body": []
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
            db::run_status(&pool, run_id)
                .await
                .unwrap()
                .map(db::RunStatus::as_str),
            Some("parked")
        );
        assert!(
            db::get_pending_proposal_for_run(&pool, run_id)
                .await
                .unwrap()
                .is_some(),
            "editable invalid Entity proposals park for user repair"
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
        assert_eq!(
            *shutdowns.lock().unwrap(),
            1,
            "the loop shut the Worker down"
        );
        // The loop owns no terminal tx on cancel; here no transition ran at
        // all, so the run stays `running`.
        assert_eq!(
            db::run_status(&pool, run_id)
                .await
                .unwrap()
                .map(db::RunStatus::as_str),
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
        assert!(
            *shutdowns.lock().unwrap() >= 1,
            "the loop shut the Worker down"
        );
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
            db::run_status(&pool, run_id)
                .await
                .unwrap()
                .map(db::RunStatus::as_str),
            Some("cancelled"),
            "a later completion does not overwrite a committed cancellation"
        );
        // And crucially, the loop published NO Done after losing the guard.
        assert!(
            drain(&mut tail).is_empty(),
            "the loop publishes no Done when its terminal transition lost"
        );
    }

    // ── run/retry (ADR-0028 retry amendment, #230) ────────────────────────────

    /// Drive a fresh ScriptedWorker `[TextDelta("half "), Error]` through
    /// `run_loop` so the Run lands `errored` with PARTIAL assistant text
    /// persisted — the failed attempt the retry must discard.
    async fn drive_to_errored_with_partial(
        pool: &SqlitePool,
        run_id: Uuid,
        amid: Uuid,
        wf: &Workflow,
    ) {
        let (hubs, run_hub) = fixtures(run_id);
        let (worker, _sent, _sd) = ScriptedWorker::new(vec![
            WorkerStdout::TextDelta {
                delta: "half ".to_string(),
            },
            WorkerStdout::Error {
                message: "boom".to_string(),
            },
        ]);
        let exit = run_loop(
            worker,
            run_id,
            wf.clone(),
            pool.clone(),
            amid,
            hubs,
            run_hub.tx.clone(),
            run_hub.gate.clone(),
            run_hub.cancel_rx(),
        )
        .await;
        assert!(matches!(exit, Exit::Errored(_)), "errored on first attempt");
        assert_eq!(
            db::run_status(pool, run_id)
                .await
                .unwrap()
                .map(db::RunStatus::as_str),
            Some("errored")
        );
    }

    /// Count a Run's messages by role for the single-turn assertion.
    async fn message_role_counts(pool: &SqlitePool, run_id: Uuid) -> (i64, i64) {
        let user: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE run_id = ?1 AND role = 'user'")
                .bind(run_id.to_string())
                .fetch_one(pool)
                .await
                .expect("count user msgs");
        let assistant: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM messages WHERE run_id = ?1 AND role = 'assistant'",
        )
        .bind(run_id.to_string())
        .fetch_one(pool)
        .await
        .expect("count assistant msgs");
        (user, assistant)
    }

    /// Test A — the authoritative "in place, cleared, single turn" proof.
    /// After driving a Run to `errored` with partial assistant text,
    /// `db::prepare_retry` flips it back to `running`, clears the failed parts,
    /// re-flips the assistant Message to `streaming`, and re-snapshots the model
    /// columns — leaving exactly one user + one assistant row, the SAME ids.
    #[tokio::test]
    async fn prepare_retry_clears_failed_output_in_place() {
        let pool = memory_pool().await;
        let wf = test_workflow(&[]);
        let (run_id, _thread_id, amid) = seed_run(&pool, &wf).await;
        drive_to_errored_with_partial(&pool, run_id, amid, &wf).await;

        // The failed attempt persisted partial text.
        let before = db::select_run_snapshot(&pool, run_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            before.text, "half ",
            "the failed attempt streamed partial text"
        );

        // Re-snapshot to a DIFFERENT model so we can assert the columns moved.
        let retry_wf = Workflow {
            model: Some("gpt-retry".to_string()),
            ..wf.clone()
        };
        let moved = db::prepare_retry(&pool, run_id, &retry_wf, db::now_ms())
            .await
            .expect("prepare_retry");
        assert!(moved.won(), "the errored Run won the retry flip");

        // Status back to running, terminal fields gone; assistant Message streaming.
        assert_eq!(
            db::run_status(&pool, run_id)
                .await
                .unwrap()
                .map(db::RunStatus::as_str),
            Some("running")
        );
        let amid_str = amid.to_string();
        let msg_status: String = sqlx::query_scalar("SELECT status FROM messages WHERE id = ?1")
            .bind(&amid_str)
            .fetch_one(&pool)
            .await
            .expect("read message status");
        assert_eq!(
            msg_status, "streaming",
            "assistant Message re-armed for streaming"
        );

        // The failed parts are GONE — snapshot text empty, no stale message_parts /
        // run_steps for the assistant message.
        let after = db::select_run_snapshot(&pool, run_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            after.text, "",
            "the failed partial text was cleared, not carried"
        );

        // Same ids; exactly one user + one assistant row.
        assert_eq!(
            db::assistant_message_id_for_run(&pool, run_id)
                .await
                .unwrap(),
            Some(amid),
            "the assistant_message_id is reused"
        );
        assert_eq!(message_role_counts(&pool, run_id).await, (1, 1));

        // The USER-prompt run_step SURVIVES the cleanup (CodeRabbit #244): the
        // delete is scoped to the assistant message, so a later park/resume can
        // still reconstruct the user turn from `run_timeline`. The assistant's own
        // `message` steps are gone (their parts were cleared above). Mutation: a
        // blanket `tool_call_id IS NULL` delete would strip the user step → this
        // count drops to 0.
        let user_message_id: String =
            sqlx::query_scalar("SELECT user_message_id FROM runs WHERE id = ?1")
                .bind(run_id.to_string())
                .fetch_one(&pool)
                .await
                .expect("read user_message_id");
        let user_steps: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM run_steps \
             WHERE run_id = ?1 AND kind = 'message' AND message_id = ?2",
        )
        .bind(run_id.to_string())
        .bind(&user_message_id)
        .fetch_one(&pool)
        .await
        .expect("count user run_steps");
        assert_eq!(
            user_steps, 1,
            "the user-prompt run_step survives retry cleanup"
        );
        let assistant_steps: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM run_steps \
             WHERE run_id = ?1 AND kind = 'message' AND message_id = ?2",
        )
        .bind(run_id.to_string())
        .bind(amid.to_string())
        .fetch_one(&pool)
        .await
        .expect("count assistant run_steps");
        assert_eq!(
            assistant_steps, 0,
            "the failed attempt's assistant message steps are cleared"
        );

        // Model column re-snapshotted from the freshly-resolved Workflow.
        let model: String = sqlx::query_scalar("SELECT model FROM runs WHERE id = ?1")
            .bind(run_id.to_string())
            .fetch_one(&pool)
            .await
            .expect("read model");
        assert_eq!(
            model, "gpt-retry",
            "the runs.model column was re-snapshotted"
        );
    }

    /// Test A2 — the failed attempt's tool_calls are cleared too. Pins
    /// `delete_tool_calls` inside `prepare_retry` as load-bearing: a `tool_calls`
    /// row (with its `run_steps` step, via `persist_tool_call`) is seeded for the
    /// errored Run, asserted present before retry, and asserted GONE after — so
    /// removing the DELETE reds this test.
    #[tokio::test]
    async fn prepare_retry_clears_tool_calls_from_failed_attempt() {
        let pool = memory_pool().await;
        let wf = test_workflow(&["read_thread"]);
        let (run_id, _thread_id, amid) = seed_run(&pool, &wf).await;

        // The failed attempt ran a tool call (and got a result) before erroring —
        // persist_tool_call writes both the tool_calls row and its run_steps step.
        db::persist_tool_call(
            &pool,
            run_id,
            "tc_failed",
            "read_thread",
            r#"{"thread_id":"x"}"#,
            db::now_ms(),
        )
        .await
        .expect("persist tool call");
        db::resolve_tool_call(
            &pool,
            "tc_failed",
            "completed",
            r#"{"ok":true}"#,
            db::now_ms(),
        )
        .await
        .expect("resolve tool call");
        drive_to_errored_with_partial(&pool, run_id, amid, &wf).await;

        async fn count_tool_calls(pool: &SqlitePool, run_id: Uuid) -> i64 {
            sqlx::query_scalar("SELECT COUNT(*) FROM tool_calls WHERE run_id = ?1")
                .bind(run_id.to_string())
                .fetch_one(pool)
                .await
                .expect("count tool_calls")
        }

        // Before retry: the failed attempt's tool_calls row exists.
        assert_eq!(
            count_tool_calls(&pool, run_id).await,
            1,
            "the failed attempt left a tool_call"
        );

        let moved = db::prepare_retry(&pool, run_id, &wf, db::now_ms())
            .await
            .expect("prepare_retry");
        assert!(moved.won());

        // After retry: the unproposed tool_calls row is gone
        // (delete_unproposed_tool_calls is load-bearing).
        assert_eq!(
            count_tool_calls(&pool, run_id).await,
            0,
            "the failed attempt's tool_calls were cleared"
        );
    }

    /// Test A3 (F1 regression) — retry SPARES a prior DECIDED proposal's committed
    /// rows. The mainline flow (propose → park → ACCEPT [stamps entity +
    /// entity_revisions referencing the proposal] → resume → later ERROR) leaves a
    /// run carrying a proposal-backed tool_call + a proposals sidecar + a referencing
    /// entity. The old delete-all `DELETE FROM tool_calls WHERE run_id=?1` would
    /// CASCADE-delete the proposals row (FK 0001:116), orphaning
    /// `entities.created_via_proposal_id` → FK violation → whole tx rolls back → Run
    /// stuck `errored` forever. This test asserts `prepare_retry` SUCCEEDS, the
    /// proposal + entity + proposal-backed tool_call SURVIVE, and the failed partial
    /// assistant text is still cleared.
    #[tokio::test]
    async fn prepare_retry_spares_decided_proposal_rows() {
        let pool = memory_pool().await;
        let wf = test_workflow(&["propose_workspace_mutation"]);
        let (run_id, _thread_id, amid) = seed_run(&pool, &wf).await;

        // Seed the committed-history of a PRIOR accepted proposal: a tool_call (+ its
        // run_step, via persist_tool_call), an accepted `proposals` row referencing
        // it, and an `entity` (+ `entity_revisions`) stamped with that proposal id —
        // exactly what apply_proposal commits.
        db::persist_tool_call(
            &pool,
            run_id,
            "tc_prop",
            "propose_workspace_mutation",
            r#"{"mutation_kind":"create_person"}"#,
            db::now_ms(),
        )
        .await
        .expect("persist proposal tool call");
        db::resolve_tool_call(
            &pool,
            "tc_prop",
            "completed",
            r#"{"ok":true}"#,
            db::now_ms(),
        )
        .await
        .expect("resolve proposal tool call");
        sqlx::query(
            "INSERT INTO proposals (id, tool_call_id, mutation_kind, status, decided_by, \
             decided_at, applied_at) VALUES ('prop-1', 'tc_prop', 'create_person', \
             'accepted', 'user', 2, 2)",
        )
        .execute(&pool)
        .await
        .expect("insert accepted proposal");
        sqlx::query(
            "INSERT INTO entities (id, type, schema_version, data, created_by, \
             created_via_proposal_id, created_at, updated_at) \
             VALUES ('ent-1', 'person', 1, '{\"name\":\"Lev\"}', 'proposal', 'prop-1', 2, 2)",
        )
        .execute(&pool)
        .await
        .expect("insert entity from proposal");
        sqlx::query(
            "INSERT INTO entity_revisions (entity_id, seq, data, proposal_id, created_at) \
             VALUES ('ent-1', 0, '{\"name\":\"Lev\"}', 'prop-1', 2)",
        )
        .execute(&pool)
        .await
        .expect("insert entity revision");

        // Then the run streamed partial text and errored.
        drive_to_errored_with_partial(&pool, run_id, amid, &wf).await;

        async fn count(pool: &SqlitePool, sql: &str, bind: &str) -> i64 {
            sqlx::query_scalar(sql)
                .bind(bind.to_string())
                .fetch_one(pool)
                .await
                .expect("count")
        }

        // prepare_retry must SUCCEED (no FK rollback).
        let moved = db::prepare_retry(&pool, run_id, &wf, db::now_ms())
            .await
            .expect("prepare_retry must not roll back when a decided proposal exists");
        assert!(moved.won());

        // The decided proposal's committed rows SURVIVE.
        assert_eq!(
            count(
                &pool,
                "SELECT COUNT(*) FROM proposals WHERE id = ?1",
                "prop-1"
            )
            .await,
            1,
            "the accepted proposal survives"
        );
        assert_eq!(
            count(
                &pool,
                "SELECT COUNT(*) FROM entities WHERE id = ?1",
                "ent-1"
            )
            .await,
            1,
            "the proposal's entity survives"
        );
        assert_eq!(
            count(
                &pool,
                "SELECT COUNT(*) FROM tool_calls WHERE id = ?1",
                "tc_prop"
            )
            .await,
            1,
            "the proposal-backed tool_call is spared"
        );
        // The kept proposal's run_step survives so the decided card still rehydrates.
        assert_eq!(
            count(
                &pool,
                "SELECT COUNT(*) FROM run_steps WHERE tool_call_id = ?1",
                "tc_prop",
            )
            .await,
            1,
            "the proposal's run_step is spared (decided-card rehydration)"
        );

        // But the failed attempt's partial assistant text IS cleared, and the Run is
        // back to running with a streaming assistant Message.
        let snap = db::select_run_snapshot(&pool, run_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(snap.text, "", "the failed partial text was cleared");
        assert_eq!(
            db::run_status(&pool, run_id)
                .await
                .unwrap()
                .map(db::RunStatus::as_str),
            Some("running")
        );
        let msg_status: String = sqlx::query_scalar("SELECT status FROM messages WHERE id = ?1")
            .bind(amid.to_string())
            .fetch_one(&pool)
            .await
            .expect("read message status");
        assert_eq!(msg_status, "streaming");
    }

    /// Test C — full re-drive. After `prepare_retry`, a fresh `run_loop` streaming
    /// `[TextDelta("full answer"), Done]` into the REUSED assistant_message_id
    /// produces ONLY the new text (NOT "half full answer") and completes.
    #[tokio::test]
    async fn retry_then_run_loop_streams_only_new_text() {
        let pool = memory_pool().await;
        let wf = test_workflow(&[]);
        let (run_id, _thread_id, amid) = seed_run(&pool, &wf).await;
        drive_to_errored_with_partial(&pool, run_id, amid, &wf).await;

        db::prepare_retry(&pool, run_id, &wf, db::now_ms())
            .await
            .expect("prepare_retry");

        // Re-drive into the SAME run_id + SAME assistant_message_id.
        let (hubs, run_hub) = fixtures(run_id);
        let (worker, _sent, _sd) = ScriptedWorker::new(vec![
            WorkerStdout::TextDelta {
                delta: "full answer".to_string(),
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
            db::run_status(&pool, run_id)
                .await
                .unwrap()
                .map(db::RunStatus::as_str),
            Some("completed")
        );
        let snap = db::select_run_snapshot(&pool, run_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            snap.text, "full answer",
            "only the retry's text, not concatenated"
        );
        assert_eq!(message_role_counts(&pool, run_id).await, (1, 1));
    }

    /// Test D — outcome mapping inputs. `prepare_retry` on a non-errored Run
    /// reports the flip LOST (caller maps to `not_errored`) and mutates nothing;
    /// an unknown run id reads `run_status == None` (caller maps to `unknown_run`).
    #[tokio::test]
    async fn prepare_retry_on_non_errored_loses_and_unknown_is_none() {
        let pool = memory_pool().await;
        let wf = test_workflow(&[]);

        // A `running` Run (never errored) loses the flip; no spawn would follow.
        let (run_id, _thread_id, _amid) = seed_run(&pool, &wf).await;
        let moved = db::prepare_retry(&pool, run_id, &wf, db::now_ms())
            .await
            .expect("prepare_retry");
        assert!(
            !moved.won(),
            "a running Run cannot be retried → not_errored"
        );
        assert_eq!(
            db::run_status(&pool, run_id)
                .await
                .unwrap()
                .map(db::RunStatus::as_str),
            Some("running"),
            "the running Run is untouched"
        );

        // An unknown run id has no status row → unknown_run.
        assert_eq!(db::run_status(&pool, Uuid::now_v7()).await.unwrap(), None);
    }
}
