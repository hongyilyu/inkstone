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
use std::sync::{Arc, Mutex, Weak};

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
/// ([`Self::gate`], [`Self::snapshot_then_attach`], [`Self::send`]) so no call
/// site re-spells the lock ordering. `cancel_tx` is
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
    /// exclusive with the other side's. Held directly across a persist/settle tx
    /// AND one or more raw [`Self::send`]s — the terminal-settlement bracket
    /// (review P1 #3: settle → interrupted → terminal, one acquisition) — or
    /// paired with [`Self::snapshot_then_attach`] on the subscribe side. NOT
    /// re-entrant, so publish via raw `send` while holding it, never a nested
    /// `gate()`.
    pub async fn gate(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.gate.lock().await
    }

    /// The gate as an OWNED guard (`Arc`-backed), for [`activate`]'s candidate
    /// lock: it must outlive the registration loop's borrow scope.
    async fn gate_owned(&self) -> tokio::sync::OwnedMutexGuard<()> {
        self.gate.clone().lock_owned().await
    }

    /// `lock → snapshot (caller's async read) → attach receiver → unlock` —
    /// ADR-0022 snapshot-then-tail. The read runs under the gate, so every
    /// delta falls wholly before or after the subscribe instant (in the
    /// snapshot or on the tail, never both, never neither). Returns a
    /// [`RunTail`] that owns the receiver + gate (no `Sender`), so the caller
    /// can `recover()` from a lag under the gate without keeping the channel open.
    pub async fn snapshot_then_attach<T, F, Fut>(&self, read: F) -> (T, RunTail)
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        let guard = self.gate.lock().await;
        let snapshot = read().await;
        let tail = RunTail {
            receiver: self.tx.subscribe(),
            gate: self.gate.clone(),
        };
        drop(guard);
        (snapshot, tail)
    }

    /// Raw sender access; the caller must hold [`Self::gate`] (the
    /// persist→publish bracket / the terminal-settlement bracket — every
    /// production publish is gated). [`RunTail::recover`] depends on that: an
    /// ungated send landing between its gated re-read and `resubscribe()` would
    /// be lost to the recovering subscriber.
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

    /// Registration identity: two handles are the same hub iff they share the
    /// gate allocation (every clone of one registration does; two registrations
    /// never do). Backs [`remove_own`]'s identity check.
    fn same(&self, other: &RunHub) -> bool {
        Arc::ptr_eq(&self.gate, &other.gate)
    }
}

/// A subscriber's live-tail handle (review F3): the broadcast `Receiver` PLUS the
/// per-run gate — but NO `Sender`. That sender-free ownership is the whole point:
/// the forwarder can [`recover`](Self::recover) from a broadcast lag under the
/// gate (re-snapshot + re-attach), yet still observe `RecvError::Closed` when the
/// Worker drops its sender — a `RunHub` clone would keep a `Sender` alive and
/// wedge that close. The lock ritual lives here, not re-spelled at the call site.
pub struct RunTail {
    receiver: broadcast::Receiver<RunEvent>,
    gate: Arc<tokio::sync::Mutex<()>>,
}

impl RunTail {
    /// The next live event, or `Lagged`/`Closed` (ADR-0022). `Lagged` → the
    /// caller [`recover`](Self::recover)s; `Closed` → the Worker dropped its
    /// sender (terminal / `hub::remove`).
    pub async fn recv(&mut self) -> Result<RunEvent, broadcast::error::RecvError> {
        self.receiver.recv().await
    }

    /// Recover from a broadcast lag: UNDER THE GATE, run `read` (re-snapshot the
    /// persisted timeline) AND re-attach a FRESH receiver at the current tail
    /// (`resubscribe`), so the snapshot's last-committed event meets the resumed
    /// tail EXACTLY — no event replayed from the stale ring buffer (which would
    /// duplicate text/reasoning), none lost. Same `lock → read → attach → unlock`
    /// ritual as [`RunHub::snapshot_then_attach`], owned here so the forwarder
    /// never touches the raw mutex.
    pub async fn recover<T, F, Fut>(&mut self, read: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        let guard = self.gate.lock().await;
        let snapshot = read().await;
        self.receiver = self.receiver.resubscribe();
        drop(guard);
        snapshot
    }

    /// Assemble a tail from raw parts (tests drive lag/close directly against a
    /// bare channel; production tails come from [`RunHub::snapshot_then_attach`]).
    #[cfg(test)]
    pub fn from_parts(
        receiver: broadcast::Receiver<RunEvent>,
        gate: Arc<tokio::sync::Mutex<()>>,
    ) -> Self {
        Self { receiver, gate }
    }
}

/// Shared registry of in-flight Runs and their transient lifecycle locks.
///
/// The per-run lifecycle lock linearizes generation changes with cancel and
/// subscribe classification. Its registry entry is weak: once no operation
/// holds or waits for the lock, a later lookup prunes it, so completed Run ids
/// do not accumulate forever. The inner `std::sync::Mutex` is held only for map
/// access and never across an `.await`.
#[derive(Clone)]
pub struct Hubs {
    inner: Arc<Mutex<Registry>>,
}

#[derive(Default)]
struct Registry {
    active: HashMap<Uuid, RunHub>,
    lifecycle: HashMap<Uuid, Weak<tokio::sync::Mutex<()>>>,
}

/// Proof that the caller owns one Run's lifecycle transition slot. Operations
/// which change the active generation require this guard, making the lock order
/// structural: lifecycle first, then the [`RunHub`] snapshot gate.
pub struct LifecycleGuard {
    run_id: Uuid,
    _guard: tokio::sync::OwnedMutexGuard<()>,
}

/// A fresh, empty hub map.
pub fn new_hubs() -> Hubs {
    Hubs {
        inner: Arc::new(Mutex::new(Registry::default())),
    }
}

/// Acquire the transient lifecycle slot for `run_id`.
pub async fn lifecycle(hubs: &Hubs, run_id: Uuid) -> LifecycleGuard {
    let slot = {
        let mut registry = hubs.inner.lock().expect("hubs mutex not poisoned");
        registry.lifecycle.retain(|_, weak| weak.strong_count() > 0);
        match registry.lifecycle.get(&run_id).and_then(Weak::upgrade) {
            Some(slot) => slot,
            None => {
                let slot = Arc::new(tokio::sync::Mutex::new(()));
                registry.lifecycle.insert(run_id, Arc::downgrade(&slot));
                slot
            }
        }
    };
    LifecycleGuard {
        run_id,
        _guard: slot.lock_owned().await,
    }
}

/// Register a fresh hub for `run_id` — ONLY if none is registered (review R8 #1).
/// `None` means another activation holds the slot (a concurrent resume/retry, or
/// a just-terminal Worker that has not yet removed its hub): the caller backs
/// off; it must NOT proceed to flip the Run's status. First-wins registration is
/// what makes the registered hub and the Run's `running` status refer to the
/// same producer — a blind insert let two activations replace each other's hub
/// and drive a Worker whose hub no subscriber or cancel could reach.
/// Test-only seeder: production activation goes through [`activate`], which
/// gate-locks the candidate before it becomes visible.
#[cfg(test)]
pub fn register(hubs: &Hubs, run_id: Uuid) -> Option<RunHub> {
    let hub = RunHub::new();
    register_candidate(hubs, run_id, &hub).then_some(hub)
}

/// Insert `candidate` for `run_id` ONLY if the slot is vacant (first-wins).
/// [`activate`] pre-locks the candidate's gate before calling this, so the hub
/// is never visible un-gated mid-activation.
fn register_candidate(hubs: &Hubs, run_id: Uuid, candidate: &RunHub) -> bool {
    match hubs
        .inner
        .lock()
        .expect("hubs mutex not poisoned")
        .active
        .entry(run_id)
    {
        std::collections::hash_map::Entry::Occupied(_) => false,
        std::collections::hash_map::Entry::Vacant(slot) => {
            slot.insert(candidate.clone());
            true
        }
    }
}

/// Activate a Run: register its hub, then run the caller's guarded status CAS
/// under that hub's gate — the ONE registry operation every activation path
/// (resume, retry, fresh spawn) goes through (review R8 #1/R9 #1). Hub-before-CAS
/// means a Run is observably `running` only while its hub is reachable, so a
/// concurrent `run/cancel` that reads `running` always finds the producer's hub
/// and signals it.
///
/// Registry occupancy NEVER substitutes for the durable CAS (review R9 #1): a
/// producer's drain (terminal/park commit + hub removal) is ONE gated section,
/// so an occupied slot is either mid-drain — acquire ITS gate to wait the drain
/// out, then register and run the CAS — or a LIVE producer (still registered
/// after the gate round-trip), whose Run's status cannot be this activation's
/// from-state, so backing off is the CAS's own answer, not a substitute. A lost
/// or faulted CAS deregisters under the gate — identity-checked, never deleting
/// a later activation's hub. `Ok(None)` = not activated; `Err` = CAS fault.
pub async fn activate<E, F, Fut>(hubs: &Hubs, run_id: Uuid, cas: F) -> Result<Option<RunHub>, E>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<bool, E>>,
{
    let lifecycle = lifecycle(hubs, run_id).await;
    if get(hubs, run_id).is_some() {
        return Ok(None);
    }

    // Lock the candidate's snapshot gate before publishing it. A subscriber
    // therefore cannot read the pre-CAS status against this generation.
    let hub = RunHub::new();
    let guard = hub.gate_owned().await;
    let inserted = register_candidate(hubs, run_id, &hub);
    debug_assert!(inserted, "lifecycle guard keeps the active slot vacant");
    let result = cas().await;
    match result {
        Ok(true) => {
            drop(guard);
            drop(lifecycle);
            Ok(Some(hub))
        }
        Ok(false) => {
            remove_own(hubs, run_id, &hub, &lifecycle);
            drop(guard);
            Ok(None)
        }
        Err(e) => {
            remove_own(hubs, run_id, &hub, &lifecycle);
            drop(guard);
            Err(e)
        }
    }
}

/// Look up the hub for `run_id`, cloning the handle if present. `None` means the
/// Run is terminal/removed (or never existed), so the subscribe handler serves a
/// tier-2 snapshot and the persisted terminal outcome.
pub fn get(hubs: &Hubs, run_id: Uuid) -> Option<RunHub> {
    hubs.inner
        .lock()
        .expect("hubs mutex not poisoned")
        .active
        .get(&run_id)
        .cloned()
}

/// Remove `run_id`'s hub ONLY if the registered entry IS `own` (identity =
/// shared gate allocation) — every removal site passes the hub it owns, so a
/// finishing Worker's cleanup can never delete a hub a newer activation (e.g. a
/// retry racing the old Worker's exit) registered for the same run (review R8
/// #1). A stale-identity call is a no-op.
pub fn remove_own(hubs: &Hubs, run_id: Uuid, own: &RunHub, lifecycle: &LifecycleGuard) {
    debug_assert_eq!(lifecycle.run_id, run_id);
    let mut registry = hubs.inner.lock().expect("hubs mutex not poisoned");
    if registry
        .active
        .get(&run_id)
        .is_some_and(|entry| entry.same(own))
    {
        registry.active.remove(&run_id);
    }
}

/// Remove a generation when no durable transition accompanies the cleanup.
/// The lifecycle/gate acquisition order matches every transition path.
pub async fn retire(hubs: &Hubs, run_id: Uuid, own: &RunHub) {
    let lifecycle = lifecycle(hubs, run_id).await;
    let gate = own.gate().await;
    remove_own(hubs, run_id, own, &lifecycle);
    drop(gate);
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    /// The two shapes compose: a receiver attached via `snapshot_then_attach`
    /// (dummy read) receives an event published through the production ritual —
    /// `gate()` held across a raw `send`. The system-level exactly-once property
    /// stays pinned by the persistence_stream/subscribe integration suites; this
    /// pins delivery through the hub's own interface.
    #[tokio::test]
    async fn gated_send_delivers_to_attached_subscriber() {
        let hubs = new_hubs();
        let hub = register(&hubs, Uuid::now_v7()).expect("fresh run registers");

        let (snapshot, mut rx) = hub.snapshot_then_attach(|| async { "snap" }).await;
        assert_eq!(snapshot, "snap", "the read's value passes through");

        let guard = hub.gate().await;
        hub.send(RunEvent::Done);
        drop(guard);

        let event = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("event arrives within timeout")
            .expect("channel open");
        assert!(
            matches!(event, RunEvent::Done),
            "a gated send reaches a snapshot_then_attach receiver"
        );
    }

    /// Concurrent activation (review R8 #1, the concurrent-resume shape): the
    /// FIRST activation wins the slot; the second backs off WITHOUT running its
    /// CAS — so two resumes can never replace each other's hub, and the map
    /// entry is exactly the winner's producer hub (`get` hands cancel/subscribe
    /// the hub the Worker publishes into).
    #[tokio::test]
    async fn activate_is_first_wins_and_the_loser_cas_never_runs() {
        let hubs = new_hubs();
        let run_id = Uuid::now_v7();

        let winner = activate(&hubs, run_id, || async { Ok::<_, ()>(true) })
            .await
            .expect("cas ok")
            .expect("first activation wins");

        let loser_cas_ran = std::sync::atomic::AtomicBool::new(false);
        let loser = activate(&hubs, run_id, || async {
            loser_cas_ran.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok::<_, ()>(true)
        })
        .await
        .expect("no fault");
        assert!(loser.is_none(), "the second activation backs off");
        assert!(
            !loser_cas_ran.load(std::sync::atomic::Ordering::SeqCst),
            "the loser's CAS never runs — it lost at the registry, before any flip"
        );

        let registered = get(&hubs, run_id).expect("winner's hub stays registered");
        assert!(
            registered.same(&winner),
            "the registered hub IS the winner's producer hub"
        );
    }

    /// A lost CAS deregisters (review R8 #1, the failed-CAS shape): activation
    /// registered the hub, the guarded flip lost (e.g. a cancel raced the
    /// parked→running resume) — the registration must not outlive it, or a
    /// producerless hub would shadow the run forever.
    #[tokio::test]
    async fn activate_removes_the_hub_on_a_lost_cas() {
        let hubs = new_hubs();
        let run_id = Uuid::now_v7();

        let outcome = activate(&hubs, run_id, || async { Ok::<_, ()>(false) })
            .await
            .expect("no fault");
        assert!(outcome.is_none(), "a lost CAS is not an activation");
        assert!(get(&hubs, run_id).is_none(), "the lost CAS deregistered its hub");
    }

    /// A faulted CAS deregisters AND propagates (review R8 #1): a DB error
    /// mid-activation must not leak a producerless hub.
    #[tokio::test]
    async fn activate_removes_the_hub_on_a_cas_fault() {
        let hubs = new_hubs();
        let run_id = Uuid::now_v7();

        let outcome = activate(&hubs, run_id, || async { Err::<bool, &str>("db fault") }).await;
        assert!(
            matches!(outcome, Err("db fault")),
            "the fault propagates"
        );
        assert!(get(&hubs, run_id).is_none(), "the faulted CAS deregistered its hub");
    }

    /// A mid-activation hub is GATE-LOCKED before it is visible (review R10 #2):
    /// a subscriber that finds it must block in `snapshot_then_attach` until the
    /// CAS settles — it can never snapshot the pre-CAS status against the new
    /// generation's channel. Deterministic on the current-thread runtime: with
    /// the old order (publish, then lock) the subscriber completes at the yield
    /// points below; gate-locked-first, it CANNOT complete until the CAS does.
    #[tokio::test]
    async fn subscribers_block_until_the_activation_cas_settles() {
        let hubs = new_hubs();
        let run_id = Uuid::now_v7();
        let (cas_tx, cas_rx) = tokio::sync::oneshot::channel::<()>();
        let cas_settled = Arc::new(std::sync::atomic::AtomicBool::new(false));

        let activation = tokio::spawn({
            let hubs = hubs.clone();
            let cas_settled = cas_settled.clone();
            async move {
                activate(&hubs, run_id, || async {
                    cas_rx.await.expect("test releases the CAS");
                    cas_settled.store(true, std::sync::atomic::Ordering::SeqCst);
                    Ok::<_, ()>(true)
                })
                .await
            }
        });

        // Wait until the candidate hub is visible in the registry.
        let hub = loop {
            if let Some(hub) = get(&hubs, run_id) {
                break hub;
            }
            tokio::task::yield_now().await;
        };

        // A subscriber attaches: it must PARK on the activation's held gate.
        let subscriber = tokio::spawn(async move {
            let (settled, _tail) = hub
                .snapshot_then_attach(|| async {
                    cas_settled.load(std::sync::atomic::Ordering::SeqCst)
                })
                .await;
            settled
        });
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        assert!(
            !subscriber.is_finished(),
            "the subscriber blocks until the activation CAS settles"
        );

        // Release the CAS: activation completes, THEN the subscriber's gated
        // read runs — and it observes the settled state, never the pre-CAS one.
        cas_tx.send(()).expect("release the CAS");
        let activated = activation.await.expect("join").expect("no fault");
        assert!(activated.is_some(), "the activation won");
        assert!(
            subscriber.await.expect("join"),
            "the subscriber's snapshot ran strictly after the CAS settled"
        );
    }

    /// A drain owns the lifecycle slot before the hub gate. An activation for
    /// the next generation therefore waits until the terminal commit and hub
    /// removal are both complete before it runs its own durable CAS.
    #[tokio::test]
    async fn activation_waits_out_an_inflight_drain_and_then_wins() {
        let hubs = new_hubs();
        let run_id = Uuid::now_v7();
        let dying = register(&hubs, run_id).expect("producer registers");
        let lifecycle = lifecycle(&hubs, run_id).await;
        let drain_guard = dying.gate().await;

        let task = tokio::spawn({
            let hubs = hubs.clone();
            async move { activate(&hubs, run_id, || async { Ok::<_, ()>(true) }).await }
        });

        remove_own(&hubs, run_id, &dying, &lifecycle);
        drop(drain_guard);
        drop(lifecycle);

        let hub = tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .expect("activation completes once the drain finishes")
            .expect("task joins")
            .expect("no CAS fault")
            .expect("the retry activates after the prior generation drains");
        let registered = get(&hubs, run_id).expect("the retry's hub is registered");
        assert!(
            registered.same(&hub),
            "the slot holds the retry's fresh hub"
        );
        assert!(!registered.same(&dying), "the dying producer's hub is gone");
    }

    /// Identity-checked removal: a late cleanup carries its own hub identity and
    /// cannot delete a newer generation registered for the same Run.
    #[tokio::test]
    async fn remove_own_ignores_a_stale_hub_identity() {
        let hubs = new_hubs();
        let run_id = Uuid::now_v7();

        let old = register(&hubs, run_id).expect("old registration");
        retire(&hubs, run_id, &old).await;
        let fresh = register(&hubs, run_id).expect("retry re-registers");

        retire(&hubs, run_id, &old).await;
        let survivor = get(&hubs, run_id).expect("the retry's hub survives");
        assert!(survivor.same(&fresh), "the surviving hub is the retry's");

        retire(&hubs, run_id, &fresh).await;
        assert!(get(&hubs, run_id).is_none(), "own removal removes");
    }

    /// `RunTail::recover` discards the stale ring buffer (review F2/F3): a receiver
    /// that lagged past capacity, after `recover`, delivers only events published
    /// AFTER recovery — never a replay of the backlog the re-snapshot already
    /// covered. The read's value passes through. Direct (no forwarder / tracing),
    /// so the recovery boundary is pinned where it lives.
    #[tokio::test]
    async fn run_tail_recover_discards_the_lagged_buffer() {
        let (tx, rx) = broadcast::channel::<RunEvent>(8);
        // Overflow the receiver: 9 sends on cap-8 leaves its next `recv()` lagged.
        for _ in 0..9 {
            let _ = tx.send(RunEvent::TextDelta {
                delta: "buffered".to_string(),
            });
        }
        let mut tail = RunTail::from_parts(rx, Arc::new(tokio::sync::Mutex::new(())));

        let read = tail.recover(|| async { 7_u8 }).await;
        assert_eq!(read, 7, "recover returns the read's value");

        // A post-recovery event is the NEXT thing delivered — the 9 buffered
        // deltas were dropped by the resubscribe, so no replay reaches the tail.
        let _ = tx.send(RunEvent::TextDelta {
            delta: "sentinel".to_string(),
        });
        let next = tokio::time::timeout(Duration::from_secs(5), tail.recv())
            .await
            .expect("event within timeout")
            .expect("channel open");
        assert!(
            matches!(next, RunEvent::TextDelta { delta } if delta == "sentinel"),
            "the resumed tail delivers only post-recovery events, never a replay"
        );
    }

    /// Mutual exclusion (ADR-0022): while `gate()` is held, a SECOND `gate()`
    /// acquisition from another task BLOCKS until release — so a
    /// snapshot_then_attach critical section can never interleave with a
    /// persist/settle → publish one (review P1 #3). The publisher records a flag
    /// after its gated send; the flag must stay unset while the gate is held and
    /// flip only after the guard drops.
    #[tokio::test]
    async fn gate_blocks_a_second_acquisition_until_release() {
        let hubs = new_hubs();
        let hub = register(&hubs, Uuid::now_v7()).expect("fresh run registers");

        let guard = hub.gate().await;

        let published = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let publisher = {
            let hub = hub.clone();
            let published = published.clone();
            tokio::spawn(async move {
                let inner = hub.gate().await;
                hub.send(RunEvent::Done);
                drop(inner);
                published.store(true, std::sync::atomic::Ordering::SeqCst);
            })
        };

        // Give the publisher ample time to run; it must be parked on the gate.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !published.load(std::sync::atomic::Ordering::SeqCst),
            "a second gate() acquisition must block while another task holds it"
        );

        drop(guard);
        tokio::time::timeout(Duration::from_secs(5), publisher)
            .await
            .expect("publisher completes once the gate is released")
            .expect("publisher task did not panic");
        assert!(
            published.load(std::sync::atomic::Ordering::SeqCst),
            "the second acquisition proceeds after the gate is dropped"
        );
    }
}
