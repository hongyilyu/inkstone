//! Slice 1 (models-settings, ADR-0024): `model/catalog` serves the embedded
//! `openai-codex` model catalog over the WebSocket. Read-only, no params.
//! Drives a real Core over the wire; the catalog content is drift-tested
//! against `pi-ai` in `packages/worker/src/models-catalog.test.ts`.

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

fn spawn_core(db_path: &Path) -> (CoreChild, String) {
    let mut child = std::process::Command::cargo_bin("core")
        .expect("core binary exists")
        .current_dir(repo_root())
        .env("INKSTONE_PORT", "0")
        .env("INKSTONE_DB_PATH", db_path)
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

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

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

#[test]
fn model_catalog_returns_openai_codex_models() {
    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");
    let (_child, ws_url) = spawn_core(&db_path);

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let (mut ws, _resp) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .expect("ws handshake");

        ws.send(Message::Text(
            r#"{"jsonrpc":"2.0","id":1,"method":"model/catalog","params":{}}"#.into(),
        ))
        .await
        .expect("send model/catalog");

        let body = next_text(&mut ws).await;
        let v: serde_json::Value = serde_json::from_str(&body).expect("model/catalog json");

        let providers = v["result"]["providers"]
            .as_array()
            .expect("providers array");
        let codex = providers
            .iter()
            .find(|p| p["id"] == serde_json::json!("openai-codex"))
            .expect("openai-codex provider present");

        let models = codex["models"].as_array().expect("models array");
        assert_eq!(models.len(), 10, "openai-codex ships 10 models");

        let gpt55 = models
            .iter()
            .find(|m| m["id"] == serde_json::json!("gpt-5.5"))
            .expect("gpt-5.5 present in catalog");
        assert_eq!(gpt55["name"], serde_json::json!("GPT-5.5"));
        assert_eq!(
            gpt55["reasoning"],
            serde_json::json!(true),
            "gpt-5.5 is reasoning-capable"
        );
        assert!(
            gpt55["cost_input"].is_number(),
            "cost_input is a bare number"
        );

        ws.close(None).await.ok();
    });
}
