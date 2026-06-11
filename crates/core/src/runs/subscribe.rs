//! `run/subscribe` handler: snapshot-then-tail (ADR-0022).
//!
//! If the Run is still streaming (a hub exists), take the per-run gate, read
//! the cumulative assistant text snapshot from tier 2, attach a broadcast
//! receiver WHILE holding the gate, then release it. This
//! `lock → snapshot → attach → unlock` is the exactly-once boundary: it is
//! mutually exclusive with the Worker's `lock → persist → publish → unlock`,
//! so every delta is delivered exactly once (via snapshot or via tail).
//!
//! The handler sends the JSON-RPC RESPONSE for the subscribe id first (so the
//! Client's request resolves), then the snapshot as a `run/event`
//! `text_delta` notification, then SPAWNS a forwarder task that owns the
//! broadcast `Receiver` + `out_tx.clone()` and forwards the live tail until
//! the channel closes or the connection drops. Spawning keeps
//! `handle_socket`'s select loop free to keep draining `out_rx`.
//!
//! If the Run is already terminal/removed (no hub), read the snapshot from
//! the DB, emit it as a `text_delta`, then the persisted terminal outcome, and
//! close without attaching. An unknown run id is handled defensibly: respond,
//! emit a `done`, do not panic.

use sqlx::SqlitePool;
use tokio::sync::broadcast;
use tokio::sync::mpsc::UnboundedSender;
use uuid::Uuid;

use super::reply::{send_proposal_pending, send_response, send_run_event, send_text_delta};
use crate::db;
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
    // invalid_params by the dispatch arm before this runs.
    let run_id = params.run_id;

    match hub::get(hubs, run_id) {
        // ---- Run still streaming: snapshot under the gate, then attach. ----
        Some(run_hub) => {
            let guard = run_hub.gate.lock().await;
            let snapshot = db::select_run_snapshot(pool, run_id).await;
            let receiver = run_hub.tx.subscribe();
            drop(guard);

            let (snapshot_text, status) = match snapshot {
                Ok(Some(snap)) => (snap.text, snap.status),
                Ok(None) => (String::new(), "running".to_string()),
                Err(e) => {
                    eprintln!("snapshot read failed for run {run_id}: {e}");
                    (String::new(), "running".to_string())
                }
            };

            // Usually a live hub means `running`, but cancellation can commit
            // before the Worker loop drops its hub clone. Report the persisted
            // status observed under the gate.
            send_subscribe_response(out_tx, id, run_id, &status);
            send_text_delta(out_tx, run_id, &snapshot_text);
            spawn_tail_forwarder(run_id, receiver, out_tx.clone(), pool.clone());
        }
        // ---- No hub: terminal, parked, or unknown. Read the persisted
        // status to tell parked (ADR-0025) from terminal. ----
        None => {
            let status = match db::run_status(pool, run_id).await {
                Ok(Some(s)) => s,
                Ok(None) => String::new(), // unknown run id — stay defensible
                Err(e) => {
                    eprintln!("run_status read failed for run {run_id}: {e}");
                    String::new()
                }
            };
            let snapshot = db::select_run_snapshot(pool, run_id).await;
            send_subscribe_response(out_tx, id, run_id, &status);
            match snapshot {
                Ok(Some(snap)) => {
                    send_text_delta(out_tx, run_id, &snap.text);
                }
                Ok(None) => {
                    // Unknown run id — no snapshot.
                }
                Err(e) => {
                    eprintln!("snapshot read failed for run {run_id}: {e}");
                }
            }
            // No-false-done (ADR-0025): a parked Run's Run Event stream stopped
            // without a terminal event. Emit the snapshot, but NOT a terminal
            // Run Event — the Client distinguishes `parked` via the response
            // status. Cancelled Runs get their own terminal event; completed
            // and the legacy unknown/errored fallback synthesize `done`.
            if status == "parked" {
                // Push `proposal/pending` (ADR-0025) so a fresh subscriber to an
                // already-parked Run learns to show the review card without a
                // separate `proposal/get` poll. Look up the Run's pending
                // Proposal id; if none is found (race / read error), the Client
                // still has the `parked` response status to fall back on.
                emit_pending(out_tx, pool, run_id).await;
            } else if status == "cancelled" {
                send_run_event(out_tx, run_id, &RunEvent::Cancelled);
            } else {
                send_run_event(out_tx, run_id, &RunEvent::Done);
            }
        }
    }
}

/// Look up the Run's pending Proposal and, if present, push a
/// `proposal/pending {run_id, proposal_id}` Notification on the connection.
/// A missing Proposal or a read error is logged and tolerated: the Client
/// still learns the park via the `parked` response status (ADR-0025).
async fn emit_pending(out_tx: &UnboundedSender<String>, pool: &SqlitePool, run_id: Uuid) {
    match db::get_pending_proposal_for_run(pool, run_id).await {
        Ok(Some(p)) => send_proposal_pending(out_tx, run_id, &p.proposal_id),
        Ok(None) => {}
        Err(e) => {
            eprintln!("pending proposal lookup failed for run {run_id}: {e}");
        }
    }
}

/// Frame the subscribe RESPONSE. Result shape is `{run_id, status}` (ADR-0022,
/// ADR-0025): `status` is `running` while a live hub exists, else the
/// persisted `runs.status` — so a refreshed Client can tell a `parked` Run
/// from a terminal one. Events arrive as separate `run/event` notifications.
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

/// Spawn a task that owns the broadcast `Receiver` + the connection's
/// `out_tx` and forwards the live tail as `run/event` notifications. Ends
/// on `RecvError::Closed` (terminal — sender dropped at the Worker's
/// removal) or when the connection drops (`out_tx.closed()` resolves once
/// the connection's `out_rx` is gone). Spawning keeps `handle_socket`'s
/// select loop free to drain `out_rx`.
///
/// Connection-drop detection (ADR-0022 connection decoupling): the forwarder
/// `tokio::select!`s between `receiver.recv()` and `out_tx.closed()` so a
/// dropped connection wakes it promptly — even while parked on `recv()` with
/// no events flowing — rather than leaking the task until the next event or
/// channel close. When the connection drops the forwarder just breaks: there
/// is no client left to receive a synthesized `done` (ADR-0012: the Run
/// itself keeps running, owned by the Worker, regardless of this connection).
///
/// `Lagged` → re-snapshot (ADR-0022 §28): if a slow subscriber overflows the
/// bounded broadcast buffer, the forwarder re-reads the persisted snapshot
/// from tier 2 (the durable text floor) and re-emits it as a cumulative
/// `text_delta`, then resumes the tail. Lag degrades to "re-read the truth,"
/// never to lost text. A re-snapshot read error is logged and tolerated.
///
/// Terminal-event guarantee: a subscribe can attach in the window between a
/// terminal event being published (under the gate, then releasing it) and
/// `hub::remove` (after the terminal SQLite tx). A `tokio::broadcast`
/// receiver created in that window is positioned AFTER the already-sent
/// terminal event and would never see it — the stream would hang. The gate
/// gives exactly-once for `text_delta`s but cannot protect a terminal message
/// a late receiver structurally cannot replay. So the forwarder tracks whether
/// it forwarded a terminal event from the tail and, on channel close (the
/// connection still up), synthesizes the persisted terminal outcome if it never
/// did. This is the single guarantee point: every connected subscriber path
/// ends with exactly one terminal event.
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
                // The connection dropped: its `out_rx` is gone, so further
                // forwarding is pointless. Break WITHOUT synthesizing a
                // `done` — there is no client to receive it. The Run keeps
                // running under the Worker (ADR-0012).
                () = out_tx.closed() => {
                    break;
                }
                recv = receiver.recv() => {
                    match recv {
                        Ok(event) => {
                            // `done`, `cancelled`, and `error` are terminal Run
                            // Events. Tracking them prevents a synthesized
                            // `done` after the real terminal event on channel
                            // close.
                            if matches!(
                                event,
                                RunEvent::Done | RunEvent::Cancelled | RunEvent::Error { .. }
                            ) {
                                saw_terminal = true;
                            }
                            send_run_event(&out_tx, run_id, &event);
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            // Sender dropped at the Worker's `hub::remove`. If
                            // we never forwarded a terminal event (attached
                            // after the Worker published it, or it fell in a
                            // lagged window), synthesize a `done` so the
                            // client's run-stream finalizes instead of hanging
                            // forever.
                            //
                            // No-false-done on park (ADR-0025): a Worker that
                            // parks removes the hub WITHOUT a terminal event,
                            // so `saw_terminal` is false here too — but the Run
                            // is not done. Check the persisted status and
                            // suppress the synthesized `done` when `parked`;
                            // instead PUSH a `proposal/pending` so the attached
                            // chat surface shows the review card without polling.
                            if !saw_terminal {
                                match db::run_status(&pool, run_id).await {
                                    Ok(Some(ref s)) if s == "parked" => {
                                        emit_pending(&out_tx, &pool, run_id).await;
                                    }
                                    Ok(Some(ref s)) if s == "cancelled" => {
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
                            eprintln!(
                                "subscribe forwarder lagged {n} events for run {run_id}; \
                                 re-snapshotting from tier 2"
                            );
                            // Re-read the persisted text (the durable floor)
                            // and re-emit it as a cumulative `text_delta` so
                            // the overflow degrades to "re-read the truth,"
                            // not lost text. A read error is logged and
                            // tolerated; the tail resumes either way.
                            match db::select_run_snapshot(&pool, run_id).await {
                                Ok(Some(snap)) => {
                                    send_text_delta(&out_tx, run_id, &snap.text);
                                }
                                Ok(None) => {}
                                Err(e) => {
                                    eprintln!(
                                        "re-snapshot read failed for run {run_id}: {e}"
                                    );
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
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use tokio::sync::mpsc;
    use uuid::Uuid;

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

    /// The terminal-event guarantee (ADR-0022): a subscriber that attaches AFTER
    /// `run/cancel` already published `Cancelled` — its broadcast receiver is
    /// positioned past the sent event — must still terminate with exactly one
    /// `cancelled` when the channel closes, NOT a synthesized `done`. Models the
    /// close-fallback arm by handing the forwarder a receiver that sees only the
    /// channel close, with the persisted status already `cancelled`.
    #[tokio::test]
    async fn tail_forwarder_synthesizes_cancelled_on_close_for_a_late_subscriber() {
        let pool = memory_pool().await;
        let run_id = seed_cancelled_run(&pool).await;

        // A receiver created after the terminal event: the sender is dropped
        // with nothing buffered, so `recv()` yields `Closed` straight away.
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
}
