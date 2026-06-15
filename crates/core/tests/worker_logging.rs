//! Worker-supervisor Diagnostic Log trail (ADR-0038, slice 3): a fault raised
//! from a site where `run_id` is NOT a function parameter — `child.rs`'s stdout
//! reader, which runs in a `tokio::spawn`ed task — still lands on the trail
//! correlated by `run_id`. This proves the headline correlation mechanism, but
//! via the **canonical path**: per the amended ADR-0038, every Diagnostic Log
//! event emits `run_id` as a **direct, top-level field** (`.run_id`), uniform
//! with slice-2's `db.*` events, so a single `jq 'select(.run_id=="X")'` mines
//! Core and Worker-supervisor faults together. `child.rs` has no `run_id`
//! parameter, so it is **threaded in** to `ChildWorker::spawn` and emitted as
//! `%run_id`. (The `worker_run` span is retained too — so transitive `sqlx`/
//! `tokio` events stay correlatable via `.span.run_id` — but the agent-queryable
//! path this test pins is top-level `.run_id`.)
//!
//! Reads the file *after* `core.kill()` (SIGKILL): the blocking daily appender
//! has each event on disk before the kill, and the Workspace TempDir outlives
//! Core (mirrors `logging.rs` / `provider_login.rs`).

use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{Workspace, next_text, read_jsonl_lines};

/// A worker that writes a malformed (non-NDJSON) stdout line trips Core's
/// `child.rs` "unknown line" arm; the resulting `worker.unknown_line` WARN lands
/// on the trail carrying a non-empty **top-level** `run_id` equal to the Run's
/// id. The non-empty top-level run_id is the load-bearing assertion — it proves
/// run_id was threaded into the child reader and emitted as a direct field, the
/// canonical (jq-mineable) shape.
#[test]
fn worker_unknown_line_carries_run_id() {
    let workspace = Workspace::new();
    let log_dir = workspace.path().join("logs");
    let core = workspace
        .core()
        .worker_fixture("bad-line-worker.ts")
        .env("INKSTONE_LOG_DIR", &log_dir)
        .spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let run_id = rt.block_on(async {
        let mut ws = core.connect().await;

        let request =
            r#"{"jsonrpc":"2.0","id":1,"method":"thread/create","params":{"prompt":"hi"}}"#;
        ws.send(Message::Text(request.into()))
            .await
            .expect("send request frame");

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

        // Drive the Run to `done`. Because the worker's stdout is read
        // sequentially, `done` can only arrive AFTER the malformed line was read
        // and skipped — a deterministic barrier that the trail now holds the
        // `worker.unknown_line` event.
        loop {
            let body = next_text(&mut ws).await;
            let v: serde_json::Value = serde_json::from_str(&body)
                .unwrap_or_else(|e| panic!("event is JSON: {e} — body: {body}"));
            if v["params"]["event"]["kind"].as_str() == Some("done") {
                break;
            }
        }

        ws.close(None).await.ok();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        run_id
    });

    // SIGKILL + reap; the blocking appender already flushed each event.
    drop(core);

    let lines = read_jsonl_lines(&log_dir);
    let mut saw_unknown_line = false;
    for line in &lines {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.get("event").and_then(|e| e.as_str()) != Some("worker.unknown_line") {
            continue;
        }
        saw_unknown_line = true;
        assert_eq!(
            v.get("level").and_then(|l| l.as_str()),
            Some("WARN"),
            "worker.unknown_line is a WARN — line: {line}"
        );
        // Canonical path (amended ADR-0038): run_id is a DIRECT, top-level field,
        // threaded into the child reader — NOT only under `.span`. A non-empty
        // value here proves child.rs received run_id and emitted it as `%run_id`,
        // uniform with slice-2's `db.*` events.
        let top_level_run_id = v.get("run_id").and_then(|r| r.as_str()).unwrap_or("");
        assert!(
            !top_level_run_id.is_empty(),
            "worker.unknown_line carries a NON-EMPTY top-level run_id — line: {line}"
        );
        assert_eq!(
            top_level_run_id, run_id,
            "the correlated top-level run_id equals the Run's id — line: {line}"
        );
    }
    assert!(
        saw_unknown_line,
        "expected a JSONL line with event=\"worker.unknown_line\" under {}; got {} line(s)",
        log_dir.display(),
        lines.len()
    );
}

/// Core supplies the Worker's `worker.jsonl` sink path BY DEFAULT (ADR-0038):
/// the Worker's sink no-ops unless `INKSTONE_WORKER_LOG_PATH` is set, so without
/// Core defaulting it the entire Worker half of the trail would write nothing in
/// normal operation. This asserts a spawned Worker that sets NO log-path env of
/// its own still receives `INKSTONE_WORKER_LOG_PATH` pointed at `worker.jsonl`
/// inside the same log dir Core writes `core.jsonl` into.
#[test]
fn worker_child_receives_default_worker_log_path() {
    let workspace = Workspace::new();
    let log_dir = workspace.path().join("logs");
    let sink_path = workspace.path().join("logpath-sink");
    let core = workspace
        .core()
        .worker_fixture("log-path-echo-worker.ts")
        // Pin Core's log dir to the tempdir (hermetic); do NOT set
        // INKSTONE_WORKER_LOG_PATH — Core must supply the default.
        .env("INKSTONE_LOG_DIR", &log_dir)
        .env("INKSTONE_TEST_LOGPATH_SINK", &sink_path)
        .spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let mut ws = core.connect().await;
        let request =
            r#"{"jsonrpc":"2.0","id":1,"method":"thread/create","params":{"prompt":"hi"}}"#;
        ws.send(Message::Text(request.into()))
            .await
            .expect("send request frame");
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

        loop {
            let body = next_text(&mut ws).await;
            let v: serde_json::Value = serde_json::from_str(&body)
                .unwrap_or_else(|e| panic!("event is JSON: {e} — body: {body}"));
            if v["params"]["event"]["kind"].as_str() == Some("done") {
                break;
            }
        }
        ws.close(None).await.ok();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    });

    drop(core);

    let echoed = std::fs::read_to_string(&sink_path)
        .unwrap_or_else(|e| panic!("read sink {}: {e}", sink_path.display()));
    let echoed = echoed.trim();
    assert!(
        !echoed.is_empty(),
        "Core supplies a default INKSTONE_WORKER_LOG_PATH — sink was empty (worker trail would be inert)"
    );
    let expected = log_dir.join("worker.jsonl");
    assert_eq!(
        std::path::Path::new(echoed),
        expected,
        "the default worker log path is worker.jsonl in Core's log dir (sibling to core.jsonl)"
    );
}
