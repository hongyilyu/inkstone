//! Slice 7 RED test (Parked Run survives a Core restart): a parked Run is
//! durable across a real Core process restart on the same DB. Core #1 parks a
//! Run on a `propose_workspace_mutation` Proposal; Core #1 is KILLED; Core #2 boots on the
//! SAME `INKSTONE_DB_PATH`. The ADR-0012 boot recovery sweep errors any
//! interrupted `running`/`pending` Runs but MUST preserve `parked` — so via
//! Core #2 the Proposal is still `pending`, `runs.status` is still `parked`
//! (NOT `errored`/`core_restarted`), and `proposal/decide{accept}` resumes the
//! Run to `completed` with a Journal Entry entity in tier 2.
//!
//! This is the property that justifies Strategy B over keep-alive (ADR-0025):
//! durable park across a Core restart. The sweep's `parked` exclusion is the
//! unit under test.
//!
//! Driven by `tests/fixtures/propose-worker.ts` over `INKSTONE_WORKER_CMD`
//! (same fixture the park/decide slices use): spawn 1 proposes & blocks (park);
//! the resume spawn detects `mode === "resume"` and finishes (a `text_delta` +
//! `done`).

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

/// Drive a Run to a park on `core`: thread/create, then poll run/subscribe
/// until status=parked. Returns the run_id.
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

/// Poll run/subscribe on `core` until the Run reaches `completed`. Panics on
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
fn parked_survives_restart() {
    let workspace = Workspace::new();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    // ── Core #1: park a Run, then KILL the process. ──────────────────────
    let mut core1 = workspace.core().worker_fixture("propose-worker.ts").spawn();
    let run_id = rt.block_on(create_and_park(&core1));
    core1.kill();

    // ── Core #2: boot on the SAME DB. The boot recovery sweep runs here. ──
    let core2 = workspace.core().worker_fixture("propose-worker.ts").spawn();

    let entity_id = rt.block_on(async {
        // The parked Run survived the restart: its Proposal is still pending.
        let resp = rpc(
            &core2,
            3,
            "proposal/get",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("pending"),
            "Proposal still pending after restart — body: {resp}"
        );
        let proposal_id = resp["result"]["proposal_id"]
            .as_str()
            .unwrap_or_else(|| panic!("proposal_id is a string — body: {resp}"))
            .to_string();

        // White-box (same sqlite file, ro): the boot sweep PRESERVED the
        // parked Run — it is still `parked`, NOT swept to errored/core_restarted.
        {
            let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect(&url)
                .await
                .expect("connect to migrated DB");
            let row = sqlx::query("SELECT status, terminal_reason FROM runs WHERE id = ?1")
                .bind(&run_id)
                .fetch_one(&pool)
                .await
                .expect("run row exists");
            let status: String = row.get("status");
            let terminal_reason: Option<String> = row.get("terminal_reason");
            assert_eq!(
                status, "parked",
                "boot recovery sweep preserved the parked Run (not swept to errored)"
            );
            assert!(
                terminal_reason.is_none(),
                "parked Run has no terminal_reason after the sweep — got {terminal_reason:?}"
            );
        }

        // The parked Run is still DECIDABLE on Core #2: accept resumes it.
        let resp = rpc(
            &core2,
            4,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "restart-k1",
            }),
        )
        .await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "decide accepted on Core #2 — body: {resp}"
        );
        let entity_id = resp["result"]["entity_id"]
            .as_str()
            .unwrap_or_else(|| panic!("entity_id is a string — body: {resp}"))
            .to_string();

        // The Run resumes in a fresh Worker on Core #2 and reaches completed.
        await_completed(&core2, &run_id).await;
        entity_id
    });

    // ── White-box: Run completed and the Journal Entry exists in tier 2. ───
    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        let run_status: String = sqlx::query_scalar("SELECT status FROM runs WHERE id = ?1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .expect("run row exists");
        assert_eq!(
            run_status, "completed",
            "run completed after restart + accept resume"
        );

        let row = sqlx::query("SELECT type, data, created_by FROM entities WHERE id = ?1")
            .bind(&entity_id)
            .fetch_one(&pool)
            .await
            .expect("entity row exists");
        let etype: String = row.get("type");
        let created_by: String = row.get("created_by");
        let data: String = row.get("data");
        assert_eq!(etype, "journal_entry", "Journal Entry created in tier 2");
        assert_eq!(created_by, "proposal", "entity created_by=proposal");
        let data_json: serde_json::Value =
            serde_json::from_str(&data).expect("entity data is JSON");
        assert_eq!(
            data_json["body"][0]["text"].as_str(),
            Some("Bought milk after daycare pickup."),
            "entity body text — got {data}"
        );
    });
}
