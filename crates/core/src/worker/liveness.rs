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

use crate::protocol::ProviderTestResult;

use super::oneshot::{self, OneShotOutcome, OneShotSpec};
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

    // Drive a one-shot Worker through the shared runner (bespoke manifest, launch
    // resolve, spawn, timed recv-loop, shutdown + drop). The launch Role is
    // `Worker` — the probe IS a Worker turn. The collector yields the terminal
    // verdict: the first `TextDelta`/`ReasoningDelta`/`Done` proves the provider
    // answered (alive); an `Error` frame is dead with its message; a `ToolRequest`
    // (the probe ships no tools) or EOF without a reply is dead with a reason.
    let corr_id = Uuid::now_v7();
    let outcome = oneshot::run(
        corr_id,
        OneShotSpec {
            name: "liveness",
            provider,
            model,
            system_prompt: PROBE_SYSTEM_PROMPT,
            prompt: PING_PROMPT,
            access_token: token.as_deref(),
            role: crate::launch::Role::Worker,
        },
        probe_timeout(),
        |worker| Box::pin(async move {
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
                        return dead(
                            "worker requested a tool during the liveness probe".to_string(),
                        );
                    }
                    // EOF before any reply: the Worker died without answering.
                    None => return dead("worker closed without a reply".to_string()),
                }
            }
        }),
    )
    .await;

    // Map the runner's terminal outcome to the wire verdict. A launch/spawn
    // failure or timeout is dead with a reason (never the secret, ADR-0038); a
    // clean collect returns the collector's own alive/dead verdict.
    match outcome {
        OneShotOutcome::Collected(result) => result,
        OneShotOutcome::LaunchFailed(e) => {
            tracing::warn!(event = "liveness.launch_resolution_failed", error = ?e);
            dead("worker launch command could not be resolved".to_string())
        }
        OneShotOutcome::SpawnFailed => dead("worker failed to start".to_string()),
        OneShotOutcome::TimedOut => dead("worker did not reply in time".to_string()),
    }
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

/// The collector timeout for the probe Worker (ADR-0062): the boot-resolved
/// `INKSTONE_PROVIDER_TEST_TIMEOUT_MS` (unset/unparseable/`0` → 15s, parsed in
/// [`crate::config::Config::from_lookup`]).
fn probe_timeout() -> std::time::Duration {
    crate::config::get().provider_test_timeout
}

#[cfg(test)]
mod tests {
    use super::*;

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
