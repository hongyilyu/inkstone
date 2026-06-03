mod credentials;
mod db;
mod dispatcher;
mod hub;
mod protocol;
mod provider_auth;
mod runs;
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
    /// Tier-2 SQLite pool (ADR-0017). Threads, Runs, Messages, Run Steps,
    /// and Run Events are written here inside a single transaction with
    /// deferred FK enforcement.
    pool: SqlitePool,
    /// Per-run event hubs (ADR-0022). `run_id → RunHub`; the Worker
    /// publishes Run Events into the hub and `run/subscribe` attaches to
    /// it. Shared across all connections so a Run's live stream outlives
    /// the socket that started it.
    hubs: Hubs,
}

#[tokio::main]
async fn main() -> Result<()> {
    // Load and validate the Workflow(s) before serving — a malformed
    // default.toml or an invalid thinking_level aborts boot (fail-fast,
    // ADR-0018) rather than failing the first Run.
    workflow::init()?;

    let pool = db::open().await?;
    let state = AppState {
        pool,
        hubs: hub::new_hubs(),
    };

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .with_state(state);

    // SPA serving (ADR-0015 dev path / ADR-0019 harness). When
    // `INKSTONE_WEB_DIR` is set AND this is a debug build, serve the built Web
    // Client from that directory: assets directly, every other non-`/ws` path
    // falls back to `index.html` so the SPA's client-side router can take over.
    // Release builds ignore the env var entirely, so a production binary can
    // never serve arbitrary files from disk (production embeds the bundle
    // instead — a future feature). With no web dir, `/` is the bare liveness
    // string the integration tests assert against.
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
    // `0` asks the OS for an ephemeral port so the test harness can spawn one
    // fresh Core per test without collisions; the *resolved* port is read back
    // from the bound listener and announced, never the literal 0.
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

/// The directory to serve the SPA from, or `None` to serve the liveness
/// string. Reads `INKSTONE_WEB_DIR`, but only honors it in debug builds — a
/// release binary always returns `None` so it cannot serve files from disk.
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
