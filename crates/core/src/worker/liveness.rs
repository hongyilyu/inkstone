//! One-shot provider liveness probe (ADR-0062): a SYNCHRONOUS non-Run Worker
//! that resolves the provider's credential, spawns an ephemeral Worker with a
//! fixed "ping" prompt, and RETURNS whether the provider answered — creating no
//! Thread, no Run row, no message persistence.
//!
//! This is [`super::title`] made synchronous: same bespoke manifest (throwaway
//! `run_id`, empty tools, thinking off), same [`ChildWorker`] spawn + collector
//! loop over the [`WorkerPort`] seam (ADR-0026), same `shutdown()` + drop on
//! every path so `kill_on_drop` reaps a hung child. But instead of fire-and-
//! forget writing a title, it returns a [`ProviderTestResult`] to the caller.
//!
//! Provider-agnostic: [`crate::provider_auth::resolve_access_token`] dispatches
//! by auth kind (ADR-0062), so an openrouter static key and a codex OAuth token
//! both resolve here and inject as the manifest's `access_token`, exactly as a
//! real Run does. A provider with no stored credential resolves to `None` and
//! the probe returns dead WITHOUT spawning.

use uuid::Uuid;

use crate::protocol::{ProviderTestResult, WorkerManifest, WorkflowManifest};

use super::child::ChildWorker;
use super::port::WorkerPort;

/// The fixed prompt the probe sends: the smallest possible turn that forces the
/// provider to answer. Any reply (a text delta or a clean `done`) proves the
/// credential + model are live; an `error` frame proves they are not.
const PING_PROMPT: &str = "ping";

/// The system prompt for the probe Worker — deliberately trivial. The turn
/// exists only to elicit a provider response, so the content does not matter.
const PROBE_SYSTEM_PROMPT: &str = "Reply with a single word.";

/// Probe `provider`'s liveness with `model` (ADR-0062). Resolves the credential;
/// on no credential returns `{ alive: false, message: "<provider> is not
/// configured" }` WITHOUT spawning. Otherwise builds a bespoke ping manifest,
/// spawns a one-shot Worker, and collects over [`WorkerPort::recv`] under a
/// timeout: the first `TextDelta`/`Done` is alive; an `Error` frame is dead with
/// its message; a `ToolRequest` (the probe ships no tools), EOF without a reply,
/// or a timeout are dead with a reason. `shutdown()` + drop run on every path.
pub(crate) async fn probe(provider: &str, model: &str) -> ProviderTestResult {
    // Token gate (ADR-0062): resolve the credential first. `Ok(None)` (no stored
    // credential) short-circuits to dead WITHOUT spawning — the load-bearing
    // "not configured" branch. `Err` (a resolution/refresh failure) is likewise
    // dead, surfaced with the provider name (never the secret, ADR-0038).
    let token = match crate::provider_auth::resolve_access_token(provider, crate::db::now_ms()).await
    {
        Ok(Some(t)) => Some(t),
        Ok(None) => {
            return dead(format!("{provider} is not configured"));
        }
        Err(e) => {
            tracing::warn!(
                event = "liveness.token_resolution_failed",
                provider = %provider,
                error = ?e
            );
            return dead(format!("could not resolve credentials for {provider}"));
        }
    };

    // Bespoke manifest (mirrors title.rs): a throwaway run_id (no Run row exists
    // for it), empty history, empty tools, thinking off, the given provider+model,
    // and the resolved token.
    let corr_id = Uuid::now_v7();
    let manifest = WorkerManifest {
        run_id: corr_id,
        workflow: WorkflowManifest {
            name: "liveness",
            version: "1",
            provider,
            model,
            system_prompt: PROBE_SYSTEM_PROMPT,
            thinking_level: "off",
            tools: vec![],
        },
        prompt: PING_PROMPT,
        messages: vec![],
        mode: None,
        access_token: token.as_deref(),
    };
    let manifest_line = super::serialize_manifest(&manifest);

    // Resolve the Worker launch command (ADR-0041 Worker role — the probe IS a
    // Worker turn). A resolution failure is dead, not a panic.
    let cmd = match crate::launch::resolve(crate::launch::Role::Worker) {
        Ok(cmd) => cmd,
        Err(e) => {
            tracing::warn!(event = "liveness.launch_resolution_failed", error = ?e);
            return dead("worker launch command could not be resolved".to_string());
        }
    };

    // Spawn. A spawn failure (missing binary, bad manifest write) is dead.
    let Ok(mut worker) =
        ChildWorker::spawn(corr_id, &cmd.program, &cmd.args, manifest_line).await
    else {
        return dead("worker failed to start".to_string());
    };

    // Time-bound the collector (mirrors title.rs): a Worker that never finishes
    // must not hang the probe or leak a child. Only the recv loop is inside the
    // timed future (borrowing `&mut worker`); on timeout the future is dropped,
    // releasing the borrow, and `worker` falls out of scope so `kill_on_drop`
    // reaps the hung child.
    //
    // The future yields the terminal [`ProviderTestResult`]: the first
    // `TextDelta` OR a `Done` is alive; an `Error` frame is dead with its
    // message; a `ToolRequest` (the probe ships no tools) or EOF without any
    // reply is dead with a reason.
    let collected = tokio::time::timeout(probe_timeout(), async {
        loop {
            match worker.recv().await {
                // Any output — a streamed delta or a clean finish — proves the
                // provider answered.
                Some(crate::protocol::WorkerStdout::TextDelta { .. })
                | Some(crate::protocol::WorkerStdout::ReasoningDelta { .. })
                | Some(crate::protocol::WorkerStdout::Done) => return alive(),
                // An explicit error frame is a failed turn: dead, carrying the
                // provider's message (the auth/rate/model detail the user needs).
                Some(crate::protocol::WorkerStdout::Error { message }) => return dead(message),
                // The probe ships no tools; a tool_request is an unexpected turn.
                Some(crate::protocol::WorkerStdout::ToolRequest { .. }) => {
                    return dead("worker requested a tool during the liveness probe".to_string());
                }
                // EOF before any reply: the Worker died without answering.
                None => return dead("worker closed without a reply".to_string()),
            }
        }
    })
    .await;

    // Drop stdin → EOF so the Worker exits, then drop the transport so
    // `kill_on_drop` reaps it. Runs on every path (incl. the timeout, where the
    // Worker is still alive and hung) so no child is leaked.
    worker.shutdown().await;
    drop(worker);

    // A timeout (`Err`) is dead; otherwise the collected result stands.
    collected.unwrap_or_else(|_elapsed| dead("worker did not reply in time".to_string()))
}

/// The alive result — `message` omitted (the provider answered).
fn alive() -> ProviderTestResult {
    ProviderTestResult {
        alive: true,
        message: None,
    }
}

/// A dead result carrying `message` (an error frame's text, a timeout, or a
/// "not configured" note).
fn dead(message: String) -> ProviderTestResult {
    ProviderTestResult {
        alive: false,
        message: Some(message),
    }
}

/// The collector timeout for the probe Worker (mirrors title.rs). Reads
/// `INKSTONE_PROVIDER_TEST_TIMEOUT_MS` as a `u64` of milliseconds; unset,
/// unparseable, or `0` falls back to 15s (a zero-length timeout fires instantly,
/// turning every probe into a silent dead result). The env seam lets tests set
/// it low to exercise the timeout without a wall-clock wait.
fn probe_timeout() -> std::time::Duration {
    const DEFAULT_MS: u64 = 15_000;
    let ms = std::env::var("INKSTONE_PROVIDER_TEST_TIMEOUT_MS")
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .filter(|ms| *ms > 0)
        .unwrap_or(DEFAULT_MS);
    std::time::Duration::from_millis(ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Serializes the `INKSTONE_PROVIDER_TEST_TIMEOUT_MS` env mutation across the
    /// cases so they don't race (the process env is global).
    static TIMEOUT_ENV_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Unset or unparseable `INKSTONE_PROVIDER_TEST_TIMEOUT_MS` → the 15s
    /// default; a valid `u64` → that many milliseconds; `0` → default (never a
    /// zero-length timeout). Pins the env seam independent of any spawned Worker.
    #[test]
    fn probe_timeout_parses_env_with_15s_default() {
        let _guard = TIMEOUT_ENV_GUARD.lock().unwrap_or_else(|p| p.into_inner());

        unsafe {
            std::env::remove_var("INKSTONE_PROVIDER_TEST_TIMEOUT_MS");
        }
        assert_eq!(probe_timeout(), Duration::from_millis(15_000));

        unsafe {
            std::env::set_var("INKSTONE_PROVIDER_TEST_TIMEOUT_MS", "200");
        }
        assert_eq!(probe_timeout(), Duration::from_millis(200));

        unsafe {
            std::env::set_var("INKSTONE_PROVIDER_TEST_TIMEOUT_MS", "not-a-number");
        }
        assert_eq!(probe_timeout(), Duration::from_millis(15_000));

        unsafe {
            std::env::set_var("INKSTONE_PROVIDER_TEST_TIMEOUT_MS", "0");
        }
        assert_eq!(probe_timeout(), Duration::from_millis(15_000));

        unsafe {
            std::env::remove_var("INKSTONE_PROVIDER_TEST_TIMEOUT_MS");
        }
    }

    /// The alive/dead constructors match their wire contract: alive omits the
    /// message, dead carries it.
    #[test]
    fn alive_and_dead_shapes() {
        let a = alive();
        assert!(a.alive);
        assert!(a.message.is_none());

        let d = dead("boom".to_string());
        assert!(!d.alive);
        assert_eq!(d.message.as_deref(), Some("boom"));
    }
}
