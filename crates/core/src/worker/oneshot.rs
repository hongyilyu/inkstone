//! Shared one-shot Worker runner (ADR-0046 / ADR-0062). A one-shot Worker is a
//! non-Run turn: a bespoke manifest (throwaway `run_id`, empty history, empty
//! tools, thinking off), spawned once, driven through a single timed recv-loop
//! over the [`WorkerPort`] seam (ADR-0026), then shut down and reaped on every
//! path so `kill_on_drop` never leaks a hung child.
//!
//! Both the thread titler ([`super::title`]) and the provider liveness probe
//! ([`super::liveness`]) are exactly this shape; they differ ONLY in the manifest
//! fields (name/prompts/model), the launch [`Role`], the timeout, and the
//! frame-handling policy (title accumulates text → sanitize; liveness returns on
//! the first token → alive / error → dead). Those pieces are supplied by the
//! caller; everything mechanical (manifest build, launch resolve, spawn, the
//! timed recv-loop wrapper, shutdown + drop) lives here so the two callers cannot
//! drift on the lifecycle.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use uuid::Uuid;

use crate::launch::Role;
use crate::protocol::{WorkerManifest, WorkflowManifest};

use super::child::ChildWorker;
use super::port::WorkerPort;

/// The caller-supplied inputs that shape a one-shot Worker's manifest + launch.
/// Everything else (throwaway `run_id`, empty history/tools, thinking off) is
/// fixed by the one-shot contract.
pub(super) struct OneShotSpec<'a> {
    /// The bespoke Workflow `name` (`"title"` / `"liveness"`) — diagnostic only.
    pub name: &'a str,
    pub provider: &'a str,
    pub model: &'a str,
    pub system_prompt: &'a str,
    pub prompt: &'a str,
    /// The resolved provider access token, injected as the manifest's
    /// `access_token`. The caller owns token resolution (its gating differs).
    pub access_token: Option<&'a str>,
    /// Which launch command to resolve (ADR-0041): `Role::Titler` for the titler,
    /// `Role::Worker` for the probe (it IS a Worker turn).
    pub role: Role,
}

/// The terminal outcome of a one-shot run. A pre-loop failure (`LaunchFailed` /
/// `SpawnFailed`) or a `TimedOut` is distinguished from the collector's own
/// terminal value so each caller can map them to its own result shape (the
/// titler keeps the placeholder; the probe returns a `dead(...)` reason).
pub(super) enum OneShotOutcome<T> {
    /// The launch command could not be resolved (empty override, etc.).
    LaunchFailed(anyhow::Error),
    /// `ChildWorker::spawn` failed (missing binary, bad manifest write).
    SpawnFailed,
    /// The collector did not finish within the timeout.
    TimedOut,
    /// The collector ran to a terminal frame (Done / EOF / Error / ToolRequest)
    /// and produced its value.
    Collected(T),
}

/// Run a one-shot Worker: build the bespoke manifest from `spec`, resolve + spawn
/// the launch command, drive `collect` inside a `timeout`, then `shutdown()` +
/// drop so `kill_on_drop` reaps the child on EVERY path (incl. the timeout, where
/// the Worker is still alive and hung).
///
/// `collect` is the caller's recv-loop policy: it borrows the spawned Worker and
/// consumes frames until it decides on a terminal value `T` (title accumulates
/// text and returns at Done/EOF; liveness returns on the first token/error).
/// Only the recv-loop is inside the timed future — on a timeout it is dropped,
/// releasing the borrow, and `worker` falls out of scope so the child is reaped.
///
/// The bound is a higher-ranked `FnOnce` returning a borrow-tied boxed future:
/// the collector's future borrows `&mut ChildWorker`, and only an HRTB (`for<'a>`)
/// can express "the returned future lives as long as the borrow it captured".
/// Callers wrap their `async` block in `Box::pin` (see the two one-shot callers).
pub(super) async fn run<T, F>(
    corr_id: Uuid,
    spec: OneShotSpec<'_>,
    timeout: Duration,
    collect: F,
) -> OneShotOutcome<T>
where
    F: for<'a> FnOnce(
        &'a mut ChildWorker,
    ) -> Pin<Box<dyn Future<Output = T> + Send + 'a>>,
{
    // Bespoke manifest: a throwaway run_id (no Run row exists for it), empty
    // history, empty tools, thinking off, plus the caller's provider/model/prompt
    // and resolved token.
    let manifest = WorkerManifest {
        run_id: corr_id,
        workflow: WorkflowManifest {
            name: spec.name,
            version: "1",
            provider: spec.provider,
            model: spec.model,
            system_prompt: spec.system_prompt,
            thinking_level: "off",
            tools: vec![],
        },
        prompt: spec.prompt,
        messages: vec![],
        mode: None,
        access_token: spec.access_token,
    };
    let manifest_line = super::serialize_manifest(&manifest);

    // Resolve the launch command (ADR-0041). A resolution failure is terminal,
    // not a panic.
    let cmd = match crate::launch::resolve(spec.role) {
        Ok(cmd) => cmd,
        Err(e) => return OneShotOutcome::LaunchFailed(e),
    };

    // Spawn. A spawn failure (missing binary, bad manifest write) is terminal.
    let Ok(mut worker) =
        ChildWorker::spawn(corr_id, &cmd.program, &cmd.args, manifest_line).await
    else {
        return OneShotOutcome::SpawnFailed;
    };

    // Time-bound the collector. Only the recv loop is inside the timed future
    // (borrowing `&mut worker`); on a timeout the future is dropped — releasing
    // the borrow — and `worker` falls out of scope at fn end, so `kill_on_drop`
    // reaps the hung child.
    let collected = tokio::time::timeout(timeout, collect(&mut worker)).await;

    // Drop stdin → EOF so the Worker exits, then drop the transport so
    // `kill_on_drop` reaps it. Runs on every path (incl. the timeout, where the
    // Worker is still alive and hung) so no child is leaked.
    worker.shutdown().await;
    drop(worker);

    match collected {
        Ok(value) => OneShotOutcome::Collected(value),
        Err(_elapsed) => OneShotOutcome::TimedOut,
    }
}

/// Read the collector timeout from `env_var` as a `u64` of milliseconds; unset,
/// unparseable, or `0` falls back to 15s. `0` is rejected because a zero-length
/// timeout fires instantly, turning every one-shot into a silent no-op. The env
/// seam lets tests set it low to exercise the timeout without a wall-clock wait.
/// Shared by the titler (`INKSTONE_TITLE_TIMEOUT_MS`) and the probe
/// (`INKSTONE_PROVIDER_TEST_TIMEOUT_MS`).
pub(super) fn timeout_from_env(env_var: &str) -> Duration {
    const DEFAULT_MS: u64 = 15_000;
    let ms = std::env::var(env_var)
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .filter(|ms| *ms > 0)
        .unwrap_or(DEFAULT_MS);
    Duration::from_millis(ms)
}
