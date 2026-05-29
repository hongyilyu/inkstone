mod dispatcher;
mod protocol;
mod runs;
mod workflow;

use std::sync::{Arc, Mutex};

use anyhow::Result;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::{Router, routing::get};
use tokio::net::TcpListener;
use uuid::Uuid;

use crate::protocol::{JsonRpcRequest, JsonRpcResponse, PostMessageParams, PostMessageResult};
use crate::runs::{RunHandle, Runs};

#[derive(Clone, Default)]
struct AppState {
    runs: Runs,
    /// Implicit ephemeral Thread for the skeleton: lazy-minted on the first
    /// `run/post_message` and reused for every subsequent Run on this Core
    /// process. Real Thread CRUD lands in a future feature.
    thread_id: Arc<Mutex<Option<Uuid>>>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let state = AppState::default();

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
    while let Some(Ok(msg)) = socket.recv().await {
        match msg {
            Message::Text(t) => {
                let Ok(req) = serde_json::from_str::<JsonRpcRequest>(&t) else {
                    // Malformed JSON-RPC frames are dropped silently for the skeleton.
                    continue;
                };
                if req.method == "run/post_message" {
                    let Ok(params) = serde_json::from_value::<PostMessageParams>(req.params)
                    else {
                        continue;
                    };
                    let response = handle_post_message(&state, req.id, params);
                    let body = serde_json::to_string(&response)
                        .expect("JsonRpcResponse always serializes");
                    if socket.send(Message::Text(body.into())).await.is_err() {
                        break;
                    }
                }
                // Other methods: drop silently for the skeleton.
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
}

fn handle_post_message(
    state: &AppState,
    id: serde_json::Value,
    params: PostMessageParams,
) -> JsonRpcResponse {
    let thread_id = {
        let mut guard = state.thread_id.lock().expect("thread_id mutex");
        *guard.get_or_insert_with(Uuid::now_v7)
    };

    // Dispatcher seam: pick a Workflow for this Run. Result is bound but
    // unused this slice — slice 7 hands it to the Worker spawn.
    let _workflow = dispatcher::dispatch(thread_id, &params.prompt);

    let run_id = Uuid::now_v7();
    state
        .runs
        .0
        .lock()
        .expect("runs mutex")
        .insert(run_id, RunHandle);

    let result = PostMessageResult {
        run_id: run_id.to_string(),
    };
    JsonRpcResponse {
        jsonrpc: "2.0",
        id,
        result: serde_json::to_value(result).expect("PostMessageResult serializes"),
    }
}
