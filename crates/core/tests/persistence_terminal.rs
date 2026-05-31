//! Slice 4 RED tests: whichever way the Worker exits — clean `done` event
//! or stdout EOF without `done` — Core writes the terminal `runs.status`,
//! the matching `terminal_reason`, the terminal `run_events` row, and (for
//! the EOF path) flips every `messages.status='streaming'` for that Run to
//! `'incomplete'` — all in one transaction.

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

fn worker_cmd_real() -> String {
    let repo_root = repo_root();
    let tsx = repo_root.join("packages/worker/node_modules/.bin/tsx");
    let cli = repo_root.join("packages/worker/src/cli.ts");
    if !tsx.exists() {
        panic!(
            "worker tsx not installed at {} — run `pnpm install` at repo root",
            tsx.display()
        );
    }
    if !cli.exists() {
        panic!("worker cli not found at {}", cli.display());
    }
    format!("{} {}", tsx.display(), cli.display())
}

/// Core binds a fixed port (8765); both tests in this binary must run
/// serially or they collide. Cargo runs tests within a binary in parallel
/// by default, so we acquire this lock for the full Core lifetime.
fn port_lock() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

fn false_binary() -> &'static str {
    if Path::new("/usr/bin/false").exists() {
        "/usr/bin/false"
    } else if Path::new("/bin/false").exists() {
        "/bin/false"
    } else {
        panic!("no `false` binary found at /usr/bin/false or /bin/false");
    }
}

/// Drop guard around `Child` that SIGKILLs and reaps on drop. Without this,
/// a panicking test would leak Core (which holds the fixed port 8765 and
/// blocks subsequent test runs).
struct CoreChild(Option<Child>);

impl Drop for CoreChild {
    fn drop(&mut self) {
        if let Some(mut c) = self.0.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

/// Spawn Core with the given env, block on its stdout until INKSTONE_LISTENING
/// appears, and return (child, ws_url).
fn spawn_core(worker_cmd: &str, db_path: &Path) -> (CoreChild, String) {
    let repo_root = repo_root();
    let mut child = std::process::Command::cargo_bin("core")
        .expect("core binary exists")
        .current_dir(&repo_root)
        .env("INKSTONE_WORKER_CMD", worker_cmd)
        .env("INKSTONE_DB_PATH", db_path)
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
fn done_event_completes_run() {
    let _guard = port_lock();
    let worker_cmd = worker_cmd_real();
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
            .expect("ws handshake succeeds");

        let request =
            r#"{"jsonrpc":"2.0","id":1,"method":"run/post_message","params":{"prompt":"hi"}}"#;
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
        let _text_delta_body = next_text(&mut ws).await;
        let done_body = next_text(&mut ws).await;

        let response: serde_json::Value = serde_json::from_str(&response_body)
            .unwrap_or_else(|e| panic!("response is JSON: {e} — body: {response_body}"));
        let run_id = response["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — body: {response_body}"))
            .to_string();

        let done: serde_json::Value = serde_json::from_str(&done_body)
            .unwrap_or_else(|e| panic!("done frame is JSON: {e} — body: {done_body}"));
        assert_eq!(
            done["params"]["event"]["kind"],
            serde_json::json!("done"),
            "third frame is done"
        );

        ws.close(None).await.ok();
        // Give Core's per-Run task time to commit the terminal tx after the
        // worker child reports stdout EOF.
        tokio::time::sleep(Duration::from_millis(200)).await;

        run_id
    });

    // _child's Drop kills + reaps Core. Run assertions while Core is still
    // alive — the terminal tx already committed during the 200ms sleep above
    // so a fresh ro pool sees the final state regardless.
    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", db_path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        // runs ----------------------------------------------------------
        let run_row = sqlx::query(
            "SELECT status, terminal_reason, ended_at FROM runs WHERE id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("read run row");
        let status: String = run_row.get("status");
        assert_eq!(status, "completed", "runs.status flipped to completed");
        let terminal_reason: Option<String> = run_row.get("terminal_reason");
        assert_eq!(
            terminal_reason.as_deref(),
            Some("completed"),
            "terminal_reason='completed'"
        );
        let ended_at: Option<i64> = run_row.get("ended_at");
        assert!(ended_at.is_some(), "ended_at is set");

        // assistant message --------------------------------------------
        let assistant_status: String = sqlx::query_scalar(
            "SELECT status FROM messages WHERE role='assistant' AND run_id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("read assistant message status");
        assert_eq!(
            assistant_status, "completed",
            "assistant message flipped to completed"
        );

        // run_events ---------------------------------------------------
        let done_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM run_events WHERE run_id = ?1 AND kind='done'",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("count done events");
        assert_eq!(done_count, 1, "exactly one terminal done run_event");
    });
}

#[test]
fn worker_eof_errors_run_and_marks_message_incomplete() {
    let _guard = port_lock();
    let worker_cmd = false_binary().to_string();
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
            .expect("ws handshake succeeds");

        let request =
            r#"{"jsonrpc":"2.0","id":1,"method":"run/post_message","params":{"prompt":"hi"}}"#;
        ws.send(Message::Text(request.into()))
            .await
            .expect("send request frame");

        let frame = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("response frame within 5s")
            .expect("response frame present")
            .expect("response frame ok");
        let body = match frame {
            Message::Text(t) => t.to_string(),
            other => panic!("expected text frame, got {other:?}"),
        };

        let v: serde_json::Value = serde_json::from_str(&body)
            .unwrap_or_else(|e| panic!("response is JSON: {e} — body: {body}"));
        let run_id = v["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — body: {body}"))
            .to_string();

        // Worker exits immediately with no stdout — no text_delta, no done.
        // Poll the DB until the run leaves the 'running' state.
        let url = format!("sqlite://{}?mode=ro", db_path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");
        // Poll for terminal status. The terminal tx commits inside Core's
        // per-Run task after the worker child reports stdout EOF; bound the
        // wait at 5s.
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let status: String = sqlx::query_scalar(
                "SELECT status FROM runs WHERE id = ?1",
            )
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .expect("poll run status");
            if status != "running" {
                break;
            }
            if Instant::now() > deadline {
                panic!(
                    "timed out waiting for runs.status to leave 'running' (still {status:?})"
                );
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        ws.close(None).await.ok();
        run_id
    });

    // _child's Drop kills + reaps Core whenever this fn returns/panics.
    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", db_path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        // runs ----------------------------------------------------------
        let run_row = sqlx::query(
            "SELECT status, terminal_reason, error_code, ended_at FROM runs WHERE id = ?1",
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
            Some("worker_disconnected"),
            "terminal_reason='worker_disconnected'"
        );
        let error_code: Option<String> = run_row.get("error_code");
        assert_eq!(
            error_code.as_deref(),
            Some("worker_disconnected"),
            "error_code='worker_disconnected'"
        );
        let ended_at: Option<i64> = run_row.get("ended_at");
        assert!(ended_at.is_some(), "ended_at is set");

        // assistant message --------------------------------------------
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

        // run_events ---------------------------------------------------
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

/// Regression: a Worker process that fails to spawn (missing binary, empty
/// `INKSTONE_WORKER_CMD`, etc.) hits one of `run_worker`'s pre-loop
/// early-return paths. Without `finalize_error`, those paths skipped the
/// terminal tx entirely and left `runs.status='running'` and the
/// assistant `messages.status='streaming'` forever — a violation of
/// ADR-0017's atomic recovery invariant.
#[test]
fn worker_spawn_failure_errors_run() {
    let _guard = port_lock();
    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");

    // Path that doesn't exist → tokio::process::Command::spawn() returns
    // Err, hitting the second pre-loop early-return path in run_worker.
    let (_child, ws_url) = spawn_core("/nonexistent/inkstone-test-worker", &db_path);

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let run_id = rt.block_on(async {
        let (mut ws, _resp) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .expect("ws handshake succeeds");

        let request =
            r#"{"jsonrpc":"2.0","id":1,"method":"run/post_message","params":{"prompt":"hi"}}"#;
        ws.send(Message::Text(request.into()))
            .await
            .expect("send request frame");

        let frame = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("response frame within 5s")
            .expect("response frame present")
            .expect("response frame ok");
        let body = match frame {
            Message::Text(t) => t.to_string(),
            other => panic!("expected text frame, got {other:?}"),
        };
        let v: serde_json::Value = serde_json::from_str(&body)
            .unwrap_or_else(|e| panic!("response is JSON: {e} — body: {body}"));
        let run_id = v["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — body: {body}"))
            .to_string();

        // Worker never ran; poll for terminal status.
        let url = format!("sqlite://{}?mode=ro", db_path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let status: String =
                sqlx::query_scalar("SELECT status FROM runs WHERE id = ?1")
                    .bind(&run_id)
                    .fetch_one(&pool)
                    .await
                    .expect("poll run status");
            if status != "running" {
                break;
            }
            if Instant::now() > deadline {
                panic!(
                    "timed out waiting for runs.status to leave 'running' (still {status:?})"
                );
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        ws.close(None).await.ok();
        run_id
    });

    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", db_path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        let run_row =
            sqlx::query("SELECT status, terminal_reason FROM runs WHERE id = ?1")
                .bind(&run_id)
                .fetch_one(&pool)
                .await
                .expect("read run row");
        let status: String = run_row.get("status");
        assert_eq!(status, "errored", "spawn failure flips runs.status to errored");
        let terminal_reason: Option<String> = run_row.get("terminal_reason");
        assert_eq!(
            terminal_reason.as_deref(),
            Some("worker_disconnected"),
            "terminal_reason='worker_disconnected'"
        );

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
    });
}
