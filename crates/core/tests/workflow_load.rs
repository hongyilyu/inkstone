//! Slice 3 (real-worker-codex): the Workflow TOML loader fails fast at Core
//! boot on a malformed `default.toml`, an invalid `thinking_level`, or a
//! missing file, and boots cleanly on a valid one. The loader lives in the
//! `core` binary crate (no lib target), so these drive it through the real
//! boot path: spawn Core with `INKSTONE_WORKFLOWS_DIR` pointed at a fixture
//! dir and assert whether it reaches `INKSTONE_LISTENING` (boot succeeded)
//! or exits first (fail-fast). Port 0 keeps a successful boot collision-free.

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use assert_cmd::cargo::CommandCargoExt;
use tempfile::TempDir;

fn write_workflow(dir: &Path, body: &str) {
    std::fs::create_dir_all(dir).expect("create workflows dir");
    std::fs::write(dir.join("default.toml"), body).expect("write default.toml");
}

/// Spawn Core with `INKSTONE_WORKFLOWS_DIR` pointed at `workflows_dir` and a
/// throwaway DB. Returns Ok(()) if Core announced INKSTONE_LISTENING within
/// the deadline (boot succeeded), Err(code/output) if it exited first
/// (fail-fast). Kills the child either way.
fn boot_outcome(workflows_dir: &Path) -> Result<(), String> {
    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");
    let mut child = Command::cargo_bin("core")
        .expect("core binary exists")
        // Port 0 → ephemeral, so a successful boot never collides with other
        // test binaries.
        .env("INKSTONE_PORT", "0")
        .env("INKSTONE_DB_PATH", &db_path)
        .env("INKSTONE_WORKFLOWS_DIR", workflows_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("core spawns");

    let stdout = child.stdout.take().expect("piped stdout");
    let mut reader = BufReader::new(stdout);
    let deadline = Instant::now() + Duration::from_secs(8);

    loop {
        // If the process already exited, boot failed (fail-fast path).
        match child.try_wait() {
            Ok(Some(status)) => {
                let _ = child.wait();
                return Err(format!("core exited before listening: {status}"));
            }
            Ok(None) => {}
            Err(e) => return Err(format!("try_wait failed: {e}")),
        }

        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("timed out waiting for boot outcome".to_string());
        }

        let mut line = String::new();
        // Bounded read: stdout is line-buffered; a short sleep keeps the loop
        // from spinning if no line is ready yet.
        match reader.read_line(&mut line) {
            Ok(0) => {
                // EOF: process closed stdout → it exited.
                let _ = child.wait();
                return Err("core stdout closed before listening".to_string());
            }
            Ok(_) => {
                if line.trim_end().starts_with("INKSTONE_LISTENING ") {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Ok(());
                }
            }
            Err(_) => {
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
}

#[test]
fn good_default_workflow_boots() {
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().join("workflows");
    write_workflow(
        &dir,
        r#"
name = "default"
version = "1.0.0"
provider = "openai-codex"
model = "gpt-5.5"
thinking_level = "off"
system_prompt = "hi"
tools = []
"#,
    );
    boot_outcome(&dir).expect("core boots with a valid default.toml");
}

#[test]
fn malformed_toml_fails_fast() {
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().join("workflows");
    write_workflow(&dir, "this is = not valid = toml ===");
    let outcome = boot_outcome(&dir);
    assert!(
        outcome.is_err(),
        "core must fail to boot on malformed workflow TOML, got: {outcome:?}"
    );
}

#[test]
fn invalid_thinking_level_fails_fast() {
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().join("workflows");
    write_workflow(
        &dir,
        r#"
name = "default"
version = "1.0.0"
provider = "openai-codex"
model = "gpt-5.5"
thinking_level = "turbo"
system_prompt = "hi"
tools = []
"#,
    );
    let outcome = boot_outcome(&dir);
    assert!(
        outcome.is_err(),
        "core must fail to boot on an invalid thinking_level, got: {outcome:?}"
    );
}

#[test]
fn missing_workflow_file_fails_fast() {
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().join("workflows");
    std::fs::create_dir_all(&dir).expect("create empty workflows dir");
    let outcome = boot_outcome(&dir);
    assert!(
        outcome.is_err(),
        "core must fail to boot when default.toml is missing, got: {outcome:?}"
    );
}
