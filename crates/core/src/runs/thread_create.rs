//! `thread/create` handler: message-first thread creation (ADR-0022). Mint a
//! NEW Thread (title derived from the prompt) plus its first Run + user
//! message in one transaction, then frame `{thread_id, run_id}`.
//!
//! Empty/whitespace-only prompts are rejected with `invalid_params` BEFORE any
//! DB write — zero rows persisted (ADR-0014).
//!
//! Pure-subscribe (ADR-0022): the response carries ONLY `{thread_id, run_id}`;
//! the Client follows with `run/subscribe(run_id)`. Hub created before the
//! Worker spawns (same ordering as `post_message`).

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;
use uuid::Uuid;

use super::handler::{self, HandlerError};
use crate::db;
use crate::dispatcher;
use crate::hub::{self, Hubs};
use crate::protocol::{ThreadCreateParams, ThreadCreateResult};
use crate::worker;

use super::title;

pub(super) async fn handle(
    pool: &SqlitePool,
    hubs: &Hubs,
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    handler::handle(id, params, out_tx, |params: ThreadCreateParams| async move {
        // Empty-prompt guard — BEFORE any persistence so a rejection writes
        // zero rows (ADR-0002).
        let trimmed = params.prompt.trim();
        if trimmed.is_empty() {
            return Err(HandlerError::InvalidParams(
                "prompt must not be empty".to_string(),
            ));
        }

        // Fallback title: a word-boundary slug derived from the prompt (ADR-0048)
        // — a terse, legible name (≤ 32 scalars, last whole word, no ellipsis),
        // not the prompt dumped and cut mid-word. Never empty (the guard above
        // rejected blanks; an overlong single word is hard-cut). The titler
        // (ADR-0046) overwrites it with a generated title on success.
        let title = title::placeholder_title(trimmed);

        let now = db::now_ms();

        let thread_id = Uuid::now_v7();
        let run_id = Uuid::now_v7();
        let user_message_id = Uuid::now_v7();
        let assistant_message_id = Uuid::now_v7();

        // Pick a Workflow (ADR-0011) and resolve its effective model/effort from
        // user settings (ADR-0024) — one shared seam.
        let workflow = dispatcher::dispatch_and_resolve(pool, thread_id, &params.prompt).await;

        db::persist_thread_with_first_run(
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
        .map_err(|e| HandlerError::Internal(e.into()))?;

        // Create the hub BEFORE spawning the Worker so a subscribe arriving
        // right after the response can't find a missing hub.
        let run_hub = hub::create(hubs, run_id);

        // Fire the one-shot title Worker (ADR-0046) — fire-and-forget, so the
        // create RESPONSE never waits on it. Clone the prompt + provider because
        // both `params.prompt` and `workflow` are moved into the Run's
        // `worker::spawn` below. `out_tx.clone()` is this connection's outbound
        // channel: on a successful generation the titler frames a `thread/titled`
        // notification onto it (ADR-0047) so the creating tab's sidebar updates
        // live. With no credential, or empty/whitespace output, it silently keeps
        // the prompt-derived placeholder and pushes nothing.
        worker::spawn_title_generation(
            thread_id,
            params.prompt.clone(),
            workflow.provider.clone(),
            pool.clone(),
            out_tx.clone(),
        );

        worker::spawn(
            run_id,
            workflow,
            params.prompt,
            // A brand-new Thread has no prior exchange — empty history.
            Vec::new(),
            pool.clone(),
            assistant_message_id,
            hubs.clone(),
            run_hub,
        );

        Ok(ThreadCreateResult {
            thread_id: thread_id.to_string(),
            run_id: run_id.to_string(),
        })
    })
    .await;
}
