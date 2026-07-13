//! An accepted `update_todo` MERGES a `Partial<TodoData>` onto the existing Todo
//! AND atomically performs `set_person_refs` (full replace), `add_person_refs`,
//! and `remove_person_ids` against `todo_person_refs`, all in the SAME
//! transaction as the Todo revision (ADR-0031, ADR-0025). The merge re-validates
//! the WHOLE Todo (status↔timestamp invariants on the merged result), so a
//! `status:"completed"` with no `completed_at` is `invalid_params` (-32602) and
//! NOTHING changes. A ref pointing at a non-Person id is likewise -32602 with no
//! merge and no ref change (atomic). Refs live in `todo_person_refs`, NEVER in
//! the Todo JSON.
//!
//! One Core, multi-run: the `propose-worker.ts` fixture re-reads
//! `INKSTONE_PROPOSE_PARAMS_FILE` on each fresh spawn, so each run rewrites the
//! file with the next mutation (create a Person, create the Todo, then
//! update_todo) before posting a message — all against the SAME Core (and DB).

use std::path::Path;

use sqlx::Row;
use sqlx::SqlitePool;

mod common;
use common::{
    CoreHandle, Workspace, await_completed, await_parked, create_and_park, decide_accept,
    entity_data, max_revision_seq, open_readonly_pool, proposal_id_for, rt,
};

/// Post a message on a new thread (the params file already holds the mutation),
/// wait until the Run parks, and return `(run_id, proposal_id)`.
async fn create_thread_and_park(core: &CoreHandle, prompt: &str) -> (String, String) {
    let (run_id, _) = create_and_park(core, prompt).await;
    let proposal_id = proposal_id_for(core, &run_id).await;
    (run_id, proposal_id)
}

fn write_params(path: &Path, params: serde_json::Value) {
    std::fs::write(path, params.to_string()).expect("write propose params file");
}

/// The `(person_id, role)` rows for a Todo, ordered by person_id for a stable
/// assertion.
async fn person_refs_of(pool: &SqlitePool, todo_id: &str) -> Vec<(String, String)> {
    let rows = sqlx::query(
        "SELECT person_id, role FROM todo_person_refs WHERE todo_id = ?1 ORDER BY person_id",
    )
    .bind(todo_id)
    .fetch_all(pool)
    .await
    .expect("fetch refs");
    rows.into_iter()
        .map(|row| (row.get("person_id"), row.get("role")))
        .collect()
}

/// Run a `create_person` mutation and accept it; returns the new Person id.
async fn create_person(
    core: &CoreHandle,
    params_path: &Path,
    name: &str,
    key: &str,
) -> String {
    write_params(
        params_path,
        serde_json::json!({
            "mutation_kind": "create_person",
            "payload": { "name": name },
            "rationale": "remember the person"
        }),
    );
    let (run, proposal) = create_thread_and_park(core, "Remember a person.").await;
    let resp = decide_accept(core, &proposal, key).await;
    assert_eq!(
        resp["result"]["status"].as_str(),
        Some("accepted"),
        "create_person accept — body: {resp}"
    );
    let person_id = resp["result"]["entity_id"]
        .as_str()
        .unwrap_or_else(|| panic!("person entity_id is a string — body: {resp}"))
        .to_string();
    await_completed(core, &run).await;
    person_id
}

/// Run a `create_todo` mutation (with optional person_refs) and accept it;
/// returns the new Todo id.
async fn create_todo(
    core: &CoreHandle,
    params_path: &Path,
    todo: serde_json::Value,
    person_refs: serde_json::Value,
    key: &str,
) -> String {
    write_params(
        params_path,
        serde_json::json!({
            "mutation_kind": "create_todo",
            "payload": { "todo": todo, "person_refs": person_refs },
            "rationale": "track the todo"
        }),
    );
    let (run, proposal) = create_thread_and_park(core, "Track a todo.").await;
    let resp = decide_accept(core, &proposal, key).await;
    assert_eq!(
        resp["result"]["status"].as_str(),
        Some("accepted"),
        "create_todo accept — body: {resp}"
    );
    let todo_id = resp["result"]["entity_id"]
        .as_str()
        .unwrap_or_else(|| panic!("todo entity_id is a string — body: {resp}"))
        .to_string();
    await_completed(core, &run).await;
    todo_id
}

fn build_core<'a>(workspace: &'a Workspace, params_path: &Path) -> CoreHandle {
    write_params(params_path, serde_json::json!({}));
    workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", params_path)
        .spawn()
}

/// Case 1: a partial merge (`due_at`) PRESERVES the original title/status, and
/// `set_person_refs` REPLACES the ref set wholesale (P1 dropped, only P2 remains).
#[test]
fn update_todo_merges_partial_and_replaces_person_refs() {
    let workspace = Workspace::new();
    let params_path = workspace.path().join("propose-params.json");
    let core = build_core(&workspace, &params_path);
    let rt = rt();

    let (todo_id, person2) = rt.block_on(async {
        let person1 = create_person(&core, &params_path, "Alice", "p1").await;
        let person2 = create_person(&core, &params_path, "Bob", "p2").await;
        let todo_id = create_todo(
            &core,
            &params_path,
            serde_json::json!({ "title": "Follow up" }),
            serde_json::json!([{ "person_id": person1, "role": "waiting_on" }]),
            "todo-create",
        )
        .await;

        // update_todo: set a due_at + fully replace the ref set with {P2:related}.
        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "update_todo",
                "payload": {
                    "todo_id": todo_id,
                    "todo": { "due_at": "2026-07-01T09:00:00" },
                    "set_person_refs": [{ "person_id": person2, "role": "related" }]
                },
                "rationale": "the user set a due date and reassigned"
            }),
        );
        let (update_run, update_proposal) =
            create_thread_and_park(&core, "Set a due date and reassign.").await;
        let resp = decide_accept(&core, &update_proposal, "todo-update").await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "update_todo accept — body: {resp}"
        );
        assert_eq!(
            resp["result"]["entity_id"].as_str(),
            Some(todo_id.as_str()),
            "update returns the target todo id — body: {resp}"
        );
        await_completed(&core, &update_run).await;
        (todo_id, person2)
    });

    rt.block_on(async {
        let pool = open_readonly_pool(&workspace).await;
        let data = entity_data(&pool, &todo_id).await;
        assert_eq!(
            data["due_at"].as_str(),
            Some("2026-07-01T09:00:00"),
            "merged Todo carries the new due_at"
        );
        assert_eq!(
            data["title"].as_str(),
            Some("Follow up"),
            "merge PRESERVES the original title"
        );
        assert_eq!(
            data["status"].as_str(),
            Some("active"),
            "merge PRESERVES the original (default) status"
        );
        assert!(
            data.get("person_refs").is_none(),
            "person_refs is NEVER stored in Todo JSON — got {data}"
        );
        assert_eq!(
            max_revision_seq(&pool, &todo_id).await,
            2,
            "update appends a seq-2 revision"
        );

        let refs = person_refs_of(&pool, &todo_id).await;
        assert_eq!(
            refs,
            vec![(person2, "related".to_string())],
            "set_person_refs REPLACES the set wholesale (P1 gone, only P2:related)"
        );
    });
}

/// Case 2: `add_person_refs` + `remove_person_ids` compose — start with {P1},
/// add P2, remove P1 → exactly {P2}.
#[test]
fn update_todo_add_and_remove_person_refs_compose() {
    let workspace = Workspace::new();
    let params_path = workspace.path().join("propose-params.json");
    let core = build_core(&workspace, &params_path);
    let rt = rt();

    let (todo_id, person2) = rt.block_on(async {
        let person1 = create_person(&core, &params_path, "Alice", "p1").await;
        let person2 = create_person(&core, &params_path, "Bob", "p2").await;
        let todo_id = create_todo(
            &core,
            &params_path,
            serde_json::json!({ "title": "Follow up" }),
            serde_json::json!([{ "person_id": person1, "role": "related" }]),
            "todo-create",
        )
        .await;

        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "update_todo",
                "payload": {
                    "todo_id": todo_id,
                    "add_person_refs": [{ "person_id": person2, "role": "related" }],
                    "remove_person_ids": [person1]
                },
                "rationale": "swap who is involved"
            }),
        );
        let (update_run, update_proposal) =
            create_thread_and_park(&core, "Swap who is involved.").await;
        let resp = decide_accept(&core, &update_proposal, "todo-update").await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "update_todo accept — body: {resp}"
        );
        await_completed(&core, &update_run).await;
        (todo_id, person2)
    });

    rt.block_on(async {
        let pool = open_readonly_pool(&workspace).await;
        let refs = person_refs_of(&pool, &todo_id).await;
        assert_eq!(
            refs,
            vec![(person2, "related".to_string())],
            "add P2 + remove P1 leaves exactly {{P2}}"
        );
    });
}

/// Case 2b (role precedence): `add_person_refs`' upsert NEVER downgrades a stored
/// `waiting_on` to `related`, and DOES upgrade a stored `related` to `waiting_on`
/// (ADR-0031: `waiting_on` includes related semantics; `waiting_on` wins).
#[test]
fn update_todo_add_person_refs_waiting_on_wins() {
    let workspace = Workspace::new();
    let params_path = workspace.path().join("propose-params.json");
    let core = build_core(&workspace, &params_path);
    let rt = rt();

    let (waiting_todo, related_todo, person1) = rt.block_on(async {
        let person1 = create_person(&core, &params_path, "Alice", "p1").await;
        // Todo A starts with a waiting_on ref to P1.
        let waiting_todo = create_todo(
            &core,
            &params_path,
            serde_json::json!({ "title": "Waiting on Alice" }),
            serde_json::json!([{ "person_id": person1, "role": "waiting_on" }]),
            "todo-create-a",
        )
        .await;
        // Todo B starts with a related ref to P1.
        let related_todo = create_todo(
            &core,
            &params_path,
            serde_json::json!({ "title": "Related to Alice" }),
            serde_json::json!([{ "person_id": person1, "role": "related" }]),
            "todo-create-b",
        )
        .await;

        // No-downgrade: add a `related` ref over the existing `waiting_on`.
        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "update_todo",
                "payload": {
                    "todo_id": waiting_todo,
                    "add_person_refs": [{ "person_id": person1, "role": "related" }]
                },
                "rationale": "re-add as related"
            }),
        );
        let (run_a, proposal_a) =
            create_thread_and_park(&core, "Re-add Alice as related.").await;
        let resp = decide_accept(&core, &proposal_a, "todo-update-a").await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "no-downgrade update accept — body: {resp}"
        );
        await_completed(&core, &run_a).await;

        // Upgrade: add a `waiting_on` ref over the existing `related`.
        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "update_todo",
                "payload": {
                    "todo_id": related_todo,
                    "add_person_refs": [{ "person_id": person1, "role": "waiting_on" }]
                },
                "rationale": "promote to waiting_on"
            }),
        );
        let (run_b, proposal_b) =
            create_thread_and_park(&core, "Promote Alice to waiting_on.").await;
        let resp = decide_accept(&core, &proposal_b, "todo-update-b").await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "upgrade update accept — body: {resp}"
        );
        await_completed(&core, &run_b).await;
        (waiting_todo, related_todo, person1)
    });

    rt.block_on(async {
        let pool = open_readonly_pool(&workspace).await;
        let waiting_refs = person_refs_of(&pool, &waiting_todo).await;
        assert_eq!(
            waiting_refs,
            vec![(person1.clone(), "waiting_on".to_string())],
            "adding `related` over `waiting_on` does NOT downgrade (waiting_on stays)"
        );
        let related_refs = person_refs_of(&pool, &related_todo).await;
        assert_eq!(
            related_refs,
            vec![(person1, "waiting_on".to_string())],
            "adding `waiting_on` over `related` UPGRADES to waiting_on"
        );
    });
}

/// Case 3 (invariant): `status:"completed"` on a Todo with no `completed_at` →
/// the MERGED whole violates the status↔timestamp invariant → -32602, and
/// NOTHING changes (data unchanged, no new revision, proposal pending, run parked).
#[test]
fn update_todo_merged_invariant_violation_is_invalid_and_changes_nothing() {
    let workspace = Workspace::new();
    let params_path = workspace.path().join("propose-params.json");
    let core = build_core(&workspace, &params_path);
    let rt = rt();

    let (todo_id, update_run_id) = rt.block_on(async {
        let todo_id = create_todo(
            &core,
            &params_path,
            serde_json::json!({ "title": "Follow up" }),
            serde_json::json!([]),
            "todo-create",
        )
        .await;

        // status:"completed" with NO completed_at — the merged whole is invalid.
        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "update_todo",
                "payload": {
                    "todo_id": todo_id,
                    "todo": { "status": "completed" }
                },
                "rationale": "the user marked it done"
            }),
        );
        let (update_run, update_proposal) =
            create_thread_and_park(&core, "Mark it done.").await;
        let resp = decide_accept(&core, &update_proposal, "todo-bad-invariant").await;
        assert_eq!(
            resp["error"]["code"].as_i64(),
            Some(-32602),
            "merged invariant violation → invalid_params — body: {resp}"
        );
        (todo_id, update_run)
    });

    rt.block_on(async {
        let pool = open_readonly_pool(&workspace).await;
        let data = entity_data(&pool, &todo_id).await;
        assert_eq!(
            data["status"].as_str(),
            Some("active"),
            "the Todo data is unchanged (still active)"
        );
        assert!(
            data.get("completed_at").is_none(),
            "no completed_at was written"
        );
        assert_eq!(
            max_revision_seq(&pool, &todo_id).await,
            1,
            "no new revision was written"
        );
        let proposal_status: String = sqlx::query_scalar(
            "SELECT p.status FROM proposals p \
             JOIN tool_calls tc ON tc.id = p.tool_call_id WHERE tc.run_id = ?1",
        )
        .bind(&update_run_id)
        .fetch_one(&pool)
        .await
        .expect("proposal row exists");
        assert_eq!(proposal_status, "pending", "the proposal stays pending");
        let run_status: String = sqlx::query_scalar("SELECT status FROM runs WHERE id = ?1")
            .bind(&update_run_id)
            .fetch_one(&pool)
            .await
            .expect("run row exists");
        assert_eq!(run_status, "parked", "the run stays parked");
    });
}

/// Case 4 (bad ref): `set_person_refs` with a non-Person id (a Project id) →
/// -32602, no merge applied (no new revision), and no ref change (atomic).
#[test]
fn update_todo_with_non_person_ref_is_rejected_atomically() {
    let workspace = Workspace::new();
    let params_path = workspace.path().join("propose-params.json");
    let core = build_core(&workspace, &params_path);
    let rt = rt();

    let (todo_id, person1) = rt.block_on(async {
        let person1 = create_person(&core, &params_path, "Alice", "p1").await;
        let todo_id = create_todo(
            &core,
            &params_path,
            serde_json::json!({ "title": "Follow up" }),
            serde_json::json!([{ "person_id": person1, "role": "waiting_on" }]),
            "todo-create",
        )
        .await;

        // Create a Project — a valid Entity, but NOT a Person.
        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "create_project",
                "payload": { "name": "Migration" },
                "rationale": "start the outcome"
            }),
        );
        let (project_run, project_proposal) =
            create_thread_and_park(&core, "Start the migration.").await;
        let resp = decide_accept(&core, &project_proposal, "proj-k1").await;
        let project_id = resp["result"]["entity_id"]
            .as_str()
            .unwrap_or_else(|| panic!("project entity_id is a string — body: {resp}"))
            .to_string();
        await_completed(&core, &project_run).await;

        // update_todo set_person_refs pointing at the Project id.
        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "update_todo",
                "payload": {
                    "todo_id": todo_id,
                    "set_person_refs": [{ "person_id": project_id, "role": "related" }]
                },
                "rationale": "dangling person link"
            }),
        );
        let (update_run, update_proposal) =
            create_thread_and_park(&core, "Reassign to the project.").await;
        let resp = decide_accept(&core, &update_proposal, "todo-bad-ref").await;
        assert_eq!(
            resp["error"]["code"].as_i64(),
            Some(-32602),
            "non-person person_id → invalid_params — body: {resp}"
        );
        await_parked(&core, &update_run).await;
        (todo_id, person1)
    });

    rt.block_on(async {
        let pool = open_readonly_pool(&workspace).await;
        assert_eq!(
            max_revision_seq(&pool, &todo_id).await,
            1,
            "rejected update wrote no new revision (no merge applied)"
        );
        let refs = person_refs_of(&pool, &todo_id).await;
        assert_eq!(
            refs,
            vec![(person1, "waiting_on".to_string())],
            "the original ref set is untouched (atomic)"
        );
    });
}

/// Case 5 (recurrence set-then-clear, ADR-0037): a Todo created with a `due_at` +
/// a due-anchored recurrence, then `update_todo { recurrence: null }` → the merge
/// drops the key (ADR-0033 sentinel) and the stored data has no `recurrence`.
#[test]
fn update_todo_clears_recurrence_via_null_sentinel() {
    let workspace = Workspace::new();
    let params_path = workspace.path().join("propose-params.json");
    let core = build_core(&workspace, &params_path);
    let rt = rt();

    let todo_id = rt.block_on(async {
        let todo_id = create_todo(
            &core,
            &params_path,
            serde_json::json!({
                "title": "Water the plants",
                "due_at": "2026-06-14T18:00:00",
                "recurrence": {
                    "interval": 1, "unit": "week", "anchor": "due_at"
                }
            }),
            serde_json::json!([]),
            "todo-create",
        )
        .await;

        // Clear the recurrence with the null sentinel.
        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "update_todo",
                "payload": {
                    "todo_id": todo_id,
                    "todo": { "recurrence": null }
                },
                "rationale": "the user stopped the repeat"
            }),
        );
        let (update_run, update_proposal) =
            create_thread_and_park(&core, "Stop the repeat.").await;
        let resp = decide_accept(&core, &update_proposal, "todo-clear-recurrence").await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "clear-recurrence accept — body: {resp}"
        );
        await_completed(&core, &update_run).await;
        todo_id
    });

    rt.block_on(async {
        let pool = open_readonly_pool(&workspace).await;
        let data = entity_data(&pool, &todo_id).await;
        assert!(
            data.get("recurrence").is_none(),
            "the null sentinel DROPPED the recurrence key — got {data}"
        );
        assert_eq!(
            data["due_at"].as_str(),
            Some("2026-06-14T18:00:00"),
            "the anchor date is PRESERVED (only recurrence cleared)"
        );
        assert_eq!(
            max_revision_seq(&pool, &todo_id).await,
            2,
            "the clear appends a seq-2 revision"
        );
    });
}

/// Case 6 (recurrence anchor-clear rejected, ADR-0037): a Todo with `due_at` + a
/// due-anchored recurrence; `update_todo { due_at: null }` would clear the date
/// the live rule anchors on → the MERGED whole fails anchor-presence → -32602 and
/// NOTHING changes (data unchanged, no new revision, proposal pending, run parked).
#[test]
fn update_todo_clearing_recurrence_anchor_is_invalid_and_changes_nothing() {
    let workspace = Workspace::new();
    let params_path = workspace.path().join("propose-params.json");
    let core = build_core(&workspace, &params_path);
    let rt = rt();

    let (todo_id, update_run_id) = rt.block_on(async {
        let todo_id = create_todo(
            &core,
            &params_path,
            serde_json::json!({
                "title": "Water the plants",
                "due_at": "2026-06-14T18:00:00",
                "recurrence": {
                    "interval": 1, "unit": "week", "anchor": "due_at"
                }
            }),
            serde_json::json!([]),
            "todo-create",
        )
        .await;

        // Clear due_at out from under the still-live due-anchored recurrence.
        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "update_todo",
                "payload": {
                    "todo_id": todo_id,
                    "todo": { "due_at": null }
                },
                "rationale": "the user cleared the due date"
            }),
        );
        let (update_run, update_proposal) =
            create_thread_and_park(&core, "Clear the due date.").await;
        let resp = decide_accept(&core, &update_proposal, "todo-bad-anchor-clear").await;
        assert_eq!(
            resp["error"]["code"].as_i64(),
            Some(-32602),
            "clearing the recurrence anchor → invalid_params — body: {resp}"
        );
        // The rejected decide leaves the Run parked; wait for that transition to
        // commit before the next block reads run/proposal status (else it races).
        await_parked(&core, &update_run).await;
        (todo_id, update_run)
    });

    rt.block_on(async {
        let pool = open_readonly_pool(&workspace).await;
        let data = entity_data(&pool, &todo_id).await;
        assert_eq!(
            data["due_at"].as_str(),
            Some("2026-06-14T18:00:00"),
            "the due_at is unchanged (the clear was rejected)"
        );
        assert!(
            data.get("recurrence").is_some(),
            "the recurrence is still present — got {data}"
        );
        assert_eq!(
            max_revision_seq(&pool, &todo_id).await,
            1,
            "no new revision was written"
        );
        let proposal_status: String = sqlx::query_scalar(
            "SELECT p.status FROM proposals p \
             JOIN tool_calls tc ON tc.id = p.tool_call_id WHERE tc.run_id = ?1",
        )
        .bind(&update_run_id)
        .fetch_one(&pool)
        .await
        .expect("proposal row exists");
        assert_eq!(proposal_status, "pending", "the proposal stays pending");
        let run_status: String = sqlx::query_scalar("SELECT status FROM runs WHERE id = ?1")
            .bind(&update_run_id)
            .fetch_one(&pool)
            .await
            .expect("run row exists");
        assert_eq!(run_status, "parked", "the run stays parked");
    });
}
