//! Slice 4 (real-worker-codex): the Core cutover. Core spawns the generic
//! `pi-agent-core` interpreter (packages/worker/src/cli.ts) with a manifest
//! on stdin, and a real agent-loop Run streams a completion back through the
//! hub end-to-end. Determinism comes from pi-ai's `faux` provider
//! (ADR-0019 as-built): the workflow declares `provider="faux"` and the
//! canned response rides `INKSTONE_FAUX_RESPONSE`, inherited Core → Worker.
//!
//! This proves the interpreter path (manifest parse → runAgentLoop tools=[]
//! → message_update/text_delta → done) without touching a real provider.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

use assert_cmd::cargo::CommandCargoExt;
use futures_util::{SinkExt, StreamExt};
use tempfile::TempDir;
use tokio_tungstenite::tungstenite::Message;

fn repo_root() -> PathBuf {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .and_then(Path::parent)
        .expect("repo root resolves from <repo>/crates/core")
        .to_path_buf()
}

/// The real generic interpreter entry (NOT the slow-worker fixture).
fn interpreter_worker_cmd() -> String {
    let root = repo_root();
    let tsx = root.join("packages/worker/node_modules/.bin/tsx");
    let cli = root.join("packages/worker/src/cli.ts");
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

/// Write a faux workflow into a fixture dir so the interpreter takes the
/// offline faux path (provider="faux").
fn write_faux_workflow(dir: &Path) {
    std::fs::create_dir_all(dir).expect("create workflows dir");
    std::fs::write(
        dir.join("default.toml"),
        r#"
name = "default"
version = "1.0.0"
provider = "faux"
model = "faux-1"
thinking_level = "off"
system_prompt = "You are a test assistant."
tools = []
"#,
    )
    .expect("write faux default.toml");
}

fn spawn_core(worker_cmd: &str, db_path: &Path, workflows_dir: &Path, faux_response: &str) -> (CoreChild, String) {
    let mut child = std::process::Command::cargo_bin("core")
        .expect("core binary exists")
        .current_dir(repo_root())
        .env("INKSTONE_PORT", "0")
        .env("INKSTONE_WORKER_CMD", worker_cmd)
        .env("INKSTONE_DB_PATH", db_path)
        .env("INKSTONE_WORKFLOWS_DIR", workflows_dir)
        // Inherited by the spawned Worker; the faux provider replies with it.
        .env("INKSTONE_FAUX_RESPONSE", faux_response)
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

#[test]
fn faux_completion_streams_through_core() {
    let worker_cmd = interpreter_worker_cmd();
    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");
    let workflows_dir = tmp.path().join("workflows");
    write_faux_workflow(&workflows_dir);
    let faux_response = "hello from faux";

    let (_child, ws_url) = spawn_core(&worker_cmd, &db_path, &workflows_dir, faux_response);

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let assembled = rt.block_on(async {
        let (mut ws, _resp) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .expect("ws handshake succeeds");

        let request =
            r#"{"jsonrpc":"2.0","id":1,"method":"thread/create","params":{"prompt":"hi there"}}"#;
        ws.send(Message::Text(request.into()))
            .await
            .expect("send request frame");

        async fn next_text(
            ws: &mut tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
        ) -> String {
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

        let response_body = next_text(&mut ws).await;
        let response: serde_json::Value = serde_json::from_str(&response_body)
            .unwrap_or_else(|e| panic!("response is JSON: {e} — body: {response_body}"));
        let run_id = response["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — body: {response_body}"))
            .to_string();

        let subscribe = format!(
            r#"{{"jsonrpc":"2.0","id":2,"method":"run/subscribe","params":{{"run_id":"{run_id}"}}}}"#
        );
        ws.send(Message::Text(subscribe.into()))
            .await
            .expect("send subscribe frame");
        let _sub_response = next_text(&mut ws).await;

        // Reassemble text_delta payloads until the terminal done. The loop
        // exits only via the done arm; an error event fails the test.
        let mut assembled = String::new();
        loop {
            let body = next_text(&mut ws).await;
            let v: serde_json::Value = serde_json::from_str(&body)
                .unwrap_or_else(|e| panic!("event is JSON: {e} — body: {body}"));
            match v["params"]["event"]["kind"].as_str() {
                Some("text_delta") => {
                    assembled.push_str(
                        v["params"]["event"]["delta"]
                            .as_str()
                            .unwrap_or_else(|| panic!("text_delta carries a string — body: {body}")),
                    );
                }
                Some("done") => break,
                Some("error") => {
                    panic!("faux run errored unexpectedly — body: {body}");
                }
                other => panic!("unexpected event kind {other:?} — body: {body}"),
            }
        }

        ws.close(None).await.ok();
        assembled
    });

    // The snapshot rides as the first text_delta (cumulative), and the faux
    // provider streams the response in token chunks; either way the
    // reassembled text equals the canned faux response.
    assert_eq!(
        assembled, faux_response,
        "reassembled stream equals the faux provider's response"
    );
}
