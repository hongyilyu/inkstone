//! The Workflow TOML loader fails fast at boot on a malformed `default.toml`,
//! an invalid `thinking_level`, or a missing file, and boots cleanly on a valid
//! one. The loader is in the binary crate (no lib target), so these drive it
//! through the real boot path: spawn Core with `INKSTONE_WORKFLOWS_DIR` and
//! assert whether it reaches `INKSTONE_LISTENING` (success) or exits first
//! (fail-fast).

use std::path::Path;

mod common;
use common::{SpawnError, Workspace};

fn write_workflow(dir: &Path, body: &str) {
    std::fs::create_dir_all(dir).expect("create workflows dir");
    std::fs::write(dir.join("default.toml"), body).expect("write default.toml");
}

/// Spawn Core pointed at `workflows_dir`. `Ok(())` if it announced
/// `INKSTONE_LISTENING`, `Err` if it exited first (fail-fast). Core is reaped
/// either way.
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

/// Static content guard on the shipped `crates/core/workflows/default.toml`
/// (not a fixture; never boots Core): its `system_prompt` must nudge proposing
/// a Journal Entry only for journal-worthy material. Real-model behavior is
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
    assert!(
        lower.contains("create")
            && lower.contains("update")
            && lower.contains("delete")
            && lower.contains("same original thread"),
        "default.toml system_prompt must describe same-thread create/update/delete intake, got: {system_prompt:?}"
    );
    assert!(
        lower.contains("read_current_thread_journal_entries")
            && lower.contains("for that entry"),
        "default.toml system_prompt must tell the model to read current-thread Journal Entries for same-thread corrections/deletions, got: {system_prompt:?}"
    );
    assert!(
        lower.contains("read another thread by")
            && lower.contains("id with read_thread")
            && lower.contains("read_thread")
            && lower.contains("must not do cross-thread")
            && lower.contains("update/delete"),
        "default.toml system_prompt must preserve read_thread while forbidding cross-thread Journal Entry update/delete, got: {system_prompt:?}"
    );
    assert!(
        lower.contains("stop after journal entry intake")
            && !lower.contains("person extraction")
            && !lower.contains("project extraction")
            && !lower.contains("todo extraction")
            && !lower.contains("entity refs")
            && !lower.contains("daily notes")
            && !lower.contains("auto-approval")
            && !lower.contains("router"),
        "default.toml system_prompt must stop after intake and keep extraction/router behavior out of scope, got: {system_prompt:?}"
    );
    let tools = doc
        .get("tools")
        .and_then(|v| v.as_array())
        .expect("shipped default.toml has a tools array");
    let tool_names = tools
        .iter()
        .map(|tool| {
            tool.as_str()
                .unwrap_or_else(|| panic!("tool entry is a string - tools: {tools:?}"))
        })
        .collect::<Vec<_>>();
    assert_eq!(
        tool_names,
        vec![
            "read_thread",
            "read_current_thread_journal_entries",
            "propose_workspace_mutation",
            "search_entities",
        ],
        "default.toml must allowlist only the exact Journal Entry intake tools"
    );
}
