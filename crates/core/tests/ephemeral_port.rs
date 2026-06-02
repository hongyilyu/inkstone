//! Slice 1 RED test: Core binds an ephemeral port when `INKSTONE_PORT=0`.
//!
//! The harness (ADR-0019) spawns one fresh Core per test and needs each to
//! bind a distinct port so parallel Playwright workers don't collide. Core
//! already announces `INKSTONE_LISTENING <url>` on stdout; this test proves
//! that with `INKSTONE_PORT=0` the announced port is OS-assigned (non-zero and
//! not the fixed default 8765) and the server is actually reachable there.
//!
//! Default behavior (no `INKSTONE_PORT`) stays 8765 — the existing
//! integration tests depend on it — so this test sets the env explicitly.

use std::io::{BufRead, BufReader};
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

use assert_cmd::cargo::CommandCargoExt;
use tempfile::TempDir;

/// SIGKILL-and-reap-on-drop guard so a panicking assertion never leaks Core.
struct CoreChild(Option<Child>);

impl Drop for CoreChild {
    fn drop(&mut self) {
        if let Some(mut c) = self.0.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

#[test]
fn ephemeral_port_binds_nonzero_and_serves() {
    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");

    let mut child = std::process::Command::cargo_bin("core")
        .expect("core binary exists")
        .env("INKSTONE_DB_PATH", &db_path)
        .env("INKSTONE_PORT", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("core spawns");

    let stdout = child.stdout.take().expect("piped stdout");
    let mut reader = BufReader::new(stdout);
    let guard = CoreChild(Some(child));

    let deadline = Instant::now() + Duration::from_secs(5);
    let url = loop {
        if Instant::now() > deadline {
            panic!("timed out waiting for INKSTONE_LISTENING line");
        }
        let mut line = String::new();
        let read = reader.read_line(&mut line).expect("read stdout");
        if read == 0 {
            panic!("core stdout closed before announcing INKSTONE_LISTENING");
        }
        let trimmed = line.trim_end_matches('\n').trim_end_matches('\r');
        if let Some(rest) = trimmed.strip_prefix("INKSTONE_LISTENING ") {
            break rest.to_string();
        }
    };

    // The announced URL must carry the *resolved* ephemeral port, not 0.
    let port: u16 = url
        .rsplit(':')
        .next()
        .and_then(|p| p.parse().ok())
        .unwrap_or_else(|| panic!("INKSTONE_LISTENING URL has a numeric port — got {url}"));
    assert_ne!(port, 0, "ephemeral port must be resolved to a real port");
    assert_ne!(port, 8765, "INKSTONE_PORT=0 must not bind the fixed default");

    let response = reqwest::blocking::get(&url).expect("GET / succeeds");
    assert_eq!(response.status().as_u16(), 200, "GET / returns 200");

    drop(guard);
}
