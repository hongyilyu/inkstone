//! Slice 3 RED test (Proposal accept): `proposal/decide{decision:"accept"}` on
//! a parked Run applies the Proposal atomically (a Todo entity lands in tier 2)
//! and resumes the Run in a FRESH Worker seeded with the reconstructed
//! transcript (ending in the Decision `tool_result`). The Run reaches
//! `completed`. A second decide with the same `decision_idempotency_key`
//! returns the prior result and does NOT double-apply.
//!
//! Driven by the (now two-spawn) `tests/fixtures/propose-worker.ts` over
//! `INKSTONE_WORKER_CMD`: spawn 1 proposes & blocks (park); spawn 2 detects
//! `mode === "resume"` and finishes (a `text_delta` + `done`).

use std::time::{Duration, Instant};

use futures_util::SinkExt;
use sqlx::Row;
use sqlx::sqlite::SqlitePoolOptions;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{CoreHandle, Workspace, next_text};

/// Open a fresh socket, send a single request, return the response body.
async fn rpc(core: &CoreHandle, id: u64, method: &str, params: serde_json::Value) -> serde_json::Value {
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

/// Drive a Run to a park: thread/create, then poll run/subscribe until
/// status=parked. Returns the run_id.
async fn create_and_park(core: &CoreHandle) -> String {
    let resp = rpc(
        core,
        1,
        "thread/create",
        serde_json::json!({ "prompt": "remember to buy milk" }),
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

/// Poll run/subscribe until the Run reaches `completed` (terminal). Panics on
/// timeout.
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
fn accept_applies_and_resumes() {
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("propose-worker.ts").spawn();

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

        // One todo entity, created via the proposal, data.title="buy milk".
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
        assert_eq!(etype, "todo", "entity type is todo");
        assert_eq!(created_by, "proposal", "entity created_by=proposal");
        assert!(via.is_some(), "entity carries created_via_proposal_id");
        let data_json: serde_json::Value = serde_json::from_str(&data).expect("entity data is JSON");
        assert_eq!(
            data_json["title"].as_str(),
            Some("buy milk"),
            "entity data.title — got {data}"
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

/// Slice 1 (Person Entity Type): the same accept→apply→resume loop as
/// `accept_applies_and_resumes`, but the worker proposes a **person**
/// (`INKSTONE_PROPOSE_KIND=person`). Proves Core's generic entity path
/// generalizes beyond `todo`: an accepted `{type:"person", data:{name,note}}`
/// lands as an `entities` row of `type='person'` with a seq-1 revision, and the
/// decide result is `accepted` + a non-empty `entity_id`.
#[test]
fn accept_applies_person() {
    let workspace = Workspace::new();
    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_KIND", "person")
        .spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let entity_id = rt.block_on(async {
        let run_id = create_and_park(&core).await;

        // The parked Proposal is a Person.
        let resp = rpc(
            &core,
            3,
            "proposal/get",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        assert_eq!(
            resp["result"]["kind"].as_str(),
            Some("person"),
            "parked proposal kind is person — body: {resp}"
        );
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
                "decision_idempotency_key": "p1",
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
        assert!(!entity_id.is_empty(), "entity_id is non-empty — body: {resp}");

        // The Run resumes in a fresh Worker and reaches completed.
        await_completed(&core, &run_id).await;

        entity_id
    });

    // White-box DB assertions.
    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        // One person entity, created via the proposal, data.name="Alice".
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
        let data_json: serde_json::Value = serde_json::from_str(&data).expect("entity data is JSON");
        assert_eq!(
            data_json["name"].as_str(),
            Some("Alice"),
            "entity data.name — got {data}"
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
    });
}

/// Slice 4 (Proposal reject): `proposal/decide{decision:"reject"}` on a parked
/// Run resolves the Decision WITHOUT applying — no entity lands in tier 2, the
/// Proposal becomes `rejected`, the awaited tool_call resolves as a NORMAL
/// (non-error) declined result, and the Run resumes in a fresh Worker to
/// `completed` (the model reads the decline and wraps up conversationally).
#[test]
fn reject_resumes_without_applying() {
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("propose-worker.ts").spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let run_id = rt.block_on(async {
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

        // Decide: reject.
        let resp = rpc(
            &core,
            4,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "reject",
                "decision_idempotency_key": "r1",
            }),
        )
        .await;
        let result = &resp["result"];
        assert_eq!(
            result["status"].as_str(),
            Some("rejected"),
            "decide result status — body: {resp}"
        );
        assert!(
            result["entity_id"].is_null() || result.get("entity_id").is_none(),
            "reject result carries no entity_id — body: {resp}"
        );

        // The Run resumes in a fresh Worker and reaches completed.
        await_completed(&core, &run_id).await;
        run_id
    });

    // White-box DB assertions.
    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        // ZERO entities for this run's proposal — reject applies nothing.
        let entity_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM entities WHERE created_via_proposal_id IN \
             (SELECT p.id FROM proposals p JOIN tool_calls tc ON tc.id = p.tool_call_id \
              WHERE tc.run_id = ?1)",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("count entities");
        assert_eq!(entity_count, 0, "reject created no entity");

        // proposals.status='rejected'.
        let prop_status: String = sqlx::query_scalar(
            "SELECT p.status FROM proposals p \
             JOIN tool_calls tc ON tc.id = p.tool_call_id WHERE tc.run_id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("proposal row exists");
        assert_eq!(prop_status, "rejected", "proposal rejected");

        // tool_calls resolved (completed) — a NORMAL result, not errored.
        let row = sqlx::query("SELECT status, result_payload FROM tool_calls WHERE run_id = ?1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .expect("tool_call row exists");
        let tc_status: String = row.get("status");
        let result_payload: Option<String> = row.get("result_payload");
        assert_eq!(tc_status, "completed", "tool_call resolved (not errored)");
        let payload = result_payload.expect("tool_call carries a result_payload");
        let payload_json: serde_json::Value =
            serde_json::from_str(&payload).expect("result_payload is JSON");
        // The decline result must NOT be flagged as an error (ADR-0025): a
        // normal Tool Result so the resumed model continues conversationally.
        assert_ne!(
            payload_json["is_error"].as_bool(),
            Some(true),
            "decline result is not an error — payload: {payload}"
        );
        assert_ne!(
            payload_json["decision"].as_str(),
            Some("accept"),
            "decline result is a reject decision — payload: {payload}"
        );

        // runs.status='completed'.
        let run_status: String = sqlx::query_scalar("SELECT status FROM runs WHERE id = ?1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .expect("run row exists");
        assert_eq!(run_status, "completed", "run completed after reject resume");
    });
}

#[test]
fn accept_is_idempotent() {
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("propose-worker.ts").spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let run_id = rt.block_on(async {
        let run_id = create_and_park(&core).await;

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

        let first = rpc(
            &core,
            4,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "same-key",
            }),
        )
        .await;
        let first_entity = first["result"]["entity_id"]
            .as_str()
            .unwrap_or_else(|| panic!("first decide entity_id — body: {first}"))
            .to_string();

        await_completed(&core, &run_id).await;

        // Second decide, same key → same result, no second entity.
        let second = rpc(
            &core,
            5,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "same-key",
            }),
        )
        .await;
        assert_eq!(
            second["result"]["status"].as_str(),
            Some("accepted"),
            "second decide returns accepted — body: {second}"
        );
        assert_eq!(
            second["result"]["entity_id"].as_str(),
            Some(first_entity.as_str()),
            "second decide returns the SAME entity_id — body: {second}"
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

        let entity_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM entities WHERE created_via_proposal_id IN \
             (SELECT p.id FROM proposals p JOIN tool_calls tc ON tc.id = p.tool_call_id \
              WHERE tc.run_id = ?1)",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("count entities");
        assert_eq!(entity_count, 1, "idempotent decide created exactly one entity");
    });
}

/// Slice 5 (Proposal edit): `proposal/decide{decision:"edit", edited_payload}`
/// on a parked Run validates the edited Todo, applies the EDITED values (not
/// the model's proposed data), records `proposals.edited_payload`, and resumes
/// the Run in a fresh Worker to `completed`. The model proposed
/// `title:"buy milk"`; the user edits to `title:"buy oat milk"`, and the
/// created entity must carry the EDIT.
#[test]
fn edit_applies_edited_payload() {
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("propose-worker.ts").spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let (run_id, entity_id) = rt.block_on(async {
        let run_id = create_and_park(&core).await;

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

        // Decide: edit with a new title.
        let resp = rpc(
            &core,
            4,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "edit",
                "edited_payload": { "title": "buy oat milk", "done": false },
                "decision_idempotency_key": "e1",
            }),
        )
        .await;
        let result = &resp["result"];
        assert_eq!(
            result["status"].as_str(),
            Some("accepted"),
            "edit decide result status — body: {resp}"
        );
        let entity_id = result["entity_id"]
            .as_str()
            .unwrap_or_else(|| panic!("entity_id is a string — body: {resp}"))
            .to_string();

        await_completed(&core, &run_id).await;
        (run_id, entity_id)
    });

    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        // The entity carries the EDITED title, not the model's "buy milk".
        let data: String = sqlx::query_scalar("SELECT data FROM entities WHERE id = ?1")
            .bind(&entity_id)
            .fetch_one(&pool)
            .await
            .expect("entity row exists");
        let data_json: serde_json::Value = serde_json::from_str(&data).expect("entity data is JSON");
        assert_eq!(
            data_json["title"].as_str(),
            Some("buy oat milk"),
            "entity data.title is the EDIT — got {data}"
        );

        // proposals.status='accepted' AND edited_payload recorded.
        let row = sqlx::query(
            "SELECT p.status, p.edited_payload FROM proposals p \
             JOIN tool_calls tc ON tc.id = p.tool_call_id WHERE tc.run_id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("proposal row exists");
        let prop_status: String = row.get("status");
        let edited_payload: Option<String> = row.get("edited_payload");
        assert_eq!(prop_status, "accepted", "edit proposal accepted");
        let edited = edited_payload.expect("proposals.edited_payload is set on edit");
        let edited_json: serde_json::Value =
            serde_json::from_str(&edited).expect("edited_payload is JSON");
        assert_eq!(
            edited_json["title"].as_str(),
            Some("buy oat milk"),
            "edited_payload carries the edit — got {edited}"
        );

        // runs.status='completed'.
        let run_status: String = sqlx::query_scalar("SELECT status FROM runs WHERE id = ?1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .expect("run row exists");
        assert_eq!(run_status, "completed", "run completed after edit resume");
    });
}

/// Slice 5: an invalid `edited_payload` (empty title fails `validate_todo`) is
/// rejected with `invalid_params` BEFORE any DB write — no entity lands, the
/// Proposal stays `pending`, and the Run stays `parked` (re-decidable).
#[test]
fn edit_rejects_invalid_payload() {
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("propose-worker.ts").spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let run_id = rt.block_on(async {
        let run_id = create_and_park(&core).await;

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

        // Decide: edit with an empty title → invalid_params, no apply.
        let resp = rpc(
            &core,
            4,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "edit",
                "edited_payload": { "title": "" },
                "decision_idempotency_key": "bad1",
            }),
        )
        .await;
        assert_eq!(
            resp["error"]["code"].as_i64(),
            Some(-32602),
            "invalid edited_payload → invalid_params — body: {resp}"
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

        // NO entity created.
        let entity_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM entities WHERE created_via_proposal_id IN \
             (SELECT p.id FROM proposals p JOIN tool_calls tc ON tc.id = p.tool_call_id \
              WHERE tc.run_id = ?1)",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("count entities");
        assert_eq!(entity_count, 0, "invalid edit created no entity");

        // proposals.status still 'pending'.
        let prop_status: String = sqlx::query_scalar(
            "SELECT p.status FROM proposals p \
             JOIN tool_calls tc ON tc.id = p.tool_call_id WHERE tc.run_id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("proposal row exists");
        assert_eq!(prop_status, "pending", "proposal still pending after invalid edit");

        // runs.status still 'parked' (no resume).
        let run_status: String = sqlx::query_scalar("SELECT status FROM runs WHERE id = ?1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .expect("run row exists");
        assert_eq!(run_status, "parked", "run still parked after invalid edit");
    });
}

/// Multi-step reconstruction (ADR-0025 core risk): the worker's first spawn
/// does a real `read_thread` tool_call (Core executes + resolves it
/// synchronously) BEFORE the `propose_entity` that parks. On accept the Run
/// resumes, and Core must rebuild a provider-valid MULTI-step transcript — a
/// prior resolved tool_call rendered as a paired `tool_result`, the
/// text-then-tool_call assistant split, and the Decision `tool_result` last,
/// with NO orphan `tool_result`. If reconstruction emitted an orphan or dropped
/// a pair the resume Worker's provider would reject the transcript and the Run
/// would not reach `completed`; reaching `completed` proves the transcript is
/// well-formed.
#[test]
fn accept_resumes_after_multistep_transcript() {
    let workspace = Workspace::new();
    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_MULTISTEP", "1")
        .spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let run_id = rt.block_on(async {
        let run_id = create_and_park(&core).await;

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

        let resp = rpc(
            &core,
            4,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "k-multistep",
            }),
        )
        .await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "decide result status — body: {resp}"
        );

        // The Run resumes from the reconstructed MULTI-step transcript and
        // reaches completed — proving the transcript is provider-valid.
        await_completed(&core, &run_id).await;
        run_id
    });

    // White-box: the read_thread tool_call AND the propose tool_call both
    // resolved (no orphan), and the run completed.
    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        let resolved: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM tool_calls WHERE run_id = ?1 AND status IN ('completed','errored')",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("count tool_calls");
        assert_eq!(resolved, 2, "both read_thread and propose tool_calls resolved");

        let run_status: String = sqlx::query_scalar("SELECT status FROM runs WHERE id = ?1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .expect("run row exists");
        assert_eq!(run_status, "completed", "run completed after multi-step resume");
    });
}
