//! Run lifecycle entry — `run/post_message` handler and the JSON-RPC error
//! envelope helper. Pure orchestration: route the request to `db::*`
//! writers, spawn the Worker, frame the response. The actual SQL is in
//! [`crate::db`]; the actual Worker process management is in
//! [`crate::worker`].

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;
use uuid::Uuid;

use crate::db;
use crate::dispatcher;
use crate::protocol::{JsonRpcResponse, PostMessageParams, PostMessageResult};
use crate::worker;

/// Handle a `run/post_message` request: lazy-mint the default Thread,
/// pick a Workflow, write the initial Run rows in one transaction, spawn
/// the Worker, then frame the JSON-RPC response on `out_tx`. The Worker's
/// stdout is forwarded back over the same `out_tx` as `run/event`
/// Notifications.
pub async fn handle_post_message(
    pool: &SqlitePool,
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

    // Spawn the Worker; the per-Run task forwards its NDJSON events as
    // `run/event` Notifications on the same per-connection sender. The
    // pool + assistant_message_id let the forwarder append each
    // `text_delta` to the assistant `message_parts.text` row that
    // `persist_initial_run` pre-inserted at `seq=0` before forwarding
    // the WS frame (ADR-0017).
    worker::spawn(
        run_id,
        workflow,
        params.prompt,
        pool.clone(),
        assistant_message_id,
        out_tx.clone(),
    );

    let response = JsonRpcResponse {
        jsonrpc: "2.0",
        id,
        result: serde_json::to_value(PostMessageResult {
            run_id: run_id.to_string(),
        })
        .expect("PostMessageResult serializes"),
    };
    let body = serde_json::to_string(&response).expect("JsonRpcResponse always serializes");
    let _ = out_tx.send(body);
}

/// Frame a JSON-RPC 2.0 error envelope and queue it on the per-connection
/// channel. `-32603` is the JSON-RPC reserved "internal error" code per
/// ADR-0014.
pub(crate) fn send_error(
    out_tx: &UnboundedSender<String>,
    id: serde_json::Value,
    message: String,
) {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": -32603, "message": message },
    })
    .to_string();
    let _ = out_tx.send(body);
}
