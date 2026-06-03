//! `run/post_message` handler.
//!
//! Add a message (and a new Run) to an EXISTING Thread (ADR-0022 —
//! `post_message` is existing-thread-only; `thread_id` is required and never
//! optional). Parse `thread_id`, verify the Thread exists, pick a Workflow,
//! write the initial Run rows in one transaction, create the per-run hub,
//! spawn the Worker publishing into it, then frame the JSON-RPC response.
//!
//! Validation (ADR-0002: Core is the authority; ADR-0014 error codes):
//! - A malformed `thread_id` (not a UUID) → `invalid_params` (-32602).
//! - A well-formed `thread_id` for a Thread that does not exist →
//!   `unknown_thread` (-32001) and ZERO rows written.
//!
//! Pure-subscribe (ADR-0022): the response carries ONLY `{run_id}` — no Run
//! Events ride the response frame. The Client receives events by following
//! with `run/subscribe(run_id)`, exactly like a reconnecting tab. The hub
//! entry is created BEFORE the Worker spawns so a fast subscribe can never
//! race a missing hub.

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;
use uuid::Uuid;

use super::reply::{send_error, send_invalid_params, send_response, send_unknown_thread};
use crate::db;
use crate::dispatcher;
use crate::hub::{self, Hubs};
use crate::protocol::{PostMessageParams, PostMessageResult};
use crate::worker;

pub(super) async fn handle(
    pool: &SqlitePool,
    hubs: &Hubs,
    id: serde_json::Value,
    params: PostMessageParams,
    out_tx: &UnboundedSender<String>,
) {
    // Parse the thread_id; a malformed id is a client error (invalid_params).
    let Ok(thread_id) = Uuid::parse_str(&params.thread_id) else {
        send_invalid_params(
            out_tx,
            id,
            format!("invalid thread_id {:?}", params.thread_id),
        );
        return;
    };

    // Existing-thread-only (ADR-0022): a well-formed but unknown thread_id is
    // rejected with unknown_thread BEFORE any persistence — zero rows written.
    match db::thread_exists(pool, thread_id).await {
        Ok(true) => {}
        Ok(false) => {
            send_unknown_thread(out_tx, id, format!("unknown thread_id {thread_id}"));
            return;
        }
        Err(e) => {
            eprintln!("thread_exists check failed: {e}");
            send_error(out_tx, id, format!("thread_exists: {e}"));
            return;
        }
    }

    let now = db::now_ms();

    // Dispatcher seam (ADR-0011): pick a Workflow for this Run.
    let workflow = dispatcher::dispatch(thread_id, &params.prompt);

    let run_id = Uuid::now_v7();
    let user_message_id = Uuid::now_v7();
    let assistant_message_id = Uuid::now_v7();

    if let Err(e) = db::persist_initial_run(
        pool,
        run_id,
        thread_id,
        user_message_id,
        assistant_message_id,
        workflow,
        &params.prompt,
        now,
    )
    .await
    {
        eprintln!("persist_initial_run failed: {e}");
        send_error(out_tx, id, format!("persist_initial_run: {e}"));
        return;
    }

    // Create the hub BEFORE spawning the Worker so a subscribe arriving the
    // instant after the response cannot find a missing hub for a Run that is
    // about to stream.
    let run_hub = hub::create(hubs, run_id);

    // Assemble the prior-Run conversation history for this Thread (ADR-0018
    // multi-turn). Excludes the Run just persisted above, so the Worker sees
    // the prior exchange but not the current prompt twice. A read failure is
    // non-fatal: fall back to no history rather than failing the Run.
    let history = db::history_for_run(pool, thread_id, run_id)
        .await
        .unwrap_or_else(|e| {
            eprintln!("history_for_run failed for run {run_id}: {e}");
            Vec::new()
        });

    // Spawn the Worker wired to publish into the hub (broadcast sender +
    // per-run gate). It removes the hub entry after its terminal tx.
    worker::spawn(
        run_id,
        workflow,
        params.prompt,
        history,
        pool.clone(),
        assistant_message_id,
        hubs.clone(),
        run_hub.tx,
        run_hub.gate,
    );

    send_response(
        out_tx,
        id,
        serde_json::to_value(PostMessageResult {
            run_id: run_id.to_string(),
        })
        .expect("PostMessageResult serializes"),
    );
}
