//! Slice 3 RED test: `thread/create({prompt})` is message-first (ADR-0022).
//!
//! `thread/create` with a non-empty prompt mints a Thread, starts its first
//! Run, and returns `{thread_id, run_id}` in one round trip — persisting
//! exactly one Thread row (with a non-empty title derived from the prompt),
//! one Run row carrying that `thread_id`, and the user Message + text part.
//! Pure-subscribe (ADR-0022): the response carries only the ids; events
//! arrive via `run/subscribe(run_id)`.
//!
//! A whitespace-only prompt is rejected with `invalid_params` (`-32602`,
//! ADR-0014) BEFORE any row is written (Core is the authority — ADR-0002),
//! so the DB shows zero `threads` and zero `runs` rows.
//!
//! Uses the REAL echo Worker (no fixture/gate) — this slice does not assert
//! mid-stream, only the create round trip and the persisted rows.

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use assert_cmd::cargo::CommandCargoExt;
use futures_util::{SinkExt, StreamExt};
use sqlx::sqlite::SqlitePoolOptions;
use tempfile::TempDir;
use tokio_tungstenite::tungstenite::Message;

/// Core binds a fixed port (8765); the tests in this binary must run
/// serially or they collide. Cargo runs tests within a binary in parallel
/// by default, so each acquires this lock for the full Core lifetime.
fn port_lock() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

/// Drop guard around `Child` that SIGKILLs and reaps on drop. Without this a
/// panicking test would leak Core (which holds the fixed port 8765 and blocks
/// subsequent test runs).
struct CoreChild(Option<Child>);

impl Drop for CoreChild {
    fn drop(&mut self) {
        if let Some(mut c) = self.0.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

/// Spawn Core wired to the REAL echo Worker and block on its stdout until
/// `INKSTONE_LISTENING` appears. Returns the reaped-on-drop child guard and
/// the `ws://…/ws` URL.
fn spawn_core(db_path: &Path) -> (CoreChild, String) {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .expect("repo root resolves from <repo>/crates/core");

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
    let worker_cmd = format!("{} {}", tsx.display(), cli.display());

    let mut child = std::process::Command::cargo_bin("core")
        .expect("core binary exists")
        .current_dir(repo_root)
        .env("INKSTONE_WORKER_CMD", &worker_cmd)
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

type Ws = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

/// Read the next text frame, bounded by a 5s timeout so a hang fails fast.
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
fn thread_create_mints_thread_and_first_message() {
    let _guard = port_lock();

    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");

    let (_core, ws_url) = spawn_core(&db_path);

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let (thread_id, run_id) = rt.block_on(async {
        let (mut ws, _resp) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .expect("ws handshake succeeds");

        // ---- thread/create: returns {thread_id, run_id}, no events ----
        let create =
            r#"{"jsonrpc":"2.0","id":1,"method":"thread/create","params":{"prompt":"hi"}}"#;
        ws.send(Message::Text(create.into()))
            .await
            .expect("send thread/create frame");

        let response_body = next_text(&mut ws).await;
        let response: serde_json::Value = serde_json::from_str(&response_body)
            .unwrap_or_else(|e| panic!("response is JSON: {e} — body: {response_body}"));
        assert_eq!(response["jsonrpc"], serde_json::json!("2.0"), "jsonrpc");
        assert_eq!(response["id"], serde_json::json!(1), "echoed id");
        // Pure-subscribe: the response is a result, not a notification.
        assert!(
            response.get("method").is_none(),
            "thread/create response has no method — body: {response_body}"
        );
        assert!(
            response.get("error").is_none(),
            "thread/create with a real prompt is not an error — body: {response_body}"
        );

        let thread_id = response["result"]["thread_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.thread_id is a string — body: {response_body}"))
            .to_string();
        let run_id = response["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — body: {response_body}"))
            .to_string();

        let parsed_thread = uuid::Uuid::parse_str(&thread_id).expect("thread_id parses as UUID");
        assert_eq!(
            parsed_thread.get_version(),
            Some(uuid::Version::SortRand),
            "thread_id is UUIDv7"
        );
        let parsed_run = uuid::Uuid::parse_str(&run_id).expect("run_id parses as UUID");
        assert_eq!(
            parsed_run.get_version(),
            Some(uuid::Version::SortRand),
            "run_id is UUIDv7"
        );

        // Drain the run to `done` so the Worker finishes cleanly before we
        // kill Core (subscribe is snapshot-then-tail per ADR-0022).
        let subscribe = format!(
            r#"{{"jsonrpc":"2.0","id":2,"method":"run/subscribe","params":{{"run_id":"{run_id}"}}}}"#
        );
        ws.send(Message::Text(subscribe.into()))
            .await
            .expect("send run/subscribe frame");
        let _sub_resp = next_text(&mut ws).await; // subscribe response
        loop {
            let body = next_text(&mut ws).await;
            let v: serde_json::Value = serde_json::from_str(&body)
                .unwrap_or_else(|e| panic!("tail frame is JSON: {e} — body: {body}"));
            if v["params"]["event"]["kind"] == serde_json::json!("done") {
                break;
            }
        }

        ws.close(None).await.ok();
        (thread_id, run_id)
    });

    drop(_core);

    // Open the DB read-only and assert the persisted rows.
    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", db_path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        // Threads: exactly one, with a non-empty derived title. ----------
        let thread_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM threads")
            .fetch_one(&pool)
            .await
            .expect("count threads");
        assert_eq!(thread_count, 1, "exactly one thread row");
        let (db_thread_id, title): (String, String) =
            sqlx::query_as("SELECT id, title FROM threads")
                .fetch_one(&pool)
                .await
                .expect("read thread row");
        assert_eq!(db_thread_id, thread_id, "threads.id matches returned thread_id");
        assert!(!title.is_empty(), "thread title is non-empty (derived from the prompt)");

        // Runs: exactly one, carrying the returned thread_id. -------------
        let run_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM runs")
            .fetch_one(&pool)
            .await
            .expect("count runs");
        assert_eq!(run_count, 1, "exactly one run row");
        let (db_run_id, db_run_thread_id): (String, String) =
            sqlx::query_as("SELECT id, thread_id FROM runs")
                .fetch_one(&pool)
                .await
                .expect("read run row");
        assert_eq!(db_run_id, run_id, "runs.id matches returned run_id");
        assert_eq!(
            db_run_thread_id, thread_id,
            "runs.thread_id matches returned thread_id"
        );

        // User message: exactly one, seq=0 text part == "hi". ------------
        let user_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE role='user'")
                .fetch_one(&pool)
                .await
                .expect("count user messages");
        assert_eq!(user_count, 1, "exactly one user message");
        let user_msg_id: String =
            sqlx::query_scalar("SELECT id FROM messages WHERE role='user'")
                .fetch_one(&pool)
                .await
                .expect("read user message id");
        let part_text: String = sqlx::query_scalar(
            "SELECT text FROM message_parts WHERE message_id = ?1 AND seq = 0",
        )
        .bind(&user_msg_id)
        .fetch_one(&pool)
        .await
        .expect("read user message_part seq=0");
        assert_eq!(part_text, "hi", "user message seq=0 text part is the prompt");
    });
}

#[test]
fn thread_create_empty_prompt_rejected() {
    let _guard = port_lock();

    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");

    let (_core, ws_url) = spawn_core(&db_path);

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let (mut ws, _resp) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .expect("ws handshake succeeds");

        // Whitespace-only prompt: rejected with invalid_params (-32602)
        // BEFORE any row is written.
        let create =
            r#"{"jsonrpc":"2.0","id":2,"method":"thread/create","params":{"prompt":"   "}}"#;
        ws.send(Message::Text(create.into()))
            .await
            .expect("send thread/create frame");

        let response_body = next_text(&mut ws).await;
        let response: serde_json::Value = serde_json::from_str(&response_body)
            .unwrap_or_else(|e| panic!("response is JSON: {e} — body: {response_body}"));
        assert_eq!(response["id"], serde_json::json!(2), "echoed id");
        assert!(
            response.get("result").is_none(),
            "rejected create carries no result — body: {response_body}"
        );
        assert_eq!(
            response["error"]["code"],
            serde_json::json!(-32602),
            "empty prompt is rejected with invalid_params (-32602) — body: {response_body}"
        );

        ws.close(None).await.ok();
    });

    drop(_core);

    // Open the DB read-only and assert zero rows were written.
    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", db_path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        let thread_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM threads")
            .fetch_one(&pool)
            .await
            .expect("count threads");
        assert_eq!(thread_count, 0, "rejection writes zero thread rows");

        let run_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM runs")
            .fetch_one(&pool)
            .await
            .expect("count runs");
        assert_eq!(run_count, 0, "rejection writes zero run rows");
    });
}
