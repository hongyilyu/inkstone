//! `run/post_message` handler.
//!
//! Lazy-mint the default Thread, pick a Workflow, write the initial Run rows
//! in one transaction, create the per-run hub, spawn the Worker publishing
//! into it, then frame the JSON-RPC response.
//!
//! Pure-subscribe (ADR-0022): the response carries ONLY `{run_id}` — no Run
//! Events ride the response frame. The Client receives events by following
//! with `run/subscribe(run_id)`, exactly like a reconnecting tab. The hub
//! entry is created BEFORE the Worker spawns so a fast subscribe can never
//! race a missing hub.

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;
use uuid::Uuid;

use super::reply::{send_error, send_response};
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
    let now = db::now_ms();

    let thread_id = match db::ensure_default_thread(pool, now).await {
        Ok(tid) => tid,
        Err(e) => {
            eprintln!("ensure_default_thread failed: {e}");
            send_error(out_tx, id, format!("ensure_default_thread: {e}"));
            return;
        }
    };

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

    // Spawn the Worker wired to publish into the hub (broadcast sender +
    // per-run gate). It removes the hub entry after its terminal tx.
    worker::spawn(
        run_id,
        workflow,
        params.prompt,
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
