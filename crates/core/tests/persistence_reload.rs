//! Slice 5 RED test: after Core handles a message and exits cleanly,
//! restarting Core against the same DB file finds the prior Thread, Run, and
//! Messages intact and starts cleanly (migration is a no-op the second time).
//!
//! This is a cross-restart durability check. Slices 1–4 already realize each
//! individual write; slice 5 proves they survive process exit and re-open.

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
    let cli = repo_root.join("crates/core/tests/fixtures/slow-worker.ts");
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

/// Drop guard around `Child` that SIGKILLs and reaps on drop. Without this, a
/// panicking test would leak Core (which holds a fixed port and blocks the
/// next spawn).
struct CoreChild(Option<Child>);

impl CoreChild {
    fn kill_and_wait(&mut self) {
        if let Some(mut c) = self.0.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

impl Drop for CoreChild {
    fn drop(&mut self) {
        self.kill_and_wait();
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
fn run_history_survives_restart() {
    let worker_cmd = worker_cmd_real();
    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    // ---- First Core spawn: post a message, await done, kill Core ----
    let run_id = {
        let (mut child, ws_url) = spawn_core(&worker_cmd, &db_path);

        let run_id = rt.block_on(async {
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

            // Pure-subscribe (ADR-0022): post_message returns {run_id} only;
            // subscribe by run_id and read until the terminal done.
            let subscribe = format!(
                r#"{{"jsonrpc":"2.0","id":2,"method":"run/subscribe","params":{{"run_id":"{run_id}"}}}}"#
            );
            ws.send(Message::Text(subscribe.into()))
                .await
                .expect("send subscribe frame");

            let _sub_response = next_text(&mut ws).await;

            // The loop only exits via the `done` arm's `break`; reaching the
            // line after it proves the subscribe stream ended with a `done`.
            loop {
                let body = next_text(&mut ws).await;
                let v: serde_json::Value = serde_json::from_str(&body)
                    .unwrap_or_else(|e| panic!("event is JSON: {e} — body: {body}"));
                if v["params"]["event"]["kind"] == serde_json::json!("done") {
                    break;
                }
            }

            ws.close(None).await.ok();
            // Slice-4 ordering: terminal tx commits in Core's per-Run task
            // after the worker child reports stdout EOF. Sleep so the commit
            // lands before we kill Core.
            tokio::time::sleep(Duration::from_millis(200)).await;

            run_id
        });

        child.kill_and_wait();
        run_id
    };

    // ---- Second Core spawn: prove migration is a no-op, then exit ----
    {
        let (mut child, _ws_url) = spawn_core(&worker_cmd, &db_path);
        // The mere fact that spawn_core returned means INKSTONE_LISTENING was
        // emitted, which means `sqlx::migrate!()` succeeded against the
        // already-migrated DB. Nothing else to do here.
        child.kill_and_wait();
    }

    // ---- Assert against the on-disk DB via a fresh read-only pool ----
    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", db_path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        // threads ------------------------------------------------------
        let thread_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM threads")
            .fetch_one(&pool)
            .await
            .expect("count threads");
        assert_eq!(thread_count, 1, "exactly one thread row");

        // runs ---------------------------------------------------------
        let run_row = sqlx::query(
            "SELECT id, status, terminal_reason, ended_at FROM runs",
        )
        .fetch_one(&pool)
        .await
        .expect("read run row");
        let id_from_db: String = run_row.get("id");
        assert_eq!(id_from_db, run_id, "runs.id matches the run_id from the WS response");
        let status: String = run_row.get("status");
        assert_eq!(status, "completed", "runs.status='completed' survived restart");
        let terminal_reason: Option<String> = run_row.get("terminal_reason");
        assert_eq!(
            terminal_reason.as_deref(),
            Some("completed"),
            "terminal_reason='completed' survived restart"
        );
        let ended_at: Option<i64> = run_row.get("ended_at");
        assert!(ended_at.is_some(), "ended_at is set");

        // messages -----------------------------------------------------
        let msg_rows = sqlx::query(
            "SELECT id, role, status FROM messages WHERE run_id = ?1 ORDER BY created_at",
        )
        .bind(&run_id)
        .fetch_all(&pool)
        .await
        .expect("read message rows");
        assert_eq!(msg_rows.len(), 2, "exactly two messages for the run");

        let user_id: String = msg_rows[0].get("id");
        let user_role: String = msg_rows[0].get("role");
        let user_status: String = msg_rows[0].get("status");
        assert_eq!(user_role, "user", "first message is the user prompt");
        assert_eq!(user_status, "completed", "user message status='completed'");

        let assistant_id: String = msg_rows[1].get("id");
        let assistant_role: String = msg_rows[1].get("role");
        let assistant_status: String = msg_rows[1].get("status");
        assert_eq!(assistant_role, "assistant", "second message is the assistant reply");
        assert_eq!(
            assistant_status, "completed",
            "assistant message status='completed' survived restart"
        );

        // message_parts ------------------------------------------------
        let user_parts = sqlx::query(
            "SELECT seq, type, text FROM message_parts WHERE message_id = ?1 ORDER BY seq",
        )
        .bind(&user_id)
        .fetch_all(&pool)
        .await
        .expect("read user message_parts");
        assert_eq!(user_parts.len(), 1, "user message has exactly one part");
        let user_seq: i64 = user_parts[0].get("seq");
        let user_type: String = user_parts[0].get("type");
        let user_text: Option<String> = user_parts[0].get("text");
        assert_eq!(user_seq, 0);
        assert_eq!(user_type, "text");
        assert_eq!(user_text.as_deref(), Some("hi"));

        let asst_parts = sqlx::query(
            "SELECT seq, type, text FROM message_parts WHERE message_id = ?1 ORDER BY seq",
        )
        .bind(&assistant_id)
        .fetch_all(&pool)
        .await
        .expect("read assistant message_parts");
        assert_eq!(asst_parts.len(), 1, "assistant message has exactly one part");
        let asst_seq: i64 = asst_parts[0].get("seq");
        let asst_type: String = asst_parts[0].get("type");
        let asst_text: Option<String> = asst_parts[0].get("text");
        assert_eq!(asst_seq, 0);
        assert_eq!(asst_type, "text");
        assert_eq!(asst_text.as_deref(), Some("echo: hi"));

        // run_events ---------------------------------------------------
        let event_kinds: Vec<String> = sqlx::query_scalar(
            "SELECT kind FROM run_events WHERE run_id = ?1 ORDER BY run_seq",
        )
        .bind(&run_id)
        .fetch_all(&pool)
        .await
        .expect("read run_events");
        assert!(
            event_kinds.len() >= 2,
            "at least two run_events: status (slice 2) + done (slice 4); got {event_kinds:?}"
        );
        assert_eq!(
            event_kinds.first().map(String::as_str),
            Some("status"),
            "first run_event is the slice-2 status row"
        );
        assert_eq!(
            event_kinds.last().map(String::as_str),
            Some("done"),
            "last run_event is the slice-4 terminal done row"
        );
    });
}
