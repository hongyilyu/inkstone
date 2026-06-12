//! Per-run event hub (ADR-0022). A Run's live event stream is owned by Core and
//! observable by any connection via `run/subscribe(run_id)`, not bound to the
//! WebSocket that started it. Core holds a map `run_id → RunHub`; the Worker
//! publishes each Run Event into the hub.
//!
//! The hub holds no durable state — tier 2 is the source of truth. A hub entry
//! is the live tail of a streaming Run: created when the Worker spawns, removed
//! at a terminal state. A subscribe to an already-removed Run reads the
//! persisted snapshot and emits the terminal outcome without attaching.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::{broadcast, watch};
use uuid::Uuid;

use crate::protocol::RunEvent;

/// Buffer depth of the per-run broadcast channel. A subscriber that overflows
/// this sees `RecvError::Lagged`.
const HUB_BUFFER: usize = 256;

/// One Run's live-event channel plus its exactly-once gate.
///
/// `tx` is the broadcast sender the Worker publishes into and subscribers attach
/// to. `gate` makes the Worker's `persist → publish` critical section mutually
/// exclusive with the subscribe handler's `snapshot → attach`, so every delta
/// falls wholly before or after a subscribe instant (ADR-0022 exactly-once).
/// `cancel_tx` is the in-memory signal Core flips after durably winning a
/// cancellation; the Worker loop observes it and stops.
#[derive(Clone)]
pub struct RunHub {
    pub tx: broadcast::Sender<RunEvent>,
    pub gate: Arc<tokio::sync::Mutex<()>>,
    cancel_tx: watch::Sender<bool>,
}

impl RunHub {
    fn new() -> Self {
        let (tx, _rx) = broadcast::channel(HUB_BUFFER);
        let (cancel_tx, _cancel_rx) = watch::channel(false);
        Self {
            tx,
            gate: Arc::new(tokio::sync::Mutex::new(())),
            cancel_tx,
        }
    }

    pub fn cancel_rx(&self) -> watch::Receiver<bool> {
        self.cancel_tx.subscribe()
    }

    pub fn cancel(&self) {
        self.cancel_tx.send_replace(true);
    }

    pub fn is_cancelled(&self) -> bool {
        *self.cancel_tx.borrow()
    }
}

/// Shared map of in-flight Runs. `std::sync::Mutex` is fine: touched only at
/// spawn / subscribe / terminal (never per-delta), so the critical section never
/// spans an `.await`. `Arc` keeps `AppState` `Clone`.
pub type Hubs = Arc<Mutex<HashMap<Uuid, RunHub>>>;

/// A fresh, empty hub map.
pub fn new_hubs() -> Hubs {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Create and register a hub for `run_id`. Called before the Worker spawns so a
/// fast `run/subscribe` can never miss a hub for a Run about to stream.
pub fn create(hubs: &Hubs, run_id: Uuid) -> RunHub {
    let hub = RunHub::new();
    hubs.lock()
        .expect("hubs mutex not poisoned")
        .insert(run_id, hub.clone());
    hub
}

/// Look up the hub for `run_id`, cloning the handle if present. `None` means the
/// Run is terminal/removed (or never existed), so the subscribe handler serves a
/// tier-2 snapshot and the persisted terminal outcome.
pub fn get(hubs: &Hubs, run_id: Uuid) -> Option<RunHub> {
    hubs.lock()
        .expect("hubs mutex not poisoned")
        .get(&run_id)
        .cloned()
}

/// Remove the hub for `run_id`. Called after the Worker's terminal tx so
/// dropping the sender lets drained subscribers observe `RecvError::Closed`.
pub fn remove(hubs: &Hubs, run_id: Uuid) {
    hubs.lock()
        .expect("hubs mutex not poisoned")
        .remove(&run_id);
}
