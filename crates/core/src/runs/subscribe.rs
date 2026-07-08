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

use super::reply::{send_proposal_pending, send_response, send_run_event, send_text_delta};
use crate::db::{self, RunStatus};
use crate::hub::{self, Hubs};
use crate::protocol::{RunEvent, SubscribeParams, SubscribeResult};

pub(super) async fn handle(
    pool: &SqlitePool,
    hubs: &Hubs,
    id: serde_json::Value,
    params: SubscribeParams,
    out_tx: &UnboundedSender<String>,
) {
    // run_id is typed at decode (ADR-0029 C2): a malformed id is framed as
    // invalid_params before this runs.
    let run_id = params.run_id;

    match hub::get(hubs, run_id) {
        // Run still streaming: snapshot under the gate, then attach
        // (RunHub::snapshot_then_attach owns the ADR-0022 lock ritual).
        Some(run_hub) => {
            let (snapshot, receiver) = run_hub
                .snapshot_then_attach(|| db::select_run_snapshot(pool, run_id))
                .await;

            let (snapshot_text, status) = match snapshot {
                Ok(Some(snap)) => (snap.text, snap.status),
                Ok(None) => (String::new(), RunStatus::Running),
                Err(e) => {
                    tracing::error!(event = "subscribe.snapshot_read_failed", %run_id, error = ?e);
                    (String::new(), RunStatus::Running)
                }
            };

            // A terminal transition can commit before the Worker drops its hub
            // clone (e.g. a `run/cancel` win while it's parked in a long tool
            // dispatch). A receiver attached now sits AFTER the published
            // terminal event while the Worker's sender keeps the channel open,
            // so the tail would block on `recv()` forever. When the status under
            // the gate is already terminal, emit it and close WITHOUT attaching.
            send_subscribe_response(out_tx, id, run_id, status.as_str());
            send_text_delta(out_tx, run_id, &snapshot_text);
            match status {
                RunStatus::Cancelled => send_run_event(out_tx, run_id, &RunEvent::Cancelled),
                RunStatus::Completed | RunStatus::Errored => {
                    send_run_event(out_tx, run_id, &RunEvent::Done)
                }
                RunStatus::Running | RunStatus::Parked => {
                    spawn_tail_forwarder(run_id, receiver, out_tx.clone(), pool.clone())
                }
            }
        }
        // No hub: terminal, parked, or unknown. Read persisted status to tell
        // parked (ADR-0025) from terminal. `None` is the unknown-run id — modeled
        // as the absence of a status rather than an empty-string sentinel.
        None => {
            let status: Option<RunStatus> = match db::run_status(pool, run_id).await {
                Ok(status) => status,
                Err(e) => {
                    tracing::error!(event = "subscribe.run_status_read_failed", %run_id, error = ?e);
                    None
                }
            };
            let snapshot = db::select_run_snapshot(pool, run_id).await;
            // The wire status stays a string (ADR-0029): an unknown run reports
            // the empty status, exactly as before.
            send_subscribe_response(out_tx, id, run_id, status.map_or("", RunStatus::as_str));
            match snapshot {
                Ok(Some(snap)) => {
                    send_text_delta(out_tx, run_id, &snap.text);
                }
                Ok(None) => {
                    // Unknown run id — no snapshot.
                }
                Err(e) => {
                    tracing::error!(event = "subscribe.snapshot_read_failed", %run_id, error = ?e);
                }
            }
            // No-false-done (ADR-0025): a parked Run stopped without a terminal
            // event, so emit NO terminal Run Event — the Client reads `parked`
            // from the response status. Cancelled gets its terminal event;
            // completed, running, and the unknown/errored fallback synthesize
            // `done`.
            match status {
                // Push `proposal/pending` (ADR-0025) so a fresh subscriber shows
                // the review card without a separate `proposal/get` poll.
                Some(RunStatus::Parked) => emit_pending(out_tx, pool, run_id).await,
                Some(RunStatus::Cancelled) => {
                    send_run_event(out_tx, run_id, &RunEvent::Cancelled)
                }
                _ => send_run_event(out_tx, run_id, &RunEvent::Done),
            }
        }
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
/// `Lagged` → re-snapshot (ADR-0022 §28): on buffer overflow, re-read the
/// persisted snapshot and re-emit it as a cumulative `text_delta`, then resume.
/// Lag degrades to "re-read the truth," never lost text.
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
    mut receiver: broadcast::Receiver<RunEvent>,
    out_tx: UnboundedSender<String>,
    pool: SqlitePool,
) {
    tokio::spawn(async move {
        let mut saw_terminal = false;
        loop {
            tokio::select! {
                // Connection dropped: break WITHOUT synthesizing a `done` —
                // no client to receive it (the Run keeps running, ADR-0012).
                () = out_tx.closed() => {
                    break;
                }
                recv = receiver.recv() => {
                    match recv {
                        Ok(event) => {
                            // Track terminal events so we don't synthesize a
                            // `done` after a real one on channel close.
                            if matches!(
                                event,
                                RunEvent::Done | RunEvent::Cancelled | RunEvent::Error { .. }
                            ) {
                                saw_terminal = true;
                            }
                            send_run_event(&out_tx, run_id, &event);
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            // Sender dropped at the Worker's `hub::remove`. If we
                            // never forwarded a terminal event (attached late or
                            // it fell in a lagged window), synthesize a `done` so
                            // the stream finalizes instead of hanging.
                            //
                            // No-false-done on park (ADR-0025): a park removes
                            // the hub WITHOUT a terminal event, so `saw_terminal`
                            // is false but the Run isn't done — when persisted
                            // status is `parked`, push `proposal/pending` instead
                            // of a synthesized `done`.
                            if !saw_terminal {
                                match db::run_status(&pool, run_id).await {
                                    Ok(Some(RunStatus::Parked)) => {
                                        emit_pending(&out_tx, &pool, run_id).await;
                                    }
                                    Ok(Some(RunStatus::Cancelled)) => {
                                        send_run_event(&out_tx, run_id, &RunEvent::Cancelled);
                                    }
                                    _ => {
                                        send_run_event(&out_tx, run_id, &RunEvent::Done);
                                    }
                                }
                            }
                            break;
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            // Tolerated degradation (ADR-0038): buffer overflow
                            // recovers via re-snapshot, so WARN. Lagged count in
                            // a field, never interpolated into the message.
                            tracing::warn!(event = "subscribe.forwarder_lagged", %run_id, n);
                            // Re-emit the persisted text as a cumulative
                            // `text_delta`; a read error is tolerated and the
                            // tail resumes either way.
                            match db::select_run_snapshot(&pool, run_id).await {
                                Ok(Some(snap)) => {
                                    send_text_delta(&out_tx, run_id, &snap.text);
                                }
                                Ok(None) => {}
                                Err(e) => {
                                    tracing::error!(event = "subscribe.resnapshot_read_failed", %run_id, error = ?e);
                                }
                            }
                        }
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use tokio::sync::mpsc;
    use tracing::field::{Field, Visit};
    use tracing::Level;
    use tracing_subscriber::layer::{Context, SubscriberExt};
    use tracing_subscriber::Layer;
    use uuid::Uuid;

    use super::*;

    /// One captured diagnostic event: its stable `event` key, its level, and
    /// the top-level `run_id` field (ADR-0038's canonical correlation field).
    #[derive(Clone)]
    struct CapturedEvent {
        event: Option<String>,
        level: Level,
        run_id: Option<String>,
    }

    /// Pulls the `event` and `run_id` field values off a `tracing` event.
    /// `tracing` fields are not a map, so a `Visit` impl is the only way to read
    /// specific field values. `event = "..."` records as a str; `%run_id`
    /// records via its `Display` impl (debug form for everything else).
    #[derive(Default)]
    struct FieldGrab {
        event: Option<String>,
        run_id: Option<String>,
    }

    impl Visit for FieldGrab {
        fn record_str(&mut self, field: &Field, value: &str) {
            match field.name() {
                "event" => self.event = Some(value.to_string()),
                "run_id" => self.run_id = Some(value.to_string()),
                _ => {}
            }
        }

        fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
            // `%run_id` lands here as a `Display`-formatted value; capture it if
            // `record_str` did not (subscriber backends differ).
            if field.name() == "run_id" && self.run_id.is_none() {
                self.run_id = Some(format!("{value:?}").trim_matches('"').to_string());
            }
        }
    }

    /// A minimal in-memory `tracing` Layer that appends each event's
    /// `event`/level/`run_id` into a shared buffer for assertions. Hand-rolled
    /// to avoid a new dev-dependency (tracing-subscriber is already a dep).
    struct CaptureLayer {
        events: Arc<Mutex<Vec<CapturedEvent>>>,
    }

    impl<S: tracing::Subscriber> Layer<S> for CaptureLayer {
        fn on_event(&self, event: &tracing::Event<'_>, _ctx: Context<'_, S>) {
            let mut grab = FieldGrab::default();
            event.record(&mut grab);
            self.events.lock().unwrap().push(CapturedEvent {
                event: grab.event,
                level: *event.metadata().level(),
                run_id: grab.run_id,
            });
        }
    }

    /// A migrated in-memory tier-2 pool (so `runs` CHECK constraints are in
    /// force).
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
        spawn_tail_forwarder(run_id, event_rx, out_tx, pool.clone());

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
        let _run_hub = hub::create(&hubs, run_id);

        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
        handle(&pool, &hubs, serde_json::json!(7), SubscribeParams { run_id }, &out_tx).await;

        // Subscribe response, then the snapshot text_delta, then `cancelled`.
        let resp: serde_json::Value =
            serde_json::from_str(&out_rx.recv().await.expect("subscribe response")).unwrap();
        assert_eq!(resp["result"]["status"].as_str(), Some("cancelled"));
        let snapshot: serde_json::Value =
            serde_json::from_str(&out_rx.recv().await.expect("snapshot")).unwrap();
        assert_eq!(snapshot["params"]["event"]["kind"].as_str(), Some("text_delta"));
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

    /// Severity split (ADR-0038): a broadcast-overflow re-snapshot is a
    /// *tolerated* degradation, so the forwarder logs `subscribe.forwarder_lagged`
    /// at WARN (not ERROR) carrying the canonical top-level `run_id`. Overflow is
    /// forced deterministically: send > capacity events into a cap-8 channel
    /// BEFORE the forwarder polls, so its first `recv()` returns
    /// `RecvError::Lagged` and it takes the re-snapshot arm.
    #[tokio::test]
    async fn forwarder_lagged_logs_warn_with_top_level_run_id() {
        let captured = Arc::new(Mutex::new(Vec::<CapturedEvent>::new()));
        let layer = CaptureLayer {
            events: captured.clone(),
        };
        // Scoped to this test via a DefaultGuard — unit tests have no global
        // subscriber, and the guard drops at test end so nothing leaks.
        let _guard = tracing::subscriber::set_default(
            tracing_subscriber::registry().with(layer),
        );

        let pool = memory_pool().await;
        // Seed a run so the Lagged arm's re-snapshot read has a valid run_id.
        let run_id = seed_cancelled_run(&pool).await;

        // Overflow a cap-8 channel before the forwarder drains: 9 buffered
        // events on a capacity-8 broadcast guarantees the receiver is past
        // capacity, so its next `recv()` yields `Lagged`.
        let (event_tx, event_rx) = broadcast::channel::<RunEvent>(8);
        for _ in 0..9 {
            event_tx
                .send(RunEvent::TextDelta { delta: "x".to_string() })
                .expect("buffer a tail event");
        }

        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
        spawn_tail_forwarder(run_id, event_rx, out_tx, pool.clone());

        // Pump the forwarder: the Lagged arm re-emits the persisted snapshot as
        // a `text_delta`, so awaiting one out frame proves it processed Lagged.
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), out_rx.recv())
            .await
            .expect("forwarder emits a re-snapshot frame within timeout");

        let events = captured.lock().unwrap();
        let lagged = events
            .iter()
            .find(|e| e.event.as_deref() == Some("subscribe.forwarder_lagged"))
            .expect("subscribe.forwarder_lagged was emitted on broadcast overflow");
        assert_eq!(
            lagged.level,
            Level::WARN,
            "forwarder lag is a tolerated degradation — WARN, not ERROR"
        );
        assert_eq!(
            lagged.run_id.as_deref(),
            Some(run_id.to_string().as_str()),
            "the lag event carries the canonical top-level run_id"
        );
    }
}
