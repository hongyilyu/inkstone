//! Connection-decouple at the WS level (ADR-0012, ADR-0022 §19-28): a dropped
//! connection does not kill the live stream, and the snapshot/tail boundary is
//! exactly-once.
//!
//! `dropped_connection_does_not_kill_run`: A starts + subscribes, drops before
//! the Worker finishes; B re-subscribes, trips the gate, and gets the snapshot
//! + remaining tail + `done`. The Worker keeps running and persisting the full
//! text across A's drop.
//!
//! `exactly_once_subscribe_during_inflight_persist`: subscribe mid-stream (gate
//! held), drain to `done`, and assert `snapshot ++ tail` equals `echo: hello`
//! exactly — no loss or duplication across the boundary.
//!
//! The slow-worker fixture (`INKSTONE_FIXTURE_CHUNKS=3`) splits `echo: hello`
//! into three incremental pieces, emits chunk 1, then blocks on the gate before
//! chunks 2-3 + `done`. Every WS read is timeout-bounded so a regression fails
//! fast rather than hanging CI.

use std::time::{Duration, Instant};

use futures_util::SinkExt;
use sqlx::sqlite::SqlitePoolOptions;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{Workspace, Ws, next_text};

/// Start a Run via `thread/create` on `ws` and return the minted `run_id`.
async fn post_message(ws: &mut Ws, id: u32) -> String {
    let post = format!(
        r#"{{"jsonrpc":"2.0","id":{id},"method":"thread/create","params":{{"prompt":"hello"}}}}"#
    );
    ws.send(Message::Text(post.into()))
        .await
        .expect("send post_message frame");
    let response_body = next_text(ws).await;
    let response: serde_json::Value = serde_json::from_str(&response_body)
        .unwrap_or_else(|e| panic!("response is JSON: {e} — body: {response_body}"));
    response["result"]["run_id"]
        .as_str()
        .unwrap_or_else(|| panic!("result.run_id is a string — body: {response_body}"))
        .to_string()
}

/// Send `run/subscribe(run_id)`, read the subscribe RESPONSE and the snapshot
/// `text_delta`, and return the cumulative snapshot text (the reassembly base).
/// The snapshot may be `""` or a partial chunk depending on the gate race, so
/// callers must not hard-assert its content.
async fn subscribe_and_read_snapshot(ws: &mut Ws, id: u32, run_id: &str) -> String {
    let subscribe = format!(
        r#"{{"jsonrpc":"2.0","id":{id},"method":"run/subscribe","params":{{"run_id":"{run_id}"}}}}"#
    );
    ws.send(Message::Text(subscribe.into()))
        .await
        .expect("send run/subscribe frame");

    let sub_resp_body = next_text(ws).await;
    let sub_resp: serde_json::Value = serde_json::from_str(&sub_resp_body)
        .unwrap_or_else(|e| panic!("subscribe response is JSON: {e} — body: {sub_resp_body}"));
    assert_eq!(
        sub_resp["id"],
        serde_json::json!(id),
        "subscribe response id — body: {sub_resp_body}"
    );
    assert!(
        sub_resp.get("method").is_none(),
        "subscribe response is a response, not a notification — body: {sub_resp_body}"
    );

    let snapshot_body = next_text(ws).await;
    let snapshot: serde_json::Value = serde_json::from_str(&snapshot_body)
        .unwrap_or_else(|e| panic!("snapshot is JSON: {e} — body: {snapshot_body}"));
    assert_eq!(
        snapshot["params"]["event"]["kind"],
        serde_json::json!("text_delta"),
        "snapshot is a text_delta — body: {snapshot_body}"
    );
    snapshot["params"]["event"]["delta"]
        .as_str()
        .unwrap_or_else(|| panic!("snapshot text_delta carries a string — body: {snapshot_body}"))
        .to_string()
}

/// Drain `ws`'s tail from `base`, appending each incremental `text_delta` until
/// the terminal `done`; returns the reassembled text.
///
/// Plain concatenation is correct here: with a 256-slot broadcast buffer and ≤3
/// deltas, `Lagged` never fires, so every tail frame is an incremental append.
/// The loop only exits via the `done` arm's `break`, so reaching the line after
/// it proves the terminal frame was a `done`.
async fn drain_tail_to_done(ws: &mut Ws, base: String) -> String {
    let mut assembled = base;
    loop {
        let body = next_text(ws).await;
        let v: serde_json::Value = serde_json::from_str(&body)
            .unwrap_or_else(|e| panic!("tail frame is JSON: {e} — body: {body}"));
        assert_eq!(
            v["method"],
            serde_json::json!("run/event"),
            "tail frame is a run/event — body: {body}"
        );
        match v["params"]["event"]["kind"].as_str() {
            Some("text_delta") => {
                assembled.push_str(
                    v["params"]["event"]["delta"]
                        .as_str()
                        .unwrap_or_else(|| panic!("tail text_delta carries a string — body: {body}")),
                );
            }
            Some("done") => break,
            other => panic!("unexpected tail event kind {other:?} — body: {body}"),
        }
    }
    assembled
}

/// A dropped connection does not kill the Run: A drops before the gate trips,
/// B re-subscribes and drains to `done`, and the persisted text is complete
/// (ADR-0012, ADR-0022).
#[test]
fn dropped_connection_does_not_kill_run() {
    let workspace = Workspace::new();
    let gate_path = workspace.path().join("gate");
    assert!(!gate_path.exists(), "gate must not exist before release");

    // chunks=3: emit chunk 1, then block on the gate before chunks 2-3 + `done`.
    let core = workspace
        .core()
        .worker_fixture("slow-worker.ts")
        .env("INKSTONE_FIXTURE_CHUNKS", "3")
        .env("INKSTONE_FIXTURE_GATE", &gate_path)
        .spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let run_id = rt.block_on(async {
        // A: post + subscribe, then DROP mid-run.
        let mut ws_a = core.connect().await;
        let run_id = post_message(&mut ws_a, 1).await;
        let _a_snapshot = subscribe_and_read_snapshot(&mut ws_a, 2, &run_id).await;

        // Drop A BEFORE tripping the gate (Worker still blocked mid-run), so
        // this proves it keeps running after the originating connection leaves.
        ws_a.close(None).await.ok();
        drop(ws_a);

        // B: re-subscribe to the SAME run, drain to done.
        let mut ws_b = core.connect().await;
        let b_base = subscribe_and_read_snapshot(&mut ws_b, 3, &run_id).await;

        // Trip the gate so the Worker emits the remaining chunks + done.
        std::fs::write(&gate_path, b"go").expect("create gate file");

        let assembled = drain_tail_to_done(&mut ws_b, b_base).await;
        assert_eq!(
            assembled, "echo: hello",
            "B's snapshot + tail reassembles to the full echo output despite A's drop"
        );

        // The Worker publishes `done` BEFORE running `complete_run`, so poll
        // until the Run leaves 'running' rather than racing the commit.
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let status: String = sqlx::query_scalar("SELECT status FROM runs WHERE id = ?1")
                .bind(&run_id)
                .fetch_one(&pool)
                .await
                .expect("poll run status");
            if status != "running" {
                break;
            }
            if Instant::now() > deadline {
                panic!("timed out waiting for runs.status to leave 'running' (still {status:?})");
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        ws_b.close(None).await.ok();
        run_id
    });

    // A's drop must not truncate the Run: assistant text complete and the Run
    // reached 'completed' (ADR-0012).
    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        let asst_text: String = sqlx::query_scalar(
            "SELECT mp.text FROM messages m \
             JOIN message_parts mp ON mp.message_id = m.id AND mp.seq = 0 \
             WHERE m.role = 'assistant' AND m.run_id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("read assistant message text");
        assert_eq!(
            asst_text, "echo: hello",
            "dropped connection did not truncate the persisted assistant text"
        );

        let status: String = sqlx::query_scalar("SELECT status FROM runs WHERE id = ?1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .expect("read run status");
        assert_eq!(status, "completed", "Run reached a terminal completed state");
    });
}

/// Exactly-once across the snapshot/tail boundary: subscribe mid-stream (gate
/// held), drain to `done`, and assert `snapshot ++ tail` equals `echo: hello`
/// exactly — no loss or duplication (ADR-0022 §19-28).
#[test]
fn exactly_once_subscribe_during_inflight_persist() {
    let workspace = Workspace::new();
    let gate_path = workspace.path().join("gate");
    assert!(!gate_path.exists(), "gate must not exist before release");

    // chunks=3: subscribe lands while the Worker is parked on the gate (after
    // chunk 1), exercising the snapshot/tail boundary under control.
    let core = workspace
        .core()
        .worker_fixture("slow-worker.ts")
        .env("INKSTONE_FIXTURE_CHUNKS", "3")
        .env("INKSTONE_FIXTURE_GATE", &gate_path)
        .spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let mut ws = core.connect().await;

        let run_id = post_message(&mut ws, 1).await;
        let base = subscribe_and_read_snapshot(&mut ws, 2, &run_id).await;

        // Trip the gate so the Worker emits the remaining chunks + done.
        std::fs::write(&gate_path, b"go").expect("create gate file");

        let assembled = drain_tail_to_done(&mut ws, base).await;
        assert_eq!(
            assembled, "echo: hello",
            "snapshot + tail reassembles to the full echo output exactly once — \
             no delta lost or duplicated across the snapshot/tail boundary"
        );

        ws.close(None).await.ok();
    });
}
