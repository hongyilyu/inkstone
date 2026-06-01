//! Per-run event hub (ADR-0022). A Run's live event stream is owned by
//! Core and observable by any connection, not bound to the WebSocket that
//! started it. Core holds a map `run_id → RunHub`; the Worker publishes
//! each Run Event into the hub, and any connection receives them by
//! calling `run/subscribe(run_id)`.
//!
//! The hub holds no durable state — tier 2 is the source of truth for
//! text. A hub entry's whole job is the live tail of a currently-streaming
//! Run: it is created when the Worker is spawned and removed when the Run
//! reaches a terminal state. A subscribe to an already-removed Run reads
//! the persisted snapshot and emits `done` without attaching.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::broadcast;
use uuid::Uuid;

use crate::protocol::RunEvent;

/// Buffer depth of the per-run broadcast channel. A slow subscriber that
/// overflows this sees `RecvError::Lagged`; slice 1 tolerates it (the
/// rigorous re-snapshot lands in slice 2). 256 deltas is generous for the
/// echo Worker's handful of events.
const HUB_BUFFER: usize = 256;

/// One Run's live-event channel plus its exactly-once gate.
///
/// `tx` is the broadcast sender the Worker publishes into and subscribers
/// attach to. `gate` is the per-run async mutex that makes the Worker's
/// `persist → publish` critical section mutually exclusive with the
/// subscribe handler's `snapshot → attach`, so every delta falls wholly
/// before or wholly after a subscribe instant (ADR-0022 exactly-once).
#[derive(Clone)]
pub struct RunHub {
    pub tx: broadcast::Sender<RunEvent>,
    pub gate: Arc<tokio::sync::Mutex<()>>,
}

impl RunHub {
    fn new() -> Self {
        let (tx, _rx) = broadcast::channel(HUB_BUFFER);
        Self {
            tx,
            gate: Arc::new(tokio::sync::Mutex::new(())),
        }
    }
}

/// Shared map of in-flight Runs. `std::sync::Mutex` because it is only
/// touched at spawn / subscribe / terminal — never per-delta — so the
/// short critical section never spans an `.await`. `Arc` lets `AppState`
/// stay `Clone` (one map shared across all connections).
pub type Hubs = Arc<Mutex<HashMap<Uuid, RunHub>>>;

/// A fresh, empty hub map.
pub fn new_hubs() -> Hubs {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Create and register a hub for `run_id`, returning it. Called before the
/// Worker is spawned so a fast `run/subscribe` can never find a missing
/// hub for a Run that is about to stream.
pub fn create(hubs: &Hubs, run_id: Uuid) -> RunHub {
    let hub = RunHub::new();
    hubs.lock()
        .expect("hubs mutex not poisoned")
        .insert(run_id, hub.clone());
    hub
}

/// Look up the hub for `run_id`, cloning the handle if present. A `None`
/// means the Run is terminal/removed (or never existed); the subscribe
/// handler then serves a snapshot from tier 2 and emits `done`.
pub fn get(hubs: &Hubs, run_id: Uuid) -> Option<RunHub> {
    hubs.lock()
        .expect("hubs mutex not poisoned")
        .get(&run_id)
        .cloned()
}

/// Remove the hub for `run_id`. Called after the Worker's terminal tx so
/// dropping the broadcast sender lets attached subscribers observe the
/// channel close (`RecvError::Closed`) once they have drained the tail.
pub fn remove(hubs: &Hubs, run_id: Uuid) {
    hubs.lock()
        .expect("hubs mutex not poisoned")
        .remove(&run_id);
}
