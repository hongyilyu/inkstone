//! Slice 6 RED test (cancel a parked Run): `run/cancel{run_id}` on a parked
//! Run cancels the Run and its pending Proposal in one transaction. The
//! response is `{outcome:"accepted"}`; white-box, `runs.status='cancelled'` and
//! the Proposal `status='cancelled'`. A subsequent `proposal/decide{accept}`
//! then returns `proposal_not_pending` and creates NO entity (the Proposal is
//! no longer pending — the decide validation reuses that gate).
//!
//! Driven by `tests/fixtures/propose-worker.ts` over `INKSTONE_WORKER_CMD`:
//! spawn 1 proposes & blocks (park). No resume Worker runs — cancel is pure
//! tier-2 (the parked Worker is already torn down on park).

use std::time::{Duration, Instant};

use futures_util::SinkExt;
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

#[test]
fn cancel_parked_run() {
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("propose-worker.ts").spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let run_id = rt.block_on(async {
        let run_id = create_and_park(&core).await;

        // Learn the proposal_id (used to attempt a post-cancel decide).
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

        // run/cancel the parked Run → outcome accepted.
        let resp = rpc(
            &core,
            4,
            "run/cancel",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        assert_eq!(
            resp["result"]["outcome"].as_str(),
            Some("accepted"),
            "cancel outcome — body: {resp}"
        );

        // A subsequent proposal/decide{accept} → proposal_not_pending.
        let resp = rpc(
            &core,
            5,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "after-cancel",
            }),
        )
        .await;
        assert_eq!(
            resp["error"]["code"].as_i64(),
            Some(-32002),
            "decide after cancel → proposal_not_pending — body: {resp}"
        );

        run_id
    });

    // White-box DB assertions over the same SQLite file.
    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        // runs.status='cancelled'.
        let run_status: String = sqlx::query_scalar("SELECT status FROM runs WHERE id = ?1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .expect("run row exists");
        assert_eq!(run_status, "cancelled", "run cancelled");

        // The Proposal status='cancelled'.
        let prop_status: String = sqlx::query_scalar(
            "SELECT p.status FROM proposals p \
             JOIN tool_calls tc ON tc.id = p.tool_call_id WHERE tc.run_id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("proposal row exists");
        assert_eq!(prop_status, "cancelled", "proposal cancelled");

        // No entity was created (the post-cancel decide was rejected).
        let entity_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM entities WHERE created_via_proposal_id IN \
             (SELECT p.id FROM proposals p JOIN tool_calls tc ON tc.id = p.tool_call_id \
              WHERE tc.run_id = ?1)",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("count entities");
        assert_eq!(entity_count, 0, "cancel + failed decide created no entity");
    });
}
