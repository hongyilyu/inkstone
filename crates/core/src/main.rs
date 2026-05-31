mod db;
mod dispatcher;
mod protocol;
mod runs;
mod worker;
mod workflow;

use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::{Router, routing::get};
use sqlx::SqlitePool;
use tokio::net::TcpListener;
use tokio::sync::mpsc::{self, UnboundedSender};
use uuid::Uuid;

use crate::protocol::{JsonRpcRequest, JsonRpcResponse, PostMessageParams, PostMessageResult};
use crate::runs::{RunHandle, Runs};

#[derive(Clone)]
struct AppState {
    runs: Runs,
    /// Tier-2 SQLite pool (ADR-0017). Slice 2 begins writing Threads, Runs,
    /// Messages, Run Steps, and Run Events through this pool inside a single
    /// transaction with deferred FK enforcement.
    pool: SqlitePool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let pool = db::open().await?;
    let state = AppState {
        runs: Runs::default(),
        pool,
    };

    let app = Router::new()
        .route("/", get(|| async { "Inkstone Core" }))
        .route("/ws", get(ws_handler))
        .with_state(state);

    let addr = "127.0.0.1:8765";
    let listener = TcpListener::bind(addr).await?;
    println!("INKSTONE_LISTENING http://{addr}");

    axum::serve(listener, app).await?;
    Ok(())
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: WebSocket, state: AppState) {
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();

    // Single-task multiplex: race between an incoming WS frame and an
    // outbound frame on the per-connection channel. Response and
    // Notifications share the channel so frame order is preserved.
    loop {
        tokio::select! {
            biased;
            msg = socket.recv() => {
                let Some(Ok(msg)) = msg else { break };
                match msg {
                    Message::Text(t) => {
                        let Ok(req) = serde_json::from_str::<JsonRpcRequest>(&t) else {
                            continue;
                        };
                        if req.method == "run/post_message" {
                            let Ok(params) = serde_json::from_value::<PostMessageParams>(req.params)
                            else {
                                continue;
                            };
                            handle_post_message(&state, req.id, params, &out_tx).await;
                        }
                        // Other methods: drop silently for the skeleton.
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            outbound = out_rx.recv() => {
                let Some(s) = outbound else { break };
                if socket.send(Message::Text(s.into())).await.is_err() {
                    break;
                }
            }
        }
    }
}

async fn handle_post_message(
    state: &AppState,
    id: serde_json::Value,
    params: PostMessageParams,
    out_tx: &UnboundedSender<String>,
) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time before epoch")
        .as_millis() as i64;

    let thread_id = match db::ensure_default_thread(&state.pool, now).await {
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

    if let Err(e) = persist_initial_run(
        &state.pool,
        run_id,
        thread_id,
        user_message_id,
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

    state
        .runs
        .0
        .lock()
        .expect("runs mutex")
        .insert(run_id, RunHandle);

    // Spawn the Worker; the per-Run task forwards its NDJSON events as
    // `run/event` Notifications on the same per-connection sender.
    worker::spawn(
        run_id,
        workflow,
        params.prompt,
        out_tx.clone(),
        state.runs.clone(),
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

/// Single transaction with deferred FK enforcement. sqlx's `pool.begin()`
/// issues `BEGIN` (deferred by default in SQLite), so the FK cycle between
/// `runs.user_message_id` and `messages.run_id` resolves only at COMMIT.
async fn persist_initial_run(
    pool: &SqlitePool,
    run_id: Uuid,
    thread_id: Uuid,
    user_message_id: Uuid,
    workflow: &workflow::Workflow,
    prompt: &str,
    now_ms: i64,
) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;

    sqlx::query(
        "INSERT INTO runs \
         (id, thread_id, workflow_name, workflow_version, provider, model, \
          user_message_id, status, started_at) \
         VALUES (?, ?, ?, ?, 'echo', 'echo', ?, 'running', ?)",
    )
    .bind(run_id.to_string())
    .bind(thread_id.to_string())
    .bind(workflow.name)
    .bind(workflow.version.to_string())
    .bind(user_message_id.to_string())
    .bind(now_ms)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO messages \
         (id, thread_id, run_id, role, status, created_at, updated_at) \
         VALUES (?, ?, ?, 'user', 'completed', ?, ?)",
    )
    .bind(user_message_id.to_string())
    .bind(thread_id.to_string())
    .bind(run_id.to_string())
    .bind(now_ms)
    .bind(now_ms)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO message_parts (message_id, seq, type, text) \
         VALUES (?, 0, 'text', ?)",
    )
    .bind(user_message_id.to_string())
    .bind(prompt)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO run_steps \
         (run_id, seq, kind, message_id, tool_call_id, created_at) \
         VALUES (?, 0, 'message', ?, NULL, ?)",
    )
    .bind(run_id.to_string())
    .bind(user_message_id.to_string())
    .bind(now_ms)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO run_events (run_id, run_seq, kind, payload, created_at) \
         VALUES (?, 0, 'status', ?, ?)",
    )
    .bind(run_id.to_string())
    .bind(r#"{"status":"running"}"#)
    .bind(now_ms)
    .execute(&mut *tx)
    .await?;

    sqlx::query("UPDATE threads SET last_activity_at = ? WHERE id = ?")
        .bind(now_ms)
        .bind(thread_id.to_string())
        .execute(&mut *tx)
        .await?;

    tx.commit().await
}

fn send_error(out_tx: &UnboundedSender<String>, id: serde_json::Value, message: String) {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": -32603, "message": message },
    })
    .to_string();
    let _ = out_tx.send(body);
}
