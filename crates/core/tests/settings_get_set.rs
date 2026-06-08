//! Slice 2 (models-settings, ADR-0024): `settings/get` + `settings/set`.
//! The user's preferred model and global effort persist in tier-2 and round-
//! trip over the wire; an unknown model or invalid effort is rejected with
//! `invalid_params` (-32602) and writes nothing. Drives a real Core.

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

type Ws = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

async fn request(ws: &mut Ws, id: u64, method: &str, params: serde_json::Value) -> serde_json::Value {
    let req = serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    ws.send(Message::Text(req.to_string().into()))
        .await
        .expect("send request");
    let frame = tokio::time::timeout(Duration::from_secs(5), ws.next())
        .await
        .expect("frame within 5s")
        .expect("frame present")
        .expect("frame ok");
    match frame {
        Message::Text(t) => serde_json::from_str(&t).expect("json response"),
        other => panic!("expected text frame, got {other:?}"),
    }
}

#[test]
fn settings_get_set_round_trips_and_validates() {
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

        // Defaults before any set: no model chosen, effort "off", provider is
        // the default Workflow's (openai-codex).
        let got = request(&mut ws, 1, "settings/get", serde_json::json!({})).await;
        assert_eq!(got["result"]["provider"], serde_json::json!("openai-codex"));
        assert_eq!(got["result"]["model"], serde_json::Value::Null);
        assert_eq!(got["result"]["effort"], serde_json::json!("off"));

        // Set both; the response echoes the updated state.
        let set = request(
            &mut ws,
            2,
            "settings/set",
            serde_json::json!({ "model": "gpt-5.4", "effort": "high" }),
        )
        .await;
        assert_eq!(set["result"]["model"], serde_json::json!("gpt-5.4"));
        assert_eq!(set["result"]["effort"], serde_json::json!("high"));

        // A fresh get reads the persisted values.
        let got2 = request(&mut ws, 3, "settings/get", serde_json::json!({})).await;
        assert_eq!(got2["result"]["model"], serde_json::json!("gpt-5.4"));
        assert_eq!(got2["result"]["effort"], serde_json::json!("high"));

        // Partial update: changing only the effort leaves the model intact.
        let set_effort = request(
            &mut ws,
            4,
            "settings/set",
            serde_json::json!({ "effort": "low" }),
        )
        .await;
        assert_eq!(set_effort["result"]["model"], serde_json::json!("gpt-5.4"));
        assert_eq!(set_effort["result"]["effort"], serde_json::json!("low"));

        // Unknown model → invalid_params (-32602), and the prior value stands.
        let bad_model = request(
            &mut ws,
            5,
            "settings/set",
            serde_json::json!({ "model": "totally-not-a-model" }),
        )
        .await;
        assert_eq!(bad_model["error"]["code"], serde_json::json!(-32602));

        // Invalid effort → invalid_params (-32602).
        let bad_effort = request(
            &mut ws,
            6,
            "settings/set",
            serde_json::json!({ "effort": "ludicrous" }),
        )
        .await;
        assert_eq!(bad_effort["error"]["code"], serde_json::json!(-32602));

        // The rejected writes changed nothing.
        let got3 = request(&mut ws, 7, "settings/get", serde_json::json!({})).await;
        assert_eq!(got3["result"]["model"], serde_json::json!("gpt-5.4"));
        assert_eq!(got3["result"]["effort"], serde_json::json!("low"));

        ws.close(None).await.ok();
    });
}

#[test]
fn settings_set_malformed_params_rejected() {
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

        // Malformed params (model is the wrong type — fails to decode). Before
        // ADR-0029 the dispatch silently dropped this (no reply); the combinator
        // now frames it as invalid_params (-32602).
        let bad = request(&mut ws, 1, "settings/set", serde_json::json!({ "model": 123 })).await;
        assert_eq!(bad["id"], serde_json::json!(1));
        assert!(
            bad.get("result").is_none(),
            "malformed set carries no result: {bad}"
        );
        assert_eq!(
            bad["error"]["code"],
            serde_json::json!(-32602),
            "malformed settings/set params rejected with invalid_params: {bad}"
        );

        ws.close(None).await.ok();
    });
}
