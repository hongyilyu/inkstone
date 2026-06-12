//! Proves the slow-worker fixture's gate primitive in isolation. The fixture
//! (`fixtures/slow-worker.ts`) emits NDJSON on stdout, reads one `{"prompt"}`
//! line, and pauses mid-stream until a test-controlled gate file appears. Spawn
//! it directly (not through Core), assert the first `text_delta` arrives and
//! the stream is then paused, trip the gate, and assert the remaining deltas +
//! `done` reassemble to `echo: hello`.

use std::io::{BufRead, BufReader, Write};
use std::process::Stdio;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::Duration;

mod common;

#[test]
fn slow_worker_fixture_pauses_until_gate_then_completes() {
    let tsx = common::tsx_bin();
    let fixture = common::fixture_path("slow-worker.ts");

    // Gate path that does not yet exist; creating it is the release.
    let tmp = tempfile::TempDir::new().expect("tempdir");
    let gate_path = tmp.path().join("gate");
    assert!(!gate_path.exists(), "gate must not exist before release");

    let mut child = std::process::Command::new(&tsx)
        .arg(&fixture)
        .env("INKSTONE_FIXTURE_CHUNKS", "2")
        .env("INKSTONE_FIXTURE_GATE", &gate_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("tsx spawns the fixture");

    // Send the prompt line, then drop stdin so the fixture's stdin reaches EOF.
    {
        let mut stdin = child.stdin.take().expect("piped stdin");
        stdin
            .write_all(b"{\"prompt\":\"hello\"}\n")
            .expect("write prompt line");
    }

    // A reader thread pumps stdout lines into a channel; the main thread uses
    // recv_timeout to assert "a line arrived" / "no line arrived" without
    // blocking unbounded.
    let stdout = child.stdout.take().expect("piped stdout");
    let (tx, rx) = mpsc::channel::<String>();
    let reader = thread::spawn(move || {
        let buf = BufReader::new(stdout);
        for line in buf.lines() {
            match line {
                Ok(l) => {
                    if tx.send(l).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Chunk 1: the first text_delta must arrive.
    let line1 = match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(l) => l,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            panic!(
                "expected a first text_delta line, but the fixture produced none \
                 (fixture missing at {} or spawn failed?)",
                fixture.display()
            );
        }
    };
    let v1: serde_json::Value = serde_json::from_str(&line1)
        .unwrap_or_else(|e| panic!("line 1 is JSON: {e} — body: {line1}"));
    assert_eq!(
        v1["kind"],
        serde_json::json!("text_delta"),
        "first line is a text_delta — body: {line1}"
    );
    let mut assembled = String::new();
    assembled.push_str(
        v1["delta"]
            .as_str()
            .unwrap_or_else(|| panic!("text_delta carries a string delta — body: {line1}")),
    );

    // Paused: no further line until the gate is tripped. The timeout elapsing
    // is the pass signal; a line before the gate means the fixture didn't block.
    match rx.recv_timeout(Duration::from_millis(300)) {
        Err(RecvTimeoutError::Timeout) => { /* paused mid-stream — correct */ }
        Ok(line) => {
            let _ = child.kill();
            let _ = child.wait();
            panic!("fixture emitted a line before the gate was tripped: {line}");
        }
        Err(RecvTimeoutError::Disconnected) => {
            let _ = child.kill();
            let _ = child.wait();
            panic!("fixture stdout closed before the gate was tripped (premature exit?)");
        }
    }

    // Release: create the gate file.
    std::fs::write(&gate_path, b"go").expect("create gate file");

    // Remaining text_delta(s) then a terminal done, in order.
    loop {
        let line = match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(l) => l,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("timed out waiting for the remaining deltas + done after the gate tripped");
            }
        };
        let v: serde_json::Value = serde_json::from_str(&line)
            .unwrap_or_else(|e| panic!("post-gate line is JSON: {e} — body: {line}"));
        match v["kind"].as_str() {
            Some("text_delta") => {
                assembled.push_str(
                    v["delta"]
                        .as_str()
                        .unwrap_or_else(|| panic!("text_delta carries a string delta — body: {line}")),
                );
            }
            Some("done") => break,
            other => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("unexpected event kind {other:?} — body: {line}");
            }
        }
    }

    // The incremental deltas reassemble to the real worker's echo output.
    assert_eq!(
        assembled, "echo: hello",
        "incremental deltas reassemble to the echo output"
    );

    // Reap the child and join the reader.
    let _ = child.kill();
    let _ = child.wait();
    let _ = reader.join();
    drop(tmp);
}
