mod db;
mod dispatcher;
mod protocol;
mod runs;
mod worker;
mod workflow;

use anyhow::Result;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::{Router, routing::get};
use sqlx::SqlitePool;
use tokio::net::TcpListener;
use tokio::sync::mpsc;

use crate::protocol::{JsonRpcRequest, PostMessageParams};

#[derive(Clone)]
struct AppState {
    /// Tier-2 SQLite pool (ADR-0017). Threads, Runs, Messages, Run Steps,
    /// and Run Events are written here inside a single transaction with
    /// deferred FK enforcement.
    pool: SqlitePool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let pool = db::open().await?;
    let state = AppState { pool };

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
                            runs::handle_post_message(&state.pool, req.id, params, &out_tx).await;
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
