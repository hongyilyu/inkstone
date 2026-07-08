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
use std::future::Future;
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
/// Both are private: the gate ritual lives behind this type's methods
/// ([`Self::gate`], [`Self::publish_gated`], [`Self::snapshot_then_attach`],
/// [`Self::send`]) so no call site re-spells the lock ordering. `cancel_tx` is
/// the in-memory signal Core flips after durably winning a cancellation; the
/// Worker loop observes it and stops.
#[derive(Clone)]
pub struct RunHub {
    tx: broadcast::Sender<RunEvent>,
    gate: Arc<tokio::sync::Mutex<()>>,
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

    /// Acquire the ADR-0022 per-run gate. The returned guard makes the caller's
    /// `persist → publish` (or `snapshot → attach`) critical section mutually
    /// exclusive with the other side's. Prefer the shaped helpers
    /// ([`Self::publish_gated`], [`Self::snapshot_then_attach`]); this exists
    /// for multi-step brackets the closures can't express (e.g. the Worker's
    /// cancel-check-then-send tool-call brackets).
    pub async fn gate(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.gate.lock().await
    }

    /// `lock → send → unlock`: the terminal/ephemeral publish ritual (ADR-0022).
    pub async fn publish_gated(&self, event: RunEvent) {
        let guard = self.gate.lock().await;
        let _ = self.tx.send(event);
        drop(guard);
    }

    /// `lock → snapshot (caller's async read) → attach receiver → unlock` —
    /// ADR-0022 snapshot-then-tail. The read runs under the gate, so every
    /// delta falls wholly before or after the subscribe instant (in the
    /// snapshot or on the tail, never both, never neither).
    pub async fn snapshot_then_attach<T, F, Fut>(
        &self,
        read: F,
    ) -> (T, broadcast::Receiver<RunEvent>)
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        let guard = self.gate.lock().await;
        let snapshot = read().await;
        let receiver = self.tx.subscribe();
        drop(guard);
        (snapshot, receiver)
    }

    /// Raw, UNGATED sender access. Gating is the caller's responsibility: take
    /// [`Self::gate`] around it for a persist→publish bracket, or call it bare
    /// for publishes whose ordering the terminal tx itself provides (the
    /// run loop's post-terminal-tx `Done`/`Error`) and for pre-attach sends.
    /// The shaped helpers cover the common rituals.
    pub fn send(&self, event: RunEvent) {
        let _ = self.tx.send(event);
    }

    /// Test-only raw tail attach, positioned at "now" WITHOUT the gate.
    /// Production subscribers must go through [`Self::snapshot_then_attach`].
    #[cfg(test)]
    pub fn subscribe_raw(&self) -> broadcast::Receiver<RunEvent> {
        self.tx.subscribe()
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

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    /// The two method shapes compose: a receiver attached via
    /// `snapshot_then_attach` (dummy read) receives an event published through
    /// `publish_gated`. The system-level exactly-once property stays pinned by
    /// the persistence_stream/subscribe integration suites; this pins delivery
    /// through the hub's own interface.
    #[tokio::test]
    async fn publish_gated_delivers_to_attached_subscriber() {
        let hubs = new_hubs();
        let hub = create(&hubs, Uuid::now_v7());

        let (snapshot, mut rx) = hub.snapshot_then_attach(|| async { "snap" }).await;
        assert_eq!(snapshot, "snap", "the read's value passes through");

        hub.publish_gated(RunEvent::Done).await;

        let event = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("event arrives within timeout")
            .expect("channel open");
        assert!(
            matches!(event, RunEvent::Done),
            "a gated publish reaches a snapshot_then_attach receiver"
        );
    }

    /// Mutual exclusion (ADR-0022): while `gate()` is held, a `publish_gated`
    /// from another task BLOCKS until release — so a snapshot_then_attach
    /// critical section can never interleave with a persist→publish one. The
    /// publisher records a flag after sending; the flag must stay unset while
    /// the gate is held and flip only after the guard drops.
    #[tokio::test]
    async fn publish_gated_blocks_while_gate_is_held() {
        let hubs = new_hubs();
        let hub = create(&hubs, Uuid::now_v7());

        let guard = hub.gate().await;

        let published = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let publisher = {
            let hub = hub.clone();
            let published = published.clone();
            tokio::spawn(async move {
                hub.publish_gated(RunEvent::Done).await;
                published.store(true, std::sync::atomic::Ordering::SeqCst);
            })
        };

        // Give the publisher ample time to run; it must be parked on the gate.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !published.load(std::sync::atomic::Ordering::SeqCst),
            "publish_gated must block while another task holds the gate"
        );

        drop(guard);
        tokio::time::timeout(Duration::from_secs(5), publisher)
            .await
            .expect("publisher completes once the gate is released")
            .expect("publisher task did not panic");
        assert!(
            published.load(std::sync::atomic::Ordering::SeqCst),
            "publish_gated proceeds after the gate is dropped"
        );
    }
}
