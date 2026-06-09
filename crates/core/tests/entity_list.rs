//! Slice 2 RED test (`entity/list`): after a proposed Entity is accepted (the
//! ADR-0025 park → `proposal/decide{accept}` path), `entity/list({type})`
//! returns the accepted Entities of that `type`, newest-first, as an
//! `EntityListResult { entities: [...] }`. Each row carries the Entity's `id`,
//! its `type`, its `data` JSON, and the `created_at`/`updated_at` stamps. The
//! read filters by `type`: listing the OTHER type returns no rows. This is the
//! read the Library's collections consume live (replacing the mock).
//!
//! The faux `tests/fixtures/propose-worker.ts` proposes ONE kind per Core
//! instance (env `INKSTONE_PROPOSE_KIND`), so the two tests prove filtering in
//! both directions: a todo Core lists its Todo (and zero People), a person Core
//! lists its Person (and zero Todos).

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

/// Drive park → accept and return the created entity_id. Reused by both tests.
async fn park_and_accept(core: &CoreHandle, idempotency_key: &str) -> String {
    let run_id = create_and_park(core).await;

    // Learn the proposal_id and accept it (creates the entity).
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

    let resp = rpc(
        core,
        4,
        "proposal/decide",
        serde_json::json!({
            "proposal_id": proposal_id,
            "decision": "accept",
            "decision_idempotency_key": idempotency_key,
        }),
    )
    .await;
    resp["result"]["entity_id"]
        .as_str()
        .unwrap_or_else(|| panic!("entity_id is a string — body: {resp}"))
        .to_string()
}

/// Slice 2: an accepted Todo is returned by `entity/list({type:"todo"})`. Mint
/// it via the park → accept path, then read it back over the type-parameterized
/// method and assert the row carries `type='todo'`, the Todo `data`
/// (`title="buy milk"`), and the timestamps. Listing `{type:"person"}` then
/// returns no rows — the read filters by type.
#[test]
fn list_todos_returns_accepted() {
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("propose-worker.ts").spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let entity_id = park_and_accept(&core, "k1").await;

        // The accepted Todo is now visible to `entity/list({type:"todo"})`.
        let resp = rpc(&core, 5, "entity/list", serde_json::json!({ "type": "todo" })).await;
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

        // Listing the OTHER type returns no rows — the read filters by type.
        let resp = rpc(&core, 6, "entity/list", serde_json::json!({ "type": "person" })).await;
        let entities = resp["result"]["entities"]
            .as_array()
            .unwrap_or_else(|| panic!("result.entities is an array — body: {resp}"));
        assert!(
            entities.is_empty(),
            "no People listed in a todo workspace — body: {resp}"
        );
    });
}

/// Slice 2 (Person Entity Type): an accepted Person is returned by
/// `entity/list({type:"person"})`. The worker proposes a Person
/// (`INKSTONE_PROPOSE_KIND=person`); after accept, the row carries
/// `type='person'` and the Person `data` (`name="Alice"`). Listing
/// `{type:"todo"}` returns no rows — filtering excludes the other type.
#[test]
fn list_person_returns_accepted() {
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

    rt.block_on(async {
        let entity_id = park_and_accept(&core, "p1").await;

        // The accepted Person is visible to `entity/list({type:"person"})`.
        let resp = rpc(&core, 5, "entity/list", serde_json::json!({ "type": "person" })).await;
        let entities = resp["result"]["entities"]
            .as_array()
            .unwrap_or_else(|| panic!("result.entities is an array — body: {resp}"));
        assert_eq!(entities.len(), 1, "exactly one Person listed — body: {resp}");

        let row = &entities[0];
        assert_eq!(
            row["id"].as_str(),
            Some(entity_id.as_str()),
            "row id matches the accepted entity — body: {resp}"
        );
        assert_eq!(row["type"].as_str(), Some("person"), "row type is person");
        assert_eq!(
            row["data"]["name"].as_str(),
            Some("Alice"),
            "row data.name is the proposed Person name — body: {resp}"
        );
        assert!(
            row["created_at"].is_number(),
            "row carries a numeric created_at — body: {resp}"
        );
        assert!(
            row["updated_at"].is_number(),
            "row carries a numeric updated_at — body: {resp}"
        );

        // Listing the OTHER type returns no rows — filtering excludes Todos.
        let resp = rpc(&core, 6, "entity/list", serde_json::json!({ "type": "todo" })).await;
        let entities = resp["result"]["entities"]
            .as_array()
            .unwrap_or_else(|| panic!("result.entities is an array — body: {resp}"));
        assert!(
            entities.is_empty(),
            "no Todos listed in a person workspace — body: {resp}"
        );
    });
}
