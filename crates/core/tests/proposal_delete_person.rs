//! An accepted `delete_person` removes the Person Entity, textualizing any
//! Journal Entry refs to it first (ADR-0030); its `entity_refs` rows cascade
//! away via FK `ON DELETE CASCADE` — Core writes NO explicit ref-delete SQL. A
//! delete whose target is the wrong Entity Type is `invalid_params` (-32602)
//! and writes nothing, as is a delete decided `edit`.
//!
//! Driven by `tests/fixtures/propose-worker.ts`: a tempfile pointed at by
//! `INKSTONE_PROPOSE_PARAMS_FILE` supplies the raw mutation the fixture
//! proposes. Each `thread/create` spawns a fresh worker that re-reads the file
//! at start, so a test can create a Person, then a delete — all on the SAME
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

/// Seed a Person against a fresh Core. Returns `(core, workspace,
/// params_dir_guard, rt, person_id)`. The tempdir guard must outlive the Core
/// (the worker re-reads the params file there).
fn seed_person(
    prefix: &str,
) -> (
    CoreHandle,
    Workspace,
    tempfile::TempDir,
    tokio::runtime::Runtime,
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

    let person_id = rt.block_on(async {
        create_entity(
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
        .await
    });

    (core, workspace, params_dir, rt, person_id)
}

/// Case 1: an accepted `delete_person` removes the Person, textualizes the
/// Journal Entry refs that pointed at it, and cascades the `entity_refs` rows.
#[test]
fn delete_person_textualizes_refs_and_removes_entity() {
    let (core, workspace, _params_dir, rt, person_id) = seed_person("inkstone-delete-person-");
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
        let run = create_and_park(&core, "Forget Alice.").await.0;
        let proposal = proposal_id_for(&core, &run).await;
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

/// Case 2: a `delete_person` whose target is a Project (wrong Entity Type) →
/// -32602; nothing is deleted, the Proposal stays pending, the Run stays parked.
#[test]
fn delete_person_with_project_target_is_invalid_and_writes_nothing() {
    let (core, workspace, _params_dir, rt, person_id) =
        seed_person("inkstone-delete-bad-target-");
    let params_path = _params_dir.path().join("propose-params.json");

    // A Project to mistarget the delete_person at.
    let project_id = rt.block_on(async {
        create_entity(
            &core,
            &params_path,
            serde_json::json!({
                "mutation_kind": "create_project",
                "payload": { "name": "Lead Ads" },
                "rationale": "a project to mistarget"
            }),
            "Remember the Lead Ads project.",
            "project-k1",
            10,
        )
        .await
    });

    let run = rt.block_on(async {
        write_params(
            &params_path,
            serde_json::json!({
                "mutation_kind": "delete_person",
                "payload": { "entity_id": project_id },
                "rationale": "wrong target type"
            }),
        );
        let run = create_and_park(&core, "Forget that person.").await.0;
        let proposal = proposal_id_for(&core, &run).await;
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
            "delete_person against a Project target → invalid_params — body: {resp}"
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
            entity_exists(&pool, &project_id).await,
            "the mistargeted Project entity is left in place"
        );
        assert!(
            entity_exists(&pool, &person_id).await,
            "the Person entity is left in place"
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

/// Case 3: a `delete_person` decided `edit` (retargeting `entity_id` to a
/// different Person) → -32602; a delete does not support `edit`, so nothing is
/// deleted, the Proposal stays pending and the Run stays parked. Guards against
/// an `edit` retargeting + deleting the WRONG entity.
#[test]
fn delete_person_edit_is_invalid_and_deletes_nothing() {
    let (core, workspace, _params_dir, rt, person_id) =
        seed_person("inkstone-delete-person-edit-");
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
        let run = create_and_park(&core, "Forget Alice.").await.0;
        let proposal = proposal_id_for(&core, &run).await;
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
