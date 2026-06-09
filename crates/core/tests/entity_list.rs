//! Slice 11 RED test (`entity/list_todos`): after a proposed Todo is accepted
//! (the ADR-0025 park → `proposal/decide{accept}` path), `entity/list_todos`
//! returns it as an `EntityListResult { entities: [...] }` row carrying the
//! Todo's `id`, `type='todo'`, its `data` JSON (`{title:"buy milk", …}`), and
//! the `created_at`/`updated_at` stamps. This is the read the Library's Todos
//! collection consumes live (replacing the mock).
//!
//! Reuses the (two-spawn) `tests/fixtures/propose-worker.ts` over
//! `INKSTONE_WORKER_CMD` to mint the accepted Todo end-to-end, then reads it
//! back over the same wire with the new method.

use std::time::{Duration, Instant};

use futures_util::SinkExt;
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

/// Slice 11: an accepted Todo is returned by `entity/list_todos`. Mint it via
/// the park → accept path, then read it back over the new method and assert the
/// row carries `type='todo'`, the Todo `data` (`title="buy milk"`), and the
/// timestamps.
#[test]
fn list_todos_returns_accepted() {
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("propose-worker.ts").spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let run_id = create_and_park(&core).await;

        // Learn the proposal_id and accept it (creates the Todo entity).
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
                "decision_idempotency_key": "k1",
            }),
        )
        .await;
        let entity_id = resp["result"]["entity_id"]
            .as_str()
            .unwrap_or_else(|| panic!("entity_id is a string — body: {resp}"))
            .to_string();

        // The accepted Todo is now visible to `entity/list_todos`.
        let resp = rpc(&core, 5, "entity/list_todos", serde_json::json!({})).await;
        let entities = resp["result"]["entities"]
            .as_array()
            .unwrap_or_else(|| panic!("result.entities is an array — body: {resp}"));
        assert_eq!(entities.len(), 1, "exactly one Todo listed — body: {resp}");

        let row = &entities[0];
        assert_eq!(
            row["id"].as_str(),
            Some(entity_id.as_str()),
            "row id matches the accepted entity — body: {resp}"
        );
        assert_eq!(row["type"].as_str(), Some("todo"), "row type is todo");
        assert_eq!(
            row["data"]["title"].as_str(),
            Some("buy milk"),
            "row data.title is the proposed Todo title — body: {resp}"
        );
        assert!(
            row["created_at"].is_number(),
            "row carries a numeric created_at — body: {resp}"
        );
        assert!(
            row["updated_at"].is_number(),
            "row carries a numeric updated_at — body: {resp}"
        );
    });
}
