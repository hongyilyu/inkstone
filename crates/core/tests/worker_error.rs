//! Slice 1 (real-worker-codex): a worker-emitted `error` Run Event
//! terminates the Run as `errored` with the worker's message persisted, and
//! the subscribe stream delivers the `error` event then closes.
//!
//! Uses the slow-worker fixture in error mode (`INKSTONE_FIXTURE_ERROR`),
//! spawned by Core exactly as the real Worker would be — the "only Core
//! spawns Worker" invariant (ADR-0001/0013) holds. Distinct from
//! `persistence_terminal.rs`'s `worker_eof_errors_run` (stdout EOF without
//! `done` → `worker_disconnected`): here the worker emits an explicit
//! `error` and Core records THAT message with `terminal_reason='errored'`.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use assert_cmd::cargo::CommandCargoExt;
use futures_util::{SinkExt, StreamExt};
use sqlx::Row;
use sqlx::sqlite::SqlitePoolOptions;
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

fn slow_worker_cmd() -> String {
    let repo_root = repo_root();
    let tsx = repo_root.join("packages/worker/node_modules/.bin/tsx");
    let fixture = repo_root.join("crates/core/tests/fixtures/slow-worker.ts");
    if !tsx.exists() {
        panic!(
            "worker tsx not installed at {} — run `pnpm install` at repo root",
            tsx.display()
        );
    }
    format!("{} {}", tsx.display(), fixture.display())
}

fn port_lock() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|p| p.into_inner())
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

fn spawn_core(worker_cmd: &str, db_path: &Path, error_message: &str, gate_path: &Path) -> (CoreChild, String) {
    let repo_root = repo_root();
    let mut child = std::process::Command::cargo_bin("core")
        .expect("core binary exists")
        .current_dir(&repo_root)
        .env("INKSTONE_WORKER_CMD", worker_cmd)
        .env("INKSTONE_DB_PATH", db_path)
        .env("INKSTONE_FIXTURE_ERROR", error_message)
        // CHUNKS=2 + GATE makes the stream provably pause mid-flight: the
        // fixture emits chunk 1, blocks until the gate file appears, then
        // emits chunk 2 + the terminal error. The test creates the gate file
        // only AFTER subscribing, so the error is delivered strictly after
        // the subscriber attaches — deterministic live-stream assertion with
        // no reliance on tsx cold-start timing.
        .env("INKSTONE_FIXTURE_CHUNKS", "2")
        .env("INKSTONE_FIXTURE_GATE", gate_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("core spawns");

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

#[test]
fn worker_error_event_marks_run_errored_with_message() {
    let _guard = port_lock();
    let worker_cmd = slow_worker_cmd();
    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");
    let gate_path = tmp.path().join("gate");
    let error_message = "provider rejected the request";

    let (_child, ws_url) = spawn_core(&worker_cmd, &db_path, error_message, &gate_path);

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let (run_id, saw_error_on_stream) = rt.block_on(async {
        let (mut ws, _resp) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .expect("ws handshake succeeds");

        let request =
            r#"{"jsonrpc":"2.0","id":1,"method":"thread/create","params":{"prompt":"hi"}}"#;
        ws.send(Message::Text(request.into()))
            .await
            .expect("send request frame");

        async fn next_text(
            ws: &mut tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
        ) -> String {
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

        // Now that we've subscribed (and read the subscribe response), trip
        // the gate so the fixture emits the remaining chunk + the terminal
        // error. This guarantees the error is delivered AFTER the subscriber
        // attached — the live-stream assertion can't be won by a race.
        std::fs::write(&gate_path, b"go").expect("create gate file");

        // Drain events; the stream must carry an `error` event and then close
        // (terminal). The loop exits on the error arm; a `done` before any
        // error is a failure (the worker errored, it must not also complete).
        let saw_error;
        loop {
            let body = next_text(&mut ws).await;
            let v: serde_json::Value = serde_json::from_str(&body)
                .unwrap_or_else(|e| panic!("event is JSON: {e} — body: {body}"));
            match v["params"]["event"]["kind"].as_str() {
                Some("error") => {
                    assert_eq!(
                        v["params"]["event"]["message"].as_str(),
                        Some(error_message),
                        "error event carries the worker's message — body: {body}"
                    );
                    saw_error = true;
                    break;
                }
                Some("done") => {
                    panic!("worker errored; stream must not emit done — body: {body}");
                }
                _ => {}
            }
        }

        ws.close(None).await.ok();
        tokio::time::sleep(Duration::from_millis(200)).await;
        (run_id, saw_error)
    });

    assert!(saw_error_on_stream, "subscribe stream delivered the error event");

    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", db_path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        let run_row = sqlx::query(
            "SELECT status, terminal_reason, error_code, error_message, ended_at \
             FROM runs WHERE id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("read run row");
        let status: String = run_row.get("status");
        assert_eq!(status, "errored", "runs.status flipped to errored");
        let terminal_reason: Option<String> = run_row.get("terminal_reason");
        assert_eq!(
            terminal_reason.as_deref(),
            Some("errored"),
            "terminal_reason='errored' (worker-emitted, not disconnect)"
        );
        let error_message_col: Option<String> = run_row.get("error_message");
        assert_eq!(
            error_message_col.as_deref(),
            Some(error_message),
            "runs.error_message carries the worker's message"
        );
        let ended_at: Option<i64> = run_row.get("ended_at");
        assert!(ended_at.is_some(), "ended_at is set");

        // assistant message flipped streaming → incomplete
        let assistant_status: String = sqlx::query_scalar(
            "SELECT status FROM messages WHERE role='assistant' AND run_id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("read assistant message status");
        assert_eq!(
            assistant_status, "incomplete",
            "assistant message flipped to incomplete"
        );

        // exactly one terminal error run_event
        let error_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM run_events WHERE run_id = ?1 AND kind='error'",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("count error events");
        assert_eq!(error_count, 1, "exactly one terminal error run_event");
    });
}
