//! Proves the slow-worker fixture's gate primitive in isolation, before any
//! hub code (slices 1/2/6) depends on it.
//!
//! The fixture (`fixtures/slow-worker.ts`) speaks the existing Worker NDJSON
//! protocol on stdout (`{"kind":"text_delta","delta":...}` lines then
//! `{"kind":"done"}`), reads one `{"prompt":...}` line on stdin, and pauses
//! mid-stream until a test-controlled gate file appears. This test spawns it
//! directly (NOT through Core, so it binds no port and can't collide with the
//! existing `end_to_end`/`persistence_*` binaries), asserts the first
//! `text_delta` arrives, asserts the stream is provably paused (a bounded read
//! timeout elapsing is the pass signal), trips the gate, then asserts the
//! remaining `text_delta`(s) + `done` arrive and reassemble to `echo: hello`.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::Stdio;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::Duration;

#[test]
fn slow_worker_fixture_pauses_until_gate_then_completes() {
    // Resolve repo paths from this crate's manifest dir so the test works
    // regardless of cargo's CWD. Mirror end_to_end.rs:15-19.
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .expect("repo root resolves from <repo>/crates/core");

    // tsx is a worker dev-dependency; pnpm's isolated mode lands the binary
    // under packages/worker/node_modules/.bin/tsx (not the workspace root).
    let tsx = repo_root.join("packages/worker/node_modules/.bin/tsx");
    let fixture = repo_root.join("crates/core/tests/fixtures/slow-worker.ts");
    if !tsx.exists() {
        panic!(
            "worker tsx not installed at {} — run `pnpm install` at repo root",
            tsx.display()
        );
    }

    // Gate path inside a TempDir that does NOT yet exist; creating it is the
    // test-controlled release.
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
        // stdin dropped here -> EOF on the fixture's stdin.
    }

    // One reader thread pumps every stdout line into a channel. The main thread
    // uses recv_timeout to assert both "a line arrived" and "no line arrived"
    // without ever blocking unbounded (keeps the test from hanging CI).
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

    // --- Chunk 1: the first text_delta must arrive. ---
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

    // --- Paused: no further line until the gate is tripped. ---
    // The timeout ELAPSING is the pass signal. A line arriving before the gate
    // exists means the fixture didn't block -> fail.
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

    // --- Release: create the gate file. ---
    std::fs::write(&gate_path, b"go").expect("create gate file");

    // --- Remaining text_delta(s) then a terminal done, in order. ---
    // The loop only exits its `done` arm by `break`; every other path panics,
    // so reaching the line after the loop proves the stream terminated cleanly.
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

    // The reassembled (incremental) deltas equal the real worker's echo output,
    // proving the chunking is faithful to `echo: <prompt>`.
    assert_eq!(
        assembled, "echo: hello",
        "incremental deltas reassemble to the echo output"
    );

    // Cleanup: reap the child and join the reader.
    let _ = child.kill();
    let _ = child.wait();
    let _ = reader.join();
    drop(tmp);
}
