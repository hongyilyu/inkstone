//! Slice 1 RED test: `run/post_message` is pure-subscribe and
//! `run/subscribe(run_id)` is snapshot-then-tail (ADR-0022).
//!
//! After `run/post_message` returns `{run_id}` — with NO Run Events on the
//! response frame — a subsequent `run/subscribe(run_id)` receives the
//! assistant text as a cumulative `text_delta` snapshot, then the live tail
//! deltas, then a terminal `done`. Worker events flow through a per-run hub,
//! not the originating connection's channel.
//!
//! Determinism comes from the slice-0 slow-worker fixture: with
//! `INKSTONE_FIXTURE_CHUNKS=2` it splits `echo: hello` into `"echo: "` +
//! `"hello"`, emits chunk 1, then BLOCKS on a test-controlled gate file
//! before emitting chunk 2 + `done`. The test trips the gate after it has
//! subscribed, so the snapshot/tail boundary is exercised under control —
//! `snapshot_cumulative_text ++ concat(tail incremental deltas)` must equal
//! `echo: hello` with no loss or duplication (the per-run gate's job).

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use assert_cmd::cargo::CommandCargoExt;
use futures_util::{SinkExt, StreamExt};
use tempfile::TempDir;
use tokio_tungstenite::tungstenite::Message;

/// Core binds a fixed port (8765); the two tests in this binary must run
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

/// Spawn Core wired to the slice-0 slow-worker fixture and block on its
/// stdout until `INKSTONE_LISTENING` appears. Returns the reaped-on-drop
/// child guard and the `ws://…/ws` URL. `chunks`/`gate_path` are passed
/// through to the fixture via Core's env (the worker child inherits it).
fn spawn_core_with_fixture(
    db_path: &Path,
    gate_path: &Path,
    chunks: &str,
) -> (CoreChild, String) {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .expect("repo root resolves from <repo>/crates/core");

    let tsx = repo_root.join("packages/worker/node_modules/.bin/tsx");
    let fixture = repo_root.join("crates/core/tests/fixtures/slow-worker.ts");
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

    let mut child = std::process::Command::cargo_bin("core")
        .expect("core binary exists")
        .current_dir(repo_root)
        .env("INKSTONE_WORKER_CMD", &worker_cmd)
        .env("INKSTONE_DB_PATH", db_path)
        .env("INKSTONE_FIXTURE_CHUNKS", chunks)
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
fn subscribe_malformed_run_id_is_invalid_params() {
    let _guard = port_lock();

    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");
    let gate_path = tmp.path().join("gate");

    let (_core, ws_url) = spawn_core_with_fixture(&db_path, &gate_path, "1");

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let (mut ws, _resp) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .expect("ws handshake succeeds");

        // A malformed run_id. Before ADR-0029 subscribe framed this as an
        // internal error (-32603); typed-at-decode (C2) makes it the same
        // invalid_params (-32602) every other method returns.
        let sub =
            r#"{"jsonrpc":"2.0","id":9,"method":"run/subscribe","params":{"run_id":"not-a-uuid"}}"#;
        ws.send(Message::Text(sub.into()))
            .await
            .expect("send subscribe");

        let frame = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("frame within 5s")
            .expect("frame present")
            .expect("frame ok");
        let body = match frame {
            Message::Text(t) => t.to_string(),
            other => panic!("expected text frame, got {other:?}"),
        };
        let v: serde_json::Value = serde_json::from_str(&body).expect("json response");
        assert_eq!(v["id"], serde_json::json!(9), "echoed id");
        assert_eq!(
            v["error"]["code"],
            serde_json::json!(-32602),
            "malformed run_id rejected with invalid_params (-32602) — body: {body}"
        );

        ws.close(None).await.ok();
    });
}

#[test]
fn subscribe_snapshot_then_tail() {
    let _guard = port_lock();

    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");
    let gate_path = tmp.path().join("gate");
    assert!(!gate_path.exists(), "gate must not exist before release");

    let (_core, ws_url) = spawn_core_with_fixture(&db_path, &gate_path, "2");

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let (mut ws, _resp) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .expect("ws handshake succeeds");

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

        // ---- post_message: returns {run_id}, NO events on the frame ----
        let post = r#"{"jsonrpc":"2.0","id":1,"method":"thread/create","params":{"prompt":"hello"}}"#;
        ws.send(Message::Text(post.into()))
            .await
            .expect("send post_message frame");

        let response_body = next_text(&mut ws).await;
        let response: serde_json::Value = serde_json::from_str(&response_body)
            .unwrap_or_else(|e| panic!("response is JSON: {e} — body: {response_body}"));
        assert_eq!(response["jsonrpc"], serde_json::json!("2.0"), "jsonrpc");
        assert_eq!(response["id"], serde_json::json!(1), "echoed id");
        // The response frame carries ONLY the result — it is NOT a run/event.
        assert!(
            response.get("method").is_none(),
            "post_message response has no method (not a notification) — body: {response_body}"
        );
        assert!(
            response["params"].get("event").is_none(),
            "post_message response carries no event — body: {response_body}"
        );
        let run_id = response["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — body: {response_body}"))
            .to_string();
        let parsed = uuid::Uuid::parse_str(&run_id).expect("run_id parses as UUID");
        assert_eq!(
            parsed.get_version(),
            Some(uuid::Version::SortRand),
            "run_id is UUIDv7"
        );

        // ---- subscribe: response, then snapshot text_delta, then tail ----
        let subscribe = format!(
            r#"{{"jsonrpc":"2.0","id":2,"method":"run/subscribe","params":{{"run_id":"{run_id}"}}}}"#
        );
        ws.send(Message::Text(subscribe.into()))
            .await
            .expect("send run/subscribe frame");

        // First frame back is the subscribe RESPONSE (resolves the request).
        let sub_resp_body = next_text(&mut ws).await;
        let sub_resp: serde_json::Value = serde_json::from_str(&sub_resp_body)
            .unwrap_or_else(|e| panic!("subscribe response is JSON: {e} — body: {sub_resp_body}"));
        assert_eq!(sub_resp["id"], serde_json::json!(2), "subscribe response id");
        assert!(
            sub_resp.get("method").is_none(),
            "subscribe response is a response, not a notification — body: {sub_resp_body}"
        );

        // Next frame is the SNAPSHOT: a cumulative text_delta. Its content may
        // be "" or "echo: " depending on whether the worker persisted chunk 1
        // before the subscribe acquired the gate — do NOT hard-assert it.
        let snapshot_body = next_text(&mut ws).await;
        let snapshot: serde_json::Value = serde_json::from_str(&snapshot_body)
            .unwrap_or_else(|e| panic!("snapshot is JSON: {e} — body: {snapshot_body}"));
        assert_eq!(
            snapshot["method"],
            serde_json::json!("run/event"),
            "snapshot is a run/event — body: {snapshot_body}"
        );
        assert_eq!(
            snapshot["params"]["run_id"],
            serde_json::json!(run_id),
            "snapshot run_id matches"
        );
        assert_eq!(
            snapshot["params"]["event"]["kind"],
            serde_json::json!("text_delta"),
            "snapshot is a text_delta — body: {snapshot_body}"
        );
        let mut assembled = snapshot["params"]["event"]["delta"]
            .as_str()
            .unwrap_or_else(|| panic!("snapshot text_delta carries a string — body: {snapshot_body}"))
            .to_string();

        // ---- trip the gate so the worker emits chunk 2 + done ----
        std::fs::write(&gate_path, b"go").expect("create gate file");

        // ---- read the tail: incremental text_deltas then a terminal done ----
        // The loop only exits via the `done` arm's `break`; every other path
        // panics, so reaching the line after the loop proves the terminal frame
        // was a `done`.
        loop {
            let body = next_text(&mut ws).await;
            let v: serde_json::Value = serde_json::from_str(&body)
                .unwrap_or_else(|e| panic!("tail frame is JSON: {e} — body: {body}"));
            assert_eq!(
                v["method"],
                serde_json::json!("run/event"),
                "tail frame is a run/event — body: {body}"
            );
            match v["params"]["event"]["kind"].as_str() {
                Some("text_delta") => {
                    assembled.push_str(
                        v["params"]["event"]["delta"]
                            .as_str()
                            .unwrap_or_else(|| panic!("tail text_delta carries a string — body: {body}")),
                    );
                }
                Some("done") => break,
                other => panic!("unexpected tail event kind {other:?} — body: {body}"),
            }
        }

        ws.close(None).await.ok();

        assert_eq!(
            assembled, "echo: hello",
            "snapshot + tail reassembles to the full echo output exactly once"
        );
    });
}

/// Regression (iteration 2): a `run/subscribe` that attaches at or after a
/// Run's terminal `done` MUST still receive a terminal `done` and never hang.
///
/// The bug: the Worker publishes `Done` to the broadcast channel under the
/// gate, releases the gate, runs the terminal SQLite tx (multi-ms), and only
/// THEN removes the hub entry. A subscribe landing in that window takes the
/// streaming (`Some`) branch, calls `tx.subscribe()` — positioned AFTER the
/// already-broadcast `Done`, which `tokio::broadcast` does not replay — and
/// the forwarder would block forever, never delivering `done`. The fix:
/// `spawn_tail_forwarder` synthesizes a `done` on channel close if it never
/// forwarded one.
///
/// Determinism/bounding: the first subscribe drains to `done`, proving the
/// Worker published it. A SECOND WS connection (pre-opened so there is zero
/// setup latency) then subscribes to the SAME run_id the instant the first
/// `done` is observed — landing at or just after terminal, which is exactly
/// the race window. EVERY frame read is bounded by a 5s timeout, so a
/// regression (the hang) fails fast as a timeout rather than blocking CI.
/// The late subscriber must deliver a snapshot `text_delta` (cumulative
/// `echo: hello`) and a terminal `done`; this holds whether it lands in the
/// `Some`-branch-after-done window (synthesize-on-close) or the already-
/// removed `None` branch (which synthesizes `done` directly).
#[test]
fn late_subscribe_after_terminal_still_gets_done() {
    let _guard = port_lock();

    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");
    // chunks=1: the fixture emits the sole `echo: hello` chunk, then blocks on
    // the gate, then emits `done`. Tripping the gate releases `done`, giving
    // the test a controlled "Worker has now published done" instant.
    let gate_path = tmp.path().join("gate");

    let (_core, ws_url) = spawn_core_with_fixture(&db_path, &gate_path, "1");

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        async fn next_text(
            ws: &mut tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
        ) -> String {
            let frame = tokio::time::timeout(Duration::from_secs(5), ws.next())
                .await
                .expect("frame within 5s (a hang here is the regression)")
                .expect("frame present")
                .expect("frame ok");
            match frame {
                Message::Text(t) => t.to_string(),
                other => panic!("expected text frame, got {other:?}"),
            }
        }

        // Connection A: post + first subscribe, drained to done.
        let (mut ws_a, _resp) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .expect("ws A handshake succeeds");

        // Connection B: pre-open so there is no setup latency between seeing
        // the first `done` and issuing the late subscribe (maximizes the
        // chance of landing in the Some-branch-after-done race window).
        let (mut ws_b, _resp_b) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .expect("ws B handshake succeeds");

        let post = r#"{"jsonrpc":"2.0","id":1,"method":"thread/create","params":{"prompt":"hello"}}"#;
        ws_a.send(Message::Text(post.into()))
            .await
            .expect("send post_message frame");
        let response_body = next_text(&mut ws_a).await;
        let response: serde_json::Value = serde_json::from_str(&response_body)
            .unwrap_or_else(|e| panic!("response is JSON: {e} — body: {response_body}"));
        let run_id = response["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — body: {response_body}"))
            .to_string();

        // First subscribe on A. With chunks=1 the fixture emits the sole
        // chunk, then blocks on the gate before `done`; trip the gate so the
        // Worker publishes `done`.
        let subscribe_a = format!(
            r#"{{"jsonrpc":"2.0","id":2,"method":"run/subscribe","params":{{"run_id":"{run_id}"}}}}"#
        );
        ws_a.send(Message::Text(subscribe_a.into()))
            .await
            .expect("send subscribe A frame");
        let _sub_a_resp = next_text(&mut ws_a).await; // subscribe response
        let _snapshot_a = next_text(&mut ws_a).await; // snapshot text_delta

        std::fs::write(&gate_path, b"go").expect("create gate file");

        // Drain A to its terminal done — this proves the Worker published it.
        loop {
            let body = next_text(&mut ws_a).await;
            let v: serde_json::Value = serde_json::from_str(&body)
                .unwrap_or_else(|e| panic!("A tail frame is JSON: {e} — body: {body}"));
            if v["params"]["event"]["kind"] == serde_json::json!("done") {
                break;
            }
        }

        // The INSTANT the first done is observed, issue the late subscribe on
        // B. The Worker is now running its terminal tx (and has not yet
        // removed the hub), so B's subscribe may take the Some branch and
        // attach AFTER the broadcast `Done` — the exact race the fix closes.
        let subscribe_b = format!(
            r#"{{"jsonrpc":"2.0","id":3,"method":"run/subscribe","params":{{"run_id":"{run_id}"}}}}"#
        );
        ws_b.send(Message::Text(subscribe_b.into()))
            .await
            .expect("send subscribe B frame");

        // B's subscribe response.
        let sub_b_resp_body = next_text(&mut ws_b).await;
        let sub_b_resp: serde_json::Value = serde_json::from_str(&sub_b_resp_body)
            .unwrap_or_else(|e| panic!("B subscribe response is JSON: {e} — body: {sub_b_resp_body}"));
        assert_eq!(sub_b_resp["id"], serde_json::json!(3), "B subscribe response id");

        // B MUST receive a snapshot text_delta then a terminal done within the
        // bounded timeout — never hang. (Before the fix, a Some-branch B
        // hangs here and the 5s timeout fails the test.) The loop only exits
        // via the `done` arm's `break`; reaching the line after it proves a
        // terminal `done` was delivered.
        let mut assembled = String::new();
        loop {
            let body = next_text(&mut ws_b).await;
            let v: serde_json::Value = serde_json::from_str(&body)
                .unwrap_or_else(|e| panic!("B frame is JSON: {e} — body: {body}"));
            assert_eq!(
                v["method"],
                serde_json::json!("run/event"),
                "B frame is a run/event — body: {body}"
            );
            match v["params"]["event"]["kind"].as_str() {
                Some("text_delta") => {
                    assembled.push_str(
                        v["params"]["event"]["delta"]
                            .as_str()
                            .unwrap_or_else(|| panic!("B text_delta carries a string — body: {body}")),
                    );
                }
                Some("done") => break,
                other => panic!("unexpected B event kind {other:?} — body: {body}"),
            }
        }

        ws_a.close(None).await.ok();
        ws_b.close(None).await.ok();

        assert_eq!(
            assembled, "echo: hello",
            "late subscriber's snapshot reassembles to the full echo output"
        );
    });
}
