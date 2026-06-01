//! Slice 4 RED test: `run/post_message({thread_id, prompt})` adds a SECOND
//! Run to an EXISTING Thread (ADR-0022 — post_message is existing-thread-only;
//! `thread_id` is never optional).
//!
//! `post_message_starts_second_run_in_existing_thread`: `thread/create` mints
//! a Thread + its first Run, then `run/post_message` against that `thread_id`
//! starts a second Run in the SAME Thread (same `thread_id`, new `run_id`).
//! The DB shows exactly one Thread and exactly two Runs, both carrying that
//! `thread_id`, with the two distinct run ids the WS responses returned.
//!
//! `post_message_unknown_thread_rejected`: `run/post_message` with a
//! well-formed but never-created `thread_id` is rejected with the
//! `unknown_thread` error (code `-32001`, ADR-0014's `-32000..-32099` Inkstone
//! server-error band) and writes ZERO rows — distinct from `invalid_params`
//! (`-32602`), which is for a malformed thread_id.
//!
//! Uses the REAL echo Worker (no fixture/gate) — this slice asserts the
//! create-then-post round trip and the persisted rows, not mid-stream timing.

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

/// Subscribe to `run_id` and drain the snapshot + tail until the terminal
/// `done`, so the Worker finishes cleanly before Core is killed.
async fn drain_run_to_done(ws: &mut Ws, sub_id: u32, run_id: &str) {
    let subscribe = format!(
        r#"{{"jsonrpc":"2.0","id":{sub_id},"method":"run/subscribe","params":{{"run_id":"{run_id}"}}}}"#
    );
    ws.send(Message::Text(subscribe.into()))
        .await
        .expect("send run/subscribe frame");
    let _sub_resp = next_text(ws).await; // subscribe response
    loop {
        let body = next_text(ws).await;
        let v: serde_json::Value = serde_json::from_str(&body)
            .unwrap_or_else(|e| panic!("tail frame is JSON: {e} — body: {body}"));
        if v["params"]["event"]["kind"] == serde_json::json!("done") {
            break;
        }
    }
}

#[test]
fn post_message_starts_second_run_in_existing_thread() {
    let _guard = port_lock();

    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");

    let (_core, ws_url) = spawn_core(&db_path);

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let (thread_id, run_id_1, run_id_2) = rt.block_on(async {
        let (mut ws, _resp) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .expect("ws handshake succeeds");

        // ---- thread/create: mint the Thread + its first Run ----
        let create =
            r#"{"jsonrpc":"2.0","id":1,"method":"thread/create","params":{"prompt":"first"}}"#;
        ws.send(Message::Text(create.into()))
            .await
            .expect("send thread/create frame");
        let create_body = next_text(&mut ws).await;
        let create_resp: serde_json::Value = serde_json::from_str(&create_body)
            .unwrap_or_else(|e| panic!("create response is JSON: {e} — body: {create_body}"));
        assert!(
            create_resp.get("error").is_none(),
            "thread/create with a real prompt is not an error — body: {create_body}"
        );
        let thread_id = create_resp["result"]["thread_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.thread_id is a string — body: {create_body}"))
            .to_string();
        let run_id_1 = create_resp["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — body: {create_body}"))
            .to_string();

        // ---- post_message into that Thread: a SECOND Run, new run_id ----
        let post = format!(
            r#"{{"jsonrpc":"2.0","id":2,"method":"run/post_message","params":{{"thread_id":"{thread_id}","prompt":"second"}}}}"#
        );
        ws.send(Message::Text(post.into()))
            .await
            .expect("send run/post_message frame");
        let post_body = next_text(&mut ws).await;
        let post_resp: serde_json::Value = serde_json::from_str(&post_body)
            .unwrap_or_else(|e| panic!("post response is JSON: {e} — body: {post_body}"));
        assert_eq!(post_resp["id"], serde_json::json!(2), "echoed id");
        assert!(
            post_resp.get("error").is_none(),
            "post into an existing thread is not an error — body: {post_body}"
        );
        let run_id_2 = post_resp["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — body: {post_body}"))
            .to_string();

        // The second Run's id is a fresh UUIDv7 distinct from the first.
        let parsed_2 = uuid::Uuid::parse_str(&run_id_2).expect("run_id_2 parses as UUID");
        assert_eq!(
            parsed_2.get_version(),
            Some(uuid::Version::SortRand),
            "run_id_2 is UUIDv7"
        );
        assert_ne!(run_id_2, run_id_1, "second run has a distinct run_id");

        // Drain both runs to done so the Workers finish cleanly.
        drain_run_to_done(&mut ws, 3, &run_id_1).await;
        drain_run_to_done(&mut ws, 4, &run_id_2).await;

        ws.close(None).await.ok();
        (thread_id, run_id_1, run_id_2)
    });

    drop(_core);

    // Open the DB read-only and assert one Thread, two Runs in it.
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
        assert_eq!(thread_count, 1, "exactly one thread row");

        let run_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM runs")
            .fetch_one(&pool)
            .await
            .expect("count runs");
        assert_eq!(run_count, 2, "exactly two run rows in the existing thread");

        // Both runs carry the same thread_id, and their ids are exactly the
        // two run ids the WS responses returned.
        let rows: Vec<(String, String)> =
            sqlx::query_as("SELECT id, thread_id FROM runs ORDER BY id")
                .fetch_all(&pool)
                .await
                .expect("read run rows");
        for (_id, run_thread_id) in &rows {
            assert_eq!(
                run_thread_id, &thread_id,
                "every run carries the existing thread_id"
            );
        }
        let mut ids: Vec<&str> = rows.iter().map(|(id, _)| id.as_str()).collect();
        ids.sort_unstable();
        let mut expected = [run_id_1.as_str(), run_id_2.as_str()];
        expected.sort_unstable();
        assert_eq!(ids, expected, "the two run ids match the WS responses");
    });
}

#[test]
fn post_message_unknown_thread_rejected() {
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

        // A well-formed UUIDv7 that was never created → unknown_thread.
        let bogus_thread = uuid::Uuid::now_v7().to_string();
        let post = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"run/post_message","params":{{"thread_id":"{bogus_thread}","prompt":"x"}}}}"#
        );
        ws.send(Message::Text(post.into()))
            .await
            .expect("send run/post_message frame");

        let body = next_text(&mut ws).await;
        let resp: serde_json::Value = serde_json::from_str(&body)
            .unwrap_or_else(|e| panic!("response is JSON: {e} — body: {body}"));
        assert_eq!(resp["id"], serde_json::json!(1), "echoed id");
        assert!(
            resp.get("result").is_none(),
            "rejected post carries no result — body: {body}"
        );
        assert_eq!(
            resp["error"]["code"],
            serde_json::json!(-32001),
            "unknown thread_id is rejected with unknown_thread (-32001) — body: {body}"
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

        let run_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM runs")
            .fetch_one(&pool)
            .await
            .expect("count runs");
        assert_eq!(run_count, 0, "unknown-thread rejection writes zero run rows");

        let thread_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM threads")
            .fetch_one(&pool)
            .await
            .expect("count threads");
        assert_eq!(
            thread_count, 0,
            "unknown-thread rejection writes zero thread rows"
        );
    });
}
