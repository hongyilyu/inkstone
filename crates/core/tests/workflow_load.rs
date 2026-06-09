//! Slice 3 (real-worker-codex): the Workflow TOML loader fails fast at Core
//! boot on a malformed `default.toml`, an invalid `thinking_level`, or a
//! missing file, and boots cleanly on a valid one. The loader lives in the
//! `core` binary crate (no lib target), so these drive it through the real
//! boot path: spawn Core with `INKSTONE_WORKFLOWS_DIR` pointed at a fixture
//! dir and assert whether it reaches `INKSTONE_LISTENING` (boot succeeded)
//! or exits first (fail-fast). Ephemeral port keeps a successful boot
//! collision-free.

use std::path::Path;

mod common;
use common::{SpawnError, Workspace};

fn write_workflow(dir: &Path, body: &str) {
    std::fs::create_dir_all(dir).expect("create workflows dir");
    std::fs::write(dir.join("default.toml"), body).expect("write default.toml");
}

/// Spawn Core with `INKSTONE_WORKFLOWS_DIR` pointed at `workflows_dir` and a
/// throwaway Workspace. `Ok(())` if Core announced `INKSTONE_LISTENING` (boot
/// succeeded), `Err` if it exited first (fail-fast). Core is reaped either way.
fn boot_outcome(workflows_dir: &Path) -> Result<(), SpawnError> {
    let workspace = Workspace::new();
    workspace
        .core()
        .env("INKSTONE_WORKFLOWS_DIR", workflows_dir)
        .try_spawn()
        .map(|_| ())
}

#[test]
fn good_default_workflow_boots() {
    let tmp = tempfile::tempdir().expect("tempdir");
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
    let tmp = tempfile::tempdir().expect("tempdir");
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
    let tmp = tempfile::tempdir().expect("tempdir");
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
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path().join("workflows");
    std::fs::create_dir_all(&dir).expect("create empty workflows dir");
    let outcome = boot_outcome(&dir);
    assert!(
        outcome.is_err(),
        "core must fail to boot when default.toml is missing, got: {outcome:?}"
    );
}
