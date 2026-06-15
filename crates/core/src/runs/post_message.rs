//! `run/post_message` handler: add a message (and a new Run) to an EXISTING
//! Thread (ADR-0022 — `thread_id` is required, never optional).
//!
//! Validation (ADR-0014): a malformed `thread_id` → `invalid_params`; a
//! well-formed but unknown one → `unknown_thread` with zero rows written.
//!
//! Pure-subscribe (ADR-0022): the response carries ONLY `{run_id}` — the
//! Client gets events by following with `run/subscribe(run_id)`. The hub is
//! created BEFORE the Worker spawns so a fast subscribe can't race a missing hub.

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;
use uuid::Uuid;

use super::handler::{self, HandlerError};
use crate::db;
use crate::dispatcher;
use crate::hub::{self, Hubs};
use crate::protocol::{PostMessageParams, PostMessageResult};
use crate::worker;

pub(super) async fn handle(
    pool: &SqlitePool,
    hubs: &Hubs,
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    handler::handle(id, params, out_tx, |params: PostMessageParams| async move {
        let thread_id = params.thread_id;

        // A well-formed but unknown thread_id is rejected BEFORE any
        // persistence — zero rows (ADR-0022).
        if !db::thread_exists(pool, thread_id)
            .await
            .map_err(|e| HandlerError::Internal(e.into()))?
        {
            return Err(HandlerError::UnknownThread(thread_id));
        }

        let now = db::now_ms();

        // Pick a Workflow (ADR-0011) and resolve its effective model/effort from
        // user settings (ADR-0024) — one shared seam.
        let workflow = dispatcher::dispatch_and_resolve(pool, thread_id, &params.prompt).await;

        let run_id = Uuid::now_v7();
        let user_message_id = Uuid::now_v7();
        let assistant_message_id = Uuid::now_v7();

        db::persist_initial_run(
            pool,
            run_id,
            thread_id,
            user_message_id,
            assistant_message_id,
            &workflow,
            &params.prompt,
            now,
        )
        .await
        .map_err(|e| HandlerError::Internal(e.into()))?;

        // Create the hub BEFORE spawning the Worker so a subscribe arriving
        // right after the response can't find a missing hub.
        let run_hub = hub::create(hubs, run_id);

        // Prior-Run conversation history (ADR-0018), excluding the Run just
        // persisted. A read failure is non-fatal: fall back to no history.
        let history = db::history_for_run(pool, thread_id, run_id)
            .await
            .unwrap_or_else(|e| {
                eprintln!("history_for_run failed for run {run_id}: {e}");
                Vec::new()
            });

        // Spawn the Worker wired to publish into the hub; it removes the hub
        // entry after its terminal tx.
        worker::spawn(
            run_id,
            workflow,
            params.prompt,
            history,
            pool.clone(),
            assistant_message_id,
            hubs.clone(),
            run_hub,
        );

        Ok(PostMessageResult {
            run_id: run_id.to_string(),
        })
    })
    .await;
}
