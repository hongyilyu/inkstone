//! An accepted `update_person` / `update_project` Proposal replaces the target
//! Entity's data, writes a new `entity_revisions` snapshot, and records an
//! `updated_from` Entity Source (ADR-0031, ADR-0025). Proves Core's update/apply
//! path is no longer journal-entry-specific.
//!
//! One Core, multi-run: the `propose-worker.ts` fixture re-reads
//! `INKSTONE_PROPOSE_PARAMS_FILE` on each fresh spawn, so each run rewrites the
//! file with the next mutation (create, then update) before posting a message.

use std::path::Path;
use std::time::{Duration, Instant};

use futures_util::SinkExt;
use sqlx::Row;
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::SqlitePool;
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

fn write_params(path: &Path, params: serde_json::Value) {
    std::fs::write(path, params.to_string()).expect("write propose params file");
}

async fn await_status(core: &CoreHandle, run_id: &str, want: &str) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if Instant::now() > deadline {
            panic!("timed out waiting for run to reach {want}");
        }
        let resp = rpc(
            core,
            9,
            "run/subscribe",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        if resp["result"]["status"].as_str() == Some(want) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

/// Post a message on a new thread (the params file already holds the mutation),
/// wait until the Run parks, and return `(run_id, proposal_id, mutation_kind)`.
async fn create_thread_and_park(core: &CoreHandle, prompt: &str) -> (String, String, String) {
    let resp = rpc(
        core,
        1,
        "thread/create",
        serde_json::json!({ "prompt": prompt }),
    )
    .await;
    let run_id = resp["result"]["run_id"]
        .as_str()
        .unwrap_or_else(|| panic!("result.run_id is a string — body: {resp}"))
        .to_string();
    await_status(core, &run_id, "parked").await;
    let (proposal_id, mutation_kind) = pending_proposal(core, &run_id).await;
    (run_id, proposal_id, mutation_kind)
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

async fn decide_accept(core: &CoreHandle, proposal_id: &str, key: &str) -> serde_json::Value {
    rpc(
        core,
        4,
        "proposal/decide",
        serde_json::json!({
            "proposal_id": proposal_id,
            "decision": "accept",
            "decision_idempotency_key": key,
        }),
    )
    .await
}

async fn open_readonly_pool(workspace: &Workspace) -> SqlitePool {
    let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .expect("connect to migrated DB")
}

async fn entity_data(pool: &SqlitePool, entity_id: &str) -> serde_json::Value {
    let data: String = sqlx::query_scalar("SELECT data FROM entities WHERE id = ?1")
        .bind(entity_id)
        .fetch_one(pool)
        .await
        .expect("entity row exists");
    serde_json::from_str(&data).expect("entity data is JSON")
}

async fn max_revision_seq(pool: &SqlitePool, entity_id: &str) -> i64 {
    sqlx::query_scalar("SELECT MAX(seq) FROM entity_revisions WHERE entity_id = ?1")
        .bind(entity_id)
        .fetch_one(pool)
        .await
        .expect("max revision seq")
}

async fn updated_from_count_for_run(pool: &SqlitePool, entity_id: &str, run_id: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM entity_sources es \
         JOIN runs r ON r.user_message_id = es.source_message_id \
         WHERE es.entity_id = ?1 AND r.id = ?2 AND es.relation = 'updated_from'",
    )
    .bind(entity_id)
    .bind(run_id)
    .fetch_one(pool)
    .await
    .expect("count updated_from sources")
}

async fn proposal_and_tool_status_for_run(pool: &SqlitePool, run_id: &str) -> (String, String) {
    let row = sqlx::query(
        "SELECT p.status, tc.status AS tool_status \
         FROM proposals p JOIN tool_calls tc ON tc.id = p.tool_call_id \
         WHERE tc.run_id = ?1",
    )
    .bind(run_id)
    .fetch_one(pool)
    .await
    .expect("proposal row exists");
    (row.get("status"), row.get("tool_status"))
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

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

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
        await_status(&core, &create_run, "completed").await;

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
        await_status(&core, &update_run, "completed").await;
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

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

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
        await_status(&core, &create_run, "completed").await;

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
        await_status(&core, &update_run, "completed").await;
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

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let (project_id, update_run_id) = rt.block_on(async {
        let (create_run, create_proposal, _) =
            create_thread_and_park(&core, "Track the Ship API v2 project.").await;
        let resp = decide_accept(&core, &create_proposal, "project-create").await;
        let project_id = resp["result"]["entity_id"]
            .as_str()
            .unwrap_or_else(|| panic!("entity_id is a string — body: {resp}"))
            .to_string();
        await_status(&core, &create_run, "completed").await;

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
