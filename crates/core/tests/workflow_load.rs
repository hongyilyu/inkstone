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

/// The shipped default Workflow nudges the model to propose a Journal Entry
/// only when the user shares journal-worthy material.
/// Unlike the boot tests above, this is a static content guard — it reads the
/// real `crates/core/workflows/default.toml` (not a fixture) and asserts on its
/// `system_prompt`, so it never boots Core. Real-model behavior is
/// non-deterministic, so this guards the prompt text only.
#[test]
fn default_workflow_prompts_for_journal_entry_boundary() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("workflows/default.toml");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read shipped default.toml at {}: {e}", path.display()));
    let doc: toml::Value = toml::from_str(&raw).expect("shipped default.toml parses as TOML");
    let system_prompt = doc
        .get("system_prompt")
        .and_then(|v| v.as_str())
        .expect("shipped default.toml has a string system_prompt");
    let lower = system_prompt.to_lowercase();
    assert!(
        lower.contains("propose") && lower.contains("journal entry"),
        "default.toml system_prompt must nudge proposing a Journal Entry, got: {system_prompt:?}"
    );
    assert!(
        lower.contains("logged experience")
            && lower.contains("observation")
            && lower.contains("reflection")
            && lower.contains("event"),
        "default.toml system_prompt must define what counts as a Journal Entry, got: {system_prompt:?}"
    );
    assert!(
        lower.contains("do not propose a journal entry")
            && lower.contains("reminders")
            && lower.contains("tasks")
            && lower.contains("todos")
            && lower.contains("future obligations")
            && lower.contains("without implying the reminder was saved"),
        "default.toml system_prompt must exclude reminders/tasks from Journal Entries, got: {system_prompt:?}"
    );
    let tools = doc
        .get("tools")
        .and_then(|v| v.as_array())
        .expect("shipped default.toml has a tools array");
    assert!(
        tools
            .iter()
            .filter_map(|tool| tool.as_str())
            .any(|tool| tool == "propose_workspace_mutation"),
        "default.toml must include 'propose_workspace_mutation' in tools"
    );
}
