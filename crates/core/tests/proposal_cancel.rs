//! `run/cancel{run_id}` on a parked Run cancels the Run and its pending
//! Proposal in one transaction, returning `{outcome:"accepted"}`. A subsequent
//! `proposal/decide{accept}` then returns `proposal_not_pending` and creates no
//! entity. Driven by `fixtures/propose-worker.ts`, which proposes and parks.

use std::time::{Duration, Instant};

use futures_util::SinkExt;
use sqlx::Row;
use sqlx::sqlite::SqlitePoolOptions;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{CoreHandle, Workspace, next_text};

/// Open a fresh socket, send one request, return the parsed response.
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

/// Drive a Run to a park: thread/create, then poll run/subscribe until
/// status=parked.
async fn create_and_park(core: &CoreHandle) -> String {
    let resp = rpc(
        core,
        1,
        "thread/create",
        serde_json::json!({ "prompt": "I bought milk after daycare pickup and felt relieved." }),
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

        // Learn the proposal_id for the post-cancel decide attempt.
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

        // Cancel the parked Run → accepted.
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

        // A fresh subscriber to a cancelled Run gets the persisted snapshot,
        // then the terminal cancellation event (not a synthesized `done`).
        let mut ws = core.connect().await;
        let subscribe = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 41,
            "method": "run/subscribe",
            "params": { "run_id": run_id },
        });
        ws.send(Message::Text(subscribe.to_string().into()))
            .await
            .expect("send cancelled subscribe");

        let sub_body = next_text(&mut ws).await;
        let sub_resp: serde_json::Value = serde_json::from_str(&sub_body)
            .unwrap_or_else(|e| panic!("subscribe response is JSON: {e} — body: {sub_body}"));
        assert_eq!(
            sub_resp["result"]["status"].as_str(),
            Some("cancelled"),
            "subscribe reports cancelled status — body: {sub_body}"
        );

        let snapshot_body = next_text(&mut ws).await;
        let snapshot: serde_json::Value = serde_json::from_str(&snapshot_body)
            .unwrap_or_else(|e| panic!("snapshot is JSON: {e} — body: {snapshot_body}"));
        assert_eq!(
            snapshot["params"]["event"]["kind"].as_str(),
            Some("text_delta"),
            "cancelled subscribe sends text snapshot first — body: {snapshot_body}"
        );

        let terminal_body = next_text(&mut ws).await;
        let terminal: serde_json::Value = serde_json::from_str(&terminal_body)
            .unwrap_or_else(|e| panic!("terminal is JSON: {e} — body: {terminal_body}"));
        assert_eq!(
            terminal["params"]["event"]["kind"].as_str(),
            Some("cancelled"),
            "cancelled Run terminates stream with cancelled event — body: {terminal_body}"
        );
        ws.close(None).await.ok();

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

/// Cancelling a RESUMING Run (parked → decided → resume spawn) is honored by
/// the resume path's pre-spawn cancel guard, so the resumed Worker never
/// produces its continuation. `INKSTONE_WORKER_PRE_SPAWN_DELAY_MS` holds the
/// resume task pre-spawn long enough for `run/cancel` to win running →
/// cancelled.
#[test]
fn cancel_during_resume_pre_spawn_prevents_continuation() {
    let workspace = Workspace::new();
    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_WORKER_PRE_SPAWN_DELAY_MS", "750")
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

        // Accept → resume re-drives parked → running, then the resume task
        // sleeps in the pre-spawn delay before spawning the resumed Worker.
        let resp = rpc(
            &core,
            4,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "resume-then-cancel",
            }),
        )
        .await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "decide accepted, resume is now in its pre-spawn window — body: {resp}"
        );

        // Cancel while still pre-spawn → wins running → cancelled and signals
        // the resume hub, so the resumed Worker bails.
        let resp = rpc(
            &core,
            5,
            "run/cancel",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        assert_eq!(
            resp["result"]["outcome"].as_str(),
            Some("accepted"),
            "cancel of a resuming Run is accepted — body: {resp}"
        );

        // Let the pre-spawn delay elapse so the resume task woke, observed the
        // cancel, and exited without spawning the Worker.
        tokio::time::sleep(Duration::from_millis(950)).await;
        run_id
    });

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
        assert_eq!(run_status, "cancelled", "resuming run ends cancelled");

        // The resumed Worker never ran: no continuation text, stays incomplete.
        // The Run parked before any text, so (ADR-0045: open-on-first-delta) the
        // assistant Message has NO text part at all — LEFT JOIN + concat so the
        // row still materializes with empty text rather than relying on an eager
        // seq-0 part that no longer exists.
        let row = sqlx::query(
            "SELECT m.status AS message_status, \
                    COALESCE(( \
                      SELECT group_concat(text, '') FROM ( \
                        SELECT text FROM message_parts \
                        WHERE message_id = m.id AND type = 'text' ORDER BY seq \
                      ) \
                    ), '') AS text \
             FROM messages m \
             WHERE m.run_id = ?1 AND m.role = 'assistant'",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("assistant message exists");
        let message_status: String = row.get("message_status");
        let text: String = row.get("text");
        assert_eq!(message_status, "incomplete", "assistant message incomplete");
        assert!(
            !text.contains("Done"),
            "resumed Worker produced no continuation — text was {text:?}"
        );
    });
}
