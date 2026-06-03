//! Slice 3 (models-settings, ADR-0024): a Run uses the user's selected model
//! and global effort. After `settings/set`, a new Run's `runs.model` is the
//! SELECTED model (not the per-provider default), and the WorkerManifest
//! carries the selected model + effort — observed via a manifest-capture
//! worker that echoes `model=<m>|effort=<e>`, which Core persists.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

use assert_cmd::cargo::CommandCargoExt;
use futures_util::{SinkExt, StreamExt};
use sqlx::Row;
use sqlx::sqlite::SqlitePoolOptions;
use tempfile::TempDir;
use tokio_tungstenite::tungstenite::Message;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("repo root resolves from <repo>/crates/core")
        .to_path_buf()
}

fn manifest_capture_cmd() -> String {
    let repo_root = repo_root();
    let tsx = repo_root.join("packages/worker/node_modules/.bin/tsx");
    let cli = repo_root.join("crates/core/tests/fixtures/manifest-capture.ts");
    if !tsx.exists() {
        panic!("worker tsx not installed — run `pnpm install`");
    }
    format!("{} {}", tsx.display(), cli.display())
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

fn spawn_core(worker_cmd: &str, db_path: &Path) -> (CoreChild, String) {
    let mut child = std::process::Command::cargo_bin("core")
        .expect("core binary exists")
        .current_dir(repo_root())
        .env("INKSTONE_PORT", "0")
        .env("INKSTONE_WORKER_CMD", worker_cmd)
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
fn run_uses_selected_model_and_effort() {
    let worker_cmd = manifest_capture_cmd();
    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");
    let (_child, ws_url) = spawn_core(&worker_cmd, &db_path);

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let run_id = rt.block_on(async {
        let (mut ws, _resp) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .expect("ws handshake");

        // Pick a model that is NOT the per-provider default (gpt-5.5) + an
        // effort that is NOT the default (off), so the assertions prove the
        // selection won, not the fallback.
        let set = request(
            &mut ws,
            1,
            "settings/set",
            serde_json::json!({ "model": "gpt-5.4", "effort": "high" }),
        )
        .await;
        assert_eq!(set["result"]["model"], serde_json::json!("gpt-5.4"));

        let created = request(&mut ws, 2, "thread/create", serde_json::json!({ "prompt": "hi" })).await;
        let run_id = created["result"]["run_id"]
            .as_str()
            .expect("run_id string")
            .to_string();

        ws.close(None).await.ok();
        run_id
    });

    // Poll the DB: the run row records the SELECTED model, and once the
    // manifest-capture worker completes, the assistant text echoes the
    // resolved model + effort the manifest carried.
    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", db_path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let row = sqlx::query(
                "SELECT r.model AS model, mp.text AS text \
                 FROM runs r \
                 JOIN messages m ON m.run_id = r.id AND m.role = 'assistant' \
                 JOIN message_parts mp ON mp.message_id = m.id AND mp.seq = 0 \
                 WHERE r.id = ?1",
            )
            .bind(&run_id)
            .fetch_optional(&pool)
            .await
            .expect("query run + assistant text");

            if let Some(row) = row {
                let model: String = row.get("model");
                let text: String = row.get("text");
                assert_eq!(model, "gpt-5.4", "runs.model is the SELECTED model");
                if !text.is_empty() {
                    assert_eq!(
                        text, "model=gpt-5.4|effort=high",
                        "manifest carried the selected model + global effort"
                    );
                    break;
                }
            }
            if Instant::now() > deadline {
                panic!("timed out waiting for the assistant text to reflect the manifest");
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    });
}
