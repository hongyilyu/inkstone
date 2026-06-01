//! Slice 2 tests: a dropped connection does not kill the live stream
//! (connection-decouple) and the snapshot/tail boundary is exactly-once
//! (ADR-0022 §19-28, ADR-0012).
//!
//! `dropped_connection_does_not_kill_run` is the headline "refresh
//! mid-stream" behavior proven at the WS level: connection A starts a Run
//! and subscribes, then drops BEFORE the Worker finishes (the fixture is
//! blocked on its gate). Connection B re-subscribes to the same `run_id`,
//! trips the gate, and must receive the partial snapshot plus the remaining
//! tail plus a terminal `done`. The Worker keeps running and persisting
//! across A's drop (ADR-0012: a dropped connection does not end a Run), and
//! the final persisted assistant text is complete.
//!
//! `exactly_once_subscribe_during_inflight_persist` is the per-run-gate
//! proof: subscribe while the Worker is mid-stream (gate held), trip the
//! gate, drain to `done`, and assert the reassembled `snapshot ++ tail`
//! equals `echo: hello` EXACTLY — every chunk present exactly once, no loss
//! or duplication across the snapshot/tail boundary.
//!
//! Determinism comes from the slice-0 slow-worker fixture: with
//! `INKSTONE_FIXTURE_CHUNKS=3` it splits `echo: hello` into three
//! INCREMENTAL pieces (`"echo"` + `": he"` + `"llo"`), emits chunk 1, then
//! BLOCKS on a test-controlled gate file before emitting chunks 2-3 + `done`.
//! Tripping the gate releases the rest. Every WS read is bounded by a 5s
//! timeout so a regression (e.g. the Worker dying when A drops → B never
//! gets `done`) fails fast as a timeout rather than hanging CI.

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

/// Convenience alias for the concrete tungstenite client stream type so the
/// shared `next_text` helper can name it without a generic.
type WsStream = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

/// Core binds a fixed port (8765); the two tests in this binary must run
/// serially or they collide. Cargo runs tests within a binary in parallel
/// by default, so each acquires this lock for the full Core lifetime. (The
/// verify phase additionally runs `--test-threads=1` so binaries don't
/// collide with each other.)
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
/// through to the fixture via Core's env (the Worker child inherits it).
fn spawn_core_with_fixture(db_path: &Path, gate_path: &Path, chunks: &str) -> (CoreChild, String) {
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

/// Read the next WS text frame, bounded by a 5s timeout. A hang (e.g. a
/// regression where the Worker dies on a connection drop and a re-subscriber
/// never gets `done`) fails fast here instead of blocking CI.
async fn next_text(ws: &mut WsStream) -> String {
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

/// Send `run/post_message` on `ws` and return the minted `run_id`.
async fn post_message(ws: &mut WsStream, id: u32) -> String {
    let post = format!(
        r#"{{"jsonrpc":"2.0","id":{id},"method":"run/post_message","params":{{"prompt":"hello"}}}}"#
    );
    ws.send(Message::Text(post.into()))
        .await
        .expect("send post_message frame");
    let response_body = next_text(ws).await;
    let response: serde_json::Value = serde_json::from_str(&response_body)
        .unwrap_or_else(|e| panic!("response is JSON: {e} — body: {response_body}"));
    response["result"]["run_id"]
        .as_str()
        .unwrap_or_else(|| panic!("result.run_id is a string — body: {response_body}"))
        .to_string()
}

/// Send `run/subscribe(run_id)` on `ws`, read the subscribe RESPONSE and the
/// snapshot `text_delta`, and return the cumulative snapshot text (the
/// reassembly base). The snapshot may be `""` or a partial chunk depending on
/// whether the Worker persisted chunk 1 before the subscribe took the gate —
/// either way `snapshot ++ tail` reassembles to the full output (the gate's
/// exactly-once guarantee), so callers must not hard-assert its content.
async fn subscribe_and_read_snapshot(ws: &mut WsStream, id: u32, run_id: &str) -> String {
    let subscribe = format!(
        r#"{{"jsonrpc":"2.0","id":{id},"method":"run/subscribe","params":{{"run_id":"{run_id}"}}}}"#
    );
    ws.send(Message::Text(subscribe.into()))
        .await
        .expect("send run/subscribe frame");

    let sub_resp_body = next_text(ws).await;
    let sub_resp: serde_json::Value = serde_json::from_str(&sub_resp_body)
        .unwrap_or_else(|e| panic!("subscribe response is JSON: {e} — body: {sub_resp_body}"));
    assert_eq!(
        sub_resp["id"],
        serde_json::json!(id),
        "subscribe response id — body: {sub_resp_body}"
    );
    assert!(
        sub_resp.get("method").is_none(),
        "subscribe response is a response, not a notification — body: {sub_resp_body}"
    );

    let snapshot_body = next_text(ws).await;
    let snapshot: serde_json::Value = serde_json::from_str(&snapshot_body)
        .unwrap_or_else(|e| panic!("snapshot is JSON: {e} — body: {snapshot_body}"));
    assert_eq!(
        snapshot["params"]["event"]["kind"],
        serde_json::json!("text_delta"),
        "snapshot is a text_delta — body: {snapshot_body}"
    );
    snapshot["params"]["event"]["delta"]
        .as_str()
        .unwrap_or_else(|| panic!("snapshot text_delta carries a string — body: {snapshot_body}"))
        .to_string()
}

/// Drain `ws`'s tail starting from `base`, appending each incremental
/// `text_delta`, until the terminal `done`. Returns the reassembled text.
///
/// Simple concatenation is correct for the echo fixture: with the 256-slot
/// broadcast buffer and ≤3 deltas, `RecvError::Lagged` never fires, so the
/// server never re-snapshots (which would re-send cumulative text). Every
/// tail frame is therefore an incremental append. The loop only exits via the
/// `done` arm's `break`, so reaching the line after it proves the terminal
/// frame was a `done`.
async fn drain_tail_to_done(ws: &mut WsStream, base: String) -> String {
    let mut assembled = base;
    loop {
        let body = next_text(ws).await;
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
    assembled
}

/// A dropped connection does not kill the Run: A starts + subscribes, drops
/// before the gate trips, B re-subscribes and drains to `done`, and the
/// persisted assistant text is complete (ADR-0012, ADR-0022).
#[test]
fn dropped_connection_does_not_kill_run() {
    let _guard = port_lock();

    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");
    let gate_path = tmp.path().join("gate");
    assert!(!gate_path.exists(), "gate must not exist before release");

    // chunks=3: the fixture emits chunk 1 (`"echo"`), then BLOCKS on the gate
    // before chunks 2-3 (`": he"`, `"llo"`) + `done`.
    let (_core, ws_url) = spawn_core_with_fixture(&db_path, &gate_path, "3");

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let run_id = rt.block_on(async {
        // ---- Connection A: post + subscribe, then DROP mid-run ----
        let (mut ws_a, _resp) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .expect("ws A handshake succeeds");
        let run_id = post_message(&mut ws_a, 1).await;
        let _a_snapshot = subscribe_and_read_snapshot(&mut ws_a, 2, &run_id).await;

        // Drop A BEFORE tripping the gate. The Worker is still blocked on the
        // gate (mid-run), so this proves it keeps running after the
        // originating connection disappears. Closing sends a Close frame; Core
        // sees it and tears down A's connection task + out_tx.
        ws_a.close(None).await.ok();
        drop(ws_a);

        // ---- Connection B: re-subscribe to the SAME run, drain to done ----
        let (mut ws_b, _resp_b) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .expect("ws B handshake succeeds");
        let b_base = subscribe_and_read_snapshot(&mut ws_b, 3, &run_id).await;

        // Trip the gate so the Worker emits the remaining chunks + done.
        std::fs::write(&gate_path, b"go").expect("create gate file");

        let assembled = drain_tail_to_done(&mut ws_b, b_base).await;
        assert_eq!(
            assembled, "echo: hello",
            "B's snapshot + tail reassembles to the full echo output despite A's drop"
        );

        // Await the terminal tx commit against a live read-only pool. The
        // Worker publishes `done` to the hub (which B observes) BEFORE running
        // `complete_run`, so poll until the Run leaves 'running' rather than
        // racing the commit. Bound at 5s.
        let url = format!("sqlite://{}?mode=ro", db_path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let status: String = sqlx::query_scalar("SELECT status FROM runs WHERE id = ?1")
                .bind(&run_id)
                .fetch_one(&pool)
                .await
                .expect("poll run status");
            if status != "running" {
                break;
            }
            if Instant::now() > deadline {
                panic!("timed out waiting for runs.status to leave 'running' (still {status:?})");
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        ws_b.close(None).await.ok();
        run_id
    });

    // ---- Assert the persisted truth against a fresh read-only pool ----
    // A's drop must not have truncated the Run: the assistant text is complete
    // and the Run reached a terminal 'completed' state (ADR-0012).
    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", db_path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        let asst_text: String = sqlx::query_scalar(
            "SELECT mp.text FROM messages m \
             JOIN message_parts mp ON mp.message_id = m.id AND mp.seq = 0 \
             WHERE m.role = 'assistant' AND m.run_id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("read assistant message text");
        assert_eq!(
            asst_text, "echo: hello",
            "dropped connection did not truncate the persisted assistant text"
        );

        let status: String = sqlx::query_scalar("SELECT status FROM runs WHERE id = ?1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .expect("read run status");
        assert_eq!(status, "completed", "Run reached a terminal completed state");
    });
}

/// Exactly-once across the snapshot/tail boundary: subscribe while the Worker
/// is mid-stream (gate held), trip the gate, drain to `done`, and assert the
/// reassembled `snapshot ++ tail` equals `echo: hello` EXACTLY — each chunk
/// present once, no loss or duplication (ADR-0022 §19-28 per-run gate).
#[test]
fn exactly_once_subscribe_during_inflight_persist() {
    let _guard = port_lock();

    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");
    let gate_path = tmp.path().join("gate");
    assert!(!gate_path.exists(), "gate must not exist before release");

    // chunks=3 splits `echo: hello` into three incremental pieces; the
    // subscribe lands while the Worker is parked on the gate (after chunk 1,
    // before chunks 2-3), so the snapshot/tail boundary is exercised under
    // control.
    let (_core, ws_url) = spawn_core_with_fixture(&db_path, &gate_path, "3");

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let (mut ws, _resp) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .expect("ws handshake succeeds");

        let run_id = post_message(&mut ws, 1).await;
        let base = subscribe_and_read_snapshot(&mut ws, 2, &run_id).await;

        // Trip the gate so the Worker emits the remaining chunks + done.
        std::fs::write(&gate_path, b"go").expect("create gate file");

        let assembled = drain_tail_to_done(&mut ws, base).await;
        assert_eq!(
            assembled, "echo: hello",
            "snapshot + tail reassembles to the full echo output exactly once — \
             no delta lost or duplicated across the snapshot/tail boundary"
        );

        ws.close(None).await.ok();
    });
}
