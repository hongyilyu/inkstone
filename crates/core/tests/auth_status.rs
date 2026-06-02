//! Slice 6 (real-worker-codex): the Credential Store + `auth/status`
//! (ADR-0023). `auth/status` reports `openai-codex` disconnected when no
//! credential file exists and connected once one does. Drives Core over the
//! WebSocket with a per-test `INKSTONE_CREDENTIALS_DIR`. (The store's own
//! `write()` 0600/0700 behavior is unit-tested in `credentials.rs`; here the
//! test writes the fixture file directly to drive the status read.)

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

struct CoreChild(Option<Child>);
impl Drop for CoreChild {
    fn drop(&mut self) {
        if let Some(mut c) = self.0.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

fn spawn_core(db_path: &Path, credentials_dir: &Path) -> (CoreChild, String) {
    let mut child = std::process::Command::cargo_bin("core")
        .expect("core binary exists")
        .current_dir(repo_root())
        .env("INKSTONE_PORT", "0")
        .env("INKSTONE_DB_PATH", db_path)
        .env("INKSTONE_CREDENTIALS_DIR", credentials_dir)
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
            panic!("core stdout closed before announcing INKSTONE_LISTENING");
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
    let frame = tokio::time::timeout(Duration::from_secs(5), ws.next())
        .await
        .expect("frame within 5s")
        .expect("frame present")
        .expect("frame ok");
    match frame {
        Message::Text(t) => t.to_string(),
        other => panic!("expected text frame, got {other:?}"),
    }
}

/// Send `auth/status` and return the `openai-codex` connected flag.
async fn codex_connected(ws: &mut Ws, id: u64) -> bool {
    let req = format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"auth/status","params":{{}}}}"#);
    ws.send(Message::Text(req.into()))
        .await
        .expect("send auth/status");
    let body = next_text(ws).await;
    let v: serde_json::Value = serde_json::from_str(&body).expect("auth/status json");
    let providers = v["result"]["providers"].as_array().expect("providers array");
    let codex = providers
        .iter()
        .find(|p| p["id"] == serde_json::json!("openai-codex"))
        .expect("openai-codex present in providers");
    codex["connected"].as_bool().expect("connected is a bool")
}

#[test]
fn auth_status_reflects_credential_presence() {
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

        // No credential file yet → disconnected.
        assert!(
            !codex_connected(&mut ws, 1).await,
            "openai-codex must be disconnected before any credential is written"
        );

        // Write a valid credential file (simulating a completed login; the
        // login/refresh path that actually writes this lands in slice 7).
        std::fs::create_dir_all(&creds_dir).expect("create creds dir");
        let cred_path = creds_dir.join("openai-codex.json");
        std::fs::write(
            &cred_path,
            r#"{"access":"tok_access","refresh":"tok_refresh","expires":9999999999999,"account_id":"acct_1"}"#,
        )
        .expect("write credential file");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&cred_path, std::fs::Permissions::from_mode(0o600))
                .expect("chmod 0600");
        }

        // Now → connected.
        assert!(
            codex_connected(&mut ws, 2).await,
            "openai-codex must be connected once a credential file exists"
        );

        ws.close(None).await.ok();
    });
}
