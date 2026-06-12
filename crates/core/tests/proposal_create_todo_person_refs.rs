//! An accepted `create_todo` carrying `person_refs` writes the Todo Entity AND
//! its `todo_person_refs` rows in ONE transaction (ADR-0031, ADR-0025). Each
//! `person_id` must reference an Accepted Person, else `proposal/decide` returns
//! `invalid_params` (-32602) and NOTHING is written (atomic). There is at most
//! one row per `(todo_id, person_id)`; a duplicate person in one payload is
//! de-duped with `waiting_on` winning over `related`; a ref with no `role`
//! defaults to `related`.
//!
//! Driven by `tests/fixtures/propose-worker.ts`: a tempfile pointed at by
//! `INKSTONE_PROPOSE_PARAMS_FILE` supplies the raw mutation the fixture proposes.
//! Each `thread/create` spawns a fresh worker that re-reads the file at start, so
//! a test can create a Person on the first run, rewrite the file to a
//! `create_todo` referencing that Person id, and create a Todo on a SECOND run
//! against the SAME Core (and DB).

use std::time::{Duration, Instant};

use futures_util::SinkExt;
use sqlx::Row;
use sqlx::sqlite::SqlitePoolOptions;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{CoreHandle, Workspace, next_text};

/// Open a fresh socket, send a single request, return the response body.
async fn rpc(
    core: &CoreHandle,
    id: u64,
    method: &str,
    params: serde_json::Value,
) -> serde_json::Value {
    let mut ws = core.connect().await;
    let req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    ws.send(Message::Text(req.to_string().into()))
        .await
        .expect("send request frame");
    let body = next_text(&mut ws).await;
    ws.close(None).await.ok();
    serde_json::from_str(&body).unwrap_or_else(|e| panic!("response is JSON: {e} — body: {body}"))
}

/// Create a Run with `prompt` and poll run/subscribe until it parks; returns the
/// run_id. `id` keeps the JSON-RPC request ids distinct across multiple Runs on
/// one Core.
async fn create_and_park(core: &CoreHandle, id: u64, prompt: &str) -> String {
    let resp = rpc(
        core,
        id,
        "thread/create",
        serde_json::json!({ "prompt": prompt }),
    )
    .await;
    let run_id = resp["result"]["run_id"]
        .as_str()
        .unwrap_or_else(|| panic!("result.run_id is a string — body: {resp}"))
        .to_string();

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if Instant::now() > deadline {
            panic!("timed out waiting for run to park");
        }
        let resp = rpc(
            core,
            id + 1,
            "run/subscribe",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        if resp["result"]["status"].as_str() == Some("parked") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    run_id
}

/// Poll run/subscribe until the Run reaches `completed`; panics on timeout.
async fn await_completed(core: &CoreHandle, run_id: &str) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if Instant::now() > deadline {
            panic!("timed out waiting for run to complete");
        }
        let resp = rpc(
            core,
            99,
            "run/subscribe",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        if resp["result"]["status"].as_str() == Some("completed") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

/// Read a Run's pending proposal_id.
async fn proposal_id_for(core: &CoreHandle, id: u64, run_id: &str) -> String {
    let resp = rpc(
        core,
        id,
        "proposal/get",
        serde_json::json!({ "run_id": run_id }),
    )
    .await;
    resp["result"]["proposal_id"]
        .as_str()
        .unwrap_or_else(|| panic!("proposal_id is a string — body: {resp}"))
        .to_string()
}

/// Write the raw `propose_workspace_mutation` params the fixture re-reads on its
/// next spawn.
fn write_params(path: &std::path::Path, params: serde_json::Value) {
    std::fs::write(path, params.to_string()).expect("write propose params file");
}

/// Run 1: propose a Person and accept it; return its entity id.
async fn create_person(core: &CoreHandle, params_path: &std::path::Path) -> String {
    write_params(
        params_path,
        serde_json::json!({
            "mutation_kind": "create_person",
            "payload": { "name": "Alice" },
            "rationale": "remember the coordinator"
        }),
    );

    let person_run = create_and_park(core, 1, "Remember Alice.").await;
    let person_proposal = proposal_id_for(core, 3, &person_run).await;
    let resp = rpc(
        core,
        4,
        "proposal/decide",
        serde_json::json!({
            "proposal_id": person_proposal,
            "decision": "accept",
            "decision_idempotency_key": "person-k1",
        }),
    )
    .await;
    assert_eq!(
        resp["result"]["status"].as_str(),
        Some("accepted"),
        "person decide accepted — body: {resp}"
    );
    let person_id = resp["result"]["entity_id"]
        .as_str()
        .unwrap_or_else(|| panic!("person entity_id is a string — body: {resp}"))
        .to_string();
    await_completed(core, &person_run).await;
    person_id
}

async fn ro_pool(workspace: &Workspace) -> sqlx::SqlitePool {
    let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .expect("connect to migrated DB")
}

/// Case 1 (happy): a `create_todo` with `person_refs=[{person_id, role:"waiting_on"}]`
/// writes one `todo_person_refs` row `(todo_id=<new todo id>, person_id, role='waiting_on')`.
#[test]
fn accept_create_todo_writes_waiting_on_person_ref() {
    let workspace = Workspace::new();
    let params_dir = tempfile::Builder::new()
        .prefix("inkstone-todo-refs-happy-")
        .tempdir()
        .expect("create params tempdir");
    let params_path = params_dir.path().join("propose-params.json");
    // Seed the file so the spawned worker can read it (rewritten before run 1).
    write_params(&params_path, serde_json::json!({}));

    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let (person_id, todo_entity_id) = rt.block_on(async {
        let person_id = create_person(&core, &params_path).await;

        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "create_todo",
                "payload": {
                    "todo": { "title": "Follow up" },
                    "person_refs": [{ "person_id": person_id, "role": "waiting_on" }]
                },
                "rationale": "track the follow-up"
            }),
        );

        let todo_run = create_and_park(&core, 10, "I need to follow up with Alice.").await;
        let todo_proposal = proposal_id_for(&core, 13, &todo_run).await;
        let resp = rpc(
            &core,
            14,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": todo_proposal,
                "decision": "accept",
                "decision_idempotency_key": "todo-k1",
            }),
        )
        .await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "todo decide accepted — body: {resp}"
        );
        let todo_entity_id = resp["result"]["entity_id"]
            .as_str()
            .unwrap_or_else(|| panic!("todo entity_id is a string — body: {resp}"))
            .to_string();
        await_completed(&core, &todo_run).await;
        (person_id, todo_entity_id)
    });

    rt.block_on(async {
        let pool = ro_pool(&workspace).await;
        let row =
            sqlx::query("SELECT todo_id, person_id, role FROM todo_person_refs WHERE todo_id = ?1")
                .bind(&todo_entity_id)
                .fetch_one(&pool)
                .await
                .expect("one todo_person_refs row exists");
        let todo_id: String = row.get("todo_id");
        let ref_person_id: String = row.get("person_id");
        let role: String = row.get("role");
        assert_eq!(todo_id, todo_entity_id, "row points at the new todo");
        assert_eq!(ref_person_id, person_id, "row points at the person");
        assert_eq!(role, "waiting_on", "role persisted as waiting_on");

        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM todo_person_refs WHERE todo_id = ?1")
                .bind(&todo_entity_id)
                .fetch_one(&pool)
                .await
                .expect("count refs");
        assert_eq!(count, 1, "exactly one ref row");

        // Refs live in the table, NOT in Todo JSON.
        let data: String = sqlx::query_scalar("SELECT data FROM entities WHERE id = ?1")
            .bind(&todo_entity_id)
            .fetch_one(&pool)
            .await
            .expect("todo entity row exists");
        let data_json: serde_json::Value = serde_json::from_str(&data).expect("entity data JSON");
        assert!(
            data_json.get("person_refs").is_none(),
            "person_refs is NOT stored in Todo JSON — got {data}"
        );
    });
}

/// Case 2 (bad person_id): a ref pointing at a non-person id (here, a Project id)
/// → -32602; ZERO todo entities AND zero `todo_person_refs` rows (atomic).
#[test]
fn create_todo_with_non_person_ref_is_rejected_atomically() {
    let workspace = Workspace::new();
    let params_dir = tempfile::Builder::new()
        .prefix("inkstone-todo-refs-bad-")
        .tempdir()
        .expect("create params tempdir");
    let params_path = params_dir.path().join("propose-params.json");
    write_params(&params_path, serde_json::json!({}));

    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        // Run 1: create a Project — a valid Entity, but NOT a Person.
        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "create_project",
                "payload": { "name": "Migration" },
                "rationale": "start the outcome"
            }),
        );
        let project_run = create_and_park(&core, 1, "Start the migration.").await;
        let project_proposal = proposal_id_for(&core, 3, &project_run).await;
        let resp = rpc(
            &core,
            4,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": project_proposal,
                "decision": "accept",
                "decision_idempotency_key": "proj-k1",
            }),
        )
        .await;
        let project_id = resp["result"]["entity_id"]
            .as_str()
            .unwrap_or_else(|| panic!("project entity_id is a string — body: {resp}"))
            .to_string();
        await_completed(&core, &project_run).await;

        // Run 2: create_todo whose person_refs[].person_id is the Project id.
        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "create_todo",
                "payload": {
                    "todo": { "title": "Follow up" },
                    "person_refs": [{ "person_id": project_id, "role": "waiting_on" }]
                },
                "rationale": "dangling person link"
            }),
        );
        let todo_run = create_and_park(&core, 10, "Follow up on the migration.").await;
        let todo_proposal = proposal_id_for(&core, 13, &todo_run).await;
        let resp = rpc(
            &core,
            14,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": todo_proposal,
                "decision": "accept",
                "decision_idempotency_key": "todo-bad",
            }),
        )
        .await;
        assert_eq!(
            resp["error"]["code"].as_i64(),
            Some(-32602),
            "non-person person_id → invalid_params — body: {resp}"
        );
    });

    rt.block_on(async {
        let pool = ro_pool(&workspace).await;
        let todo_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM entities WHERE type = 'todo'")
                .fetch_one(&pool)
                .await
                .expect("count todo entities");
        assert_eq!(todo_count, 0, "rejected create_todo created no todo entity");
        let ref_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM todo_person_refs")
            .fetch_one(&pool)
            .await
            .expect("count refs");
        assert_eq!(ref_count, 0, "rejected create_todo wrote no person refs");
    });
}

/// Case 3 (dedup): `person_refs=[{X,related},{X,waiting_on}]` → exactly ONE row
/// for X with role `waiting_on` (waiting_on wins).
#[test]
fn duplicate_person_ref_collapses_with_waiting_on_winning() {
    let workspace = Workspace::new();
    let params_dir = tempfile::Builder::new()
        .prefix("inkstone-todo-refs-dedup-")
        .tempdir()
        .expect("create params tempdir");
    let params_path = params_dir.path().join("propose-params.json");
    write_params(&params_path, serde_json::json!({}));

    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let (person_id, todo_entity_id) = rt.block_on(async {
        let person_id = create_person(&core, &params_path).await;
        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "create_todo",
                "payload": {
                    "todo": { "title": "Follow up" },
                    "person_refs": [
                        { "person_id": person_id, "role": "related" },
                        { "person_id": person_id, "role": "waiting_on" }
                    ]
                },
                "rationale": "track the follow-up"
            }),
        );
        let todo_run = create_and_park(&core, 10, "Follow up with Alice.").await;
        let todo_proposal = proposal_id_for(&core, 13, &todo_run).await;
        let resp = rpc(
            &core,
            14,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": todo_proposal,
                "decision": "accept",
                "decision_idempotency_key": "todo-dedup",
            }),
        )
        .await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "todo decide accepted — body: {resp}"
        );
        let todo_entity_id = resp["result"]["entity_id"]
            .as_str()
            .unwrap_or_else(|| panic!("todo entity_id is a string — body: {resp}"))
            .to_string();
        await_completed(&core, &todo_run).await;
        (person_id, todo_entity_id)
    });

    rt.block_on(async {
        let pool = ro_pool(&workspace).await;
        let rows = sqlx::query("SELECT person_id, role FROM todo_person_refs WHERE todo_id = ?1")
            .bind(&todo_entity_id)
            .fetch_all(&pool)
            .await
            .expect("fetch refs");
        assert_eq!(rows.len(), 1, "duplicate person collapses to one row");
        let ref_person_id: String = rows[0].get("person_id");
        let role: String = rows[0].get("role");
        assert_eq!(ref_person_id, person_id, "row points at the person");
        assert_eq!(role, "waiting_on", "waiting_on wins over related");
    });
}

/// Case 4 (role default): a ref `{person_id}` with no `role` → row with role
/// `related`.
#[test]
fn person_ref_without_role_defaults_to_related() {
    let workspace = Workspace::new();
    let params_dir = tempfile::Builder::new()
        .prefix("inkstone-todo-refs-default-")
        .tempdir()
        .expect("create params tempdir");
    let params_path = params_dir.path().join("propose-params.json");
    write_params(&params_path, serde_json::json!({}));

    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let todo_entity_id = rt.block_on(async {
        let person_id = create_person(&core, &params_path).await;
        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "create_todo",
                "payload": {
                    "todo": { "title": "Follow up" },
                    "person_refs": [{ "person_id": person_id }]
                },
                "rationale": "track the follow-up"
            }),
        );
        let todo_run = create_and_park(&core, 10, "Follow up with Alice.").await;
        let todo_proposal = proposal_id_for(&core, 13, &todo_run).await;
        let resp = rpc(
            &core,
            14,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": todo_proposal,
                "decision": "accept",
                "decision_idempotency_key": "todo-default",
            }),
        )
        .await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "todo decide accepted — body: {resp}"
        );
        let todo_entity_id = resp["result"]["entity_id"]
            .as_str()
            .unwrap_or_else(|| panic!("todo entity_id is a string — body: {resp}"))
            .to_string();
        await_completed(&core, &todo_run).await;
        todo_entity_id
    });

    rt.block_on(async {
        let pool = ro_pool(&workspace).await;
        let role: String =
            sqlx::query_scalar("SELECT role FROM todo_person_refs WHERE todo_id = ?1")
                .bind(&todo_entity_id)
                .fetch_one(&pool)
                .await
                .expect("one todo_person_refs row exists");
        assert_eq!(role, "related", "missing role defaults to related");
    });
}
