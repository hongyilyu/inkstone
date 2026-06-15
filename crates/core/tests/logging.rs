//! Diagnostic Log trail (ADR-0036): Core initializes a `tracing` subscriber at
//! boot that writes structured JSONL events to a rolling file under
//! `INKSTONE_LOG_DIR`, while the `INKSTONE_LISTENING` stdout marker the harness
//! parses stays verbatim. Reads the file *after* `core.kill()` (SIGKILL) — the
//! Workspace TempDir outlives Core (mirrors `provider_login.rs`), and the
//! blocking daily appender has each event on disk before the kill.

mod common;
use common::Workspace;

/// The boot trail lands in `INKSTONE_LOG_DIR` as JSONL whose lines carry a
/// stable `event` key — `core.listening` proves the subscriber is wired — AND
/// the `INKSTONE_LISTENING` stdout marker still parses (non-empty `http_url`).
#[test]
fn core_writes_listening_event_to_jsonl_and_keeps_stdout_marker() {
    let workspace = Workspace::new();
    let log_dir = workspace.path().join("logs");
    let mut core = workspace.core().env("INKSTONE_LOG_DIR", &log_dir).spawn();

    // `spawn()` already blocked on the stdout marker; this asserts the harness
    // parsed it (the marker is NOT migrated into tracing per ADR-0036).
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

/// Read every non-empty line of every file under `dir` (the daily appender
/// suffixes the file with a date, so the exact name is not assumed).
fn read_jsonl_lines(dir: &std::path::Path) -> Vec<String> {
    let mut lines = Vec::new();
    let entries = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("read_dir {}: {e}", dir.display()));
    for entry in entries {
        let path = entry.expect("dir entry").path();
        if path.is_file() {
            let body = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
            lines.extend(body.lines().filter(|l| !l.is_empty()).map(str::to_owned));
        }
    }
    lines
}
