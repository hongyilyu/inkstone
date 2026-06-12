mod credentials;
mod db;
mod decide;
mod dispatcher;
mod entities;
mod hub;
mod models;
mod protocol;
mod provider_auth;
mod resume;
mod runs;
mod settings;
mod tools;
mod worker;
mod workflow;

use anyhow::Result;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::{Router, routing::get};
use sqlx::SqlitePool;
use std::path::PathBuf;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tower_http::services::{ServeDir, ServeFile};

use crate::hub::Hubs;
use crate::protocol::JsonRpcRequest;

#[derive(Clone)]
struct AppState {
    /// Tier-2 SQLite pool (ADR-0017).
    pool: SqlitePool,
    /// Per-run event hubs (ADR-0022): `run_id → RunHub`, shared across all
    /// connections so a Run's live stream outlives the socket that started it.
    hubs: Hubs,
}

#[tokio::main]
async fn main() -> Result<()> {
    // Validate the Workflow(s) before serving: a malformed default.toml aborts
    // boot (fail-fast, ADR-0018) rather than failing the first Run.
    workflow::init()?;

    let pool = db::open().await?;

    // Boot recovery sweep (ADR-0012): error any Run left `running` by a prior
    // Core crash — it has no live Worker. Preserves `parked` Runs (ADR-0025).
    let recovered = db::recover_interrupted_runs(&pool, db::now_ms()).await?;
    if recovered > 0 {
        println!("INKSTONE_RECOVERED {recovered} interrupted run(s) errored as core_restarted");
    }

    let state = AppState {
        pool,
        hubs: hub::new_hubs(),
    };

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .with_state(state);

    // SPA serving (ADR-0015 / ADR-0019). In debug builds with `INKSTONE_WEB_DIR`
    // set, serve the built Web Client from that dir: assets directly, other
    // non-`/ws` paths fall back to `index.html` for the client-side router.
    // Release builds ignore the env var (never serve arbitrary files from disk).
    // With no web dir, `/` is the bare liveness string the tests assert against.
    let app = match web_dir_for_serving() {
        Some(dir) => {
            let index = dir.join("index.html");
            let serve_dir =
                ServeDir::new(&dir).fallback(ServeFile::new(index));
            app.fallback_service(serve_dir)
        }
        None => app.route("/", get(|| async { "Inkstone Core" })),
    };

    // Port resolution (ADR-0019): `INKSTONE_PORT` overrides the default 8765.
    // `0` asks the OS for an ephemeral port (per-test isolation); the resolved
    // port is read back from the listener and announced, never the literal 0.
    let port: u16 = std::env::var("INKSTONE_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8765);
    let listener = TcpListener::bind(("127.0.0.1", port)).await?;
    let local_addr = listener.local_addr()?;
    println!("INKSTONE_LISTENING http://{local_addr}");

    axum::serve(listener, app).await?;
    Ok(())
}

/// The directory to serve the SPA from, or `None` to serve the liveness string.
/// Reads `INKSTONE_WEB_DIR` but honors it only in debug builds, so a release
/// binary never serves files from disk.
fn web_dir_for_serving() -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var_os("INKSTONE_WEB_DIR")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: WebSocket, state: AppState) {
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();

    // Single-task multiplex: race an incoming WS frame against an outbound frame
    // on the per-connection channel. Responses and Notifications share the
    // channel so frame order is preserved.
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
                        runs::dispatch(&state.pool, &state.hubs, req, &out_tx).await;
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
