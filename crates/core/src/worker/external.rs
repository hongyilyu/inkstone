//! External tool-call lifecycle (external-task-views A4): the coherent owner of
//! an MCP call's durable transitions — begin (persist the pending row + publish
//! `Started`), finish (resolve the row + publish the terminal event), and the
//! interrupted-settlement publication a Run termination emits for still-pending
//! calls. Each is ONE gated critical section so it is atomic w.r.t. the cancel
//! path's gated `Cancelled` (review #1). `run_loop` (worker/run.rs) is left as
//! frame orchestration: it pairs started↔finished frames and routes them here;
//! `run/cancel` publishes interrupted settlements through `publish_interrupted`.

use sqlx::SqlitePool;
use uuid::Uuid;

use crate::db;
use crate::hub::RunHub;
use crate::protocol::{RunEvent, ToolCallStatus, TranscriptToolResult};

/// Persist an external call's started row AND publish its `Started` event as ONE
/// gated critical section (external-task-views A4, review #1). Holding the
/// per-run gate ACROSS the commit and the publish makes the pair atomic w.r.t.
/// the cancel path's gated `Cancelled` — a concurrent cancel can only interleave
/// wholly before or wholly after, never between the committed row and its event.
/// The insert is guarded on the Run still being `running`; the finished frame
/// re-pairs by resolving the persisted row (review M1), so no id is tracked here.
/// A DB fault is `Err` — the caller STOPS the Worker (review R12 #2): letting the
/// model proceed on an unpersisted call would diverge live from reload and
/// resume.
pub(super) async fn begin_external_and_publish(
    pool: &SqlitePool,
    run_id: Uuid,
    run_hub: &RunHub,
    tool_call_id: &str,
    name: &str,
    request_payload: &str,
) -> sqlx::Result<()> {
    let guard = run_hub.gate().await;
    let outcome = db::begin_external_tool_call(
        pool,
        run_id,
        tool_call_id,
        name,
        request_payload,
        db::now_ms(),
    )
    .await;
    let result = match outcome {
        Ok(moved) if moved.won() => {
            run_hub.send(RunEvent::ToolCall {
                tool_call_id: tool_call_id.to_string(),
                name: name.to_string(),
                status: ToolCallStatus::Started,
                arg: None,
                result: None,
            });
            Ok(())
        }
        Ok(_) => {
            tracing::warn!(
                event = "worker.external_started_after_terminal",
                %run_id, tool_call_id
            );
            Ok(())
        }
        Err(e) => Err(e),
    };
    drop(guard);
    result
}

/// Resolve an external call's row AND publish its terminal event as ONE gated
/// critical section (external-task-views A4, review #1). The resolve is scoped to
/// `status='pending'`, so a finish that races a cancel/EOF settle LOSES and emits
/// nothing; and because the commit and the publish share the gate, a won finish's
/// event is ordered BEFORE any `Cancelled` — a live tail can never close on
/// `Cancelled` while its already-committed result sits unpublished (live ==
/// reload).
/// A DB fault is `Err` — the caller STOPS the Worker (review R12 #2): a result
/// the model already consumed but whose row stayed `pending` would reload (and
/// resume) as "not executed".
pub(super) async fn finish_external_and_publish(
    pool: &SqlitePool,
    run_id: Uuid,
    run_hub: &RunHub,
    tool_call_id: &str,
    result: TranscriptToolResult,
) -> sqlx::Result<()> {
    let status = if result.is_error { "errored" } else { "completed" };
    let payload = serde_json::to_string(&result).expect("TranscriptToolResult serializes");
    let guard = run_hub.gate().await;
    let outcome =
        db::finish_external_tool_call(pool, run_id, tool_call_id, status, &payload, db::now_ms())
            .await;
    let flow = match outcome {
        Ok(Some(name)) => {
            run_hub.send(RunEvent::ToolCall {
                tool_call_id: tool_call_id.to_string(),
                name,
                status: if result.is_error {
                    ToolCallStatus::Error
                } else {
                    ToolCallStatus::Completed
                },
                arg: None,
                result: Some(result),
            });
            Ok(())
        }
        // No pending row: a terminal settle already claimed it, OR the frame was
        // unpaired (a Worker-contract violation pi's sequential mode prevents).
        // Both are benign here — the row, if any, is already settled.
        Ok(None) => {
            tracing::debug!(
                event = "worker.external_finished_lost_to_settle",
                %run_id, tool_call_id
            );
            Ok(())
        }
        Err(e) => Err(e),
    };
    drop(guard);
    flow
}

/// Publish the interrupted `tool_call {status: error, result}` event for each
/// external call a terminal transition settled (external-task-views A4) —
/// after that tx committed, before the terminal Run Event. Shared by the
/// loop's own terminal branch and `run/cancel`'s post-response publish.
pub(crate) fn publish_interrupted(
    run_hub: &RunHub,
    interrupted: Vec<db::InterruptedExternalCall>,
) {
    for call in interrupted {
        run_hub.send(RunEvent::ToolCall {
            tool_call_id: call.tool_call_id,
            name: call.name,
            status: ToolCallStatus::Error,
            arg: None,
            result: Some(TranscriptToolResult::interrupted()),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::memory_pool;
    use crate::protocol::WorkerStdout;
    use crate::worker::port::Exit;
    use crate::worker::run::run_loop;
    use crate::worker::test_support::*;

    /// An external call's two frames persist one row — pending on `started`,
    /// resolved on `finished` with `tool_calls.status` DERIVED from
    /// `result.is_error` — and publish started + terminal `tool_call` events,
    /// the terminal one CARRYING the result (A4: the live expandable row must
    /// match reload). A failed call persists as an error, never success-shaped.
    #[tokio::test]
    async fn external_frames_persist_rows_and_publish_result_bearing_events() {
        let pool = memory_pool().await;
        let wf = test_workflow(&[]);
        let (run_id, _t, amid) = seed_run(&pool, &wf).await;
        let (hubs, run_hub) = fixtures(run_id);
        let mut rx = run_hub.subscribe_raw();
        let (worker, sent, _sd) = ScriptedWorker::new(vec![
            external_started("tc-ok", "ticktick_filter_tasks"),
            external_finished("tc-ok", "1 task found", false),
            external_started("tc-bad", "ticktick_search_task"),
            external_finished("tc-bad", "Missing required parameter", true),
            WorkerStdout::Done,
        ]);

        let exit = run_loop(
            worker,
            run_id,
            wf,
            pool.clone(),
            amid,
            hubs,
            run_hub.clone(),
        )
        .await;

        assert_eq!(exit, Exit::Done);
        // Core only observes — no Tool Protocol round-trip happened.
        assert!(sent.lock().unwrap().is_empty(), "no tool_result was sent");

        // Persisted rows: status derives from result.is_error; the payload is
        // the TranscriptToolResult JSON.
        let (name, status, payload) = tool_call_row(&pool, "tc-ok").await.expect("tc-ok row");
        assert_eq!(name, "ticktick_filter_tasks");
        assert_eq!(status, "completed");
        assert_eq!(
            serde_json::from_str::<TranscriptToolResult>(&payload.expect("payload")).unwrap(),
            TranscriptToolResult::text("1 task found", false)
        );
        let (_, status, payload) = tool_call_row(&pool, "tc-bad").await.expect("tc-bad row");
        assert_eq!(status, "errored", "a failed call persists as an error");
        assert_eq!(
            serde_json::from_str::<TranscriptToolResult>(&payload.expect("payload")).unwrap(),
            TranscriptToolResult::text("Missing required parameter", true)
        );

        // Events: started (no result) then terminal (carrying the result), per
        // call, in source order.
        let events = drain(&mut rx);
        let calls: Vec<(&str, &ToolCallStatus, bool)> = events
            .iter()
            .filter_map(|e| match e {
                RunEvent::ToolCall {
                    tool_call_id,
                    status,
                    result,
                    ..
                } => Some((tool_call_id.as_str(), status, result.is_some())),
                _ => None,
            })
            .collect();
        assert_eq!(
            calls,
            vec![
                ("tc-ok", &ToolCallStatus::Started, false),
                ("tc-ok", &ToolCallStatus::Completed, true),
                ("tc-bad", &ToolCallStatus::Started, false),
                ("tc-bad", &ToolCallStatus::Error, true),
            ],
            "started omits result; the terminal event carries it"
        );
    }

    /// A cancel signalled just before a finished frame trips the loop's
    /// post-recv cancel check, which breaks BEFORE the finished arm runs — so
    /// the row stays `pending` for `run/cancel`'s settle to claim, and no
    /// completion event escapes. (The DB-level guard that stops a finish which
    /// races an ALREADY-COMMITTED settle is exercised directly by
    /// `finish_external_tool_call_loses_to_a_committed_settle`.)
    #[tokio::test]
    async fn cancel_racing_finished_frame_leaves_row_pending_for_the_settle() {
        let pool = memory_pool().await;
        let wf = test_workflow(&[]);
        let (run_id, _t, amid) = seed_run(&pool, &wf).await;
        let (hubs, run_hub) = fixtures(run_id);
        let mut tail = run_hub.subscribe_raw();
        // started (idx 0), then cancel flips before the finished frame (idx 1).
        let (worker, _sent, _sd) = CancelingWorker::new(
            vec![
                external_started("tc-race", "ticktick_filter_tasks"),
                external_finished("tc-race", "1 task found", false),
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
            run_hub.clone(),
        )
        .await;

        assert_eq!(exit, Exit::Cancelled);
        // The row stayed pending — the finished arm skipped its resolve, so the
        // cancel transition's settle (run in run/cancel, not here) will catch it.
        let (_, status, payload) = tool_call_row(&pool, "tc-race").await.expect("row");
        assert_eq!(status, "pending", "the finished frame did not resolve the row");
        assert_eq!(payload, None, "no success-shaped result clobbered the settle");
        // No completion event was published for the raced finished frame (only
        // the started event precedes the cancel).
        let events = drain(&mut tail);
        assert!(
            !events.iter().any(|e| matches!(
                e,
                RunEvent::ToolCall { status: ToolCallStatus::Completed, .. }
            )),
            "no completed tool_call event escaped the cancel guard: {events:?}"
        );
    }

    /// The DB-level guard (external-task-views A4, finding #1): once a terminal
    /// settle has committed the row (`cancel_running_run` → interrupted), a
    /// LATER `finish_external_tool_call` LOSES (`WHERE status='pending'` matches
    /// 0 rows) and leaves the interrupted result intact — a late success result
    /// can never clobber the settle. And `begin_external_tool_call` LOSES once
    /// the Run is no longer `running`, so a started frame that races the
    /// terminal inserts no phantom row.
    #[tokio::test]
    async fn finish_external_tool_call_loses_to_a_committed_settle() {
        let pool = memory_pool().await;
        let wf = test_workflow(&[]);
        let (run_id, _t, _amid) = seed_run(&pool, &wf).await;

        // A started external call lands its pending row while running.
        assert!(
            db::begin_external_tool_call(
                &pool,
                run_id,
                "tc-x",
                "ticktick_filter_tasks",
                "{}",
                db::now_ms(),
            )
            .await
            .unwrap()
            .won()
        );

        // The cancel transition settles it as interrupted + flips the Run.
        assert!(
            db::cancel_running_run(&pool, run_id, db::now_ms())
                .await
                .unwrap()
                .won()
        );

        // A finish now LOSES — the row is no longer pending.
        let finished = db::finish_external_tool_call(
            &pool,
            run_id,
            "tc-x",
            "completed",
            r#"{"content":[{"type":"text","text":"late"}],"is_error":false}"#,
            db::now_ms(),
        )
        .await
        .unwrap();
        assert!(
            finished.is_none(),
            "a finish racing a committed settle loses (no pending row to resolve)"
        );
        let (_, status, payload) = tool_call_row(&pool, "tc-x").await.expect("row");
        assert_eq!(status, "errored", "the interrupted settle stands");
        assert_eq!(
            serde_json::from_str::<TranscriptToolResult>(&payload.unwrap()).unwrap(),
            TranscriptToolResult::interrupted(),
            "the late success result did not clobber the settle"
        );

        // A started frame arriving after the Run went terminal inserts nothing.
        let began = db::begin_external_tool_call(
            &pool,
            run_id,
            "tc-late",
            "ticktick_search_task",
            "{}",
            db::now_ms(),
        )
        .await
        .unwrap();
        assert!(!began.won(), "begin loses once the Run is not running");
        assert!(
            tool_call_row(&pool, "tc-late").await.is_none(),
            "no phantom row for a started frame that raced the terminal"
        );
    }

    /// Barrier (external-task-views A4, review #1): `finish_external_and_publish`
    /// commits the row INSIDE the gate, so while another holder owns the gate the
    /// resolve cannot land — the row stays `pending` and no event escapes. This is
    /// the anti-divergence property: the publish can never be observed before its
    /// commit, and (symmetrically) a won finish's event orders before a gated
    /// `Cancelled`. On a current-thread runtime a single `yield_now` parks the
    /// spawned finish squarely on `gate().await`; before the fix (commit BEFORE
    /// the gate) the row would already read `completed` here.
    #[tokio::test]
    async fn finish_external_persist_and_publish_are_one_gated_unit() {
        let pool = memory_pool().await;
        let wf = test_workflow(&[]);
        let (run_id, _t, _amid) = seed_run(&pool, &wf).await;
        let (_hubs, run_hub) = fixtures(run_id);
        let mut tail = run_hub.subscribe_raw();
        assert!(
            db::begin_external_tool_call(&pool, run_id, "tc-g", "ticktick_filter_tasks", "{}", db::now_ms())
                .await
                .unwrap()
                .won()
        );

        // Hold the gate, then spawn the finish: it parks on `gate().await`.
        let guard = run_hub.gate().await;
        let finish = tokio::spawn({
            let pool = pool.clone();
            let hub = run_hub.clone();
            async move {
                finish_external_and_publish(
                    &pool,
                    run_id,
                    &hub,
                    "tc-g",
                    TranscriptToolResult::text("1 task", false),
                )
                .await
                .expect("finish persists");
            }
        });
        tokio::task::yield_now().await;

        // Gate held → the resolve has not committed and no event leaked.
        let (_, status, _) = tool_call_row(&pool, "tc-g").await.expect("row");
        assert_eq!(status, "pending", "the commit is inside the gate we hold");
        assert!(tail.try_recv().is_err(), "no event before the gate frees");

        // Release: the finish commits and publishes as a unit.
        drop(guard);
        finish.await.expect("finish task joins");
        let (_, status, _) = tool_call_row(&pool, "tc-g").await.expect("row");
        assert_eq!(status, "completed", "the resolve lands once the gate frees");
        assert!(
            matches!(
                drain(&mut tail).as_slice(),
                [RunEvent::ToolCall { status: ToolCallStatus::Completed, result: Some(_), .. }]
            ),
            "exactly the completed tool_call event, carrying its result"
        );
    }

    /// A mixed Core + external batch lands in SOURCE order in `run_steps` —
    /// the durable timeline the reload renders (A4: sequential mode makes
    /// frame order == source order by contract).
    #[tokio::test]
    async fn mixed_core_and_external_batch_lands_in_source_order() {
        let pool = memory_pool().await;
        let wf = test_workflow(&["read_thread"]);
        let (run_id, thread_id, amid) = seed_run(&pool, &wf).await;
        let (hubs, run_hub) = fixtures(run_id);
        let (worker, _sent, _sd) = ScriptedWorker::new(vec![
            WorkerStdout::ToolRequest {
                run_id: String::new(),
                tool_call_id: "tc-core".to_string(),
                name: "read_thread".to_string(),
                params: serde_json::json!({ "thread_id": thread_id.to_string() }),
            },
            external_started("tc-ext", "ticktick_filter_tasks"),
            external_finished("tc-ext", "1 task found", false),
            WorkerStdout::TextDelta {
                delta: "done".to_string(),
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
            run_hub.clone(),
        )
        .await;

        assert_eq!(exit, Exit::Done);
        let timeline = run_steps_kinds_and_content(&pool, run_id).await;
        assert_eq!(
            timeline,
            vec![
                ("message".to_string(), "prompt".to_string()),
                ("tool_call".to_string(), "read_thread".to_string()),
                ("tool_call".to_string(), "ticktick_filter_tasks".to_string()),
                ("message".to_string(), "done".to_string()),
            ],
            "Core and external calls interleave in source order"
        );
    }

    /// Worker EOF after `external_tool_started` (the Worker died mid-call):
    /// the terminal transition settles the row as an ERROR carrying the
    /// Core-generated interrupted result, and the interrupted `tool_call`
    /// event publishes BEFORE the loop finishes (EOF's terminal signal is the
    /// hub closing — no Done/Error event follows it).
    #[tokio::test]
    async fn worker_eof_after_started_settles_interrupted() {
        let pool = memory_pool().await;
        let wf = test_workflow(&[]);
        let (run_id, _t, amid) = seed_run(&pool, &wf).await;
        let (hubs, run_hub) = fixtures(run_id);
        let mut rx = run_hub.subscribe_raw();
        // started, then the script is exhausted → recv None (EOF, no finished).
        let (worker, _sent, _sd) =
            ScriptedWorker::new(vec![external_started("tc-hang", "ticktick_search_task")]);

        let exit = run_loop(
            worker,
            run_id,
            wf,
            pool.clone(),
            amid,
            hubs,
            run_hub.clone(),
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
        let (_, status, payload) = tool_call_row(&pool, "tc-hang").await.expect("row");
        assert_eq!(status, "errored");
        assert_eq!(
            serde_json::from_str::<TranscriptToolResult>(&payload.expect("payload")).unwrap(),
            TranscriptToolResult::interrupted(),
            "the settle wrote the Core-generated interrupted result"
        );

        // Live path: started, then the interrupted error event carrying the
        // SAME result reload will render — published before the hub closes.
        let events = drain(&mut rx);
        let calls: Vec<(&str, &ToolCallStatus, Option<&TranscriptToolResult>)> = events
            .iter()
            .filter_map(|e| match e {
                RunEvent::ToolCall {
                    tool_call_id,
                    status,
                    result,
                    ..
                } => Some((tool_call_id.as_str(), status, result.as_ref())),
                _ => None,
            })
            .collect();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0], ("tc-hang", &ToolCallStatus::Started, None));
        assert_eq!(
            calls[1],
            (
                "tc-hang",
                &ToolCallStatus::Error,
                Some(&TranscriptToolResult::interrupted())
            )
        );
        // EOF publishes the interrupted `tool_call` BEFORE the terminal Run
        // Event, and that terminal event is `Error` (NOT `Done`, NOT absent) —
        // the Worker died, so the live tail sees the failure.
        let interrupted_idx = events.iter().position(|e| {
            matches!(e, RunEvent::ToolCall { status: ToolCallStatus::Error, .. })
        });
        let terminal_idx = events
            .iter()
            .position(|e| matches!(e, RunEvent::Error { .. }));
        assert!(
            matches!((interrupted_idx, terminal_idx), (Some(i), Some(t)) if i < t),
            "interrupted tool_call precedes the terminal Error, got {events:?}"
        );
        assert!(
            !events.iter().any(|e| matches!(e, RunEvent::Done)),
            "EOF is not reported as done"
        );
    }

    /// Two same-name external calls stay two distinct rows with distinct
    /// results (A4: per-call identity — the Web never groups external calls).
    #[tokio::test]
    async fn two_same_name_external_calls_persist_two_rows() {
        let pool = memory_pool().await;
        let wf = test_workflow(&[]);
        let (run_id, _t, amid) = seed_run(&pool, &wf).await;
        let (hubs, run_hub) = fixtures(run_id);
        let (worker, _sent, _sd) = ScriptedWorker::new(vec![
            external_started("tc-1", "ticktick_search_task"),
            external_finished("tc-1", "first result", false),
            external_started("tc-2", "ticktick_search_task"),
            external_finished("tc-2", "second result", false),
            WorkerStdout::Done,
        ]);

        let exit = run_loop(
            worker,
            run_id,
            wf,
            pool.clone(),
            amid,
            hubs,
            run_hub.clone(),
        )
        .await;

        assert_eq!(exit, Exit::Done);
        let (_, _, first) = tool_call_row(&pool, "tc-1").await.expect("tc-1");
        let (_, _, second) = tool_call_row(&pool, "tc-2").await.expect("tc-2");
        assert_eq!(
            serde_json::from_str::<TranscriptToolResult>(&first.unwrap()).unwrap(),
            TranscriptToolResult::text("first result", false)
        );
        assert_eq!(
            serde_json::from_str::<TranscriptToolResult>(&second.unwrap()).unwrap(),
            TranscriptToolResult::text("second result", false)
        );
    }

    /// Fault injection (review R12 #2): a DB fault on the external BEGIN write
    /// STOPS the Worker — the model must not run ahead of the durable
    /// transcript. A closed pool makes every acquire fail; the loop must exit
    /// `Errored` with the persist message, consuming no further frames.
    #[tokio::test]
    async fn begin_persist_fault_stops_the_worker() {
        let pool = memory_pool().await;
        let wf = test_workflow(&[]);
        let (run_id, _t, amid) = seed_run(&pool, &wf).await;
        let (hubs, run_hub) = fixtures(run_id);
        let (worker, _sent, shutdowns) = ScriptedWorker::new(vec![
            external_started("tc-fault", "ticktick_filter_tasks"),
            WorkerStdout::TextDelta {
                delta: "never persisted".to_string(),
            },
            WorkerStdout::Done,
        ]);

        pool.close().await;
        let exit = run_loop(
            worker,
            run_id,
            wf,
            pool.clone(),
            amid,
            hubs,
            run_hub.clone(),
        )
        .await;

        assert_eq!(
            exit,
            Exit::Errored(super::super::run::EXTERNAL_PERSIST_FAILED_MESSAGE.to_string()),
            "a lifecycle-persist fault is run-fatal, not telemetry"
        );
        assert!(
            *shutdowns.lock().unwrap() >= 1,
            "the Worker was shut down at the fault"
        );
    }
}