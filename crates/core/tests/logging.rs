//! Diagnostic Log trail (ADR-0038): Core initializes a `tracing` subscriber at
//! boot that writes structured JSONL events to a rolling file under
//! `INKSTONE_LOG_DIR`, while the `INKSTONE_LISTENING` stdout marker the harness
//! parses stays verbatim. Reads the file *after* `core.kill()` (SIGKILL) — the
//! Workspace TempDir outlives Core (mirrors `provider_login.rs`), and the
//! blocking daily appender has each event on disk before the kill.

use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{Workspace, read_jsonl_lines};

/// The boot trail lands in `INKSTONE_LOG_DIR` as JSONL whose lines carry a
/// stable `event` key — `core.listening` proves the subscriber is wired — AND
/// the `INKSTONE_LISTENING` stdout marker still parses (non-empty `http_url`).
#[test]
fn core_writes_listening_event_to_jsonl_and_keeps_stdout_marker() {
    let workspace = Workspace::new();
    let log_dir = workspace.path().join("logs");
    let mut core = workspace.core().env("INKSTONE_LOG_DIR", &log_dir).spawn();

    // `spawn()` already blocked on the stdout marker; this asserts the harness
    // parsed it (the marker is NOT migrated into tracing per ADR-0038).
    assert!(
        !core.http_url().is_empty(),
        "INKSTONE_LISTENING stdout marker still parsed off stdout"
    );

    // SIGKILL + reap. The blocking appender wrote each event synchronously, so
    // the file is complete on disk; the TempDir outlives Core, so the read below
    // is valid.
    core.kill();

    // The daily appender names the file with a date suffix, so read the dir and
    // concatenate every `*.jsonl` line rather than assuming a fixed filename.
    let lines = read_jsonl_lines(&log_dir);
    assert!(
        !lines.is_empty(),
        "expected at least one JSONL line under {}",
        log_dir.display()
    );

    let has_listening = lines.iter().any(|line| {
        serde_json::from_str::<serde_json::Value>(line)
            .ok()
            .and_then(|v| v.get("event").and_then(|e| e.as_str()).map(str::to_owned))
            .is_some_and(|event| event == "core.listening")
    });
    assert!(
        has_listening,
        "expected a JSONL line with event=\"core.listening\" under {}; got {} line(s)",
        log_dir.display(),
        lines.len()
    );
}

/// A malformed (non-JSON-RPC) text frame, which Core's WS loop previously
/// `continue`d on silently, now lands on the trail as a WARN
/// `core.jsonrpc_parse_failed` event (ADR-0038: make swallows observable). The
/// bad text rides as a bounded field, never interpolated into the message.
#[test]
fn malformed_ws_frame_logs_jsonrpc_parse_failed_warn() {
    let workspace = Workspace::new();
    let log_dir = workspace.path().join("logs");
    let mut core = workspace.core().env("INKSTONE_LOG_DIR", &log_dir).spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    // Match a WARN `core.jsonrpc_parse_failed` line in the trail.
    let is_parse_failed_warn = |line: &str| {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            return false;
        };
        v.get("event").and_then(|e| e.as_str()) == Some("core.jsonrpc_parse_failed")
            && v.get("level").and_then(|l| l.as_str()) == Some("WARN")
    };

    rt.block_on(async {
        let mut ws = core.connect().await;
        // Not a JsonRpcRequest — decode fails, the loop drops the frame.
        ws.send(Message::Text("this is not json-rpc".into()))
            .await
            .expect("send malformed frame");

        // Deterministic barrier instead of a fixed sleep (which races Core's WS
        // processing on slow CI): poll the trail until the event is observable,
        // with a generous timeout that only guards against a hang.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if read_jsonl_lines(&log_dir)
                .iter()
                .any(|l| is_parse_failed_warn(l))
            {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "timed out waiting for a WARN core.jsonrpc_parse_failed line under {}",
                log_dir.display()
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    });

    // The barrier above already proved the event landed; SIGKILL + reap.
    core.kill();
}