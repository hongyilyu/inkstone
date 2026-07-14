//! An accepted `update_person` / `update_project` Proposal replaces the target
//! Entity's data, writes a new `entity_revisions` snapshot, and records an
//! `updated_from` Entity Source (ADR-0031, ADR-0025). Proves Core's update/apply
//! path is no longer journal-entry-specific.
//!
//! One Core, multi-run: the `propose-worker.ts` fixture re-reads
//! `INKSTONE_PROPOSE_PARAMS_FILE` on each fresh spawn, so each run rewrites the
//! file with the next mutation (create, then update) before posting a message.

use std::path::Path;

mod common;
use common::{
    CoreHandle, Workspace, await_completed, create_and_park, decide_accept, entity_data,
    max_revision_seq, open_readonly_pool, proposal_and_tool_status_for_run, rpc, rt,
    updated_from_count_for_run,
};

fn write_params(path: &Path, params: serde_json::Value) {
    std::fs::write(path, params.to_string()).expect("write propose params file");
}

/// Post a message on a new thread (the params file already holds the mutation),
/// wait until the Run parks, and return `(run_id, proposal_id, mutation_kind)`.
async fn create_thread_and_park(core: &CoreHandle, prompt: &str) -> (String, String, String) {
    let (run_id, _) = create_and_park(core, prompt).await;
    let (proposal_id, mutation_kind) = pending_proposal(core, &run_id).await;
    (run_id, proposal_id, mutation_kind)
}

async fn proposal_get(core: &CoreHandle, run_id: &str) -> serde_json::Value {
    rpc(
        core,
        3,
        "proposal/get",
        serde_json::json!({ "run_id": run_id }),
    )
    .await
}

async fn pending_proposal(core: &CoreHandle, run_id: &str) -> (String, String) {
    let resp = rpc(
        core,
        3,
        "proposal/get",
        serde_json::json!({ "run_id": run_id }),
    )
    .await;
    let proposal_id = resp["result"]["proposal_id"]
        .as_str()
        .unwrap_or_else(|| panic!("proposal_id is a string — body: {resp}"))
        .to_string();
    let mutation_kind = resp["result"]["mutation_kind"]
        .as_str()
        .unwrap_or_else(|| panic!("mutation_kind is a string — body: {resp}"))
        .to_string();
    (proposal_id, mutation_kind)
}

#[test]
fn update_person_replaces_data_and_records_updated_from() {
    let workspace = Workspace::new();
    let params_path = workspace.path().join("propose-params.json");

    // Run 1 proposes the create.
    write_params(
        &params_path,
        serde_json::json!({
            "mutation_kind": "create_person",
            "payload": { "name": "Alice", "note": "daycare coordinator" },
            "rationale": "remember Alice"
        }),
    );

    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    let rt = rt();

    let (entity_id, update_run_id) = rt.block_on(async {
        let (create_run, create_proposal, kind) =
            create_thread_and_park(&core, "Remember Alice, the daycare coordinator.").await;
        assert_eq!(kind, "create_person", "first proposal is a create_person");
        let resp = decide_accept(&core, &create_proposal, "person-create").await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "create_person accept — body: {resp}"
        );
        let entity_id = resp["result"]["entity_id"]
            .as_str()
            .unwrap_or_else(|| panic!("entity_id is a string — body: {resp}"))
            .to_string();
        await_completed(&core, &create_run).await;

        // Run 2 proposes the update of the just-created Person.
        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "update_person",
                "payload": { "entity_id": entity_id, "name": "Alice", "note": "new note" },
                "rationale": "the user corrected Alice's note"
            }),
        );
        let (update_run, update_proposal, kind) =
            create_thread_and_park(&core, "Update Alice's note.").await;
        assert_eq!(kind, "update_person", "second proposal is an update_person");
        let resp = decide_accept(&core, &update_proposal, "person-update").await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "update_person accept — body: {resp}"
        );
        assert_eq!(
            resp["result"]["entity_id"].as_str(),
            Some(entity_id.as_str()),
            "update returns the target entity id — body: {resp}"
        );
        await_completed(&core, &update_run).await;
        (entity_id, update_run)
    });

    rt.block_on(async {
        let pool = open_readonly_pool(&workspace).await;
        let data = entity_data(&pool, &entity_id).await;
        assert_eq!(
            data["note"].as_str(),
            Some("new note"),
            "entity current data reflects the updated note"
        );
        assert!(
            data.get("entity_id").is_none(),
            "stored entity data does not persist the update target id"
        );
        assert_eq!(
            max_revision_seq(&pool, &entity_id).await,
            2,
            "update appends a seq-2 revision"
        );
        assert_eq!(
            updated_from_count_for_run(&pool, &entity_id, &update_run_id).await,
            1,
            "accepted update records an updated_from source from the current user Message"
        );
    });
}

#[test]
fn update_project_replaces_status_and_records_updated_from() {
    let workspace = Workspace::new();
    let params_path = workspace.path().join("propose-params.json");

    write_params(
        &params_path,
        serde_json::json!({
            "mutation_kind": "create_project",
            "payload": { "name": "Ship API v2", "status": "active" },
            "rationale": "track the project"
        }),
    );

    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    let rt = rt();

    let (entity_id, update_run_id) = rt.block_on(async {
        let (create_run, create_proposal, kind) =
            create_thread_and_park(&core, "Track the Ship API v2 project.").await;
        assert_eq!(kind, "create_project", "first proposal is a create_project");
        let resp = decide_accept(&core, &create_proposal, "project-create").await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "create_project accept — body: {resp}"
        );
        let entity_id = resp["result"]["entity_id"]
            .as_str()
            .unwrap_or_else(|| panic!("entity_id is a string — body: {resp}"))
            .to_string();
        await_completed(&core, &create_run).await;

        // active → on_hold is a valid transition; both forbid timestamps.
        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "update_project",
                "payload": { "entity_id": entity_id, "name": "Ship API v2", "status": "on_hold" },
                "rationale": "the user paused the project"
            }),
        );
        let (update_run, update_proposal, kind) =
            create_thread_and_park(&core, "Put Ship API v2 on hold.").await;
        assert_eq!(kind, "update_project", "second proposal is an update_project");
        let resp = decide_accept(&core, &update_proposal, "project-update").await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "update_project accept — body: {resp}"
        );
        assert_eq!(
            resp["result"]["entity_id"].as_str(),
            Some(entity_id.as_str()),
            "update returns the target entity id — body: {resp}"
        );
        await_completed(&core, &update_run).await;
        (entity_id, update_run)
    });

    rt.block_on(async {
        let pool = open_readonly_pool(&workspace).await;
        let data = entity_data(&pool, &entity_id).await;
        assert_eq!(
            data["status"].as_str(),
            Some("on_hold"),
            "entity current data reflects the updated status"
        );
        assert_eq!(
            max_revision_seq(&pool, &entity_id).await,
            2,
            "update appends a seq-2 revision"
        );
        assert_eq!(
            updated_from_count_for_run(&pool, &entity_id, &update_run_id).await,
            1,
            "accepted update records an updated_from source from the current user Message"
        );
    });
}

#[test]
fn update_person_with_non_person_target_is_invalid() {
    let workspace = Workspace::new();
    let params_path = workspace.path().join("propose-params.json");

    write_params(
        &params_path,
        serde_json::json!({
            "mutation_kind": "create_project",
            "payload": { "name": "Ship API v2", "status": "active" },
            "rationale": "track the project"
        }),
    );

    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    let rt = rt();

    let (project_id, update_run_id) = rt.block_on(async {
        let (create_run, create_proposal, _) =
            create_thread_and_park(&core, "Track the Ship API v2 project.").await;
        let resp = decide_accept(&core, &create_proposal, "project-create").await;
        let project_id = resp["result"]["entity_id"]
            .as_str()
            .unwrap_or_else(|| panic!("entity_id is a string — body: {resp}"))
            .to_string();
        await_completed(&core, &create_run).await;

        // update_person pointed at the Project's id — a target-type mismatch.
        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "update_person",
                "payload": { "entity_id": project_id, "name": "Not a person" },
                "rationale": "the user tried to edit the wrong entity type"
            }),
        );
        let (update_run, update_proposal, _) =
            create_thread_and_park(&core, "Rename that to a person.").await;
        let resp = decide_accept(&core, &update_proposal, "bad-target").await;
        assert_eq!(
            resp["error"]["code"].as_i64(),
            Some(-32602),
            "bad-target-type update is invalid_params — body: {resp}"
        );
        assert!(
            resp["error"]["message"]
                .as_str()
                .unwrap_or_default()
                .contains("Accepted person"),
            "invalid reason names the required target entity type — body: {resp}"
        );
        (project_id, update_run)
    });

    rt.block_on(async {
        let pool = open_readonly_pool(&workspace).await;
        // The Project entity is untouched by the bad update.
        assert_eq!(
            max_revision_seq(&pool, &project_id).await,
            1,
            "bad-target update writes no new revision on the project"
        );
        let (proposal_status, tool_status) =
            proposal_and_tool_status_for_run(&pool, &update_run_id).await;
        assert_eq!(
            proposal_status, "pending",
            "bad-target update leaves the proposal pending"
        );
        assert_eq!(
            tool_status, "pending",
            "bad-target update leaves the tool call unresolved"
        );
        let run_status: String = sqlx::query_scalar("SELECT status FROM runs WHERE id = ?1")
            .bind(&update_run_id)
            .fetch_one(&pool)
            .await
            .expect("run row exists");
        assert_eq!(run_status, "parked", "bad-target update leaves the run parked");
    });
}

/// lamplit-desk-alignment: `proposal/get` for an `update_person` returns the
/// CURRENT stored Person as `review_context.current_person`, so the Client can
/// render Current-vs-Proposed. The proposed payload OMITS `note` and `aliases`
/// (an accepted full-document REPLACE would drop them, ADR-0016/ADR-0033); the
/// current context still surfaces them, making the removal visible before accept.
#[test]
fn proposal_get_returns_current_person_with_replaced_away_fields() {
    let workspace = Workspace::new();
    let params_path = workspace.path().join("propose-params.json");

    write_params(
        &params_path,
        serde_json::json!({
            "mutation_kind": "create_person",
            "payload": { "name": "Alice", "note": "daycare coordinator", "aliases": ["Al"] },
            "rationale": "remember Alice"
        }),
    );

    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    let rt = rt();

    rt.block_on(async {
        let (create_run, create_proposal, kind) =
            create_thread_and_park(&core, "Remember Alice, the daycare coordinator.").await;
        assert_eq!(kind, "create_person", "first proposal is a create_person");
        let resp = decide_accept(&core, &create_proposal, "person-create").await;
        let entity_id = resp["result"]["entity_id"]
            .as_str()
            .unwrap_or_else(|| panic!("entity_id is a string — body: {resp}"))
            .to_string();
        await_completed(&core, &create_run).await;

        // The proposed update keeps only `name` (renamed) — `note` and `aliases`
        // are omitted, so an accepted REPLACE removes them.
        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "update_person",
                "payload": { "entity_id": entity_id, "name": "Alice Renamed" },
                "rationale": "the user renamed Alice and dropped the note"
            }),
        );
        let (update_run, _proposal_id, kind) =
            create_thread_and_park(&core, "Rename Alice.").await;
        assert_eq!(kind, "update_person", "second proposal is an update_person");

        let resp = proposal_get(&core, &update_run).await;
        let current = &resp["result"]["review_context"]["current_person"];
        assert_eq!(
            current["entity_id"].as_str(),
            Some(entity_id.as_str()),
            "current_person carries the stored entity id — body: {resp}"
        );
        assert_eq!(
            current["name"].as_str(),
            Some("Alice"),
            "current_person carries the stored name (pre-rename) — body: {resp}"
        );
        assert_eq!(
            current["note"].as_str(),
            Some("daycare coordinator"),
            "current_person surfaces the note the REPLACE would drop — body: {resp}"
        );
        assert_eq!(
            current["aliases"],
            serde_json::json!(["Al"]),
            "current_person surfaces the aliases the REPLACE would drop — body: {resp}"
        );
        // The proposed payload stays mutation-only (the current context is a
        // separate review surface, not folded into the payload).
        assert!(
            resp["result"]["payload"].get("note").is_none(),
            "proposed payload omits the dropped note — body: {resp}"
        );
    });
}

/// lamplit-desk-alignment: the `update_project` sibling of the test above. A
/// `proposal/get` for an `update_project` returns the CURRENT stored Project as
/// `review_context.current_project`. The proposed payload OMITS `outcome` and
/// `note` (a full-document REPLACE would drop them, ADR-0016/ADR-0033); the
/// current context still surfaces them. Also confirms Project review-context
/// still works after the `update_todo` review-context wiring was removed.
#[test]
fn proposal_get_returns_current_project_with_replaced_away_fields() {
    let workspace = Workspace::new();
    let params_path = workspace.path().join("propose-params.json");

    write_params(
        &params_path,
        serde_json::json!({
            "mutation_kind": "create_project",
            "payload": {
                "name": "Ship API v2",
                "outcome": "all clients on v2 by Q3",
                "status": "active",
                "note": "kickoff next week"
            },
            "rationale": "track the project"
        }),
    );

    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    let rt = rt();

    rt.block_on(async {
        let (create_run, create_proposal, kind) =
            create_thread_and_park(&core, "Track the Ship API v2 project.").await;
        assert_eq!(kind, "create_project", "first proposal is a create_project");
        let resp = decide_accept(&core, &create_proposal, "project-create").await;
        let entity_id = resp["result"]["entity_id"]
            .as_str()
            .unwrap_or_else(|| panic!("entity_id is a string — body: {resp}"))
            .to_string();
        await_completed(&core, &create_run).await;

        // The proposed update keeps only `name` + `status` — `outcome` and `note`
        // are omitted, so an accepted REPLACE removes them.
        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "update_project",
                "payload": { "entity_id": entity_id, "name": "Ship API v2", "status": "on_hold" },
                "rationale": "the user paused the project and dropped the note"
            }),
        );
        let (update_run, _proposal_id, kind) =
            create_thread_and_park(&core, "Put Ship API v2 on hold.").await;
        assert_eq!(kind, "update_project", "second proposal is an update_project");

        let resp = proposal_get(&core, &update_run).await;
        let current = &resp["result"]["review_context"]["current_project"];
        assert_eq!(
            current["entity_id"].as_str(),
            Some(entity_id.as_str()),
            "current_project carries the stored entity id — body: {resp}"
        );
        assert_eq!(
            current["name"].as_str(),
            Some("Ship API v2"),
            "current_project carries the stored name — body: {resp}"
        );
        assert_eq!(
            current["outcome"].as_str(),
            Some("all clients on v2 by Q3"),
            "current_project surfaces the outcome the REPLACE would drop — body: {resp}"
        );
        assert_eq!(
            current["note"].as_str(),
            Some("kickoff next week"),
            "current_project surfaces the note the REPLACE would drop — body: {resp}"
        );
        // The proposed payload stays mutation-only.
        assert!(
            resp["result"]["payload"].get("note").is_none(),
            "proposed payload omits the dropped note — body: {resp}"
        );
        assert!(
            resp["result"]["payload"].get("outcome").is_none(),
            "proposed payload omits the dropped outcome — body: {resp}"
        );
    });
}
