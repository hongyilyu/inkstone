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
/// requests (off-allowlist case); `id_file` points the fixture at a file
/// holding the `thread_id` to read.
fn spawn_core(
    worker_cmd: &str,
    db_path: &Path,
    tool: Option<&str>,
    id_file: Option<&Path>,
) -> (CoreChild, String) {
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
    if let Some(f) = id_file {
        cmd.env("INKSTONE_TOOLWORKER_THREAD_ID_FILE", f);
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

/// Create a Thread with `prompt`, subscribe to its Run, drain to `done`, and
/// return (thread_id, run_id, concatenated text deltas).
async fn run_and_collect(ws_url: &str, prompt: &str) -> (String, String, String) {
    let (mut ws, _resp) = tokio_tungstenite::connect_async(ws_url)
        .await
        .expect("ws handshake succeeds");

    let request = format!(
        r#"{{"jsonrpc":"2.0","id":1,"method":"thread/create","params":{{"prompt":"{prompt}"}}}}"#
    );
    ws.send(Message::Text(request.into()))
        .await
        .expect("send request frame");

    let response_body = next_text(&mut ws).await;
    let response: serde_json::Value = serde_json::from_str(&response_body)
        .unwrap_or_else(|e| panic!("response is JSON: {e} — body: {response_body}"));
    let thread_id = response["result"]["thread_id"]
        .as_str()
        .unwrap_or_else(|| panic!("result.thread_id is a string — body: {response_body}"))
        .to_string();
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
    (thread_id, run_id, text)
}

#[test]
fn read_thread_returns_another_threads_messages() {
    let worker_cmd = tool_worker_cmd();
    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");
    let id_file = tmp.path().join("tid");
    let (_child, ws_url) = spawn_core(&worker_cmd, &db_path, None, Some(&id_file));

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let run_b = rt.block_on(async {
        // Thread A carries a distinctive prompt. Its own Run calls read_thread
        // with the default unknown id (the id-file doesn't exist yet) → an
        // error outcome it ignores; we just need A persisted.
        let (thread_a, _run_a, _text_a) =
            run_and_collect(&ws_url, "alpha-secret-123").await;

        // Point the fixture at A, then run Thread B — B's Run reads A.
        std::fs::write(&id_file, &thread_a).expect("write id file");
        let (_thread_b, run_b, text_b) = run_and_collect(&ws_url, "beta").await;

        assert!(
            text_b.contains("tool_outcome=ok:"),
            "B's read_thread call succeeded — got {text_b:?}"
        );
        assert!(
            text_b.contains("alpha-secret-123"),
            "read_thread returned A's message text — got {text_b:?}"
        );
        run_b
    });

    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", db_path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        let row = sqlx::query(
            "SELECT name, status, result_payload FROM tool_calls WHERE run_id = ?1",
        )
        .bind(&run_b)
        .fetch_one(&pool)
        .await
        .expect("a tool_calls row exists for B's run");
        let name: String = row.get("name");
        let status: String = row.get("status");
        let result_payload: Option<String> = row.get("result_payload");
        assert_eq!(name, "read_thread");
        assert_eq!(status, "completed");
        assert!(
            result_payload.as_deref().unwrap_or("").contains("alpha-secret-123"),
            "result_payload carries A's content — got {result_payload:?}"
        );

        let step_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM run_steps WHERE run_id = ?1 AND kind = 'tool_call'",
        )
        .bind(&run_b)
        .fetch_one(&pool)
        .await
        .expect("count tool_call run_steps");
        assert_eq!(step_count, 1, "exactly one tool_call run_step");
    });
}

#[test]
fn unknown_thread_id_returns_error_outcome() {
    let worker_cmd = tool_worker_cmd();
    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");
    // No id-file → the fixture reads the unknown "t-dummy"; read_thread must
    // return an error outcome and the Run must still complete cleanly.
    let (_child, ws_url) = spawn_core(&worker_cmd, &db_path, None, None);

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let (_thread, _run, text) = run_and_collect(&ws_url, "hi").await;
        assert!(
            text.contains("tool_outcome=err:"),
            "unknown thread id yields an error outcome — got {text:?}"
        );
    });
}

#[test]
fn off_allowlist_tool_returns_error_outcome() {
    let worker_cmd = tool_worker_cmd();
    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");
    // The fixture requests a tool not in the Workflow allowlist; Core must
    // reject it with an `err` outcome rather than dispatching.
    let (_child, ws_url) = spawn_core(&worker_cmd, &db_path, Some("nonexistent"), None);

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let (_thread, _run, text) = run_and_collect(&ws_url, "hi").await;
        assert!(
            text.contains("tool_outcome=err:"),
            "off-allowlist tool yields an error outcome — got {text:?}"
        );
    });
}
