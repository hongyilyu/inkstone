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
            spawn_tail_forwarder(run_id, receiver, out_tx.clone());
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
/// `out_tx` and forwards the live tail as `run/event` notifications. Ends on
/// `RecvError::Closed` (terminal — sender dropped at the Worker's removal) or
/// when `out_tx.send` fails (connection dropped). On `RecvError::Lagged(n)`
/// it continues (slice 1 tolerance; the rigorous re-snapshot is slice 2).
/// Spawning keeps `handle_socket`'s select loop free to drain `out_rx`.
///
/// Terminal-`done` guarantee: a subscribe can attach in the window between
/// the Worker publishing `Done` (under the gate, then releasing it) and
/// `hub::remove` (after the terminal SQLite tx). A `tokio::broadcast`
/// receiver created in that window is positioned AFTER the already-sent
/// `Done` and would never see it — the stream would hang. The gate gives
/// exactly-once for `text_delta`s but cannot protect a terminal message a
/// late receiver structurally cannot replay. So the forwarder tracks whether
/// it forwarded a `Done` from the tail and, on channel close, synthesizes one
/// if it never did. This is the single guarantee point: every subscriber path
/// ends with exactly one `done`.
fn spawn_tail_forwarder(
    run_id: Uuid,
    mut receiver: broadcast::Receiver<RunEvent>,
    out_tx: UnboundedSender<String>,
) {
    tokio::spawn(async move {
        let mut saw_done = false;
        loop {
            match receiver.recv().await {
                Ok(event) => {
                    if matches!(event, RunEvent::Done) {
                        saw_done = true;
                    }
                    send_run_event(&out_tx, run_id, &event);
                    if out_tx.is_closed() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Closed) => {
                    // Sender dropped at the Worker's `hub::remove`. If we
                    // never forwarded a `Done` (attached after the Worker
                    // published it, or it fell in a lagged window),
                    // synthesize one so the client's run-stream finalizes
                    // instead of hanging forever.
                    if !saw_done {
                        send_run_event(&out_tx, run_id, &RunEvent::Done);
                    }
                    break;
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    eprintln!("subscribe forwarder lagged {n} events for run {run_id}");
                    // Slice 1: tolerate lag and keep forwarding the tail. A
                    // `Done` dropped in the lagged window is recovered by the
                    // synthesize-on-close path above.
                    continue;
                }
            }
        }
    });
}
