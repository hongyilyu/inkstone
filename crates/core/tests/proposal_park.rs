//! Slice 1 RED test (Proposal park): when the Worker emits a `propose_entity`
//! `tool_request`, Core persists a Proposal (`pending`) + a `tool_calls` row,
//! sets `runs.status='parked'` + `awaiting_tool_call_id`, and tears the Worker
//! down WITHOUT erroring the Run (ADR-0025: park is a third Worker exit). A
//! Client that subscribes sees `status:"parked"` and NO `done`/`error`;
//! `proposal/get(run_id)` returns the pending Todo Proposal.
//!
//! Driven by `tests/fixtures/propose-worker.ts` over `INKSTONE_WORKER_CMD`,
//! spawned by Core exactly as the real Worker would be.

use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use sqlx::Row;
use sqlx::sqlite::SqlitePoolOptions;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{CoreHandle, Workspace, next_text};

/// Open a fresh socket, send a single request, and return the response body
/// (the first text frame).
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

#[test]
fn parks_on_propose_entity() {
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("propose-worker.ts").spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let run_id = rt.block_on(async {
        // Start a Run via thread/create.
        let resp = rpc(
            &core,
            1,
            "thread/create",
            serde_json::json!({ "prompt": "remember to buy milk" }),
        )
        .await;
        let run_id = resp["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — body: {resp}"))
            .to_string();

        // Poll run/subscribe until the Run reports status:"parked" (the Worker
        // boots tsx, then emits the propose_entity request, then Core parks).
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if Instant::now() > deadline {
                panic!("timed out waiting for run to park");
            }
            let resp = rpc(
                &core,
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

        // Subscribe again and assert NO done/error event arrives within a
        // short window (the park is not a terminal Run Event).
        let mut ws = core.connect().await;
        let sub = serde_json::json!({
            "jsonrpc": "2.0", "id": 3, "method": "run/subscribe",
            "params": { "run_id": run_id },
        });
        ws.send(Message::Text(sub.to_string().into()))
            .await
            .expect("send subscribe");
        let sub_resp = next_text(&mut ws).await;
        let sub_v: serde_json::Value =
            serde_json::from_str(&sub_resp).expect("subscribe response is JSON");
        assert_eq!(
            sub_v["result"]["status"].as_str(),
            Some("parked"),
            "subscribe response carries status:parked — body: {sub_resp}"
        );

        // Drain events for ~1.5s; none may be a terminal done/error.
        let window = Instant::now() + Duration::from_millis(1500);
        while Instant::now() < window {
            match tokio::time::timeout(Duration::from_millis(300), ws.next()).await {
                Ok(Some(Ok(Message::Text(t)))) => {
                    let v: serde_json::Value = serde_json::from_str(&t).unwrap_or_default();
                    let kind = v["params"]["event"]["kind"].as_str();
                    assert!(
                        kind != Some("done") && kind != Some("error"),
                        "parked run must not emit a terminal done/error — got {t}"
                    );
                }
                Ok(Some(Ok(_))) => {}
                Ok(Some(Err(_))) | Ok(None) => break,
                Err(_) => {} // timeout: no event, keep waiting out the window
            }
        }
        ws.close(None).await.ok();

        // proposal/get returns the pending Todo proposal.
        let resp = rpc(
            &core,
            4,
            "proposal/get",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        let p = &resp["result"];
        assert_eq!(p["kind"].as_str(), Some("todo"), "proposal kind — {resp}");
        assert_eq!(p["status"].as_str(), Some("pending"), "proposal status — {resp}");
        assert_eq!(p["run_id"].as_str(), Some(run_id.as_str()), "proposal run_id — {resp}");
        assert_eq!(p["change_kind"].as_str(), Some("create"), "change_kind — {resp}");
        assert_eq!(p["data"]["title"].as_str(), Some("buy milk"), "data.title — {resp}");

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

        let row = sqlx::query("SELECT status, awaiting_tool_call_id FROM runs WHERE id = ?1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .expect("run row exists");
        let status: String = row.get("status");
        let awaiting: Option<String> = row.get("awaiting_tool_call_id");
        assert_eq!(status, "parked", "runs.status is parked");
        assert!(awaiting.is_some(), "runs.awaiting_tool_call_id is set");

        let prop_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM proposals p \
             JOIN tool_calls tc ON tc.id = p.tool_call_id \
             WHERE tc.run_id = ?1 AND p.status = 'pending'",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("count proposals");
        assert_eq!(prop_count, 1, "exactly one pending proposal");

        let tc_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM tool_calls WHERE run_id = ?1 AND status = 'pending'",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("count tool_calls");
        assert_eq!(tc_count, 1, "exactly one pending tool_call");

        let terminal_events: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM run_log WHERE run_id = ?1 AND kind IN ('done','error')",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("count terminal run_log");
        assert_eq!(terminal_events, 0, "no done/error run_event for a parked run");
    });
}

/// No-false-done for an ATTACHED subscriber (ADR-0025). A Client that
/// subscribes to a live, streaming Run (`status:"running"`) and is still
/// attached when the Run parks must NOT receive a synthesized `done` — the
/// forwarder's channel-close path suppresses it for a parked Run. The
/// `parks_on_propose_entity` test can only hit the no-hub branch (it polls
/// until parked first), so this is the only coverage of the forwarder path,
/// which is the slice's stated reason to exist.
#[test]
fn parked_run_emits_no_false_done_to_attached_subscriber() {
    let workspace = Workspace::new();
    // The fixture emits a `text_delta` then waits 1.5s before proposing, so a
    // subscribe lands on the LIVE hub before the park.
    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_DELAY_MS", "1500")
        .spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let resp = rpc(
            &core,
            1,
            "thread/create",
            serde_json::json!({ "prompt": "remember to buy milk" }),
        )
        .await;
        let run_id = resp["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — body: {resp}"))
            .to_string();

        // Subscribe immediately — attach to the live hub during the fixture's
        // pre-propose delay. `status:"running"` proves we took the streaming
        // (hub-present) path, not the no-hub parked branch.
        let mut ws = core.connect().await;
        let sub = serde_json::json!({
            "jsonrpc": "2.0", "id": 2, "method": "run/subscribe",
            "params": { "run_id": run_id },
        });
        ws.send(Message::Text(sub.to_string().into()))
            .await
            .expect("send subscribe");
        let sub_resp = next_text(&mut ws).await;
        let sub_v: serde_json::Value =
            serde_json::from_str(&sub_resp).expect("subscribe response is JSON");
        assert_eq!(
            sub_v["result"]["status"].as_str(),
            Some("running"),
            "attached to a LIVE streaming hub before the park — body: {sub_resp}"
        );

        // Drain across the park (fixture proposes at ~boot+1.5s). The hub closes
        // when Core parks; the forwarder must suppress the synthesized `done`.
        // Assert no terminal event ever arrives, and that we saw the live
        // text_delta (confirming a real attached tail, not an empty snapshot).
        let mut saw_text = false;
        let window = Instant::now() + Duration::from_secs(5);
        while Instant::now() < window {
            match tokio::time::timeout(Duration::from_millis(500), ws.next()).await {
                Ok(Some(Ok(Message::Text(t)))) => {
                    let v: serde_json::Value = serde_json::from_str(&t).unwrap_or_default();
                    let kind = v["params"]["event"]["kind"].as_str();
                    if kind == Some("text_delta") {
                        saw_text = true;
                    }
                    assert!(
                        kind != Some("done") && kind != Some("error"),
                        "attached subscriber must not get a terminal done/error on park — got {t}"
                    );
                }
                Ok(Some(Ok(_))) => {}
                Ok(Some(Err(_))) | Ok(None) => break, // hub/conn closed without a done — acceptable
                Err(_) => {}                          // idle tick
            }
        }
        ws.close(None).await.ok();
        assert!(
            saw_text,
            "attached subscriber received the pre-propose text_delta (live tail)"
        );

        // Confirm the Run actually parked within the window (so the assertion
        // above genuinely covered the park transition).
        let resp = rpc(
            &core,
            3,
            "proposal/get",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("pending"),
            "Run parked with a pending proposal — {resp}"
        );
    });
}

/// Slice 8: an ATTACHED subscriber is PUSHED a `proposal/pending` Notification
/// the moment the Run parks (ADR-0025) — so a chat surface already subscribed
/// to the Run learns to show the review card without polling. The forwarder's
/// channel-close→parked branch emits `proposal/pending {run_id, proposal_id}`
/// instead of merely suppressing the synthesized `done`. Still NO terminal
/// `done`/`error`.
#[test]
fn attached_subscriber_gets_proposal_pending_on_park() {
    let workspace = Workspace::new();
    // The fixture emits a `text_delta` then waits 1.5s before proposing, so a
    // subscribe lands on the LIVE hub before the park.
    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_DELAY_MS", "1500")
        .spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let resp = rpc(
            &core,
            1,
            "thread/create",
            serde_json::json!({ "prompt": "remember to buy milk" }),
        )
        .await;
        let run_id = resp["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — body: {resp}"))
            .to_string();

        // Attach to the live hub during the fixture's pre-propose delay.
        let mut ws = core.connect().await;
        let sub = serde_json::json!({
            "jsonrpc": "2.0", "id": 2, "method": "run/subscribe",
            "params": { "run_id": run_id },
        });
        ws.send(Message::Text(sub.to_string().into()))
            .await
            .expect("send subscribe");
        let sub_resp = next_text(&mut ws).await;
        let sub_v: serde_json::Value =
            serde_json::from_str(&sub_resp).expect("subscribe response is JSON");
        assert_eq!(
            sub_v["result"]["status"].as_str(),
            Some("running"),
            "attached to a LIVE streaming hub before the park — body: {sub_resp}"
        );

        // Drain across the park. We must observe a `proposal/pending`
        // notification carrying this run_id (and a proposal_id), and NEVER a
        // terminal done/error.
        let mut saw_pending = false;
        let window = Instant::now() + Duration::from_secs(5);
        while Instant::now() < window {
            match tokio::time::timeout(Duration::from_millis(500), ws.next()).await {
                Ok(Some(Ok(Message::Text(t)))) => {
                    let v: serde_json::Value = serde_json::from_str(&t).unwrap_or_default();
                    let kind = v["params"]["event"]["kind"].as_str();
                    assert!(
                        kind != Some("done") && kind != Some("error"),
                        "attached subscriber must not get a terminal done/error on park — got {t}"
                    );
                    if v["method"].as_str() == Some("proposal/pending") {
                        assert_eq!(
                            v["params"]["run_id"].as_str(),
                            Some(run_id.as_str()),
                            "proposal/pending carries the run_id — {t}"
                        );
                        assert!(
                            v["params"]["proposal_id"].as_str().is_some(),
                            "proposal/pending carries a proposal_id — {t}"
                        );
                        saw_pending = true;
                        break;
                    }
                }
                Ok(Some(Ok(_))) => {}
                Ok(Some(Err(_))) | Ok(None) => break,
                Err(_) => {}
            }
        }
        ws.close(None).await.ok();
        assert!(
            saw_pending,
            "attached subscriber received a proposal/pending notification on park"
        );
    });
}
