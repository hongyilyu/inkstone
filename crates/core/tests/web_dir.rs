//! Core serves the SPA from `INKSTONE_WEB_DIR` (debug-only; ADR-0015/ADR-0019).
//! When set in a debug build, Core serves:
//!   - `GET /`               → the dir's `index.html`
//!   - `GET /assets/<file>`  → built assets
//!   - `GET /<spa-route>`    → `index.html` (SPA client-side routing fallback)
//!   - `GET /ws`             → WebSocket upgrade (precedence over the fallback)
//!
//! Unset in debug → the bare `"Inkstone Core"` string. Release ignores the env
//! var and serves the embedded SPA, so production never serves files from disk.

mod common;
use common::Workspace;

#[test]
fn serves_spa_from_web_dir() {
    let workspace = Workspace::new();

    // A minimal on-disk "SPA": index.html with a recognizable marker + an asset.
    let web_dir = workspace.path().join("dist");
    std::fs::create_dir_all(web_dir.join("assets")).expect("mk assets dir");
    std::fs::write(
        web_dir.join("index.html"),
        "<!doctype html><title>Inkstone</title><body>SPA_MARKER_4842</body>",
    )
    .expect("write index.html");
    std::fs::write(web_dir.join("assets").join("app.js"), "console.log('hi')")
        .expect("write asset");

    let core = workspace.core().env("INKSTONE_WEB_DIR", &web_dir).spawn();
    let base = core.http_url();

    // GET / → the on-disk index.html (NOT the bare "Inkstone Core" string).
    let root = reqwest::blocking::get(base).expect("GET / succeeds");
    assert_eq!(root.status().as_u16(), 200, "GET / is 200");
    let root_body = root.text().expect("body decodes");
    assert!(
        root_body.contains("SPA_MARKER_4842"),
        "GET / serves the on-disk index.html — body: {root_body}"
    );

    // GET /assets/app.js → the built asset.
    let asset = reqwest::blocking::get(format!("{base}/assets/app.js")).expect("GET asset");
    assert_eq!(asset.status().as_u16(), 200, "asset is 200");
    assert!(
        asset.text().expect("asset body").contains("console.log"),
        "asset content served"
    );

    // GET /threads/abc → SPA fallback to index.html (client-side routing).
    let deep = reqwest::blocking::get(format!("{base}/threads/abc")).expect("GET deep link");
    assert_eq!(deep.status().as_u16(), 200, "SPA deep link is 200");
    assert!(
        deep.text().expect("deep body").contains("SPA_MARKER_4842"),
        "unknown route falls back to index.html"
    );

    // /ws must still upgrade — the fallback must not swallow the WebSocket route.
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    rt.block_on(async {
        core.connect().await;
    });
}
