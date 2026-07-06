//! Embedded SPA serving for release builds (ADR-0015). The built Web Client
//! (`apps/web/dist/`) is compiled into the binary via `rust-embed` and served
//! from the same listener as the WebSocket: `/` → embedded `index.html`,
//! `/assets/*` → embedded asset with its guessed content-type, any other path
//! → embedded `index.html` so deep links reach the client-side router.
//!
//! The derive requires `apps/web/dist/` to exist at compile time, so any
//! release-profile cargo command fails without a prior `pnpm -C apps/web build`
//! — that ordering is what `pnpm build:release` encodes. `#[folder]` resolves
//! against `CARGO_MANIFEST_DIR` (same trick as `workflow.rs::default_dir`).
//! Files ADDED to dist after a cargo build may not retrigger the cached derive
//! expansion — `touch` this file if a stale embed is suspected.

use axum::body::Body;
use axum::http::{StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../../apps/web/dist/"]
struct WebAssets;

pub async fn serve_embedded(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    let file = WebAssets::get(path).or_else(|| WebAssets::get("index.html"));
    match file {
        Some(f) => {
            let mime = f.metadata.mimetype().to_string();
            ([(header::CONTENT_TYPE, mime)], Body::from(f.data.into_owned())).into_response()
        }
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}
