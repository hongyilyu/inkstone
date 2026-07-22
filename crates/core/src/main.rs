mod cancel;
mod config;
mod credentials;
mod db;
mod decide;
mod dispatcher;
mod entities;
mod field_spec;
mod hub;
mod launch;
mod localtime;
mod logging;
mod models;
mod mutate;
mod mutation;
mod mutation_target;
mod observations;
mod protocol;
mod provider_auth;
mod providers;
mod recurrence;
mod resume;
mod runs;
mod settings;
mod skills;
mod start_run;
mod tools;
#[cfg(not(debug_assertions))]
mod web_embed;
mod worker;
mod workflow;

use anyhow::Result;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::{Router, routing::get};
use sqlx::SqlitePool;
use std::net::IpAddr;
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
    // Resolve all INKSTONE_* env knobs once and freeze them in a process-global
    // Config. Modules read the struct, not the env — tests inject values
    // directly without env mutation. Must run before `logging::init`:
    // `resolve_log_dir()` reads `config::get()`, which panics pre-init.
    config::init(config::Config::from_env());

    // Initialize the Diagnostic Log subscriber next (ADR-0038) — only config
    // resolution, which it depends on, precedes it — so even
    // `workflow::init`/`db::open` faults are captured on the trail. Fail-OPEN:
    // observability is not an availability dependency — an unwritable log dir
    // must not abort Core boot (mirrors the worker-spawn sink, which also
    // degrades silently). Worst case the trail is absent; the process serves.
    if let Err(e) = logging::init() {
        eprintln!("INKSTONE_LOG_INIT_FAILED {e:#}");
    }

    // Validate the Workflow(s) before serving: a malformed default.toml aborts
    // boot (fail-fast, ADR-0018) rather than failing the first Run.
    workflow::init()?;

    let pool = db::open().await?;

    // Seed the bundled example Skills into the Core-managed skills dir on first
    // run (ADR-0036), so the feature is live on a fresh install. Best-effort and
    // only when the dir is absent — an existing dir is the user's (drop-in
    // ownership), so edits and deletes survive and we never re-seed. A failure is
    // logged inside, never fatal: worst case the install ships no skills until one
    // is dropped in.
    skills::seed_if_absent();

    // Boot recovery sweep (ADR-0012): error any Run left `running` by a prior
    // Core crash — it has no live Worker. Preserves `parked` Runs (ADR-0025).
    let recovered = db::recover_interrupted_runs(&pool, db::now_ms()).await?;
    if recovered > 0 {
        // The `INKSTONE_RECOVERED` marker stays raw (ADR-0038 keeps the boot
        // markers verbatim); the structured milestone is emitted alongside it.
        tracing::info!(event = "core.runs_recovered", count = recovered);
        println!("INKSTONE_RECOVERED {recovered} interrupted run(s) errored as core_restarted");
    }

    let state = AppState {
        pool,
        hubs: hub::new_hubs(),
    };

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/media/{id}", get(media_handler))
        .with_state(state);

    // SPA serving (ADR-0015 / ADR-0019). In debug builds with `INKSTONE_WEB_DIR`
    // set, serve the built Web Client from that dir: assets directly, other
    // non-`/ws` paths fall back to `index.html` for the client-side router.
    // Debug without the env var → the bare liveness string the tests assert
    // against. Release builds serve the SPA embedded at compile time (ADR-0015);
    // the env var stays ignored (never serve arbitrary files from disk).
    let app = match web_dir_for_serving() {
        Some(dir) => {
            let index = dir.join("index.html");
            let serve_dir = ServeDir::new(&dir).fallback(ServeFile::new(index));
            app.fallback_service(serve_dir)
        }
        None => {
            #[cfg(debug_assertions)]
            let app = app.route("/", get(|| async { "Inkstone Core" }));
            // GET/HEAD-only, so other methods 405 like the debug ServeDir path.
            #[cfg(not(debug_assertions))]
            let app = app.fallback_service(get(web_embed::serve_embedded));
            app
        }
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
    // Diagnostic Log boot milestone (ADR-0038), emitted BEFORE the stdout marker
    // so the blocking appender has it on disk before any observer of the marker
    // can act (the test harness unblocks on the marker, then may SIGKILL at
    // once). Distinct from the marker below (the harness's liveness contract,
    // NOT migrated into tracing). Variable data (`addr`) is a field, not message.
    tracing::info!(event = "core.listening", addr = %local_addr);
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

async fn ws_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !websocket_origin_allowed(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, state))
        .into_response()
}

fn websocket_origin_allowed(headers: &HeaderMap) -> bool {
    let mut origins = headers.get_all(header::ORIGIN).iter();
    let Some(origin) = origins.next() else {
        return true;
    };
    if origins.next().is_some() {
        return false;
    }
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    let Ok(uri) = origin.parse::<Uri>() else {
        return false;
    };
    let Some(scheme) = uri.scheme_str() else {
        return false;
    };
    if scheme != "http" && scheme != "https" {
        return false;
    }
    let Some(authority) = uri.authority() else {
        return false;
    };
    if authority.as_str().contains('@')
        || origin.len() != scheme.len() + 3 + authority.as_str().len()
    {
        return false;
    }

    if scheme == "https" && config::get().public_origin.as_deref() == Some(origin) {
        return true;
    }

    let Some(host) = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    scheme == "http"
        && authority.as_str().eq_ignore_ascii_case(host)
        && (authority.host().eq_ignore_ascii_case("localhost")
            || authority
                .host()
                .parse::<IpAddr>()
                .is_ok_and(|ip| ip.is_loopback()))
}

/// `GET /media/{id}` (ADR-0058): serve a stored media blob's bytes with the
/// stored `mime` as Content-Type. Unknown id → 404; a row whose bytes are gone
/// from disk (or whose stored path escapes the media root) is ALSO a 404 — but
/// loud, per ADR-0058 ("a row pointing at missing bytes is a loud read error").
/// `db::resolve_media_path` is the trust boundary turning the stored relative
/// path into a real filesystem path.
async fn media_handler(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let row = match db::get_media(&state.pool, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            tracing::error!(event = "media.read_failed", media_id = %id, error = ?e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let path = match db::resolve_media_path(&row.storage_path) {
        Ok(path) => path,
        Err(e) => {
            tracing::error!(event = "media.read_failed", media_id = %id, error = ?e);
            return StatusCode::NOT_FOUND.into_response();
        }
    };
    match tokio::fs::read(&path).await {
        // `nosniff` pins the response to the stored mime: without it a browser
        // may sniff crafted image bytes into text/html and execute them as a
        // stored XSS. `Content-Disposition` closes the other half: a stored
        // active-content mime (e.g. text/html) navigated directly would
        // otherwise execute on the app origin, so anything non-`image/*`
        // downloads (`attachment`) instead of rendering (`inline`). Both are
        // response-header policy, not validation — the mime itself stays
        // unvalidated (ADR-0058: Core stores, never sniffs or allowlists).
        Ok(bytes) => {
            let disposition = if row.mime.starts_with("image/") {
                "inline"
            } else {
                "attachment"
            };
            (
                [
                    (header::CONTENT_TYPE, row.mime),
                    (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_string()),
                    (header::CONTENT_DISPOSITION, disposition.to_string()),
                ],
                bytes,
            )
                .into_response()
        }
        Err(e) => {
            tracing::error!(event = "media.read_failed", media_id = %id, error = ?e);
            StatusCode::NOT_FOUND.into_response()
        }
    }
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
                let Some(Ok(msg)) = msg else {
                    // recv closed or errored: a normal client disconnect is not a
                    // fault, so this stays low-severity (ADR-0038 level discipline).
                    tracing::debug!(event = "core.ws_recv_closed");
                    break;
                };
                match msg {
                    Message::Text(t) => {
                        let Ok(req) = serde_json::from_str::<JsonRpcRequest>(&t) else {
                            // A malformed frame is tolerated (we drop it and keep
                            // serving), so WARN, not ERROR. The bad text rides as a
                            // BOUNDED preview field, never interpolated into the
                            // message (ADR-0038).
                            tracing::warn!(
                                event = "core.jsonrpc_parse_failed",
                                preview = %t.chars().take(200).collect::<String>(),
                            );
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
                    tracing::warn!(event = "core.ws_send_failed");
                    break;
                }
            }
        }
    }
}
