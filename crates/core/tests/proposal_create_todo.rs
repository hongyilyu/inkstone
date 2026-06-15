//! An accepted `create_todo` Proposal validates the `todo` sub-object of a
//! `{todo, person_refs?}` envelope as `TodoData`, defaults a missing `status` to
//! `active`, and persists a `todo` Entity sourced `created_from` the user Message
//! (ADR-0031, ADR-0025). When `todo.project_id` is present it must reference an
//! Accepted Project, else `proposal/decide` returns `invalid_params` and nothing
//! lands. `person_refs` is NOT persisted in this slice (slice 5 adds its table).
//!
//! Driven by `tests/fixtures/propose-worker.ts`: a tempfile pointed at by
//! `INKSTONE_PROPOSE_PARAMS_FILE` supplies the raw mutation the fixture proposes.
//! Each `thread/create` spawns a fresh worker that re-reads the file at start, so
//! a test can create a Project on the first run, rewrite the file to a
//! `create_todo` carrying that Project id, and create a Todo on a SECOND run
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

/// Case 1: a `create_todo` whose `todo.project_id` points at an Accepted Project
/// persists a `todo` Entity carrying that `project_id`, with `status` defaulted to
/// `active`, `type='todo'`, and a `created_from` source.
#[test]
fn accept_create_todo_links_project_and_defaults_status() {
    let workspace = Workspace::new();

    let params_dir = tempfile::Builder::new()
        .prefix("inkstone-create-todo-")
        .tempdir()
        .expect("create params tempdir");
    let params_path = params_dir.path().join("propose-params.json");

    // Run 1 proposes a Project; capture its entity id on accept.
    write_params(
        &params_path,
        serde_json::json!({
            "mutation_kind": "create_project",
            "payload": { "name": "Ship API v2 migration" },
            "rationale": "start the migration outcome"
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

    let (todo_run_id, project_id, todo_entity_id) = rt.block_on(async {
        // --- Run 1: create_project ---
        let project_run = create_and_park(&core, 1, "Start the API v2 migration.").await;
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
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "project decide accepted — body: {resp}"
        );
        let project_id = resp["result"]["entity_id"]
            .as_str()
            .unwrap_or_else(|| panic!("project entity_id is a string — body: {resp}"))
            .to_string();
        await_completed(&core, &project_run).await;

        // Now that we know the Project id, rewrite the params to a create_todo
        // ENVELOPE linking it; the next thread/create re-reads the file.
        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "create_todo",
                "payload": {
                    "todo": { "title": "Ship it", "project_id": project_id }
                },
                "rationale": "track the migration follow-up"
            }),
        );

        // --- Run 2: create_todo on the SAME Core/DB ---
        let todo_run = create_and_park(&core, 10, "I need to ship the migration.").await;
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

        (todo_run, project_id, todo_entity_id)
    });

    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        let row = sqlx::query(
            "SELECT type, data, created_by, created_via_proposal_id FROM entities WHERE id = ?1",
        )
        .bind(&todo_entity_id)
        .fetch_one(&pool)
        .await
        .expect("todo entity row exists");
        let etype: String = row.get("type");
        let data: String = row.get("data");
        let created_by: String = row.get("created_by");
        let via: Option<String> = row.get("created_via_proposal_id");
        assert_eq!(etype, "todo", "entity type is todo");
        assert_eq!(created_by, "proposal", "entity created_by=proposal");
        assert!(via.is_some(), "entity carries created_via_proposal_id");

        let data_json: serde_json::Value =
            serde_json::from_str(&data).expect("entity data is JSON");
        assert_eq!(
            data_json["title"].as_str(),
            Some("Ship it"),
            "entity data round-trips title — got {data}"
        );
        // Headline: the stored Todo carries project_id and defaults status=active.
        assert_eq!(
            data_json["project_id"].as_str(),
            Some(project_id.as_str()),
            "stored todo links the Project — got {data}"
        );
        assert_eq!(
            data_json["status"].as_str(),
            Some("active"),
            "stored todo defaults status to active — got {data}"
        );
        // The envelope is unwrapped: the stored data is the TodoData, not {todo}.
        assert!(
            data_json.get("todo").is_none(),
            "stored data is the unwrapped TodoData, not the envelope — got {data}"
        );

        // created_from a user Message (source_entity_id NULL).
        let row = sqlx::query(
            "SELECT es.source_entity_id FROM entity_sources es \
             JOIN runs r ON r.user_message_id = es.source_message_id \
             WHERE es.entity_id = ?1 AND r.id = ?2 AND es.relation = 'created_from'",
        )
        .bind(&todo_entity_id)
        .bind(&todo_run_id)
        .fetch_one(&pool)
        .await
        .expect("entity_source row joined to the run's user_message_id");
        let source_entity_id: Option<String> = row.get("source_entity_id");
        assert!(
            source_entity_id.is_none(),
            "Todo sourced from a Message has NULL source_entity_id"
        );

        let rev_seq: i64 = sqlx::query_scalar(
            "SELECT seq FROM entity_revisions WHERE entity_id = ?1 ORDER BY seq DESC LIMIT 1",
        )
        .bind(&todo_entity_id)
        .fetch_one(&pool)
        .await
        .expect("entity_revision row exists");
        assert_eq!(rev_seq, 1, "first entity revision is seq 1");
    });
}

/// Case 2: a `{todo:{title}}`-only create defaults `status` to `active` in the
/// stored entity data.
#[test]
fn accept_create_todo_defaults_status_active() {
    let workspace = Workspace::new();

    let params_dir = tempfile::Builder::new()
        .prefix("inkstone-create-todo-default-")
        .tempdir()
        .expect("create params tempdir");
    let params_path = params_dir.path().join("propose-params.json");
    write_params(
        &params_path,
        serde_json::json!({
            "mutation_kind": "create_todo",
            "payload": { "todo": { "title": "buy milk" } },
            "rationale": "the user has a thing to do"
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

    let entity_id = rt.block_on(async {
        let run_id = create_and_park(&core, 1, "I need to buy milk.").await;
        let proposal_id = proposal_id_for(&core, 3, &run_id).await;
        let resp = rpc(
            &core,
            4,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "k1",
            }),
        )
        .await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "decide result status — body: {resp}"
        );
        let entity_id = resp["result"]["entity_id"]
            .as_str()
            .unwrap_or_else(|| panic!("entity_id is a string — body: {resp}"))
            .to_string();
        await_completed(&core, &run_id).await;
        entity_id
    });

    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");
        let data: String = sqlx::query_scalar("SELECT data FROM entities WHERE id = ?1")
            .bind(&entity_id)
            .fetch_one(&pool)
            .await
            .expect("entity row exists");
        let data_json: serde_json::Value =
            serde_json::from_str(&data).expect("entity data is JSON");
        assert_eq!(
            data_json["status"].as_str(),
            Some("active"),
            "stored todo defaults status to active — got {data}"
        );
    });
}

/// Case 2b: a `create_todo` whose `todo` carries a `due_at` anchor and a
/// `due_at`-anchored recurrence rule persists that rule into the stored entity
/// `data` JSON (ADR-0037). After accept, the `recurrence` object round-trips with
/// its `unit`/`schedule`/`anchor`.
#[test]
fn accept_create_todo_persists_recurrence_rule() {
    let workspace = Workspace::new();

    let params_dir = tempfile::Builder::new()
        .prefix("inkstone-create-todo-recurrence-")
        .tempdir()
        .expect("create params tempdir");
    let params_path = params_dir.path().join("propose-params.json");
    write_params(
        &params_path,
        serde_json::json!({
            "mutation_kind": "create_todo",
            "payload": {
                "todo": {
                    "title": "Weekly review",
                    "due_at": "2026-06-19T17:00:00",
                    "recurrence": {
                        "interval": 1,
                        "unit": "week",
                        "schedule": "regular",
                        "anchor": "due_at",
                        "catch_up": false
                    }
                }
            },
            "rationale": "a recurring obligation"
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

    let entity_id = rt.block_on(async {
        let run_id = create_and_park(&core, 1, "Review my projects every week.").await;
        let proposal_id = proposal_id_for(&core, 3, &run_id).await;
        let resp = rpc(
            &core,
            4,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "rec1",
            }),
        )
        .await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "decide result status — body: {resp}"
        );
        let entity_id = resp["result"]["entity_id"]
            .as_str()
            .unwrap_or_else(|| panic!("entity_id is a string — body: {resp}"))
            .to_string();
        await_completed(&core, &run_id).await;
        entity_id
    });

    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");
        let data: String = sqlx::query_scalar("SELECT data FROM entities WHERE id = ?1")
            .bind(&entity_id)
            .fetch_one(&pool)
            .await
            .expect("entity row exists");
        let data_json: serde_json::Value =
            serde_json::from_str(&data).expect("entity data is JSON");
        let recurrence = &data_json["recurrence"];
        assert!(
            recurrence.is_object(),
            "stored todo carries the recurrence rule — got {data}"
        );
        assert_eq!(
            recurrence["unit"].as_str(),
            Some("week"),
            "recurrence unit round-trips — got {data}"
        );
        assert_eq!(
            recurrence["schedule"].as_str(),
            Some("regular"),
            "recurrence schedule round-trips — got {data}"
        );
        assert_eq!(
            recurrence["anchor"].as_str(),
            Some("due_at"),
            "recurrence anchor round-trips — got {data}"
        );
    });
}

/// Case 3: a `create_todo` whose `project_id` does NOT reference an Accepted
/// Project is rejected with `invalid_params` (-32602) BEFORE any DB write: no
/// todo entity, the Proposal stays `pending`, the Run stays `parked`.
#[test]
fn create_todo_with_bad_project_id_is_rejected() {
    let workspace = Workspace::new();

    let params_dir = tempfile::Builder::new()
        .prefix("inkstone-create-todo-bad-")
        .tempdir()
        .expect("create params tempdir");
    let params_path = params_dir.path().join("propose-params.json");
    // A well-formed but non-existent id — references no Accepted Project.
    let bogus = uuid::Uuid::now_v7().to_string();
    write_params(
        &params_path,
        serde_json::json!({
            "mutation_kind": "create_todo",
            "payload": { "todo": { "title": "x", "project_id": bogus } },
            "rationale": "dangling project link"
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

    let run_id = rt.block_on(async {
        let run_id = create_and_park(&core, 1, "Track something against a missing project.").await;
        let proposal_id = proposal_id_for(&core, 3, &run_id).await;
        let resp = rpc(
            &core,
            4,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "bad1",
            }),
        )
        .await;
        assert_eq!(
            resp["error"]["code"].as_i64(),
            Some(-32602),
            "dangling project_id → invalid_params — body: {resp}"
        );
        run_id
    });

    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        // No todo entity exists at all.
        let todo_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM entities WHERE type = 'todo'")
                .fetch_one(&pool)
                .await
                .expect("count todo entities");
        assert_eq!(todo_count, 0, "rejected create_todo created no todo entity");

        // proposals.status still 'pending'.
        let prop_status: String = sqlx::query_scalar(
            "SELECT p.status FROM proposals p \
             JOIN tool_calls tc ON tc.id = p.tool_call_id WHERE tc.run_id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("proposal row exists");
        assert_eq!(prop_status, "pending", "proposal still pending after reject");

        // runs.status still 'parked'.
        let run_status: String = sqlx::query_scalar("SELECT status FROM runs WHERE id = ?1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .expect("run row exists");
        assert_eq!(run_status, "parked", "run still parked after reject");
    });
}
