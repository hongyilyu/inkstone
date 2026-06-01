//! Slice 5 RED test: `thread/list` returns Thread summaries ordered by
//! most-recent activity first (newest `last_activity_at` first).
//!
//! `thread_list_returns_threads_newest_first`: create two Threads via
//! `thread/create` ("alpha" then "beta"), then `run/post_message` into the
//! FIRST Thread ("alpha") to bump its `last_activity_at` strictly newest.
//! `thread/list` (no params) then returns `{threads: [...]}` with the two
//! summaries ordered [alpha, beta] — alpha first because its activity was
//! bumped last — each carrying `{id, title, last_activity_at}`.
//!
//! Determinism: ms-granularity ties at create time are possible, so the test
//! does not rely on create order. After creating both Threads it sleeps ~10ms
//! and posts a "bump" message into alpha, which writes a strictly-later
//! `last_activity_at` (each new Run touches the Thread). Order is then
//! unambiguous: [alpha (bumped), beta].
//!
//! `thread/create` and `run/post_message` are pure-subscribe (ADR-0022): each
//! returns exactly ONE response frame and streams NO Run Events unless the
//! Client subscribes (this test never does). So the frames arrive in request
//! order and every read is bounded by a 5s timeout.
//!
//! Uses the REAL echo Worker (no fixture/gate) — this slice asserts the list
//! read, not mid-stream timing.

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use assert_cmd::cargo::CommandCargoExt;
use futures_util::{SinkExt, StreamExt};
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

/// Send a `thread/create` with `prompt`, read the single response frame, and
/// return its `thread_id`. Pure-subscribe: no events ride the response.
async fn create_thread(ws: &mut Ws, id: u32, prompt: &str) -> String {
    let create = format!(
        r#"{{"jsonrpc":"2.0","id":{id},"method":"thread/create","params":{{"prompt":"{prompt}"}}}}"#
    );
    ws.send(Message::Text(create.into()))
        .await
        .expect("send thread/create frame");
    let body = next_text(ws).await;
    let resp: serde_json::Value = serde_json::from_str(&body)
        .unwrap_or_else(|e| panic!("create response is JSON: {e} — body: {body}"));
    assert!(
        resp.get("error").is_none(),
        "thread/create with a real prompt is not an error — body: {body}"
    );
    resp["result"]["thread_id"]
        .as_str()
        .unwrap_or_else(|| panic!("result.thread_id is a string — body: {body}"))
        .to_string()
}

#[test]
fn thread_list_returns_threads_newest_first() {
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

        // ---- Create thread A ("alpha") then thread B ("beta") ----
        let thread_a = create_thread(&mut ws, 1, "alpha").await;
        let thread_b = create_thread(&mut ws, 2, "beta").await;

        // ---- Bump A's activity strictly newest ----
        // ms-granularity ties at create time are possible. Sleep ~10ms so the
        // bump's `now_ms()` is strictly greater, then post into A: each new
        // Run touches the Thread's `last_activity_at`, making A most-recent.
        tokio::time::sleep(Duration::from_millis(10)).await;
        let bump = format!(
            r#"{{"jsonrpc":"2.0","id":3,"method":"run/post_message","params":{{"thread_id":"{thread_a}","prompt":"bump"}}}}"#
        );
        ws.send(Message::Text(bump.into()))
            .await
            .expect("send run/post_message bump frame");
        let bump_body = next_text(&mut ws).await;
        let bump_resp: serde_json::Value = serde_json::from_str(&bump_body)
            .unwrap_or_else(|e| panic!("bump response is JSON: {e} — body: {bump_body}"));
        assert!(
            bump_resp.get("error").is_none(),
            "post_message into an existing thread is not an error — body: {bump_body}"
        );

        // ---- thread/list (no params): read until the id:99 response ----
        let list = r#"{"jsonrpc":"2.0","id":99,"method":"thread/list","params":{}}"#;
        ws.send(Message::Text(list.into()))
            .await
            .expect("send thread/list frame");

        // Read bounded frames until the thread/list response (id:99) arrives.
        // (No events stream on this connection — nothing was subscribed — so
        // this resolves on the very next frame; the loop just guards against
        // any stray frame and keeps every read bounded.)
        let resp = loop {
            let body = next_text(&mut ws).await;
            let v: serde_json::Value = serde_json::from_str(&body)
                .unwrap_or_else(|e| panic!("thread/list frame is JSON: {e} — body: {body}"));
            if v["id"] == serde_json::json!(99) {
                break v;
            }
        };

        assert!(
            resp.get("error").is_none(),
            "thread/list is read-only and must not error — body: {resp}"
        );
        assert!(
            resp.get("method").is_none(),
            "thread/list response is a result, not a notification — body: {resp}"
        );

        let threads = resp["result"]["threads"]
            .as_array()
            .unwrap_or_else(|| panic!("result.threads is an array — body: {resp}"));
        assert_eq!(threads.len(), 2, "exactly two threads — body: {resp}");

        // Newest-first: A ("alpha", bumped) precedes B ("beta").
        let first_id = threads[0]["id"]
            .as_str()
            .unwrap_or_else(|| panic!("threads[0].id is a string — body: {resp}"));
        let first_title = threads[0]["title"]
            .as_str()
            .unwrap_or_else(|| panic!("threads[0].title is a string — body: {resp}"));
        let first_activity = threads[0]["last_activity_at"]
            .as_i64()
            .unwrap_or_else(|| panic!("threads[0].last_activity_at is an integer — body: {resp}"));

        let second_id = threads[1]["id"]
            .as_str()
            .unwrap_or_else(|| panic!("threads[1].id is a string — body: {resp}"));
        let second_title = threads[1]["title"]
            .as_str()
            .unwrap_or_else(|| panic!("threads[1].title is a string — body: {resp}"));
        let second_activity = threads[1]["last_activity_at"]
            .as_i64()
            .unwrap_or_else(|| panic!("threads[1].last_activity_at is an integer — body: {resp}"));

        assert_eq!(first_id, thread_a, "newest thread is A — body: {resp}");
        assert_eq!(first_title, "alpha", "A's title is its prompt — body: {resp}");
        assert_eq!(second_id, thread_b, "older thread is B — body: {resp}");
        assert_eq!(second_title, "beta", "B's title is its prompt — body: {resp}");
        assert!(
            first_activity >= second_activity,
            "threads are ordered by last_activity_at DESC ({first_activity} >= {second_activity}) — body: {resp}"
        );

        ws.close(None).await.ok();
    });
}
