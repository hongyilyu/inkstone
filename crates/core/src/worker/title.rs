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
use tracing::Instrument;
use uuid::Uuid;

use crate::protocol::{WorkerManifest, WorkflowManifest};

use super::child::ChildWorker;
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
/// non-empty result — overwrites `threads.title`. Any pre-spawn or mid-stream
/// failure keeps the placeholder.
pub fn spawn_title_generation(
    thread_id: Uuid,
    prompt: String,
    provider: String,
    pool: SqlitePool,
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

            // Bespoke manifest (ADR-0046): empty tools, no Run descriptors, no
            // skills injection, thinking off.
            let manifest = WorkerManifest {
                run_id: corr_id,
                workflow: WorkflowManifest {
                    name: "title",
                    version: "1",
                    provider: &provider,
                    model,
                    system_prompt: TITLE_SYSTEM_PROMPT,
                    thinking_level: "off",
                    tools: vec![],
                },
                prompt: &prompt,
                messages: vec![],
                mode: None,
                access_token: Some(&token),
            };
            let manifest_line = serialize_manifest(&manifest);

            // Resolve the title-Worker launch command (ADR-0041 Titler role); a
            // resolution failure keeps the placeholder.
            let Ok(cmd) = crate::launch::resolve(crate::launch::Role::Titler) else {
                return;
            };

            // Spawn + collect. A spawn failure keeps the placeholder.
            let Ok(mut worker) =
                ChildWorker::spawn(corr_id, &cmd.program, &cmd.args, manifest_line).await
            else {
                return;
            };

            let mut acc = String::new();
            loop {
                match worker.recv().await {
                    Some(crate::protocol::WorkerStdout::TextDelta { delta }) => {
                        acc.push_str(&delta)
                    }
                    Some(crate::protocol::WorkerStdout::Done) => break,
                    // The titler has no tools and an explicit error is a failed
                    // turn: in both cases discard the partial output and keep the
                    // placeholder.
                    Some(crate::protocol::WorkerStdout::Error { .. })
                    | Some(crate::protocol::WorkerStdout::ToolRequest { .. }) => return,
                    // EOF without `done`: use whatever was accumulated.
                    None => break,
                }
            }
            // Drop stdin → EOF so the Worker exits; kill_on_drop reaps it.
            worker.shutdown().await;
            drop(worker);

            // Sanitize + persist. `None` (empty/whitespace after sanitizing)
            // keeps the placeholder.
            if let Some(title) = crate::runs::title::sanitize_title(&acc) {
                let _ = crate::db::update_thread_title(&pool, thread_id, &title).await;
            }
        }
        .instrument(span),
    );
}

/// Serialize a manifest to a newline-terminated NDJSON line, mirroring
/// [`super::serialize_manifest`]. Kept local to avoid widening the parent
/// module's surface.
fn serialize_manifest(manifest: &WorkerManifest<'_>) -> String {
    let mut line = serde_json::to_string(manifest).expect("WorkerManifest serializes");
    line.push('\n');
    line
}
