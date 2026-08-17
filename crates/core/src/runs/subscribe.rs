//! `run/subscribe` handler: snapshot-then-tail (ADR-0022).
//!
//! Live hub: take the per-run gate, snapshot tier 2, attach a broadcast
//! receiver under the gate, release. This `lock → snapshot → attach → unlock`
//! is mutually exclusive with the Worker's `lock → persist → publish → unlock`,
//! so every delta is delivered exactly once (snapshot or tail). Send the
//! subscribe response, then the snapshot as a `text_delta`, then spawn a
//! forwarder for the live tail (keeping `handle_socket`'s select loop free).
//!
//! No hub (terminal/removed): emit the DB snapshot and the persisted terminal
//! outcome, then close without attaching. An unknown run id stays defensible.

use sqlx::SqlitePool;
use tokio::sync::broadcast;
use tokio::sync::mpsc::UnboundedSender;
use uuid::Uuid;

use super::reply::{send_proposal_pending, send_response, send_run_event};
use crate::db::{self, RunStatus};
use crate::hub::{self, Hubs, RunTail};
use crate::protocol::{RunEvent, SubscribeParams, SubscribeResult};

pub(super) async fn handle(
    pool: &SqlitePool,
    hubs: &Hubs,
    id: serde_json::Value,
    params: SubscribeParams,
    out_tx: &UnboundedSender<String>,
) {
    let run_id = params.run_id;
    let lifecycle = hub::lifecycle(hubs, run_id).await;

    match hub::get(hubs, run_id) {
        Some(run_hub) => {
            // Snapshot and attach while the lifecycle slot pins this exact hub
            // generation. The hub gate keeps the durable timeline and live tail
            // gap-free; the lifecycle slot keeps generation classification stable.
            let ((snapshot, segments), tail) = run_hub
                .snapshot_then_attach(|| async {
                    (
                        db::select_run_snapshot(pool, run_id).await,
                        db::run_live_segments(pool, run_id, true).await,
                    )
                })
                .await;

            let (status, error_message) = match snapshot {
                Ok(Some(snap)) => (snap.status, snap.error_message),
                Ok(None) => (RunStatus::Running, None),
                Err(e) => {
                    tracing::error!(event = "subscribe.snapshot_read_failed", %run_id, error = ?e);
                    (RunStatus::Running, None)
                }
            };

            send_subscribe_response(out_tx, id, run_id, status.as_str());
            send_segment_snapshot(out_tx, run_id, segments);
            match status {
                RunStatus::Running | RunStatus::Parked => {
                    drop(lifecycle);
                    spawn_tail_forwarder(run_id, hubs.clone(), tail, out_tx.clone(), pool.clone());
                }
                terminal => {
                    if let Some(event) = terminal_event(terminal, error_message) {
                        send_run_event(out_tx, run_id, &event);
                    }
                    drop(lifecycle);
                }
            }
        }
        None => {
            // No activation or drain can cross this read: both acquire the same
            // lifecycle slot before changing the hub generation or durable status.
            let snapshot = match db::select_run_snapshot(pool, run_id).await {
                Ok(snapshot) => snapshot,
                Err(e) => {
                    tracing::error!(event = "subscribe.snapshot_read_failed", %run_id, error = ?e);
                    None
                }
            };
            let segments = if snapshot.is_some() {
                Some(db::run_live_segments(pool, run_id, false).await)
            } else {
                None
            };

            send_subscribe_response(
                out_tx,
                id,
                run_id,
                snapshot.as_ref().map_or("", |snap| snap.status.as_str()),
            );
            if let Some(segments) = segments {
                send_segment_snapshot(out_tx, run_id, segments);
            }
            match snapshot {
                Some(snap) if snap.status == RunStatus::Parked => {
                    emit_pending(out_tx, pool, run_id).await;
                }
                Some(snap) => {
                    if let Some(event) = terminal_event(snap.status, snap.error_message) {
                        send_run_event(out_tx, run_id, &event);
                    }
                }
                None => send_run_event(
                    out_tx,
                    run_id,
                    &RunEvent::Error {
                        message: "unknown run".to_string(),
                    },
                ),
            }
            drop(lifecycle);
        }
    }
}

/// The terminal `RunEvent` a settled (or live-lost) status maps to — `None` for
/// `Parked` (which pushes `proposal/pending` instead, ADR-0025). A `Running` Run
/// reached WITHOUT a live hub lost its Worker (the boot-recovery window — every
/// activation path registers its hub BEFORE flipping `running`, review R8 #1 —
/// which the recovery sweep closes) → `Error`, NEVER a synthesized `Done`. The
/// SINGLE source every subscribe terminal site consumes (review M2), so the
/// mapping can't diverge and the forwarder can't fall through to a
/// false-success catch-all.
fn terminal_event(status: RunStatus, error_message: Option<String>) -> Option<RunEvent> {
    match status {
        RunStatus::Parked => None,
        RunStatus::Completed => Some(RunEvent::Done),
        RunStatus::Cancelled => Some(RunEvent::Cancelled),
        RunStatus::Errored => Some(RunEvent::Error {
            message: error_message.unwrap_or_default(),
        }),
        RunStatus::Running => Some(RunEvent::Error {
            message: crate::worker::WORKER_DISCONNECTED_MESSAGE.to_string(),
        }),
    }
}

/// Push a `proposal/pending {run_id, proposal_id}` Notification if the Run has
/// a pending Proposal. A missing Proposal or read error is tolerated — the
/// Client still learns the park via the `parked` response status (ADR-0025).
async fn emit_pending(out_tx: &UnboundedSender<String>, pool: &SqlitePool, run_id: Uuid) {
    match db::get_pending_proposal_for_run(pool, run_id).await {
        Ok(Some(p)) => send_proposal_pending(out_tx, run_id, &p.proposal_id),
        Ok(None) => {}
        Err(e) => {
            // Tolerated degradation (ADR-0038 level discipline): the Client
            // still learns the park via the `parked` response status, so this
            // is WARN, not ERROR.
            tracing::warn!(event = "subscribe.pending_proposal_lookup_failed", %run_id, error = ?e);
        }
    }
}

/// Emit the Run's ordered timeline as ONE `RunEvent::Snapshot` (review P1 #2):
/// the Client atomically REPLACES its segments for the Run with this list, so the
/// reconnect timeline matches `thread/get` in interleaved order (text / reasoning
/// / tool_call), plus any still-running call. Maps db `MessageSegment` → wire
/// `Segment` via the shared `From` impl. A read fault degrades to no snapshot
/// (WARN) — the tail still delivers subsequent deltas.
fn send_segment_snapshot(
    out_tx: &UnboundedSender<String>,
    run_id: Uuid,
    segments: sqlx::Result<Vec<db::MessageSegment>>,
) {
    match segments {
        Ok(segments) => send_run_event(
            out_tx,
            run_id,
            &RunEvent::Snapshot {
                segments: segments.into_iter().map(crate::protocol::Segment::from).collect(),
            },
        ),
        Err(e) => {
            tracing::warn!(event = "subscribe.segment_snapshot_read_failed", %run_id, error = ?e);
        }
    }
}

/// Frame the subscribe RESPONSE `{run_id, status}` (ADR-0022, ADR-0025):
/// `status` is `running` while a live hub exists, else persisted `runs.status`,
/// so a refreshed Client tells `parked` from terminal. Events arrive as
/// separate `run/event` notifications.
fn send_subscribe_response(
    out_tx: &UnboundedSender<String>,
    id: serde_json::Value,
    run_id: Uuid,
    status: &str,
) {
    send_response(
        out_tx,
        id,
        serde_json::to_value(SubscribeResult {
            run_id: run_id.to_string(),
            status: status.to_string(),
        })
        .expect("SubscribeResult serializes"),
    );
}

/// Spawn a task owning the broadcast `Receiver` + the connection's `out_tx`,
/// forwarding the live tail as `run/event` notifications. Ends on
/// `RecvError::Closed` (sender dropped at the Worker's `hub::remove`) or on
/// connection drop (`out_tx.closed()`). `tokio::select!`ing on both wakes a
/// dropped connection promptly even while parked on `recv()` (ADR-0022); on
/// drop it just breaks, no synthesized `done` — the Run keeps running under the
/// Worker (ADR-0012).
///
/// `Lagged` → re-snapshot + re-attach under the gate (ADR-0022 §28, review F2):
/// on buffer overflow, re-read the ordered timeline AND attach a FRESH receiver
/// (`resubscribe()`, positioned at the current tail) inside the gate, so the
/// snapshot's last-committed event meets the resumed tail exactly — no event is
/// replayed from the stale buffer (which would duplicate text/reasoning), none
/// lost. The [`RunTail`] owns the receiver + gate but NO sender, so the forwarder
/// never keeps the channel open and `Closed` still fires.
///
/// Terminal-event guarantee: a subscribe can attach in the window between a
/// terminal event being published and `hub::remove`, with its receiver
/// positioned AFTER the event — it would never see it and the stream would
/// hang. So the forwarder tracks whether it forwarded a terminal event and, on
/// channel close (connection still up), synthesizes the persisted outcome if it
/// never did. Every connected subscriber path ends with exactly one terminal
/// event.
fn spawn_tail_forwarder(
    run_id: Uuid,
    hubs: Hubs,
    mut tail: RunTail,
    out_tx: UnboundedSender<String>,
    pool: SqlitePool,
) {
    tokio::spawn(async move {
        let mut saw_terminal = false;
        'forward: loop {
            tokio::select! {
                () = out_tx.closed() => break,
                recv = tail.recv() => {
                    match recv {
                        Ok(event) => {
                            if matches!(
                                event,
                                RunEvent::Done | RunEvent::Cancelled | RunEvent::Error { .. }
                            ) {
                                saw_terminal = true;
                            }
                            send_run_event(&out_tx, run_id, &event);
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            if !saw_terminal {
                                // The old sender is gone. Pin generation turnover
                                // before deciding whether to reattach or synthesize
                                // the persisted terminal outcome.
                                let lifecycle = hub::lifecycle(&hubs, run_id).await;
                                if let Some(next) = hub::get(&hubs, run_id) {
                                    let (segments, next_tail) = next
                                        .snapshot_then_attach(|| async {
                                            db::run_live_segments(&pool, run_id, true).await
                                        })
                                        .await;
                                    send_segment_snapshot(&out_tx, run_id, segments);
                                    tail = next_tail;
                                    drop(lifecycle);
                                    continue 'forward;
                                }

                                match db::select_run_snapshot(&pool, run_id).await {
                                    Ok(Some(snap)) if snap.status == RunStatus::Parked => {
                                        emit_pending(&out_tx, &pool, run_id).await;
                                    }
                                    Ok(Some(snap)) => {
                                        if let Some(event) =
                                            terminal_event(snap.status, snap.error_message)
                                        {
                                            send_run_event(&out_tx, run_id, &event);
                                        }
                                    }
                                    Ok(None) | Err(_) => send_run_event(
                                        &out_tx,
                                        run_id,
                                        &RunEvent::Error {
                                            message: crate::worker::WORKER_DISCONNECTED_MESSAGE
                                                .to_string(),
                                        },
                                    ),
                                }
                                drop(lifecycle);
                            }
                            break;
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            tracing::warn!(event = "subscribe.forwarder_lagged", %run_id, n);
                            let segments = tail
                                .recover(|| async {
                                    db::run_live_segments(&pool, run_id, true).await
                                })
                                .await;
                            send_segment_snapshot(&out_tx, run_id, segments);
                        }
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use crate::db::test_support::memory_pool;
    use std::sync::Arc;
    use tokio::sync::mpsc;
    use uuid::Uuid;

    use super::*;

    /// Seed a Thread + Run, then commit a `running -> cancelled` transition so
    /// tier 2 reports `cancelled` (the state a late subscriber must read back).
    async fn seed_cancelled_run(pool: &SqlitePool) -> Uuid {
        let workflow = crate::workflow::Workflow {
            name: "test".to_string(),
            version: "1".to_string(),
            provider: "faux".to_string(),
            model: Some("m".to_string()),
            system_prompt: "sp".to_string(),
            thinking_level: Some("off".to_string()),
            tools: Vec::new(),
            external_tools: false,
        };
        let run_id = Uuid::now_v7();
        db::persist_thread_with_first_run(
            pool,
            Uuid::now_v7(),
            run_id,
            Uuid::now_v7(),
            Uuid::now_v7(),
            &workflow,
            "prompt",
            &[],
            "t",
            1,
        )
        .await
        .expect("seed run");
        assert!(
            db::cancel_running_run(pool, run_id, db::now_ms())
                .await
                .expect("cancel")
                .won(),
            "the seed transition wins running -> cancelled"
        );
        run_id
    }

    /// Seed a Thread + Run, then stamp it `errored` with `message` (the terminal
    /// fields `RunStatus::fail` leaves behind), so a late subscriber must read the
    /// failure back as `Error` — never a synthesized `done`.
    async fn seed_errored_run(pool: &SqlitePool, message: &str) -> Uuid {
        let workflow = crate::workflow::Workflow {
            name: "test".to_string(),
            version: "1".to_string(),
            provider: "faux".to_string(),
            model: Some("m".to_string()),
            system_prompt: "sp".to_string(),
            thinking_level: Some("off".to_string()),
            tools: Vec::new(),
            external_tools: false,
        };
        let run_id = Uuid::now_v7();
        db::persist_thread_with_first_run(
            pool,
            Uuid::now_v7(),
            run_id,
            Uuid::now_v7(),
            Uuid::now_v7(),
            &workflow,
            "prompt",
            &[],
            "t",
            1,
        )
        .await
        .expect("seed run");
        sqlx::query(
            "UPDATE runs SET status = 'errored', terminal_reason = 'errored', \
             error_code = 'agent_error', error_message = ?1, ended_at = 99 WHERE id = ?2",
        )
        .bind(message)
        .bind(run_id.to_string())
        .execute(pool)
        .await
        .expect("stamp errored");
        run_id
    }

    /// Seed a Thread + Run left `running` (the state `run/post_message` leaves it
    /// in), so a subscribe takes the live-hub snapshot path.
    async fn seed_running_run(pool: &SqlitePool) -> Uuid {
        let workflow = crate::workflow::Workflow {
            name: "test".to_string(),
            version: "1".to_string(),
            provider: "faux".to_string(),
            model: Some("m".to_string()),
            system_prompt: "sp".to_string(),
            thinking_level: Some("off".to_string()),
            tools: Vec::new(),
            external_tools: false,
        };
        let run_id = Uuid::now_v7();
        db::persist_thread_with_first_run(
            pool,
            Uuid::now_v7(),
            run_id,
            Uuid::now_v7(),
            Uuid::now_v7(),
            &workflow,
            "prompt",
            &[],
            "t",
            1,
        )
        .await
        .expect("seed run");
        run_id
    }

    /// Terminal-event guarantee (ADR-0022): a subscriber attaching after
    /// `Cancelled` was published — its receiver positioned past the event —
    /// must still terminate with exactly one `cancelled` on channel close, not
    /// a synthesized `done`.
    #[tokio::test]
    async fn tail_forwarder_synthesizes_cancelled_on_close_for_a_late_subscriber() {
        let pool = memory_pool().await;
        let run_id = seed_cancelled_run(&pool).await;

        // Receiver created after the terminal event: sender dropped with
        // nothing buffered, so `recv()` yields `Closed` straight away.
        let (event_tx, event_rx) = broadcast::channel::<RunEvent>(8);
        drop(event_tx);

        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
        spawn_tail_forwarder(
            run_id,
            hub::new_hubs(),
            RunTail::from_parts(event_rx, Arc::new(tokio::sync::Mutex::new(()))),
            out_tx,
            pool.clone(),
        );

        // Exactly one frame: a synthesized `cancelled`, then the channel closes.
        let body = tokio::time::timeout(std::time::Duration::from_secs(5), out_rx.recv())
            .await
            .expect("forwarder emits within timeout")
            .expect("a terminal frame is sent");
        let frame: serde_json::Value = serde_json::from_str(&body).expect("frame is JSON");
        assert_eq!(
            frame["params"]["event"]["kind"].as_str(),
            Some("cancelled"),
            "a late subscriber to a cancelled Run gets `cancelled`, not `done` — body: {body}"
        );
        assert!(
            out_rx.recv().await.is_none(),
            "the forwarder sends exactly one terminal event then ends"
        );
    }

    /// A subscribe finding a LIVE hub whose persisted status is already
    /// `cancelled` (Worker won the cancel but hasn't dropped its hub clone).
    /// Attaching a tail would block forever, so the handler must emit
    /// `cancelled` and close instead.
    #[tokio::test]
    async fn live_hub_with_terminal_status_emits_cancelled_without_tailing() {
        let pool = memory_pool().await;
        let run_id = seed_cancelled_run(&pool).await;
        // A live hub still registered (Worker has not reached hub::remove).
        let hubs = hub::new_hubs();
        let _run_hub = hub::register(&hubs, run_id).expect("fresh run registers");

        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
        handle(&pool, &hubs, serde_json::json!(7), SubscribeParams { run_id }, &out_tx).await;

        // Subscribe response, then the ordered segment snapshot, then `cancelled`.
        let resp: serde_json::Value =
            serde_json::from_str(&out_rx.recv().await.expect("subscribe response")).unwrap();
        assert_eq!(resp["result"]["status"].as_str(), Some("cancelled"));
        let snapshot: serde_json::Value =
            serde_json::from_str(&out_rx.recv().await.expect("snapshot")).unwrap();
        assert_eq!(snapshot["params"]["event"]["kind"].as_str(), Some("snapshot"));
        let terminal: serde_json::Value =
            serde_json::from_str(&out_rx.recv().await.expect("terminal")).unwrap();
        assert_eq!(
            terminal["params"]["event"]["kind"].as_str(),
            Some("cancelled"),
            "a live-hub-but-cancelled subscribe terminates with cancelled"
        );

        // No forwarder spawned: this scope is the only owner of out_tx, so
        // dropping it closes the channel immediately.
        drop(out_tx);
        assert!(
            out_rx.recv().await.is_none(),
            "no forwarder attached — exactly three frames, then close"
        );
    }

    /// Review #2: a late subscribe to an ERRORED Run with NO live hub must
    /// terminate with `Error` (carrying the persisted message), never a
    /// synthesized `done`. This is the no-hub branch the old `_ => Done` fall-
    /// through mis-reported as success.
    #[tokio::test]
    async fn no_hub_errored_run_terminates_with_error_not_done() {
        let pool = memory_pool().await;
        let run_id = seed_errored_run(&pool, "provider auth failed").await;
        // Empty registry → the no-hub branch (the Run's hub is long gone).
        let hubs = hub::new_hubs();

        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
        handle(&pool, &hubs, serde_json::json!(9), SubscribeParams { run_id }, &out_tx).await;

        let resp: serde_json::Value =
            serde_json::from_str(&out_rx.recv().await.expect("subscribe response")).unwrap();
        assert_eq!(resp["result"]["status"].as_str(), Some("errored"));
        let snapshot: serde_json::Value =
            serde_json::from_str(&out_rx.recv().await.expect("snapshot")).unwrap();
        assert_eq!(snapshot["params"]["event"]["kind"].as_str(), Some("snapshot"));
        let terminal: serde_json::Value =
            serde_json::from_str(&out_rx.recv().await.expect("terminal")).unwrap();
        assert_eq!(
            terminal["params"]["event"]["kind"].as_str(),
            Some("error"),
            "an errored Run re-attaches as error, never a synthesized done"
        );
        assert_eq!(
            terminal["params"]["event"]["message"].as_str(),
            Some("provider auth failed"),
            "the persisted error_message rides the re-attach"
        );

        drop(out_tx);
        assert!(out_rx.recv().await.is_none(), "exactly three frames, then close");
    }

    /// Barrier (review P1 #2): the live-hub subscribe snapshot is ONE ordered
    /// `snapshot` event — the full `run_steps` timeline (text / reasoning /
    /// tool_call in order), INCLUDING a call that settled after the client's
    /// `thread/get` (excluded there as pending). The Client atomically replaces
    /// its segments, so the settled call is delivered in true order, never lost.
    #[tokio::test]
    async fn live_subscribe_snapshot_carries_the_ordered_settled_call() {
        let pool = memory_pool().await;
        let run_id = seed_running_run(&pool).await;
        // The window: the call was pending at the client's thread/get (excluded
        // there), then settled before this subscribe reads its snapshot.
        assert!(
            db::begin_external_tool_call(
                &pool,
                run_id,
                "tc-win",
                "ticktick_filter_tasks",
                r#"{"filter":{"status":[0]}}"#,
                db::now_ms(),
            )
            .await
            .expect("begin")
            .won()
        );
        assert!(matches!(
            db::finish_external_tool_call(
                &pool,
                run_id,
                "tc-win",
                "completed",
                r#"{"content":[{"type":"text","text":"3 tasks"}],"is_error":false}"#,
                db::now_ms(),
            )
            .await
            .expect("finish"),
            db::ExternalToolFinish::Resolved(_)
        ));

        // A live hub (the run is still streaming) → the snapshot-then-attach path.
        let hubs = hub::new_hubs();
        let _run_hub = hub::register(&hubs, run_id).expect("fresh run registers");
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
        handle(
            &pool,
            &hubs,
            serde_json::json!(3),
            SubscribeParams { run_id },
            &out_tx,
        )
        .await;

        // Collect the snapshot frames (the forwarder then blocks on an empty tail).
        let mut frames = Vec::new();
        while let Ok(Some(body)) =
            tokio::time::timeout(std::time::Duration::from_millis(250), out_rx.recv()).await
        {
            frames.push(serde_json::from_str::<serde_json::Value>(&body).expect("json frame"));
        }

        let snapshot = frames
            .iter()
            .find(|f| f["params"]["event"]["kind"].as_str() == Some("snapshot"))
            .expect("a single ordered snapshot event is emitted");
        let segments = snapshot["params"]["event"]["segments"]
            .as_array()
            .expect("the snapshot carries an ordered segments array");
        let tool_call = segments
            .iter()
            .find(|s| s["kind"].as_str() == Some("tool_call"))
            .expect("the settled tool call is in the ordered snapshot, not lost");
        assert_eq!(tool_call["tool_call_id"].as_str(), Some("tc-win"));
        assert_eq!(tool_call["status"].as_str(), Some("completed"));
        assert_eq!(
            tool_call["result"]["content"][0]["text"].as_str(),
            Some("3 tasks"),
            "the settled call carries the model-received result (A4)"
        );
    }

    /// No-duplication on lag recovery (review F2): after the re-snapshot the
    /// forwarder `resubscribe()`s, so the stale retained buffer is DISCARDED —
    /// the resumed tail carries only events published strictly AFTER recovery,
    /// never a replay of buffered deltas the snapshot already covered. Forces
    /// Lagged with `BUFFERED` deltas, then proves the FIRST post-snapshot tail
    /// frame is a later `SENTINEL`, not a re-delivered `BUFFERED`.
    #[tokio::test]
    async fn forwarder_lag_resubscribes_without_replaying_the_buffer() {
        let pool = memory_pool().await;
        let run_id = seed_cancelled_run(&pool).await;

        // Overflow a cap-8 channel BEFORE the forwarder drains, so its first
        // `recv()` yields `Lagged` and it takes the re-snapshot + resubscribe arm.
        let (event_tx, event_rx) = broadcast::channel::<RunEvent>(8);
        for _ in 0..9 {
            event_tx
                .send(RunEvent::TextDelta {
                    delta: "BUFFERED".to_string(),
                })
                .expect("buffer a tail event");
        }

        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
        spawn_tail_forwarder(
            run_id,
            hub::new_hubs(),
            RunTail::from_parts(event_rx, Arc::new(tokio::sync::Mutex::new(()))),
            out_tx,
            pool.clone(),
        );

        // Frame 1 is the re-snapshot (recovery). Draining it proves the Lagged
        // arm ran AND the forwarder resubscribed (send happens after resubscribe).
        let snapshot = tokio::time::timeout(std::time::Duration::from_secs(5), out_rx.recv())
            .await
            .expect("re-snapshot frame within timeout")
            .expect("re-snapshot frame present");
        assert!(
            !snapshot.contains("BUFFERED"),
            "the re-snapshot is the persisted timeline, never the broadcast buffer — frame: {snapshot}"
        );

        // A NEW event after recovery: the fresh receiver (at the tail) delivers
        // THIS, never one of the 9 discarded `BUFFERED` deltas.
        event_tx
            .send(RunEvent::TextDelta {
                delta: "SENTINEL".to_string(),
            })
            .expect("publish a post-recovery event");
        let next = tokio::time::timeout(std::time::Duration::from_secs(5), out_rx.recv())
            .await
            .expect("post-recovery tail frame within timeout")
            .expect("post-recovery tail frame present");
        assert!(
            next.contains("SENTINEL") && !next.contains("BUFFERED"),
            "the resumed tail delivers only post-recovery events, never a replayed buffer — frame: {next}"
        );
    }

    /// Cross-generation re-attach (review R10 #2): an old tail whose channel
    /// closes NON-terminally (park→resume / errored→retry drained the old
    /// generation) while the run is RUNNING under a NEW generation must re-attach
    /// to it — fresh ordered snapshot, then the new tail — never misreport the
    /// live resumed run as worker-disconnected.
    #[tokio::test]
    async fn forwarder_reattaches_to_a_new_generation_on_nonterminal_close() {
        let pool = memory_pool().await;
        let run_id = seed_running_run(&pool).await;

        // The OLD generation's channel, with the forwarder tailing it.
        let (old_tx, old_rx) = broadcast::channel::<RunEvent>(8);
        let hubs = hub::new_hubs();
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
        spawn_tail_forwarder(
            run_id,
            hubs.clone(),
            RunTail::from_parts(old_rx, Arc::new(tokio::sync::Mutex::new(()))),
            out_tx,
            pool.clone(),
        );

        // A NEW generation activates (registered hub), then the old generation's
        // channel closes without a terminal event — the park/retry drain shape.
        let next = hub::register(&hubs, run_id).expect("new generation registers");
        drop(old_tx);

        // Frame 1: the re-attach snapshot (proves the forwarder attached to the
        // new generation instead of synthesizing worker-disconnected).
        let snapshot = tokio::time::timeout(std::time::Duration::from_secs(5), out_rx.recv())
            .await
            .expect("re-attach snapshot within timeout")
            .expect("frame present");
        assert!(
            snapshot.contains("\"snapshot\""),
            "the old tail re-attached with an ordered snapshot — frame: {snapshot}"
        );

        // The new generation's events now flow through the SAME subscriber.
        next.send(RunEvent::TextDelta {
            delta: "resumed".to_string(),
        });
        let tail_frame = tokio::time::timeout(std::time::Duration::from_secs(5), out_rx.recv())
            .await
            .expect("new-generation tail frame within timeout")
            .expect("frame present");
        assert!(
            tail_frame.contains("resumed"),
            "the new generation's tail reaches the old subscriber — frame: {tail_frame}"
        );
    }

    /// The boot-recovery zombie stays bounded (review R11 #2): `running` with NO
    /// live generation — confirmed by the one re-read the new close-loop takes —
    /// still closes with worker-disconnected (never hangs, never loops).
    #[tokio::test]
    async fn forwarder_close_on_running_zombie_reports_disconnect_bounded() {
        let pool = memory_pool().await;
        let run_id = seed_running_run(&pool).await;

        let (old_tx, old_rx) = broadcast::channel::<RunEvent>(8);
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
        spawn_tail_forwarder(
            run_id,
            hub::new_hubs(),
            RunTail::from_parts(old_rx, Arc::new(tokio::sync::Mutex::new(()))),
            out_tx,
            pool.clone(),
        );
        drop(old_tx);

        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), out_rx.recv())
            .await
            .expect("the zombie close settles within the bound")
            .expect("frame present");
        let v: serde_json::Value = serde_json::from_str(&frame).expect("json");
        assert_eq!(v["params"]["event"]["kind"].as_str(), Some("error"));
        assert_eq!(
            v["params"]["event"]["message"].as_str(),
            Some(crate::worker::WORKER_DISCONNECTED_MESSAGE),
            "a genuine no-generation running run is a lost Worker"
        );
    }

    /// The no-hub subscribe branch re-checks a RUNNING status (review R11 #2):
    /// with no generation appearing across the confirming re-read, the boot
    /// zombie closes with Error — the pre-existing contract, now via the
    /// bounded recheck path.
    #[tokio::test]
    async fn no_hub_running_zombie_subscribe_closes_with_error() {
        let pool = memory_pool().await;
        let run_id = seed_running_run(&pool).await;
        let hubs = hub::new_hubs();

        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
        handle(&pool, &hubs, serde_json::json!(11), SubscribeParams { run_id }, &out_tx).await;

        let resp: serde_json::Value =
            serde_json::from_str(&out_rx.recv().await.expect("subscribe response")).unwrap();
        assert_eq!(resp["result"]["status"].as_str(), Some("running"));
        let snapshot: serde_json::Value =
            serde_json::from_str(&out_rx.recv().await.expect("snapshot")).unwrap();
        assert_eq!(snapshot["params"]["event"]["kind"].as_str(), Some("snapshot"));
        let terminal: serde_json::Value =
            serde_json::from_str(&out_rx.recv().await.expect("terminal")).unwrap();
        assert_eq!(terminal["params"]["event"]["kind"].as_str(), Some("error"));
        assert_eq!(
            terminal["params"]["event"]["message"].as_str(),
            Some(crate::worker::WORKER_DISCONNECTED_MESSAGE),
        );
    }
}