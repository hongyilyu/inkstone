//! An accepted `delete_project` removes the Project Entity via the generic
//! delete path (its revisions/sources cascade away by FK). A delete whose
//! target is the wrong Entity Type is `invalid_params` (-32602) and writes
//! nothing.
//!
//! Driven by `tests/fixtures/propose-worker.ts`: a tempfile pointed at by
//! `INKSTONE_PROPOSE_PARAMS_FILE` supplies the raw mutation the fixture
//! proposes. Each `thread/create` spawns a fresh worker that re-reads the file
//! at start, so a test can create a Project, then a delete — all on the SAME
//! Core (and DB) across successive Runs.

use sqlx::Row;
use sqlx::sqlite::SqlitePoolOptions;

mod common;
use common::{await_completed, CoreHandle, create_and_park, proposal_id_for, rpc, rt, Workspace};

/// Write the raw `propose_workspace_mutation` params the fixture re-reads on its
/// next spawn.
fn write_params(path: &std::path::Path, params: serde_json::Value) {
    std::fs::write(path, params.to_string()).expect("write propose params file");
}

/// Propose `params` on a fresh Run, accept it with `idem_key`, and return the
/// new Entity id. Drives one create-and-accept cycle against `core`.
async fn create_entity(
    core: &CoreHandle,
    params_path: &std::path::Path,
    params: serde_json::Value,
    prompt: &str,
    idem_key: &str,
    base_id: u64,
) -> String {
    write_params(params_path, params);
    let run = create_and_park(core, prompt).await.0;
    let proposal = proposal_id_for(core, &run).await;
    let resp = rpc(
        core,
        base_id + 3,
        "proposal/decide",
        serde_json::json!({
            "proposal_id": proposal,
            "decision": "accept",
            "decision_idempotency_key": idem_key,
        }),
    )
    .await;
    assert_eq!(
        resp["result"]["status"].as_str(),
        Some("accepted"),
        "create decide accepted — body: {resp}"
    );
    let entity_id = resp["result"]["entity_id"]
        .as_str()
        .unwrap_or_else(|| panic!("entity_id is a string — body: {resp}"))
        .to_string();
    await_completed(core, &run).await;
    entity_id
}

async fn ro_pool(workspace: &Workspace) -> sqlx::SqlitePool {
    let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .expect("connect to migrated DB")
}

async fn entity_exists(pool: &sqlx::SqlitePool, entity_id: &str) -> bool {
    let row: Option<String> = sqlx::query_scalar("SELECT id FROM entities WHERE id = ?1")
        .bind(entity_id)
        .fetch_optional(pool)
        .await
        .expect("query entity exists");
    row.is_some()
}

/// Seed a Project and a bystander Person against a fresh Core. Returns
/// `(core, workspace, params_dir_guard, rt, project_id, person_id)`. The
/// tempdir guard must outlive the Core (the worker re-reads the params file
/// there).
#[allow(clippy::type_complexity)]
fn seed_project_and_person(
    prefix: &str,
) -> (
    CoreHandle,
    Workspace,
    tempfile::TempDir,
    tokio::runtime::Runtime,
    String,
    String,
) {
    let workspace = Workspace::new();
    let params_dir = tempfile::Builder::new()
        .prefix(prefix)
        .tempdir()
        .expect("create params tempdir");
    let params_path = params_dir.path().join("propose-params.json");
    write_params(&params_path, serde_json::json!({}));

    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    let rt = rt();

    let (project_id, person_id) = rt.block_on(async {
        let project_id = create_entity(
            &core,
            &params_path,
            serde_json::json!({
                "mutation_kind": "create_project",
                "payload": { "name": "Ship v2" },
                "rationale": "track the launch"
            }),
            "Start the v2 project.",
            "project-k1",
            1,
        )
        .await;

        let person_id = create_entity(
            &core,
            &params_path,
            serde_json::json!({
                "mutation_kind": "create_person",
                "payload": { "name": "Alice" },
                "rationale": "remember the coordinator"
            }),
            "Remember Alice.",
            "person-k1",
            10,
        )
        .await;

        (project_id, person_id)
    });

    (core, workspace, params_dir, rt, project_id, person_id)
}

/// Case 1: an accepted `delete_project` removes the Project entity and leaves
/// unrelated entities untouched.
#[test]
fn delete_project_removes_entity_and_keeps_bystanders() {
    let (core, workspace, _params_dir, rt, project_id, person_id) =
        seed_project_and_person("inkstone-delete-project-");
    let params_path = _params_dir.path().join("propose-params.json");

    rt.block_on(async {
        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "delete_project",
                "payload": { "entity_id": project_id },
                "rationale": "the user no longer tracks this project"
            }),
        );
        let run = create_and_park(&core, "Drop the v2 project.").await.0;
        let proposal = proposal_id_for(&core, &run).await;
        let resp = rpc(
            &core,
            43,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal,
                "decision": "accept",
                "decision_idempotency_key": "del-project-k1",
            }),
        )
        .await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "delete_project accepted — body: {resp}"
        );
        assert_eq!(
            resp["result"]["entity_id"].as_str(),
            Some(project_id.as_str()),
            "delete_project returns the deleted project id — body: {resp}"
        );
        await_completed(&core, &run).await;
    });

    rt.block_on(async {
        let pool = ro_pool(&workspace).await;
        assert!(
            !entity_exists(&pool, &project_id).await,
            "accepted delete_project removes the Project entity"
        );
        assert!(
            entity_exists(&pool, &person_id).await,
            "an unrelated Person entity is left in place"
        );
    });
}

/// Case 2: a `delete_project` whose target is a Person (wrong Entity Type) →
/// -32602; nothing is changed — both entities keep their rows, the Proposal
/// stays pending, the Run stays parked.
#[test]
fn delete_project_with_person_target_is_invalid_and_writes_nothing() {
    let (core, workspace, _params_dir, rt, project_id, person_id) =
        seed_project_and_person("inkstone-delete-project-bad-target-");
    let params_path = _params_dir.path().join("propose-params.json");

    let run = rt.block_on(async {
        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "delete_project",
                "payload": { "entity_id": person_id },
                "rationale": "wrong target type"
            }),
        );
        let run = create_and_park(&core, "Drop that project.").await.0;
        let proposal = proposal_id_for(&core, &run).await;
        let resp = rpc(
            &core,
            43,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal,
                "decision": "accept",
                "decision_idempotency_key": "del-project-bad",
            }),
        )
        .await;
        assert_eq!(
            resp["error"]["code"].as_i64(),
            Some(-32602),
            "delete_project against a Person target → invalid_params — body: {resp}"
        );
        let parked = rpc(
            &core,
            44,
            "run/subscribe",
            serde_json::json!({ "run_id": run }),
        )
        .await;
        assert_eq!(
            parked["result"]["status"].as_str(),
            Some("parked"),
            "invalid delete leaves the Run parked — body: {parked}"
        );
        run
    });

    rt.block_on(async {
        let pool = ro_pool(&workspace).await;
        assert!(
            entity_exists(&pool, &project_id).await,
            "the Project entity is left in place"
        );
        assert!(
            entity_exists(&pool, &person_id).await,
            "the mistargeted Person entity is left in place"
        );
        let row = sqlx::query(
            "SELECT p.status, tc.status AS tool_status \
             FROM proposals p JOIN tool_calls tc ON tc.id = p.tool_call_id \
             WHERE tc.run_id = ?1",
        )
        .bind(&run)
        .fetch_one(&pool)
        .await
        .expect("delete proposal row exists");
        let proposal_status: String = row.get("status");
        let tool_status: String = row.get("tool_status");
        assert_eq!(
            proposal_status, "pending",
            "invalid delete leaves the proposal pending"
        );
        assert_eq!(
            tool_status, "pending",
            "invalid delete leaves the tool call unresolved"
        );
    });
}
