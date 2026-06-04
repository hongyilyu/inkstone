//! Slice 2 RED test (Tool Protocol): Core keeps the Worker's stdin open,
//! parses stdout as `RunEvent | ToolRequest`, dispatches a `tool_request` to
//! the Rust tool registry, writes a `tool_result` back correlated by
//! `tool_call_id`, and persists a `tool_calls` row + a `run_steps` row of
//! kind `tool_call`. The `read_thread` tool is a stub here (returns
//! `{"messages":[]}`); the real query lands in slice 3.
//!
//! Driven by `tests/fixtures/tool-worker.ts` over `INKSTONE_WORKER_CMD`,
//! spawned by Core exactly as the real Worker would be. The fixture emits a
//! `tool_request`, blocks for the `tool_result`, then echoes the outcome it
//! received as a `text_delta` so the round-trip is observable on the
//! subscribe stream as well as in the DB.

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

fn tool_worker_cmd() -> String {
    let repo_root = repo_root();
    let tsx = repo_root.join("packages/worker/node_modules/.bin/tsx");
    let fixture = repo_root.join("crates/core/tests/fixtures/tool-worker.ts");
    if !tsx.exists() {
        panic!(
            "worker tsx not installed at {} — run `pnpm install` at repo root",
            tsx.display()
        );
    }
    format!("{} {}", tsx.display(), fixture.display())
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

/// Spawn Core on an ephemeral port (`INKSTONE_PORT=0`) so tests don't
/// contend a fixed port. `tool` optionally overrides the tool the fixture
/// requests (off-allowlist case).
fn spawn_core(worker_cmd: &str, db_path: &Path, tool: Option<&str>) -> (CoreChild, String) {
    let repo_root = repo_root();
    let mut cmd = std::process::Command::cargo_bin("core").expect("core binary exists");
    cmd.current_dir(&repo_root)
        .env("INKSTONE_WORKER_CMD", worker_cmd)
        .env("INKSTONE_DB_PATH", db_path)
        .env("INKSTONE_PORT", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    if let Some(t) = tool {
        cmd.env("INKSTONE_TOOLWORKER_TOOL", t);
    }
    let mut child = cmd.spawn().expect("core spawns");

    let stdout = child.stdout.take().expect("piped stdout");
    let mut reader = BufReader::new(stdout);
    let deadline = Instant::now() + Duration::from_secs(5);
    let http_url = loop {
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("timed out waiting for INKSTONE_LISTENING line");
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
    let frame = tokio::time::timeout(Duration::from_secs(8), ws.next())
        .await
        .expect("frame within 8s")
        .expect("frame present")
        .expect("frame ok");
    match frame {
        Message::Text(t) => t.to_string(),
        other => panic!("expected text frame, got {other:?}"),
    }
}

/// Drive a Run to completion and return (run_id, concatenated text deltas).
async fn run_and_collect(ws_url: &str) -> (String, String) {
    let (mut ws, _resp) = tokio_tungstenite::connect_async(ws_url)
        .await
        .expect("ws handshake succeeds");

    let request = r#"{"jsonrpc":"2.0","id":1,"method":"thread/create","params":{"prompt":"hi"}}"#;
    ws.send(Message::Text(request.into()))
        .await
        .expect("send request frame");

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

    let mut text = String::new();
    loop {
        let body = next_text(&mut ws).await;
        let v: serde_json::Value = serde_json::from_str(&body)
            .unwrap_or_else(|e| panic!("event is JSON: {e} — body: {body}"));
        match v["params"]["event"]["kind"].as_str() {
            Some("text_delta") => {
                if let Some(d) = v["params"]["event"]["delta"].as_str() {
                    text.push_str(d);
                }
            }
            Some("done") => break,
            Some("error") => panic!("run errored unexpectedly — body: {body}"),
            _ => {}
        }
    }
    ws.close(None).await.ok();
    tokio::time::sleep(Duration::from_millis(200)).await;
    (run_id, text)
}

#[test]
fn read_thread_tool_round_trips_and_persists() {
    let worker_cmd = tool_worker_cmd();
    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");
    let (_child, ws_url) = spawn_core(&worker_cmd, &db_path, None);

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let run_id = rt.block_on(async {
        let (run_id, text) = run_and_collect(&ws_url).await;
        // The fixture echoes the outcome it received from Core. A successful
        // round-trip yields `tool_outcome=ok:<stub payload>`.
        assert!(
            text.contains("tool_outcome=ok:"),
            "stream shows a successful tool outcome — got {text:?}"
        );
        assert!(
            text.contains("messages"),
            "tool result carries the stub {{messages:[]}} payload — got {text:?}"
        );
        run_id
    });

    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", db_path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        // tool_calls -----------------------------------------------------
        let row = sqlx::query(
            "SELECT name, status, request_payload, result_payload \
             FROM tool_calls WHERE run_id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("a tool_calls row exists for the run");
        let name: String = row.get("name");
        let status: String = row.get("status");
        let request_payload: Option<String> = row.get("request_payload");
        let result_payload: Option<String> = row.get("result_payload");
        assert_eq!(name, "read_thread", "tool_calls.name");
        assert_eq!(status, "completed", "tool_calls.status flipped to completed");
        assert!(request_payload.is_some(), "request_payload persisted");
        assert!(
            result_payload.as_deref().unwrap_or("").contains("messages"),
            "result_payload carries the tool output — got {result_payload:?}"
        );

        // run_steps ------------------------------------------------------
        let step_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM run_steps WHERE run_id = ?1 AND kind = 'tool_call'",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("count tool_call run_steps");
        assert_eq!(step_count, 1, "exactly one tool_call run_step");
    });
}

#[test]
fn off_allowlist_tool_returns_error_outcome() {
    let worker_cmd = tool_worker_cmd();
    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");
    // The fixture requests a tool not in the Workflow allowlist; Core must
    // reject it with an `err` outcome rather than dispatching.
    let (_child, ws_url) = spawn_core(&worker_cmd, &db_path, Some("nonexistent"));

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let (_run_id, text) = run_and_collect(&ws_url).await;
        assert!(
            text.contains("tool_outcome=err:"),
            "off-allowlist tool yields an error outcome — got {text:?}"
        );
    });
}
