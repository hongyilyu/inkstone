//! Slice 8 (real-worker-codex): `provider/login_start` orchestration
//! (ADR-0023, ADR-0014 amendment). Core spawns the Provider Helper in login
//! mode, relays its authorize URL to the Client, and — when the helper later
//! emits credentials (after the browser callback) — persists them as the
//! single writer. The Client learns the outcome by re-querying
//! `provider/status`. Driven offline by a stub login helper (no real :1455).

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

use assert_cmd::cargo::CommandCargoExt;
use futures_util::{SinkExt, StreamExt};
use tempfile::TempDir;
use tokio_tungstenite::tungstenite::Message;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("repo root resolves from <repo>/crates/core")
        .to_path_buf()
}

fn tsx() -> PathBuf {
    let p = repo_root().join("packages/worker/node_modules/.bin/tsx");
    if !p.exists() {
        panic!("worker tsx not installed — run `pnpm install`");
    }
    p
}

struct CoreChild(Option<Child>);
impl Drop for CoreChild {
    fn drop(&mut self) {
        if let Some(mut c) = self.0.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

fn spawn_core(db_path: &Path, creds_dir: &Path) -> (CoreChild, String) {
    let root = repo_root();
    let login_helper = root.join("crates/core/tests/fixtures/login-helper.ts");
    let login_cmd = format!("{} {} login", tsx().display(), login_helper.display());

    let mut child = std::process::Command::cargo_bin("core")
        .expect("core binary exists")
        .current_dir(&root)
        .env("INKSTONE_PORT", "0")
        .env("INKSTONE_DB_PATH", db_path)
        .env("INKSTONE_CREDENTIALS_DIR", creds_dir)
        .env("INKSTONE_PROVIDER_LOGIN_CMD", &login_cmd)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("core spawns");

    let stdout = child.stdout.take().expect("piped stdout");
    let mut reader = BufReader::new(stdout);
    let deadline = Instant::now() + Duration::from_secs(8);
    let http_url = loop {
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("timed out waiting for INKSTONE_LISTENING");
        }
        let mut line = String::new();
        let read = reader.read_line(&mut line).expect("read stdout");
        if read == 0 {
            let _ = child.kill();
            let _ = child.wait();
            panic!("core stdout closed before INKSTONE_LISTENING");
        }
        let trimmed = line.trim_end_matches('\n').trim_end_matches('\r');
        if let Some(rest) = trimmed.strip_prefix("INKSTONE_LISTENING ") {
            break rest.to_string();
        }
    };
    let ws_url = http_url
        .strip_prefix("http://")
        .map(|host| format!("ws://{host}/ws"))
        .expect("INKSTONE_LISTENING URL has http:// prefix");
    (CoreChild(Some(child)), ws_url)
}

type Ws = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

async fn next_text(ws: &mut Ws) -> String {
    let frame = tokio::time::timeout(Duration::from_secs(10), ws.next())
        .await
        .expect("frame within 10s")
        .expect("frame present")
        .expect("frame ok");
    match frame {
        Message::Text(t) => t.to_string(),
        other => panic!("expected text frame, got {other:?}"),
    }
}

async fn codex_connected(ws: &mut Ws, id: u64) -> bool {
    let req = format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"provider/status","params":{{}}}}"#);
    ws.send(Message::Text(req.into())).await.expect("send status");
    let body = next_text(ws).await;
    let v: serde_json::Value = serde_json::from_str(&body).expect("status json");
    v["result"]["providers"]
        .as_array()
        .expect("providers")
        .iter()
        .find(|p| p["id"] == serde_json::json!("openai-codex"))
        .expect("openai-codex present")["connected"]
        .as_bool()
        .expect("connected bool")
}

#[test]
fn login_start_returns_authorize_url_then_persists() {
    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");
    let creds_dir = tmp.path().join("credentials");

    let (_child, ws_url) = spawn_core(&db_path, &creds_dir);

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let (mut ws, _resp) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .expect("ws handshake");

        // Disconnected to start.
        assert!(!codex_connected(&mut ws, 1).await, "disconnected before login");

        // login_start → reply carries the stub helper's authorize URL.
        let req = r#"{"jsonrpc":"2.0","id":2,"method":"provider/login_start","params":{"provider":"openai-codex"}}"#;
        ws.send(Message::Text(req.into())).await.expect("send login_start");
        let body = next_text(&mut ws).await;
        let v: serde_json::Value = serde_json::from_str(&body).expect("login_start json");
        assert_eq!(
            v["result"]["authorize_url"].as_str(),
            Some("https://auth.openai.com/oauth/authorize?stub=1"),
            "login_start returns the helper's authorize URL — body: {body}"
        );

        // The helper emits credentials ~100ms later; Core persists them. Poll
        // provider/status until it flips to connected (bounded).
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut connected = false;
        let mut id = 3;
        while Instant::now() < deadline {
            if codex_connected(&mut ws, id).await {
                connected = true;
                break;
            }
            id += 1;
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(connected, "provider/status flips to connected after the helper persists");

        ws.close(None).await.ok();
    });

    // The persisted credential is the one the login helper produced, 0600.
    let persisted: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(creds_dir.join("openai-codex.json")).expect("read persisted"),
    )
    .expect("persisted json");
    assert_eq!(persisted["access"], serde_json::json!("logged-in-access"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(creds_dir.join("openai-codex.json"))
            .expect("stat")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "persisted credential is 0600");
    }
}
