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
//! the DB, emit it as a `text_delta`, then a `done`, and close without
//! attaching. An unknown run id is handled defensibly: respond, emit a
//! `done`, do not panic.

use sqlx::SqlitePool;
use tokio::sync::broadcast;
use tokio::sync::mpsc::UnboundedSender;
use uuid::Uuid;

use super::reply::{send_error, send_response, send_run_event, send_text_delta};
use crate::db;
use crate::hub::{self, Hubs};
use crate::protocol::{RunEvent, SubscribeParams};

pub(super) async fn handle(
    pool: &SqlitePool,
    hubs: &Hubs,
    id: serde_json::Value,
    params: SubscribeParams,
    out_tx: &UnboundedSender<String>,
) {
    let Ok(run_id) = Uuid::parse_str(&params.run_id) else {
        send_error(out_tx, id, format!("invalid run_id {:?}", params.run_id));
        return;
    };

    match hub::get(hubs, run_id) {
        // ---- Run still streaming: snapshot under the gate, then attach. ----
        Some(run_hub) => {
            let guard = run_hub.gate.lock().await;
            let snapshot = db::select_run_snapshot(pool, run_id).await;
            let receiver = run_hub.tx.subscribe();
            drop(guard);

            let snapshot_text = match snapshot {
                Ok(Some(snap)) => snap.text,
                Ok(None) => String::new(),
                Err(e) => {
                    eprintln!("snapshot read failed for run {run_id}: {e}");
                    String::new()
                }
            };

            send_subscribe_response(out_tx, id, run_id);
            send_text_delta(out_tx, run_id, &snapshot_text);
            spawn_tail_forwarder(run_id, receiver, out_tx.clone(), pool.clone());
        }
        // ---- Run terminal/unknown: snapshot from the DB, emit done. ----
        None => {
            let snapshot = db::select_run_snapshot(pool, run_id).await;
            send_subscribe_response(out_tx, id, run_id);
            match snapshot {
                Ok(Some(snap)) => {
                    send_text_delta(out_tx, run_id, &snap.text);
                }
                Ok(None) => {
                    // Unknown run id — stay defensible: no snapshot, just done.
                }
                Err(e) => {
                    eprintln!("snapshot read failed for run {run_id}: {e}");
                }
            }
            send_run_event(out_tx, run_id, &RunEvent::Done);
        }
    }
}

/// Frame the subscribe RESPONSE. Result shape is `{run_id}` (symmetry with
/// `post_message`); events arrive as separate `run/event` notifications.
fn send_subscribe_response(out_tx: &UnboundedSender<String>, id: serde_json::Value, run_id: Uuid) {
    send_response(
        out_tx,
        id,
        serde_json::json!({ "run_id": run_id.to_string() }),
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
/// Terminal-`done` guarantee: a subscribe can attach in the window between
/// the Worker publishing `Done` (under the gate, then releasing it) and
/// `hub::remove` (after the terminal SQLite tx). A `tokio::broadcast`
/// receiver created in that window is positioned AFTER the already-sent
/// `Done` and would never see it — the stream would hang. The gate gives
/// exactly-once for `text_delta`s but cannot protect a terminal message a
/// late receiver structurally cannot replay. So the forwarder tracks
/// whether it forwarded a `Done` from the tail and, on channel close (the
/// connection still up), synthesizes one if it never did. This is the single
/// guarantee point: every connected subscriber path ends with exactly one
/// `done`.
fn spawn_tail_forwarder(
    run_id: Uuid,
    mut receiver: broadcast::Receiver<RunEvent>,
    out_tx: UnboundedSender<String>,
    pool: SqlitePool,
) {
    tokio::spawn(async move {
        let mut saw_done = false;
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
                            if matches!(event, RunEvent::Done) {
                                saw_done = true;
                            }
                            send_run_event(&out_tx, run_id, &event);
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            // Sender dropped at the Worker's `hub::remove`. If
                            // we never forwarded a `Done` (attached after the
                            // Worker published it, or it fell in a lagged
                            // window), synthesize one so the client's
                            // run-stream finalizes instead of hanging forever.
                            if !saw_done {
                                send_run_event(&out_tx, run_id, &RunEvent::Done);
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