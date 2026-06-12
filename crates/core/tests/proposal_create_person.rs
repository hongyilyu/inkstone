//! An accepted `create_person` Proposal validates a `PersonData` payload and
//! persists a `person` Entity sourced `created_from` the user Message (ADR-0031,
//! ADR-0025). Proves Core's create/apply path is no longer journal-entry-specific.
//!
//! Driven by `tests/fixtures/propose-worker.ts`: a tempfile pointed at by
//! `INKSTONE_PROPOSE_PARAMS_FILE` supplies the raw `create_person` mutation the
//! fixture proposes; on accept the run resumes to `completed`.

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

/// Create a Run and poll run/subscribe until it parks; returns the run_id.
async fn create_and_park(core: &CoreHandle) -> String {
    let resp = rpc(
        core,
        1,
        "thread/create",
        serde_json::json!({ "prompt": "Remember Alice, the daycare coordinator." }),
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
            2,
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
            9,
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

#[test]
fn accept_create_person_applies_and_resumes() {
    let workspace = Workspace::new();

    // Point the fixture at a `create_person` mutation via a tempfile. The
    // TempDir is held for the whole test so the file stays alive until Core
    // (and the fixture it spawns) has read it.
    let params_dir = tempfile::Builder::new()
        .prefix("inkstone-create-person-")
        .tempdir()
        .expect("create params tempdir");
    let params_path = params_dir.path().join("propose-params.json");
    std::fs::write(
        &params_path,
        serde_json::json!({
            "mutation_kind": "create_person",
            "payload": {
                "name": "Alice",
                "note": "daycare coordinator",
                "aliases": ["Al"]
            },
            "rationale": "remember Alice"
        })
        .to_string(),
    )
    .expect("write propose params file");

    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let (run_id, entity_id) = rt.block_on(async {
        let run_id = create_and_park(&core).await;

        // Learn the proposal_id.
        let resp = rpc(
            &core,
            3,
            "proposal/get",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        let proposal_id = resp["result"]["proposal_id"]
            .as_str()
            .unwrap_or_else(|| panic!("proposal_id is a string — body: {resp}"))
            .to_string();

        // Decide: accept.
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
        let result = &resp["result"];
        assert_eq!(
            result["status"].as_str(),
            Some("accepted"),
            "decide result status — body: {resp}"
        );
        let entity_id = result["entity_id"]
            .as_str()
            .unwrap_or_else(|| panic!("entity_id is a string — body: {resp}"))
            .to_string();

        // The Run resumes in a fresh Worker and reaches completed.
        await_completed(&core, &run_id).await;

        (run_id, entity_id)
    });

    // White-box DB assertions.
    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        // One Person entity, created via the proposal.
        let row = sqlx::query(
            "SELECT type, data, created_by, created_via_proposal_id FROM entities WHERE id = ?1",
        )
        .bind(&entity_id)
        .fetch_one(&pool)
        .await
        .expect("entity row exists");
        let etype: String = row.get("type");
        let data: String = row.get("data");
        let created_by: String = row.get("created_by");
        let via: Option<String> = row.get("created_via_proposal_id");
        assert_eq!(etype, "person", "entity type is person");
        assert_eq!(created_by, "proposal", "entity created_by=proposal");
        assert!(via.is_some(), "entity carries created_via_proposal_id");
        let data_json: serde_json::Value =
            serde_json::from_str(&data).expect("entity data is JSON");
        assert_eq!(
            data_json["name"].as_str(),
            Some("Alice"),
            "entity data round-trips name — got {data}"
        );
        assert_eq!(
            data_json["note"].as_str(),
            Some("daycare coordinator"),
            "entity data round-trips note — got {data}"
        );
        assert_eq!(
            data_json["aliases"][0].as_str(),
            Some("Al"),
            "entity data round-trips aliases — got {data}"
        );

        // entity_sources records the source user Message (source_entity_id NULL).
        let row = sqlx::query(
            "SELECT es.source_entity_id FROM entity_sources es \
             JOIN runs r ON r.user_message_id = es.source_message_id \
             WHERE es.entity_id = ?1 AND r.id = ?2 AND es.relation = 'created_from'",
        )
        .bind(&entity_id)
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("entity_source row joined to the run's user_message_id");
        let source_entity_id: Option<String> = row.get("source_entity_id");
        assert!(
            source_entity_id.is_none(),
            "Person sourced from a Message has NULL source_entity_id"
        );

        // entity_revisions seq 1.
        let rev_seq: i64 = sqlx::query_scalar(
            "SELECT seq FROM entity_revisions WHERE entity_id = ?1 ORDER BY seq DESC LIMIT 1",
        )
        .bind(&entity_id)
        .fetch_one(&pool)
        .await
        .expect("entity_revision row exists");
        assert_eq!(rev_seq, 1, "first entity revision is seq 1");

        // proposals.status='accepted'.
        let prop_status: String = sqlx::query_scalar(
            "SELECT p.status FROM proposals p \
             JOIN tool_calls tc ON tc.id = p.tool_call_id WHERE tc.run_id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("proposal row exists");
        assert_eq!(prop_status, "accepted", "proposal accepted");

        // tool_calls resolved (completed).
        let tc_status: String =
            sqlx::query_scalar("SELECT status FROM tool_calls WHERE run_id = ?1")
                .bind(&run_id)
                .fetch_one(&pool)
                .await
                .expect("tool_call row exists");
        assert_eq!(tc_status, "completed", "tool_call resolved");

        // runs.status='completed'.
        let run_status: String = sqlx::query_scalar("SELECT status FROM runs WHERE id = ?1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .expect("run row exists");
        assert_eq!(run_status, "completed", "run completed");
    });
}
