//! Slice 6 RED test: `thread/get(thread_id)` returns a Thread's messages
//! with assembled text (ADR-0022 read path, ADR-0017 flat-text-no-parts[]).
//!
//! `thread/get` returns `{thread_id, title, messages: [{id, role, status,
//! run_id, text}]}` in chronological order, where each message's `text` is
//! the concatenation of its text parts. A COMPLETED Run yields the full user
//! + assistant text; a MID-STREAM Run yields a `streaming` assistant message
//! carrying its partial text and `run_id` (so a refreshed Client can
//! resubscribe). This is the rehydration source for refresh-durability.
//!
//! Message ordering is `created_at, rowid` — the user message is inserted
//! before the assistant message in the same ms, so the rowid tiebreaker keeps
//! the user message first on a ms-tie.
//!
//! Test 1 uses the REAL echo Worker (drains to `done` for the completed
//! case). Test 2 uses the slice-0 slow-worker fixture (`INKSTONE_FIXTURE_CHUNKS=2`
//! + a gate) to hold the Run mid-stream while `thread/get` is issued on a
//! SECOND connection (no subscribe on it, so its only frame is the response).

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
/// serially or they collide. Each acquires this lock for Core's lifetime.
fn port_lock() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

/// Drop guard around `Child` that SIGKILLs and reaps on drop, so a panicking
/// test cannot leak Core (which holds the fixed port and blocks reruns).
struct CoreChild(Option<Child>);

impl Drop for CoreChild {
    fn drop(&mut self) {
        if let Some(mut c) = self.0.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

fn repo_root() -> &'static Path {
    // <repo>/crates/core/tests/thread_get.rs → CARGO_MANIFEST_DIR = <repo>/crates/core
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    Box::leak(
        manifest_dir
            .parent()
            .and_then(Path::parent)
            .expect("repo root resolves from <repo>/crates/core")
            .to_path_buf()
            .into_boxed_path(),
    )
}

/// Block on Core's stdout until `INKSTONE_LISTENING` appears; return the
/// reaped-on-drop child guard and the `ws://…/ws` URL.
fn await_listening(mut child: Child) -> (CoreChild, String) {
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

/// Spawn Core wired to the REAL echo Worker.
fn spawn_core_real(db_path: &Path) -> (CoreChild, String) {
    let root = repo_root();
    let tsx = root.join("packages/worker/node_modules/.bin/tsx");
    let cli = root.join("packages/worker/src/cli.ts");
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

    let child = std::process::Command::cargo_bin("core")
        .expect("core binary exists")
        .current_dir(root)
        .env("INKSTONE_WORKER_CMD", &worker_cmd)
        .env("INKSTONE_DB_PATH", db_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("core spawns");

    await_listening(child)
}

/// Spawn Core wired to the slice-0 slow-worker fixture (chunks + gate).
fn spawn_core_fixture(db_path: &Path, gate_path: &Path, chunks: &str) -> (CoreChild, String) {
    let root = repo_root();
    let tsx = root.join("packages/worker/node_modules/.bin/tsx");
    let fixture = root.join("crates/core/tests/fixtures/slow-worker.ts");
    if !tsx.exists() {
        panic!(
            "worker tsx not installed at {} — run `pnpm install` at repo root",
            tsx.display()
        );
    }
    if !fixture.exists() {
        panic!("slow-worker fixture not found at {}", fixture.display());
    }
    let worker_cmd = format!("{} {}", tsx.display(), fixture.display());

    let child = std::process::Command::cargo_bin("core")
        .expect("core binary exists")
        .current_dir(root)
        .env("INKSTONE_WORKER_CMD", &worker_cmd)
        .env("INKSTONE_DB_PATH", db_path)
        .env("INKSTONE_FIXTURE_CHUNKS", chunks)
        .env("INKSTONE_FIXTURE_GATE", gate_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("core spawns");

    await_listening(child)
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

/// Read frames (bounded) until one whose `id` matches `want_id`, skipping
/// any interleaved `run/event` notifications. Returns the parsed response.
async fn read_response_with_id(ws: &mut Ws, want_id: i64) -> serde_json::Value {
    loop {
        let body = next_text(ws).await;
        let v: serde_json::Value = serde_json::from_str(&body)
            .unwrap_or_else(|e| panic!("frame is JSON: {e} — body: {body}"));
        if v["id"] == serde_json::json!(want_id) {
            return v;
        }
    }
}

async fn send(ws: &mut Ws, frame: String) {
    ws.send(Message::Text(frame.into()))
        .await
        .expect("send frame");
}

#[test]
fn thread_get_completed_run_returns_full_text() {
    let _guard = port_lock();

    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");

    let (_core, ws_url) = spawn_core_real(&db_path);

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let (mut ws, _resp) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .expect("ws handshake succeeds");

        // ---- thread/create{prompt:"hi"} → {thread_id, run_id} ----
        send(
            &mut ws,
            r#"{"jsonrpc":"2.0","id":1,"method":"thread/create","params":{"prompt":"hi"}}"#
                .to_string(),
        )
        .await;
        let create = read_response_with_id(&mut ws, 1).await;
        let thread_id = create["result"]["thread_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.thread_id is a string — {create}"))
            .to_string();
        let run_id = create["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — {create}"))
            .to_string();

        // ---- subscribe + drain to done so the assistant text is fully
        // persisted ("echo: hi") and its status flips to completed ----
        send(
            &mut ws,
            format!(
                r#"{{"jsonrpc":"2.0","id":2,"method":"run/subscribe","params":{{"run_id":"{run_id}"}}}}"#
            ),
        )
        .await;
        let _sub_resp = read_response_with_id(&mut ws, 2).await;
        loop {
            let body = next_text(&mut ws).await;
            let v: serde_json::Value = serde_json::from_str(&body)
                .unwrap_or_else(|e| panic!("tail frame is JSON: {e} — body: {body}"));
            if v["params"]["event"]["kind"] == serde_json::json!("done") {
                break;
            }
        }

        // ---- thread/get{thread_id} (distinct ids from 50). The subscribe
        // `done` is published by the Worker BEFORE its terminal tx commits
        // the status flip (worker.rs: publish under the gate, then
        // `complete_run` after stdout EOF), so the assistant status may still
        // read `streaming` for a beat after we observe `done`. Poll
        // thread/get (bounded ~5s) until the assistant settles to
        // `completed`; the text is already fully assembled. ----
        let got = {
            let mut req_id = 50;
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                send(
                    &mut ws,
                    format!(
                        r#"{{"jsonrpc":"2.0","id":{req_id},"method":"thread/get","params":{{"thread_id":"{thread_id}"}}}}"#
                    ),
                )
                .await;
                let resp = read_response_with_id(&mut ws, req_id).await;
                let settled = resp["result"]["messages"]
                    .as_array()
                    .and_then(|m| m.get(1))
                    .map(|asst| asst["status"] == serde_json::json!("completed"))
                    .unwrap_or(false);
                if settled || Instant::now() > deadline {
                    break resp;
                }
                req_id += 1;
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        };

        assert!(
            got.get("error").is_none(),
            "thread/get for a known thread is not an error — {got}"
        );
        assert_eq!(
            got["result"]["thread_id"],
            serde_json::json!(thread_id),
            "result.thread_id echoes the requested thread_id — {got}"
        );
        let title = got["result"]["title"]
            .as_str()
            .unwrap_or_else(|| panic!("result.title is a string — {got}"));
        assert!(!title.is_empty(), "title is non-empty — {got}");

        let messages = got["result"]["messages"]
            .as_array()
            .unwrap_or_else(|| panic!("result.messages is an array — {got}"));
        assert_eq!(messages.len(), 2, "two messages (user + assistant) — {got}");

        // [0] = user, completed, text == "hi", run_id == run_id
        let user = &messages[0];
        assert_eq!(user["role"], serde_json::json!("user"), "messages[0] role — {got}");
        assert_eq!(
            user["status"],
            serde_json::json!("completed"),
            "user message completed — {got}"
        );
        assert_eq!(user["text"], serde_json::json!("hi"), "user text — {got}");
        assert_eq!(
            user["run_id"],
            serde_json::json!(run_id),
            "user run_id — {got}"
        );
        assert!(
            user["id"].as_str().is_some_and(|s| !s.is_empty()),
            "user message id present — {got}"
        );

        // [1] = assistant, completed, text == "echo: hi", run_id == run_id
        let asst = &messages[1];
        assert_eq!(
            asst["role"],
            serde_json::json!("assistant"),
            "messages[1] role — {got}"
        );
        assert_eq!(
            asst["status"],
            serde_json::json!("completed"),
            "assistant completed after done — {got}"
        );
        assert_eq!(
            asst["text"],
            serde_json::json!("echo: hi"),
            "assistant assembled text — {got}"
        );
        assert_eq!(
            asst["run_id"],
            serde_json::json!(run_id),
            "assistant run_id — {got}"
        );

        ws.close(None).await.ok();
    });
}

#[test]
fn thread_get_midstream_run_returns_streaming_partial() {
    let _guard = port_lock();

    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");
    let gate_path = tmp.path().join("gate");
    assert!(!gate_path.exists(), "gate must not exist before release");

    // chunks=2: "echo: hello" → chunk1 "echo: ", BLOCK on gate, chunk2
    // "hello" + done. Holding the gate keeps the Run mid-stream.
    let (_core, ws_url) = spawn_core_fixture(&db_path, &gate_path, "2");

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        // Connection A: create + subscribe (held mid-stream on the gate).
        let (mut ws_a, _resp_a) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .expect("ws A handshake succeeds");
        // Connection B: pre-open; thread/get runs here with NO subscribe, so
        // its only frame is the thread/get response (no interleaved events).
        let (mut ws_b, _resp_b) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .expect("ws B handshake succeeds");

        // ---- thread/create{prompt:"hello"} → {thread_id, run_id} ----
        send(
            &mut ws_a,
            r#"{"jsonrpc":"2.0","id":1,"method":"thread/create","params":{"prompt":"hello"}}"#
                .to_string(),
        )
        .await;
        let create = read_response_with_id(&mut ws_a, 1).await;
        let thread_id = create["result"]["thread_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.thread_id is a string — {create}"))
            .to_string();
        let run_id = create["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — {create}"))
            .to_string();

        // ---- subscribe on A; accumulate snapshot + tail text_deltas until
        // chunk1 ("echo: ") has landed, which (persist-before-publish in the
        // Worker) proves it is persisted. The gate is NOT tripped, so the
        // Worker is blocked after chunk1 — no further frames arrive. ----
        send(
            &mut ws_a,
            format!(
                r#"{{"jsonrpc":"2.0","id":2,"method":"run/subscribe","params":{{"run_id":"{run_id}"}}}}"#
            ),
        )
        .await;
        let _sub_resp = read_response_with_id(&mut ws_a, 2).await;
        let mut assembled = String::new();
        while assembled != "echo: " {
            let body = next_text(&mut ws_a).await;
            let v: serde_json::Value = serde_json::from_str(&body)
                .unwrap_or_else(|e| panic!("A tail frame is JSON: {e} — body: {body}"));
            if v["params"]["event"]["kind"] == serde_json::json!("text_delta") {
                assembled.push_str(
                    v["params"]["event"]["delta"]
                        .as_str()
                        .unwrap_or_else(|| panic!("text_delta carries a string — {body}")),
                );
            }
        }

        // ---- thread/get on B WITHOUT tripping the gate (distinct id 60) ----
        send(
            &mut ws_b,
            format!(
                r#"{{"jsonrpc":"2.0","id":60,"method":"thread/get","params":{{"thread_id":"{thread_id}"}}}}"#
            ),
        )
        .await;
        let got = read_response_with_id(&mut ws_b, 60).await;

        assert!(
            got.get("error").is_none(),
            "thread/get mid-stream is not an error — {got}"
        );
        let messages = got["result"]["messages"]
            .as_array()
            .unwrap_or_else(|| panic!("result.messages is an array — {got}"));
        assert_eq!(messages.len(), 2, "two messages (user + assistant) — {got}");

        // user: completed, text == "hello"
        let user = &messages[0];
        assert_eq!(user["role"], serde_json::json!("user"), "messages[0] role — {got}");
        assert_eq!(
            user["status"],
            serde_json::json!("completed"),
            "user completed — {got}"
        );
        assert_eq!(user["text"], serde_json::json!("hello"), "user text — {got}");

        // assistant: streaming, text is a NON-EMPTY prefix of "echo: hello"
        // that is NOT yet the full text, carrying run_id for resubscribe.
        let asst = &messages[1];
        assert_eq!(
            asst["role"],
            serde_json::json!("assistant"),
            "messages[1] role — {got}"
        );
        assert_eq!(
            asst["status"],
            serde_json::json!("streaming"),
            "assistant still streaming mid-run — {got}"
        );
        let asst_text = asst["text"]
            .as_str()
            .unwrap_or_else(|| panic!("assistant text is a string — {got}"));
        assert!(!asst_text.is_empty(), "assistant partial text non-empty — {got}");
        assert!(
            "echo: hello".starts_with(asst_text),
            "assistant text is a prefix of the full output — got {asst_text:?}"
        );
        assert_ne!(
            asst_text, "echo: hello",
            "assistant text is still PARTIAL (not the full output) — {got}"
        );
        assert_eq!(
            asst["run_id"],
            serde_json::json!(run_id),
            "assistant carries run_id so the Client can resubscribe — {got}"
        );

        // ---- trip the gate + drain A to done so Core finishes cleanly ----
        std::fs::write(&gate_path, b"go").expect("create gate file");
        loop {
            let body = next_text(&mut ws_a).await;
            let v: serde_json::Value = serde_json::from_str(&body)
                .unwrap_or_else(|e| panic!("A drain frame is JSON: {e} — body: {body}"));
            if v["params"]["event"]["kind"] == serde_json::json!("done") {
                break;
            }
        }

        ws_a.close(None).await.ok();
        ws_b.close(None).await.ok();
    });
}
