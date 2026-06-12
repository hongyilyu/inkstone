//! An accepted `create_{person,project,todo}` carrying an optional
//! `source_journal_entry_id` records its EntitySource via `source_entity_id`
//! pointing at that Journal Entry (relation `created_from`) INSTEAD of the user
//! Message (ADR-0031, ADR-0030). When the field is absent, behavior is unchanged:
//! the Entity is sourced from the run's user Message (`source_message_id` set,
//! `source_entity_id` NULL).
//!
//! Driven by `tests/fixtures/propose-worker.ts`: a tempfile pointed at by
//! `INKSTONE_PROPOSE_PARAMS_FILE` supplies the raw mutation the fixture proposes.
//! Each `thread/create` spawns a fresh worker that re-reads the file at start, so
//! a test can create a Journal Entry on the first run, rewrite the file to a
//! `create_todo` referencing that JE id, and create a Todo on a SECOND run against
//! the SAME Core (and DB).

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

/// Run 1: propose a Journal Entry and accept it; return its entity id.
async fn create_journal_entry(core: &CoreHandle, params_path: &std::path::Path) -> String {
    write_params(
        params_path,
        serde_json::json!({
            "mutation_kind": "create_journal_entry",
            "payload": {
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "text", "text": "talked to Alice" }]
            },
            "rationale": "log the conversation"
        }),
    );

    let je_run = create_and_park(core, 1, "I talked to Alice today.").await;
    let je_proposal = proposal_id_for(core, 3, &je_run).await;
    let resp = rpc(
        core,
        4,
        "proposal/decide",
        serde_json::json!({
            "proposal_id": je_proposal,
            "decision": "accept",
            "decision_idempotency_key": "je-k1",
        }),
    )
    .await;
    assert_eq!(
        resp["result"]["status"].as_str(),
        Some("accepted"),
        "journal entry decide accepted — body: {resp}"
    );
    let je_id = resp["result"]["entity_id"]
        .as_str()
        .unwrap_or_else(|| panic!("journal entry entity_id is a string — body: {resp}"))
        .to_string();
    await_completed(core, &je_run).await;
    je_id
}

async fn ro_pool(workspace: &Workspace) -> sqlx::SqlitePool {
    let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .expect("connect to migrated DB")
}

/// Case 1 (JE-sourced todo): a `create_todo` carrying `source_journal_entry_id`
/// pointing at a real Journal Entry writes the Todo's `entity_sources` row with
/// `source_entity_id` = that JE id, `source_message_id` NULL, relation
/// `created_from`.
#[test]
fn accept_create_todo_sourced_from_journal_entry() {
    let workspace = Workspace::new();
    let params_dir = tempfile::Builder::new()
        .prefix("inkstone-je-source-todo-")
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

    let (je_id, todo_entity_id) = rt.block_on(async {
        let je_id = create_journal_entry(&core, &params_path).await;

        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "create_todo",
                "payload": {
                    "todo": { "title": "follow up" },
                    "source_journal_entry_id": je_id
                },
                "rationale": "track the follow-up from the journal entry"
            }),
        );

        let todo_run = create_and_park(&core, 10, "I should follow up.").await;
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
        (je_id, todo_entity_id)
    });

    rt.block_on(async {
        let pool = ro_pool(&workspace).await;

        // Exactly one entity_sources row for the Todo, sourced from the JE.
        let rows = sqlx::query(
            "SELECT source_entity_id, source_message_id, relation \
             FROM entity_sources WHERE entity_id = ?1",
        )
        .bind(&todo_entity_id)
        .fetch_all(&pool)
        .await
        .expect("fetch todo entity_sources");
        assert_eq!(rows.len(), 1, "exactly one entity_sources row for the Todo");
        let source_entity_id: Option<String> = rows[0].get("source_entity_id");
        let source_message_id: Option<String> = rows[0].get("source_message_id");
        let relation: String = rows[0].get("relation");
        assert_eq!(
            source_entity_id.as_deref(),
            Some(je_id.as_str()),
            "Todo is sourced from the Journal Entry (source_entity_id)"
        );
        assert!(
            source_message_id.is_none(),
            "a JE-sourced Todo leaves source_message_id NULL"
        );
        assert_eq!(relation, "created_from", "relation is created_from");

        // source_journal_entry_id is provenance only — NEVER stored in Todo data.
        let data: String = sqlx::query_scalar("SELECT data FROM entities WHERE id = ?1")
            .bind(&todo_entity_id)
            .fetch_one(&pool)
            .await
            .expect("todo entity row exists");
        assert!(
            !data.contains("source_journal_entry_id"),
            "source_journal_entry_id is not stored in Todo data — got {data}"
        );
    });
}

/// Case 2 (bad source id): a `create_person` whose `source_journal_entry_id`
/// references a non-Journal-Entry id (here, the Person's own kind via a random
/// UUID) → `invalid_params` (-32602); NO person entity is created.
#[test]
fn create_person_with_non_journal_entry_source_is_rejected() {
    let workspace = Workspace::new();
    let params_dir = tempfile::Builder::new()
        .prefix("inkstone-je-source-bad-")
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
        // A syntactically valid UUID that is not any Journal Entry id.
        let bogus_je = uuid::Uuid::now_v7().to_string();
        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "create_person",
                "payload": {
                    "name": "x",
                    "source_journal_entry_id": bogus_je
                },
                "rationale": "dangling journal-entry source"
            }),
        );
        let person_run = create_and_park(&core, 1, "Remember x.").await;
        let person_proposal = proposal_id_for(&core, 3, &person_run).await;
        let resp = rpc(
            &core,
            4,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": person_proposal,
                "decision": "accept",
                "decision_idempotency_key": "person-bad",
            }),
        )
        .await;
        assert_eq!(
            resp["error"]["code"].as_i64(),
            Some(-32602),
            "non-journal-entry source_journal_entry_id → invalid_params — body: {resp}"
        );
    });

    rt.block_on(async {
        let pool = ro_pool(&workspace).await;
        let person_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM entities WHERE type = 'person'")
                .fetch_one(&pool)
                .await
                .expect("count person entities");
        assert_eq!(person_count, 0, "rejected create_person created no person");
    });
}

/// Case 3 (regression, no source): a `create_person` WITHOUT
/// `source_journal_entry_id` is still sourced from the run's user Message
/// (`source_message_id` set, `source_entity_id` NULL) — unchanged Message-sourcing.
#[test]
fn create_person_without_source_is_message_sourced() {
    let workspace = Workspace::new();
    let params_dir = tempfile::Builder::new()
        .prefix("inkstone-je-source-regression-")
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

    let (run_id, person_id) = rt.block_on(async {
        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "create_person",
                "payload": { "name": "y" },
                "rationale": "remember y"
            }),
        );
        let person_run = create_and_park(&core, 1, "Remember y.").await;
        let person_proposal = proposal_id_for(&core, 3, &person_run).await;
        let resp = rpc(
            &core,
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
        await_completed(&core, &person_run).await;
        (person_run, person_id)
    });

    rt.block_on(async {
        let pool = ro_pool(&workspace).await;
        let row = sqlx::query(
            "SELECT es.source_entity_id, es.source_message_id \
             FROM entity_sources es \
             JOIN runs r ON r.user_message_id = es.source_message_id \
             WHERE es.entity_id = ?1 AND r.id = ?2 AND es.relation = 'created_from'",
        )
        .bind(&person_id)
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("entity_source row joined to the run's user_message_id");
        let source_entity_id: Option<String> = row.get("source_entity_id");
        let source_message_id: Option<String> = row.get("source_message_id");
        assert!(
            source_message_id.is_some(),
            "a Person with no source field is sourced from the user Message"
        );
        assert!(
            source_entity_id.is_none(),
            "a Message-sourced Person has NULL source_entity_id"
        );
    });
}
