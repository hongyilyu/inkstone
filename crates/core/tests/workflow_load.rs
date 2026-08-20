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
/// (not a fixture; never boots Core): its `system_prompt` must route each
/// Message correctly — journal-worthy material that also mentions
/// People/Projects → ONE `apply_intent_graph` intent graph (ADR-0042); direct
/// contact/outcome capture → create_project/create_person sourced from the
/// user Message; reminders/tasks → the TickTick redirect (ADR-0064, no
/// mutation); pure conversation → no proposal. Real-model behavior is
/// non-deterministic, so this guards the prompt text only.
#[test]
fn default_workflow_prompts_for_capture_intent_boundary() {
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
    // Bucket 2 — the reminder boundary (ADR-0065 amending ADR-0064): a
    // reminder/task/obligation is still kept OUT of a Journal Entry, but it is
    // no longer a dead end — it becomes exactly ONE `propose_ticktick_task`
    // Proposal, and no other Workspace mutation. The prompt must also keep the
    // capability limits honest (Inbox-only; no complete/edit/delete).
    assert!(
        lower.contains("do not propose a journal entry")
            && lower.contains("reminders")
            && lower.contains("tasks")
            && lower.contains("future"),
        "default.toml system_prompt must still keep reminders/tasks out of Journal Entries, got: {system_prompt:?}"
    );
    assert!(
        lower.contains("ticktick is the user's task system")
            && lower.contains("propose_ticktick_task")
            && lower.contains("never a journal entry")
            && lower.contains("never any other workspace")
            && lower.contains("inbox")
            && lower.contains("cannot complete, edit, or delete"),
        "default.toml system_prompt must route reminders/tasks to ONE propose_ticktick_task with honest limits, got: {system_prompt:?}"
    );
    assert!(
        lower.contains("propose one ticktick task via"),
        "default.toml system_prompt must ask for exactly ONE task per proposal, got: {system_prompt:?}"
    );
    // The retired dead-end redirect must be GONE — that phrasing is exactly the
    // capability ADR-0065 restores.
    assert!(
        !lower.contains("add it in ticktick — do not propose")
            && !lower.contains("you cannot create or edit tasks from here"),
        "default.toml system_prompt must not keep the retired add-it-yourself dead end, got: {system_prompt:?}"
    );
    // Task capture is fully retired: no todo mutation kind may be prompted.
    assert!(
        !lower.contains("create_todo") && !lower.contains("update_todo"),
        "default.toml system_prompt must not mention the retired todo mutation kinds, got: {system_prompt:?}"
    );
    // Direct capture (no Journal Entry, sourced from the user Message): each of
    // the two surviving shapes routes to its create_* mutation.
    assert!(
        lower.contains("create_project")
            && lower.contains("create_person")
            && lower.contains("sourced from the user message")
            && lower.contains("do not create a journal entry first"),
        "default.toml system_prompt must describe DIRECT create_project/create_person capture sourced from the user Message, got: {system_prompt:?}"
    );
    assert!(
        lower.contains("outcome, not a category"),
        "default.toml system_prompt must define a Project as an outcome, not a category/area, got: {system_prompt:?}"
    );
    // Phrases that WRAP across prompt lines are matched on whitespace-collapsed
    // text, so a harmless reflow of the shipped prompt cannot red this test.
    let flat = lower.split_whitespace().collect::<Vec<_>>().join(" ");
    assert!(
        lower.contains("names a project")
            && lower.contains("concrete next")
            // Post-cutover (ADR-0065) the action is PROPOSED as a TickTick
            // task, not pointed at; one proposal at a time still holds.
            && flat.contains("propose it via propose_ticktick_task")
            && flat.contains("do not turn the action phrase into a new project name"),
        "default.toml system_prompt must route a named Project plus explicit action to a TickTick task proposal, got: {system_prompt:?}"
    );
    // Bucket 3 — ordinary conversation captures nothing.
    assert!(
        lower.contains("propose nothing"),
        "default.toml system_prompt must tell the model to propose nothing for ordinary conversation, got: {system_prompt:?}"
    );
    assert!(
        lower.contains("create")
            && lower.contains("update")
            && lower.contains("delete")
            && lower.contains("same original thread"),
        "default.toml system_prompt must describe same-thread create/update/delete intake, got: {system_prompt:?}"
    );
    assert!(
        lower.contains("read_current_thread_journal_entries") && lower.contains("for that entry"),
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
        !lower.contains("stop after journal entry intake"),
        "default.toml system_prompt must no longer stop after intake — extraction is now one intent graph, got: {system_prompt:?}"
    );
    // Intent-graph extraction (ADR-0042): a journal-worthy message that also
    // mentions People/Projects/actions is recognized as ONE intent graph and
    // proposed as ONE apply_intent_graph mutation — entity nodes + the three
    // link kinds, with existing_id hints from search_entities. The old
    // per-entity, JE-accepted-first, create-then-reference sequencing is gone.
    assert!(
        lower.contains("apply_intent_graph")
            && lower.contains("intent graph")
            && lower.contains("one proposal")
            && lower.contains("search_entities")
            && lower.contains("existing_id")
            && lower.contains("payload.entities")
            && lower.contains("payload.links"),
        "default.toml system_prompt must describe recognizing one intent graph and proposing one apply_intent_graph with entities + links + existing_id hints from search_entities, got: {system_prompt:?}"
    );
    assert!(
        lower.contains("journal_ref") && !lower.contains("todo_project") && !lower.contains("todo_person"),
        "default.toml system_prompt must name journal_ref as the one link kind (the todo links are retired), got: {system_prompt:?}"
    );
    // Near-match gap (ADR-0042 near-match amendment): the model must NOT fold an
    // activity/aspect qualifier (e.g. "testing") into a Project NAME — "Lead Ads
    // testing" is still the "Lead Ads" Project, with the testing work as the Todo /
    // journal prose — so an existing Project is reused, not duplicated as a near-twin.
    assert!(
        lower.contains("qualifier")
            && lower.contains("project name")
            && lower.contains("base name"),
        "default.toml system_prompt must tell the model not to fold an activity qualifier into a Project name (reuse the base-name Project), got: {system_prompt:?}"
    );
    // And the model must search_entities by the entity's BASE NAME, not a whole
    // sentence/blob — a long query never matches a short stored name (the search
    // safety-net whiffs otherwise).
    assert!(
        lower.contains("search_entities")
            && lower.contains("by its base name")
            && lower.contains("not a whole sentence"),
        "default.toml system_prompt must tell the model to search_entities by an entity's base name, not a whole sentence, got: {system_prompt:?}"
    );
    // The graph is only for >=1 extracted entity; pure prose stays
    // create_journal_entry, and the old sequencing wording must be gone.
    assert!(
        lower.contains("at least one entity")
            && lower.contains("use create_journal_entry")
            && !lower.contains("never batch")
            && !lower.contains("from that accepted journal entry"),
        "default.toml system_prompt must keep pure-prose journaling on create_journal_entry and drop the old per-entity/JE-accepted-first sequencing, got: {system_prompt:?}"
    );
    // Re-scan recognition (ADR-0042, slice 6): a message naming a journal entry id
    // and asking for mentioned-but-uncaptured entities must route to ONE
    // apply_intent_graph in ANCHOR-REUSE mode — read the current-thread entries,
    // recognize only what's NEW, splice each via a journal_ref match_text, suppress
    // anything already anchored, and propose nothing when nothing new is found.
    assert!(
        lower.contains("re-scan")
            && lower.contains("anchored_entities")
            && lower.contains("existing_id: that entry")
            && lower.contains("no body")
            && lower.contains("match_text")
            && lower.contains("suppress")
            && lower.contains("propose nothing"),
        "default.toml system_prompt must describe re-scanning a Journal Entry in anchor-reuse mode (read anchored_entities, reuse existing_id with no body, splice via match_text, suppress already-captured, propose nothing when nothing is new), got: {system_prompt:?}"
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
            // The ticktick-writes cutover's exposure lever (ADR-0065): the ONE
            // remote write, reachable only through this Proposal tool.
            "propose_ticktick_task",
            "search_entities",
        ],
        "default.toml must allowlist only the exact capture-intake tools"
    );
    // The S4 cutover exposes the Worker-executed ticktick_* read tools to the
    // default Workflow (external-task-views A3).
    assert_eq!(
        doc.get("external_tools").and_then(|v| v.as_bool()),
        Some(true),
        "default.toml must set external_tools = true (the ticktick_* exposure switch)"
    );
}
