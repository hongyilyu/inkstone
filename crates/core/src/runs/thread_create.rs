//! `thread/create` handler: message-first thread creation (ADR-0022).
//!
//! Validate the prompt, mint a NEW Thread (with a title derived from the
//! prompt) plus its first Run + user message in one transaction, create the
//! per-run hub, spawn the Worker into it, then frame the `{thread_id,
//! run_id}` response.
//!
//! Empty-prompt rejection (ADR-0002 — Core is the authority): if the prompt
//! is empty or whitespace-only (`trim().is_empty()`), respond with
//! `invalid_params` (-32602, ADR-0014) and RETURN before any DB write — zero
//! rows persisted. This guard runs BEFORE `persist_thread_with_first_run`.
//!
//! Pure-subscribe (ADR-0022): the response carries ONLY `{thread_id,
//! run_id}` — no Run Events ride the frame. The Client follows with
//! `run/subscribe(run_id)`. The hub is created BEFORE the Worker spawns so a
//! fast subscribe can never race a missing hub (same ordering as
//! `post_message`).

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;
use uuid::Uuid;

use super::reply::{send_error, send_invalid_params, send_response};
use crate::db;
use crate::dispatcher;
use crate::hub::{self, Hubs};
use crate::protocol::{ThreadCreateParams, ThreadCreateResult};
use crate::worker;

/// Max length of a Thread title derived from its first prompt. The title is
/// the trimmed prompt truncated to this many `char`s (counted by Unicode
/// scalar, not bytes, so the cut never splits a multi-byte character).
const TITLE_MAX_CHARS: usize = 80;

pub(super) async fn handle(
    pool: &SqlitePool,
    hubs: &Hubs,
    id: serde_json::Value,
    params: ThreadCreateParams,
    out_tx: &UnboundedSender<String>,
) {
    // Empty-prompt guard — runs BEFORE any persistence so a rejection writes
    // zero rows (ADR-0002: Core is the authority).
    let trimmed = params.prompt.trim();
    if trimmed.is_empty() {
        send_invalid_params(out_tx, id, "prompt must not be empty".to_string());
        return;
    }

    // Title derivation: the trimmed prompt, truncated to TITLE_MAX_CHARS
    // Unicode scalars (never empty here — the guard above rejected blanks).
    let title: String = trimmed.chars().take(TITLE_MAX_CHARS).collect();

    let now = db::now_ms();

    let thread_id = Uuid::now_v7();
    let run_id = Uuid::now_v7();
    let user_message_id = Uuid::now_v7();
    let assistant_message_id = Uuid::now_v7();

    // Dispatcher seam (ADR-0011): pick a Workflow for this Run, then resolve
    // its effective model/effort from user settings (ADR-0024).
    let base = dispatcher::dispatch(thread_id, &params.prompt);
    let workflow = dispatcher::resolve_effective_workflow(pool, base).await;

    if let Err(e) = db::persist_thread_with_first_run(
        pool,
        thread_id,
        run_id,
        user_message_id,
        assistant_message_id,
        &workflow,
        &params.prompt,
        &title,
        now,
    )
    .await
    {
        eprintln!("persist_thread_with_first_run failed: {e}");
        send_error(out_tx, id, format!("persist_thread_with_first_run: {e}"));
        return;
    }

    // Create the hub BEFORE spawning the Worker so a subscribe arriving the
    // instant after the response cannot find a missing hub.
    let run_hub = hub::create(hubs, run_id);

    worker::spawn(
        run_id,
        workflow,
        params.prompt,
        // A brand-new Thread has no prior exchange — empty history.
        Vec::new(),
        pool.clone(),
        assistant_message_id,
        hubs.clone(),
        run_hub.tx,
        run_hub.gate,
    );

    send_response(
        out_tx,
        id,
        serde_json::to_value(ThreadCreateResult {
            thread_id: thread_id.to_string(),
            run_id: run_id.to_string(),
        })
        .expect("ThreadCreateResult serializes"),
    );
}
