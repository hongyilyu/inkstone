//! An accepted `delete_person`/`delete_todo` removes the Entity, and its
//! `todo_person_refs` rows are cascaded away automatically by the table's FK
//! `ON DELETE CASCADE` (ADR-0031) — Core writes NO explicit ref-delete SQL.
//! Deleting a Person leaves any Todo that referenced it in place (only the ref
//! row is gone), and deleting a Todo leaves the Person in place. A delete whose
//! target is the wrong Entity Type is `invalid_params` (-32602) and writes
//! nothing.
//!
//! Driven by `tests/fixtures/propose-worker.ts`: a tempfile pointed at by
//! `INKSTONE_PROPOSE_PARAMS_FILE` supplies the raw mutation the fixture
//! proposes. Each `thread/create` spawns a fresh worker that re-reads the file
//! at start, so a test can create a Person, then a Todo referencing it, then a
//! delete — all on the SAME Core (and DB) across successive Runs.

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
    let run = create_and_park(core, base_id, prompt).await;
    let proposal = proposal_id_for(core, base_id + 2, &run).await;
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

async fn rw_pool(workspace: &Workspace) -> sqlx::SqlitePool {
    let url = format!("sqlite://{}", workspace.db_path().display());
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

async fn ref_row_exists(pool: &sqlx::SqlitePool, todo_id: &str, person_id: &str) -> bool {
    let row: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM todo_person_refs WHERE todo_id = ?1 AND person_id = ?2 LIMIT 1",
    )
    .bind(todo_id)
    .bind(person_id)
    .fetch_optional(pool)
    .await
    .expect("query ref row exists");
    row.is_some()
}

async fn seed_journal_entry_ref_to_person(
    pool: &sqlx::SqlitePool,
    person_id: &str,
) -> (String, String) {
    let journal_entry_id = "01900000-0000-7000-8000-00000000je01";
    let ref_id = "01900000-0000-7000-8000-00000000ef01";
    let data = serde_json::json!({
        "occurred_at": "2026-06-18T09:00:00",
        "body": [
            { "type": "text", "text": "This morning I had a talk with " },
            { "type": "entity_ref", "ref_id": ref_id },
            { "type": "text", "text": " about Lead Ads." }
        ]
    })
    .to_string();
    sqlx::query(
        "INSERT INTO entities \
         (id, type, schema_version, data, created_by, created_at, updated_at) \
         VALUES (?1, 'journal_entry', 1, ?2, 'user', 1, 1)",
    )
    .bind(journal_entry_id)
    .bind(&data)
    .execute(pool)
    .await
    .expect("insert journal entry");
    sqlx::query(
        "INSERT INTO entity_revisions (entity_id, seq, data, proposal_id, created_at) \
         VALUES (?1, 1, ?2, NULL, 1)",
    )
    .bind(journal_entry_id)
    .bind(&data)
    .execute(pool)
    .await
    .expect("insert journal entry revision");
    sqlx::query(
        "INSERT INTO entity_refs \
         (id, source_entity_id, target_entity_id, label_snapshot, created_at) \
         VALUES (?1, ?2, ?3, 'Alice', 1)",
    )
    .bind(ref_id)
    .bind(journal_entry_id)
    .bind(person_id)
    .execute(pool)
    .await
    .expect("insert entity ref");
    (journal_entry_id.to_string(), ref_id.to_string())
}

/// Seed a Person and a Todo (with a waiting_on ref to that Person) against a
/// fresh Core. Returns `(core, workspace, params_dir_guard, person_id,
/// todo_id)`. The tempdir guard must outlive the Core (the worker re-reads the
/// params file there).
fn seed_person_and_linked_todo(
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

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let (person_id, todo_id) = rt.block_on(async {
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
            1,
        )
        .await;

        let todo_id = create_entity(
            &core,
            &params_path,
            serde_json::json!({
                "mutation_kind": "create_todo",
                "payload": {
                    "todo": { "title": "Follow up", "note": "ping about daycare" },
                    "person_refs": [{ "person_id": person_id, "role": "waiting_on" }]
                },
                "rationale": "track the follow-up"
            }),
            "I need to follow up with Alice.",
            "todo-k1",
            10,
        )
        .await;

        (person_id, todo_id)
    });

    (core, workspace, params_dir, rt, person_id, todo_id)
}

/// Case 1: an accepted `delete_person` removes the Person AND cascades the
/// `(todo_id, person_id)` ref row, while leaving the Todo Entity (and its
/// title/note text) untouched.
#[test]
fn delete_person_cascades_refs_and_keeps_todo() {
    let (core, workspace, _params_dir, rt, person_id, todo_id) =
        seed_person_and_linked_todo("inkstone-delete-person-");
    let params_path = _params_dir.path().join("propose-params.json");
    let (journal_entry_id, ref_id) = rt.block_on(async {
        let pool = rw_pool(&workspace).await;
        seed_journal_entry_ref_to_person(&pool, &person_id).await
    });

    rt.block_on(async {
        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "delete_person",
                "payload": { "entity_id": person_id },
                "rationale": "the user no longer tracks this person"
            }),
        );
        let run = create_and_park(&core, 20, "Forget Alice.").await;
        let proposal = proposal_id_for(&core, 22, &run).await;
        let resp = rpc(
            &core,
            23,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal,
                "decision": "accept",
                "decision_idempotency_key": "del-person-k1",
            }),
        )
        .await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "delete_person accepted — body: {resp}"
        );
        assert_eq!(
            resp["result"]["entity_id"].as_str(),
            Some(person_id.as_str()),
            "delete_person returns the deleted person id — body: {resp}"
        );
        await_completed(&core, &run).await;
    });

    rt.block_on(async {
        let pool = ro_pool(&workspace).await;
        assert!(
            !entity_exists(&pool, &person_id).await,
            "accepted delete_person removes the Person entity"
        );
        assert!(
            !ref_row_exists(&pool, &todo_id, &person_id).await,
            "the (todo, person) ref row cascades away with the Person"
        );
        assert!(
            entity_exists(&pool, &todo_id).await,
            "the referencing Todo entity is left in place"
        );
        let data: String = sqlx::query_scalar("SELECT data FROM entities WHERE id = ?1")
            .bind(&todo_id)
            .fetch_one(&pool)
            .await
            .expect("todo entity row exists");
        let data_json: serde_json::Value = serde_json::from_str(&data).expect("todo data JSON");
        assert_eq!(
            data_json["title"].as_str(),
            Some("Follow up"),
            "Todo title is unchanged — got {data}"
        );
        assert_eq!(
            data_json["note"].as_str(),
            Some("ping about daycare"),
            "Todo note is unchanged — got {data}"
        );
        let data: String = sqlx::query_scalar("SELECT data FROM entities WHERE id = ?1")
            .bind(&journal_entry_id)
            .fetch_one(&pool)
            .await
            .expect("journal entry row exists");
        let data_json: serde_json::Value =
            serde_json::from_str(&data).expect("journal entry data JSON");
        assert_eq!(
            data_json["body"],
            serde_json::json!([
                { "type": "text", "text": "This morning I had a talk with " },
                { "type": "text", "text": "Alice" },
                { "type": "text", "text": " about Lead Ads." }
            ]),
            "delete_person textualizes Journal Entry refs before the target ref row cascades — got {data}"
        );
        let ref_exists: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM entity_refs WHERE id = ?1 LIMIT 1")
                .bind(&ref_id)
                .fetch_optional(&pool)
                .await
                .expect("query entity_ref");
        assert!(
            ref_exists.is_none(),
            "entity_refs row still cascades away after textualization"
        );
    });
}

/// Case 2: an accepted `delete_todo` removes the Todo AND cascades its
/// `(todo_id, person_id)` ref row, while leaving the Person Entity in place.
#[test]
fn delete_todo_cascades_refs_and_keeps_person() {
    let (core, workspace, _params_dir, rt, person_id, todo_id) =
        seed_person_and_linked_todo("inkstone-delete-todo-");
    let params_path = _params_dir.path().join("propose-params.json");

    rt.block_on(async {
        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "delete_todo",
                "payload": { "entity_id": todo_id },
                "rationale": "the user finished and discarded this todo"
            }),
        );
        let run = create_and_park(&core, 20, "Drop the follow-up todo.").await;
        let proposal = proposal_id_for(&core, 22, &run).await;
        let resp = rpc(
            &core,
            23,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal,
                "decision": "accept",
                "decision_idempotency_key": "del-todo-k1",
            }),
        )
        .await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "delete_todo accepted — body: {resp}"
        );
        assert_eq!(
            resp["result"]["entity_id"].as_str(),
            Some(todo_id.as_str()),
            "delete_todo returns the deleted todo id — body: {resp}"
        );
        await_completed(&core, &run).await;
    });

    rt.block_on(async {
        let pool = ro_pool(&workspace).await;
        assert!(
            !entity_exists(&pool, &todo_id).await,
            "accepted delete_todo removes the Todo entity"
        );
        assert!(
            !ref_row_exists(&pool, &todo_id, &person_id).await,
            "the (todo, person) ref row cascades away with the Todo"
        );
        assert!(
            entity_exists(&pool, &person_id).await,
            "the linked Person entity is left in place"
        );
    });
}

/// Case 3: a `delete_person` whose target is a Todo (wrong Entity Type) →
/// -32602; nothing is deleted, the Proposal stays pending, the Run stays parked.
#[test]
fn delete_person_with_todo_target_is_invalid_and_writes_nothing() {
    let (core, workspace, _params_dir, rt, person_id, todo_id) =
        seed_person_and_linked_todo("inkstone-delete-bad-target-");
    let params_path = _params_dir.path().join("propose-params.json");

    let run = rt.block_on(async {
        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "delete_person",
                "payload": { "entity_id": todo_id },
                "rationale": "wrong target type"
            }),
        );
        let run = create_and_park(&core, 20, "Forget that person.").await;
        let proposal = proposal_id_for(&core, 22, &run).await;
        let resp = rpc(
            &core,
            23,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal,
                "decision": "accept",
                "decision_idempotency_key": "del-person-bad",
            }),
        )
        .await;
        assert_eq!(
            resp["error"]["code"].as_i64(),
            Some(-32602),
            "delete_person against a Todo target → invalid_params — body: {resp}"
        );
        let parked = rpc(
            &core,
            24,
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
            entity_exists(&pool, &todo_id).await,
            "the mistargeted Todo entity is left in place"
        );
        assert!(
            entity_exists(&pool, &person_id).await,
            "the Person entity is left in place"
        );
        assert!(
            ref_row_exists(&pool, &todo_id, &person_id).await,
            "the ref row is left in place"
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

/// Case 4: a `delete_person` decided `edit` (retargeting `entity_id` to a
/// different Person) → -32602; a delete does not support `edit`, so nothing is
/// deleted, the Proposal stays pending and the Run stays parked. Guards against
/// an `edit` retargeting + deleting the WRONG entity.
#[test]
fn delete_person_edit_is_invalid_and_deletes_nothing() {
    let (core, workspace, _params_dir, rt, person_id, todo_id) =
        seed_person_and_linked_todo("inkstone-delete-person-edit-");
    let params_path = _params_dir.path().join("propose-params.json");

    // A second Person to use as the (illegitimate) retarget id for the edit.
    let other_person_id = rt.block_on(async {
        create_entity(
            &core,
            &params_path,
            serde_json::json!({
                "mutation_kind": "create_person",
                "payload": { "name": "Bob" },
                "rationale": "another person to retarget the delete at"
            }),
            "Remember Bob.",
            "person-edit-other",
            30,
        )
        .await
    });

    let run = rt.block_on(async {
        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "delete_person",
                "payload": { "entity_id": person_id },
                "rationale": "the user no longer tracks this person"
            }),
        );
        let run = create_and_park(&core, 40, "Forget Alice.").await;
        let proposal = proposal_id_for(&core, 42, &run).await;
        let resp = rpc(
            &core,
            43,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal,
                "decision": "edit",
                "edited_payload": { "entity_id": other_person_id },
                "decision_idempotency_key": "del-person-edit",
            }),
        )
        .await;
        assert_eq!(
            resp["error"]["code"].as_i64(),
            Some(-32602),
            "edit on a delete_person → invalid_params — body: {resp}"
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
            "an edit-rejected delete leaves the Run parked — body: {parked}"
        );
        run
    });

    rt.block_on(async {
        let pool = ro_pool(&workspace).await;
        assert!(
            entity_exists(&pool, &person_id).await,
            "the original delete target Person is left in place"
        );
        assert!(
            entity_exists(&pool, &other_person_id).await,
            "the retarget Person is NOT deleted by the rejected edit"
        );
        assert!(
            entity_exists(&pool, &todo_id).await,
            "the linked Todo entity is left in place"
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
            "an edit-rejected delete leaves the proposal pending"
        );
        assert_eq!(
            tool_status, "pending",
            "an edit-rejected delete leaves the tool call unresolved"
        );
    });
}
