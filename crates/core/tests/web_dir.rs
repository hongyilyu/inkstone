//! Slice 2 RED test: Core serves the SPA from `INKSTONE_WEB_DIR` (debug-only).
//!
//! The harness (ADR-0019) builds `apps/web/dist/` and points Core at it via
//! `INKSTONE_WEB_DIR` so the browser loads the real Web Client from the same
//! Core it talks to (per ADR-0015's dev-serving path; production embeds the
//! bundle instead). When the env var is set in a debug build, Core serves:
//!   - `GET /`               → the dir's `index.html`
//!   - `GET /assets/<file>`  → built assets
//!   - `GET /<spa-route>`    → `index.html` (SPA client-side routing fallback)
//!   - `GET /ws`             → WebSocket upgrade (keeps precedence over fallback)
//!
//! Unset (or a release build) → the current bare `"Inkstone Core"` string, so
//! production cannot serve arbitrary files from disk.

use std::io::{BufRead, BufReader};
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

use assert_cmd::cargo::CommandCargoExt;
use tempfile::TempDir;

struct CoreChild(Option<Child>);

impl Drop for CoreChild {
    fn drop(&mut self) {
        if let Some(mut c) = self.0.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

/// Spawn Core with `INKSTONE_WEB_DIR` set to `web_dir`, on an ephemeral port,
/// and block on stdout until it announces its URL. Returns the reaped-on-drop
/// guard and the base `http://127.0.0.1:<port>` URL.
fn spawn_core_with_web_dir(db_path: &std::path::Path, web_dir: &std::path::Path) -> (CoreChild, String) {
    let mut child = std::process::Command::cargo_bin("core")
        .expect("core binary exists")
        .env("INKSTONE_DB_PATH", db_path)
        .env("INKSTONE_PORT", "0")
        .env("INKSTONE_WEB_DIR", web_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("core spawns");

    let stdout = child.stdout.take().expect("piped stdout");
    let mut reader = BufReader::new(stdout);
    let guard = CoreChild(Some(child));

    let deadline = Instant::now() + Duration::from_secs(5);
    let url = loop {
        if Instant::now() > deadline {
            panic!("timed out waiting for INKSTONE_LISTENING line");
        }
        let mut line = String::new();
        let read = reader.read_line(&mut line).expect("read stdout");
        if read == 0 {
            panic!("core stdout closed before announcing INKSTONE_LISTENING");
        }
        let trimmed = line.trim_end_matches('\n').trim_end_matches('\r');
        if let Some(rest) = trimmed.strip_prefix("INKSTONE_LISTENING ") {
            break rest.to_string();
        }
    };

    (guard, url)
}

#[test]
fn serves_spa_from_web_dir() {
    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");

    // A minimal on-disk "SPA": index.html with a recognizable marker + an asset.
    let web_dir = tmp.path().join("dist");
    std::fs::create_dir_all(web_dir.join("assets")).expect("mk assets dir");
    std::fs::write(
        web_dir.join("index.html"),
        "<!doctype html><title>Inkstone</title><body>SPA_MARKER_4842</body>",
    )
    .expect("write index.html");
    std::fs::write(web_dir.join("assets").join("app.js"), "console.log('hi')")
        .expect("write asset");

    let (_core, base) = spawn_core_with_web_dir(&db_path, &web_dir);

    // GET / → the on-disk index.html (NOT the bare "Inkstone Core" string).
    let root = reqwest::blocking::get(&base).expect("GET / succeeds");
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
    let ws_url = base
        .strip_prefix("http://")
        .map(|host| format!("ws://{host}/ws"))
        .expect("http:// prefix");
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    rt.block_on(async {
        tokio_tungstenite::connect_async(&ws_url)
            .await
            .expect("/ws still upgrades to a WebSocket");
    });
}
