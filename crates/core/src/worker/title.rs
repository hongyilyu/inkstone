//! One-shot thread-title generation (ADR-0046): a non-Run Worker that turns the
//! user's first message into a short title, sanitizes its reply, and overwrites
//! the prompt-derived placeholder in `threads.title`.
//!
//! Unlike [`super::spawn`], this builds a BESPOKE manifest directly — no
//! dispatcher, no skills injection, no Run tool descriptors — and drives the
//! spawned Worker through a tiny collector loop over the [`WorkerPort`] seam
//! (ADR-0026) rather than the shared `run_loop`. It is fire-and-forget: the
//! create RESPONSE never waits on it, and any failure (no credential, launch
//! error, spawn error, Worker error, empty/whitespace output) silently keeps the
//! placeholder.
//!
//! Token gate (ADR-0046): the titler spawns ONLY on `Ok(Some(token))` — a
//! stricter bar than [`super::spawn`]'s tokenless path. No credential (`Ok(None)`)
//! and a resolution error (`Err`) both return without spawning.

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;
use tracing::Instrument;
use uuid::Uuid;

use super::oneshot::{self, OneShotOutcome, OneShotSpec};
use super::port::WorkerPort;

/// The system prompt for the title Worker, synthesized from the cross-tool
/// consensus on short-title generation (ADR-0046). Hardcoded here — the title
/// Workflow is bespoke, not a `Workflow` TOML.
const TITLE_SYSTEM_PROMPT: &str = "You generate a short title for a personal-notes thread from the user's first message.
Output ONLY the title — no preamble, no quotes, no trailing punctuation, no label like \"Title:\".
Rules:
- 3 to 7 words, a single line.
- Use the same language as the user's message.
- Do not speak in the first person.
- Keep meaningful specifics (names, numbers, filenames); drop filler words.
- Do not assume a tech stack.
- Always output something meaningful; never refuse.";

/// Fire a one-shot title Worker for `thread_id` (ADR-0046). Returns immediately;
/// a Tokio task resolves the token (strict gate), builds the bespoke manifest,
/// spawns the Worker, collects its `text_delta`s, sanitizes them, and — on a
/// non-empty result — overwrites `threads.title` AND pushes a `thread/titled`
/// notification onto `out_tx` (ADR-0047), the creating connection's outbound
/// channel, so its sidebar updates live. Any pre-spawn or mid-stream failure
/// keeps the placeholder and pushes nothing.
pub fn spawn_title_generation(
    thread_id: Uuid,
    prompt: String,
    provider: String,
    pool: SqlitePool,
    out_tx: UnboundedSender<String>,
) {
    // Title generation is not a Run, so the correlation span keys on `thread_id`
    // (ADR-0038). `corr_id` is a throwaway id minted only for the manifest's
    // `run_id` field (the Worker stamps its trail with it) and log correlation —
    // no Run row exists for it.
    let span = tracing::info_span!("title_gen", %thread_id);
    tokio::spawn(
        async move {
            let corr_id = Uuid::now_v7();

            // Token gate (strict, ADR-0046): spawn ONLY on Ok(Some). Ok(None)
            // (no credential) and Err (resolution failure) both keep the
            // placeholder.
            let token =
                match crate::provider_auth::resolve_access_token(&provider, crate::db::now_ms())
                    .await
                {
                    Ok(Some(t)) => t,
                    _ => return,
                };

            // Resolve the title model. `title_model_for` falls back to the chat
            // default; a provider with no model at all (None) cannot be titled.
            let Some(model) = crate::models::title_model_for(&provider) else {
                return;
            };

            // Drive a one-shot Worker through the shared runner (bespoke manifest,
            // launch resolve, spawn, timed recv-loop, shutdown + drop). The
            // collector accumulates `text_delta`s and yields `Some(acc)` on a
            // clean Done/EOF, or `None` to discard and keep the placeholder (an
            // explicit `error` frame or an unexpected `tool_request` — the titler
            // has no tools). Any pre-loop failure or timeout keeps the placeholder.
            let outcome = oneshot::run(
                corr_id,
                OneShotSpec {
                    name: "title",
                    provider: &provider,
                    model,
                    system_prompt: TITLE_SYSTEM_PROMPT,
                    prompt: &prompt,
                    access_token: Some(&token),
                    role: crate::launch::Role::Titler,
                },
                title_timeout(),
                |worker| Box::pin(async move {
                    let mut acc = String::new();
                    loop {
                        match worker.recv().await {
                            Some(crate::protocol::WorkerStdout::TextDelta { delta }) => {
                                acc.push_str(&delta)
                            }
                            // Reasoning deltas (ADR-0045 reasoning amendment, #202)
                            // are not title text — skip them and keep collecting.
                            Some(crate::protocol::WorkerStdout::ReasoningDelta { .. }) => {}
                            Some(crate::protocol::WorkerStdout::Done) => return Some(acc),
                            // The titler has no tools and an explicit error is a
                            // failed turn: in both cases discard the partial output
                            // and keep the placeholder.
                            Some(crate::protocol::WorkerStdout::Error { .. })
                            | Some(crate::protocol::WorkerStdout::ToolRequest { .. }) => {
                                return None;
                            }
                            // EOF without `done`: use whatever was accumulated.
                            None => return Some(acc),
                        }
                    }
                }),
            )
            .await;

            // Sanitize + persist only on a clean collect that produced output. A
            // launch/spawn failure or timeout, an error/tool_request frame
            // (`Collected(None)`), or empty/whitespace output (`sanitize_title` →
            // `None`) all keep the prompt-derived placeholder.
            if let OneShotOutcome::Collected(Some(acc)) = outcome {
                if let Some(title) = crate::runs::title::sanitize_title(&acc) {
                    match crate::db::update_thread_title(&pool, thread_id, &title).await {
                        // The title was durably written: push it live to the
                        // creating connection (ADR-0047) so its sidebar updates
                        // without a `thread/list` poll. A dead `out_tx` (the tab
                        // closed) is a silent no-op; the next `thread/list`
                        // self-heals.
                        Ok(()) => {
                            crate::runs::reply::send_thread_titled(&out_tx, thread_id, &title);
                        }
                        // A persistent write failure is non-fatal degradation (the
                        // placeholder stays, nothing is pushed), but it must
                        // surface in the diagnostic trail (ADR-0038) rather than
                        // vanish.
                        Err(e) => {
                            tracing::warn!(event = "title.update_failed", %thread_id, error = ?e);
                        }
                    }
                }
            }
        }
        .instrument(span),
    );
}

/// The collector timeout for the title Worker (ADR-0046), read from
/// `INKSTONE_TITLE_TIMEOUT_MS` via the shared [`oneshot::timeout_from_env`]
/// (unset/unparseable/`0` → 15s).
fn title_timeout() -> std::time::Duration {
    oneshot::timeout_from_env("INKSTONE_TITLE_TIMEOUT_MS")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Serializes the `INKSTONE_TITLE_TIMEOUT_MS` env mutation across the two
    /// `title_timeout` cases so they don't race (the process env is global).
    static TIMEOUT_ENV_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Unset or unparseable `INKSTONE_TITLE_TIMEOUT_MS` → the 15s default; a
    /// valid `u64` → that many milliseconds. Pins the env seam the timeout test
    /// relies on, independent of any spawned Worker.
    #[test]
    fn title_timeout_parses_env_with_15s_default() {
        let _guard = TIMEOUT_ENV_GUARD.lock().unwrap_or_else(|p| p.into_inner());

        // Unset → default 15s.
        unsafe {
            std::env::remove_var("INKSTONE_TITLE_TIMEOUT_MS");
        }
        assert_eq!(title_timeout(), Duration::from_millis(15_000));

        // A valid u64 → that many ms.
        unsafe {
            std::env::set_var("INKSTONE_TITLE_TIMEOUT_MS", "200");
        }
        assert_eq!(title_timeout(), Duration::from_millis(200));

        // Garbage → default 15s (never panics, never a zero-length timeout).
        unsafe {
            std::env::set_var("INKSTONE_TITLE_TIMEOUT_MS", "not-a-number");
        }
        assert_eq!(title_timeout(), Duration::from_millis(15_000));

        // Zero → default 15s. A 0ms timeout fires instantly, so every title
        // attempt would be a silent no-op; reject it (CodeRabbit #208).
        unsafe {
            std::env::set_var("INKSTONE_TITLE_TIMEOUT_MS", "0");
        }
        assert_eq!(title_timeout(), Duration::from_millis(15_000));

        unsafe {
            std::env::remove_var("INKSTONE_TITLE_TIMEOUT_MS");
        }
    }
}
