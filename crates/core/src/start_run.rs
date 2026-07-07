//! Run start as one deep, directly-testable verb (ADR-0029, extending the
//! `run/cancel` → [`crate::cancel`] precedent to the four Run-creation sites:
//! `run/post_message`, `thread/create`, `journal/entry`, `run/retry`).
//!
//! [`start_run`] is the ONLY place the Run-start sequence lives; its three
//! ordering invariants are code structure, not per-handler discipline:
//!
//! 1. **Gate BEFORE persist** — the provider-credential gate (ADR-0062) runs
//!    before any row is written, so a tokenless Worker (which would only 401
//!    into an opaque errored Run) is rejected with zero rows.
//! 2. **Hub BEFORE spawn** — the hub is registered before the Worker spawns so
//!    a fast `run/subscribe` can never race a missing hub (ADR-0022).
//! 3. **History BEFORE spawn** — prior-Run history (ADR-0018) is assembled
//!    before the spawn, with the byte-identical non-fatal eprintln fallback.
//!
//! The persist step is a closed [`PersistStep`] enum (exactly three variants
//! eventually — `FreshRun` now; `CreateThread` and `RetryCas` land in later
//! slices), not user-extensible: each variant keeps its current transactional
//! shape behind the shared sequence. The Worker spawn is INJECTED as `spawn_fn`
//! (production: [`default_spawn`]) so the sequence is assertable against a
//! `:memory:` pool without a real Worker binary — mirroring how
//! [`crate::cancel`] injects `get_hub` (ADR-0026: no new subsystem dependency).
//! `deferred_spawn` returns the spawn as an unfired closure for retry's
//! response-BEFORE-spawn wire ordering (slice 3).

use sqlx::SqlitePool;
use uuid::Uuid;

use crate::db;
use crate::dispatcher;
use crate::hub::{self, Hubs, RunHub};
use crate::protocol::ManifestAttachment;
use crate::workflow::Workflow;

/// What the persist step does — a closed set (exactly three variants
/// eventually: `FreshRun` now; `CreateThread` and `RetryCas` land in later
/// slices), not user-extensible. The resolved [`Workflow`] is NOT an input:
/// [`start_run`] resolves it via `dispatch_and_resolve` and passes it into the
/// variant's persist execution.
pub enum PersistStep {
    /// Fresh run insert into an existing Thread (`post_message`,
    /// `journal_entry`) — `db::persist_initial_run`'s one deferred-FK
    /// transaction. `attachments` are the user Message's resolved media links
    /// (ADR-0058), validated by the shell BEFORE the verb runs and persisted
    /// inside the same transaction.
    FreshRun {
        run_id: Uuid,
        user_message_id: Uuid,
        assistant_message_id: Uuid,
        attachments: Vec<db::AttachmentSeed>,
        now: i64,
    },
}

impl PersistStep {
    /// The Run id this step will persist (minted by the caller — ids stay
    /// caller-owned so retry can reuse them in a later slice).
    fn run_id(&self) -> Uuid {
        match self {
            PersistStep::FreshRun { run_id, .. } => *run_id,
        }
    }

    /// The assistant Message id the spawned Worker appends into.
    fn assistant_message_id(&self) -> Uuid {
        match self {
            PersistStep::FreshRun {
                assistant_message_id,
                ..
            } => *assistant_message_id,
        }
    }

    /// Execute the variant's persist transaction. Each variant keeps its
    /// current transactional shape — this match is dispatch, not a new shape.
    async fn execute(
        &self,
        pool: &SqlitePool,
        thread_id: Uuid,
        workflow: &Workflow,
        prompt: &str,
    ) -> sqlx::Result<()> {
        match self {
            PersistStep::FreshRun {
                run_id,
                user_message_id,
                assistant_message_id,
                attachments,
                now,
            } => {
                db::persist_initial_run(
                    pool,
                    *run_id,
                    thread_id,
                    *user_message_id,
                    *assistant_message_id,
                    workflow,
                    prompt,
                    attachments,
                    *now,
                )
                .await
            }
        }
    }
}

/// Parameters for starting a Run.
pub struct StartRunParams {
    pub thread_id: Uuid,
    pub prompt: String,
    /// The CURRENT turn's images (chat-image-attachments), already read +
    /// base64-encoded by the shell (so a read failure fails the RPC before the
    /// verb runs) — carried through to the spawn manifest untouched.
    pub manifest_attachments: Vec<ManifestAttachment>,
    pub persist_step: PersistStep,
    /// `thread/create` sets true (slice 2): a brand-new Thread has no prior
    /// exchange, so skip the history read entirely.
    pub skip_history: bool,
    /// `run/retry` sets true (slice 3): the handler frames its Response BEFORE
    /// the spawn, so the spawn comes back as an unfired closure.
    pub deferred_spawn: bool,
}

/// A successfully started Run.
pub struct StartedRun {
    pub run_id: Uuid,
    /// The assistant Message id the Worker streams into. Unused by
    /// `post_message`'s shell; `thread/create` and `retry` read it in later
    /// slices.
    #[allow(dead_code)]
    pub assistant_message_id: Uuid,
    /// `Some` only when [`StartRunParams::deferred_spawn`] was set: the spawn,
    /// unfired, for the caller to invoke AFTER framing its Response. Unread by
    /// the fresh paths (always `None` there); `retry` fires it in slice 3.
    #[allow(dead_code)]
    pub deferred_spawn: Option<Box<dyn FnOnce() + Send>>,
}

/// Errors from [`start_run`] — the verb's OWN error type, not wire errors (the
/// thin handler maps these to `HandlerError`, keeping the deep verb independent
/// of the handler layer per ADR-0029).
#[derive(Debug)]
pub enum StartRunError {
    /// The resolved model's provider has no stored credential (ADR-0062).
    /// Carries the provider id.
    ProviderNotConnected(String),
    /// A DB or credential-store fault.
    Internal(anyhow::Error),
}

/// Everything `worker::spawn` takes — built by [`start_run`], consumed by the
/// injected `spawn_fn` (production: [`default_spawn`]).
pub struct SpawnManifest {
    pub run_id: Uuid,
    pub workflow: Workflow,
    pub prompt: String,
    pub history: Vec<(String, String)>,
    /// The current turn's pre-encoded image attachments
    /// (chat-image-attachments) — resolved by the shell, shipped in the fresh
    /// spawn manifest.
    pub manifest_attachments: Vec<ManifestAttachment>,
    pub pool: SqlitePool,
    pub assistant_message_id: Uuid,
    pub hubs: Hubs,
    pub run_hub: RunHub,
}

/// The production spawn: hand the manifest to the real Worker spawner.
pub fn default_spawn(m: SpawnManifest) {
    crate::worker::spawn(
        m.run_id,
        m.workflow,
        m.prompt,
        m.history,
        m.manifest_attachments,
        m.pool,
        m.assistant_message_id,
        m.hubs,
        m.run_hub,
    );
}

/// The ADR-0062 provider-credential gate, in the verb's own error vocabulary.
/// CHOICE: this deliberately calls `credentials::is_connected` directly — the
/// same check `runs::handler::ensure_provider_connected` performs — rather
/// than the handler helper, because the deep verb must not depend on the
/// handler layer's wire-error type (ADR-0029), and `HandlerError` is
/// `pub(super)` to `runs` (widening the helper would force widening the enum
/// too). Same mapping, byte-identical behavior: missing → ProviderNotConnected
/// carrying the provider id; a present-but-unparseable store → Internal (fail
/// loud on a corrupt store, never a misleading "not connected").
fn ensure_provider_connected(provider: &str) -> Result<(), StartRunError> {
    match crate::credentials::is_connected(provider) {
        Ok(true) => Ok(()),
        Ok(false) => Err(StartRunError::ProviderNotConnected(provider.to_string())),
        Err(e) => Err(StartRunError::Internal(e)),
    }
}

/// Start a Run: dispatch → gate → persist → hub → history → spawn, in that
/// order, as described in the module docs. Returns the typed [`StartedRun`];
/// the only failure channels are the provider gate and an internal fault.
pub async fn start_run<F>(
    pool: &SqlitePool,
    hubs: &Hubs,
    params: StartRunParams,
    spawn_fn: F,
) -> Result<StartedRun, StartRunError>
where
    F: FnOnce(SpawnManifest) + Send + 'static,
{
    let StartRunParams {
        thread_id,
        prompt,
        manifest_attachments,
        persist_step,
        skip_history,
        deferred_spawn,
    } = params;
    let run_id = persist_step.run_id();
    let assistant_message_id = persist_step.assistant_message_id();

    // 1. Pick a Workflow (ADR-0011) and resolve its effective model/effort from
    //    user settings (ADR-0024) — one shared seam. Infallible.
    let workflow = dispatcher::dispatch_and_resolve(pool, thread_id, &prompt).await;

    // 2. Gate BEFORE persist (ADR-0062): reject a disconnected provider with
    //    zero rows written — a tokenless Worker would only 401 into an opaque
    //    errored Run. Fail loud so the Client can prompt "connect it".
    ensure_provider_connected(&workflow.provider)?;

    // 3. Persist: the variant's own transactional shape, against the resolved
    //    Workflow.
    persist_step
        .execute(pool, thread_id, &workflow, &prompt)
        .await
        .map_err(|e| StartRunError::Internal(e.into()))?;

    // 4. Hub BEFORE spawn (ADR-0022): a subscribe arriving right after the
    //    response can't find a missing hub.
    let run_hub = hub::create(hubs, run_id);

    // 5. History BEFORE spawn (ADR-0018): prior-Run conversation history,
    //    excluding the Run just persisted. A read failure is non-fatal: fall
    //    back to no history. `skip_history` (thread/create) skips the read — a
    //    brand-new Thread has no prior exchange.
    let history = if skip_history {
        Vec::new()
    } else {
        db::history_for_run(pool, thread_id, run_id)
            .await
            .unwrap_or_else(|e| {
                eprintln!("history_for_run failed for run {run_id}: {e}");
                Vec::new()
            })
    };

    // 6. Spawn: immediately on the fresh paths; as an unfired closure when
    //    deferred (retry frames its Response BEFORE the spawn).
    let manifest = SpawnManifest {
        run_id,
        workflow,
        prompt,
        history,
        manifest_attachments,
        pool: pool.clone(),
        assistant_message_id,
        hubs: hubs.clone(),
        run_hub,
    };
    let deferred = if deferred_spawn {
        Some(Box::new(move || spawn_fn(manifest)) as Box<dyn FnOnce() + Send>)
    } else {
        spawn_fn(manifest);
        None
    };

    Ok(StartedRun {
        run_id,
        assistant_message_id,
        deferred_spawn: deferred,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use sqlx::SqlitePool;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use uuid::Uuid;

    use super::{PersistStep, SpawnManifest, StartRunError, StartRunParams, start_run};
    use crate::db;
    use crate::hub;
    use crate::workflow::default_workflow;

    /// A migrated in-memory tier-2 pool, `max_connections(1)` so the single
    /// `:memory:` database persists across calls — same shape as `cancel.rs`'s
    /// test pool.
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

    /// A panic-safe credentials-dir fixture (shared
    /// [`crate::credentials::test_credentials_dir`]), mirroring
    /// `runs/retry.rs`'s. When `connected`, seeds an openai-codex credential so
    /// the ADR-0062 provider gate passes; when not, the dir stays empty (a
    /// disconnected provider). Keep the guard bound for the whole test.
    fn credentials_dir(connected: bool) -> crate::credentials::CredentialsDirGuard {
        let guard = crate::credentials::test_credentials_dir();
        if connected {
            crate::credentials::write(
                "openai-codex",
                &crate::credentials::StoredCredential::Oauth(crate::credentials::Credentials {
                    access: "tok".to_string(),
                    refresh: "ref".to_string(),
                    expires: 9_999_999_999_999,
                    account_id: "acct".to_string(),
                }),
            )
            .expect("write credential");
        }
        guard
    }

    /// Insert a bare Thread row (no prior Run), so `PersistStep::FreshRun` has
    /// a parent AND the `runs` table starts empty (the gate test asserts zero
    /// rows). Loads the default Workflow (idempotent) for
    /// `dispatch_and_resolve`.
    async fn seed_thread(pool: &SqlitePool) -> Uuid {
        crate::workflow::init().expect("load default workflow");
        let thread_id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO threads (id, title, created_at, last_activity_at) VALUES (?1, 't', 1, 1)",
        )
        .bind(thread_id.to_string())
        .execute(pool)
        .await
        .expect("insert thread");
        thread_id
    }

    /// Fresh-run params with newly minted ids. Returns `(params, run_id)`.
    fn fresh_params(thread_id: Uuid) -> (StartRunParams, Uuid) {
        let run_id = Uuid::now_v7();
        (
            StartRunParams {
                thread_id,
                prompt: "the prompt".to_string(),
                manifest_attachments: Vec::new(),
                persist_step: PersistStep::FreshRun {
                    run_id,
                    user_message_id: Uuid::now_v7(),
                    assistant_message_id: Uuid::now_v7(),
                    attachments: Vec::new(),
                    now: 1,
                },
                skip_history: false,
                deferred_spawn: false,
            },
            run_id,
        )
    }

    async fn runs_count(pool: &SqlitePool) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM runs")
            .fetch_one(pool)
            .await
            .expect("count runs")
    }

    // 1. The immediate path: persist → hub → spawn. The recording spawn_fn
    //    asserts the hub is registered AT SPAWN TIME (hub BEFORE spawn); the
    //    deferred test below pins persist/hub before the spawn instant from the
    //    outside. After return: the run row exists (`running`), the hub is
    //    registered, and spawn ran exactly once with the right run_id.
    #[tokio::test]
    async fn ordering_persist_before_hub_before_spawn() {
        let _cred = credentials_dir(true);
        let pool = memory_pool().await;
        let hubs = hub::new_hubs();
        let thread_id = seed_thread(&pool).await;
        let (params, run_id) = fresh_params(thread_id);

        let spawned: Arc<Mutex<Vec<Uuid>>> = Arc::new(Mutex::new(Vec::new()));
        let recorder = {
            let spawned = spawned.clone();
            let hubs = hubs.clone();
            move |m: SpawnManifest| {
                // Hub BEFORE spawn: the registry entry exists at spawn time, so
                // a subscribe racing the spawn can never miss it.
                assert!(hub::get(&hubs, m.run_id).is_some(), "hub exists at spawn time");
                spawned.lock().unwrap().push(m.run_id);
            }
        };

        let started = start_run(&pool, &hubs, params, recorder)
            .await
            .expect("start_run succeeds");

        assert_eq!(started.run_id, run_id);
        assert!(started.deferred_spawn.is_none(), "immediate path returns no closure");
        assert_eq!(runs_count(&pool).await, 1, "the run row was persisted");
        assert_eq!(
            db::run_status(&pool, run_id).await.expect("status").map(db::RunStatus::as_str),
            Some("running"),
            "the fresh run is running"
        );
        assert!(hub::get(&hubs, run_id).is_some(), "the hub is registered");
        assert_eq!(*spawned.lock().unwrap(), vec![run_id], "spawn ran once with the run id");
    }

    // 2. Gate BEFORE persist (ADR-0062): a disconnected provider is rejected
    //    with ProviderNotConnected AND zero rows written AND no hub AND no spawn
    //    (panic-in-closure pins "never called", like cancel.rs's tests).
    #[tokio::test]
    async fn provider_gate_rejects_before_persist() {
        let _cred = credentials_dir(false);
        let pool = memory_pool().await;
        let hubs = hub::new_hubs();
        let thread_id = seed_thread(&pool).await;
        let (params, run_id) = fresh_params(thread_id);

        let result = start_run(&pool, &hubs, params, |_m: SpawnManifest| {
            panic!("a rejected start must never spawn");
        })
        .await;

        match result {
            Err(StartRunError::ProviderNotConnected(provider)) => {
                assert_eq!(provider, "openai-codex", "carries the provider id");
            }
            Err(StartRunError::Internal(e)) => panic!("expected ProviderNotConnected, got Internal({e})"),
            Ok(_) => panic!("expected ProviderNotConnected, got Ok"),
        }
        assert_eq!(runs_count(&pool).await, 0, "gate BEFORE persist: zero rows written");
        assert!(hub::get(&hubs, run_id).is_none(), "no hub was created");
    }

    // 3. deferred_spawn: true → the spawn comes back as an UNFIRED closure. At
    //    return the run row + hub already exist (persist and hub strictly
    //    precede the spawn instant); firing the closure spawns exactly once.
    #[tokio::test]
    async fn deferred_spawn_returns_unfired_closure() {
        let _cred = credentials_dir(true);
        let pool = memory_pool().await;
        let hubs = hub::new_hubs();
        let thread_id = seed_thread(&pool).await;
        let (mut params, run_id) = fresh_params(thread_id);
        params.deferred_spawn = true;

        let spawned: Arc<Mutex<Vec<Uuid>>> = Arc::new(Mutex::new(Vec::new()));
        let recorder = {
            let spawned = spawned.clone();
            move |m: SpawnManifest| {
                spawned.lock().unwrap().push(m.run_id);
            }
        };

        let started = start_run(&pool, &hubs, params, recorder)
            .await
            .expect("start_run succeeds");

        assert!(spawned.lock().unwrap().is_empty(), "deferred: not spawned at return");
        assert_eq!(runs_count(&pool).await, 1, "persisted BEFORE the deferred spawn fires");
        assert!(hub::get(&hubs, run_id).is_some(), "hub registered BEFORE the deferred spawn fires");

        started.deferred_spawn.expect("the unfired spawn closure")();

        assert_eq!(*spawned.lock().unwrap(), vec![run_id], "firing the closure spawns once");
    }

    // 4. skip_history: true → the manifest carries an EMPTY history even when
    //    the thread has a prior run with completed messages. The control run on
    //    the same thread (skip_history: false) proves the seed produced real
    //    history — without it an empty history would be vacuous.
    #[tokio::test]
    async fn skip_history_passes_empty() {
        let _cred = credentials_dir(true);
        let pool = memory_pool().await;
        let hubs = hub::new_hubs();
        crate::workflow::init().expect("load default workflow");
        // A Thread WITH a prior run: its user Message is `completed`, so
        // history_for_run on a later run returns at least that exchange.
        let thread_id = Uuid::now_v7();
        db::persist_thread_with_first_run(
            &pool,
            thread_id,
            Uuid::now_v7(),
            Uuid::now_v7(),
            Uuid::now_v7(),
            default_workflow(),
            "the earlier prompt",
            &[],
            "t",
            1,
        )
        .await
        .expect("seed prior run");

        let histories: Arc<Mutex<Vec<Vec<(String, String)>>>> = Arc::new(Mutex::new(Vec::new()));

        let (mut params, _) = fresh_params(thread_id);
        params.skip_history = true;
        start_run(&pool, &hubs, params, {
            let histories = histories.clone();
            move |m: SpawnManifest| histories.lock().unwrap().push(m.history)
        })
        .await
        .expect("skip_history run succeeds");

        let (params, _) = fresh_params(thread_id);
        start_run(&pool, &hubs, params, {
            let histories = histories.clone();
            move |m: SpawnManifest| histories.lock().unwrap().push(m.history)
        })
        .await
        .expect("control run succeeds");

        let histories = histories.lock().unwrap();
        assert!(histories[0].is_empty(), "skip_history passes an empty history");
        assert!(
            !histories[1].is_empty(),
            "control: without skip the prior exchange is present"
        );
    }
}
