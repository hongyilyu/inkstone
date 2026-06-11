//! Live Run cancellation: `run/cancel` on a running Run is a real terminal
//! transition, not just an accepted response. The test holds the Worker after
//! its first `text_delta`, cancels through the public WebSocket API, and proves
//! the Run stays `cancelled` even if the Worker gate is later released.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use sqlx::Row;
use sqlx::sqlite::SqlitePoolOptions;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{Workspace, next_text};

fn parse(body: &str) -> serde_json::Value {
    serde_json::from_str(body).unwrap_or_else(|e| panic!("frame is JSON: {e} — body: {body}"))
}

async fn next_json(ws: &mut common::Ws) -> serde_json::Value {
    let body = next_text(ws).await;
    parse(&body)
}

async fn no_text_frame(ws: &mut common::Ws, duration: Duration) {
    match tokio::time::timeout(duration, ws.next()).await {
        Err(_) | Ok(None) => {}
        Ok(Some(Ok(Message::Close(_)))) => {}
        Ok(Some(Ok(frame))) => panic!("expected no frame, got {frame:?}"),
        Ok(Some(Err(e))) => panic!("websocket read error: {e}"),
    }
}

#[test]
fn cancel_running_run_wins_and_suppresses_late_worker_done() {
    let workspace = Workspace::new();
    let gate_path = workspace.path().join("cancel-gate");
    assert!(!gate_path.exists(), "gate must not exist before release");

    let core = workspace
        .core()
        .worker_fixture("slow-worker.ts")
        .env("INKSTONE_FIXTURE_CHUNKS", "2")
        .env("INKSTONE_FIXTURE_GATE", &gate_path)
        .spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let run_id = rt.block_on(async {
        let mut ws = core.connect().await;

        let create = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "thread/create",
            "params": { "prompt": "hello" },
        });
        ws.send(Message::Text(create.to_string().into()))
            .await
            .expect("send thread/create");

        let create_resp = next_json(&mut ws).await;
        let run_id = create_resp["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — body: {create_resp}"))
            .to_string();

        let subscribe = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "run/subscribe",
            "params": { "run_id": run_id },
        });
        ws.send(Message::Text(subscribe.to_string().into()))
            .await
            .expect("send run/subscribe");

        let sub_resp = next_json(&mut ws).await;
        assert_eq!(
            sub_resp["result"]["status"].as_str(),
            Some("running"),
            "subscribe reports running before cancel — body: {sub_resp}"
        );

        let mut streamed = String::new();
        while streamed.is_empty() {
            let event = next_json(&mut ws).await;
            assert_eq!(
                event["method"].as_str(),
                Some("run/event"),
                "expected run/event while waiting for first delta — body: {event}"
            );
            assert_eq!(
                event["params"]["event"]["kind"].as_str(),
                Some("text_delta"),
                "expected text_delta before cancel — body: {event}"
            );
            streamed.push_str(
                event["params"]["event"]["delta"]
                    .as_str()
                    .unwrap_or_else(|| panic!("delta is string — body: {event}")),
            );
        }

        let cancel = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "run/cancel",
            "params": { "run_id": run_id },
        });
        ws.send(Message::Text(cancel.to_string().into()))
            .await
            .expect("send run/cancel");

        let cancel_resp = next_json(&mut ws).await;
        assert_eq!(cancel_resp["id"].as_i64(), Some(3), "cancel response id");
        assert_eq!(
            cancel_resp["result"]["outcome"].as_str(),
            Some("accepted"),
            "cancel response accepted — body: {cancel_resp}"
        );

        let terminal = next_json(&mut ws).await;
        assert_eq!(
            terminal["params"]["event"]["kind"].as_str(),
            Some("cancelled"),
            "running cancel emits terminal cancelled — body: {terminal}"
        );

        // The Worker is still gated. If Core failed to signal the live Worker
        // or suppress late terminal events, a later `done` would show up here
        // after the gate is released.
        no_text_frame(&mut ws, Duration::from_millis(250)).await;
        std::fs::write(&gate_path, b"go").expect("release worker gate");
        no_text_frame(&mut ws, Duration::from_millis(500)).await;

        ws.close(None).await.ok();
        run_id
    });

    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        let run = sqlx::query("SELECT status, terminal_reason FROM runs WHERE id = ?1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .expect("run row exists");
        let status: String = run.get("status");
        let terminal_reason: String = run.get("terminal_reason");
        assert_eq!(status, "cancelled", "run status");
        assert_eq!(terminal_reason, "cancelled", "terminal reason");

        let assistant_status: String = sqlx::query_scalar(
            "SELECT status FROM messages WHERE role='assistant' AND run_id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("assistant message exists");
        assert_eq!(
            assistant_status, "incomplete",
            "partial assistant text remains incomplete"
        );

        let cancelled_logs: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM run_log WHERE run_id = ?1 AND kind = 'cancelled'",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("count cancelled log rows");
        assert_eq!(cancelled_logs, 1, "one cancellation run_log row");
    });
}

#[test]
fn cancel_before_worker_start_prevents_worker_output() {
    let workspace = Workspace::new();

    let core = workspace
        .core()
        .worker_fixture("slow-worker.ts")
        .env("INKSTONE_FIXTURE_CHUNKS", "1")
        .env("INKSTONE_WORKER_PRE_SPAWN_DELAY_MS", "750")
        .spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let run_id = rt.block_on(async {
        let mut ws = core.connect().await;

        let create = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "thread/create",
            "params": { "prompt": "hello" },
        });
        ws.send(Message::Text(create.to_string().into()))
            .await
            .expect("send thread/create");
        let create_resp = next_json(&mut ws).await;
        let run_id = create_resp["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — body: {create_resp}"))
            .to_string();

        let cancel = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "run/cancel",
            "params": { "run_id": run_id },
        });
        ws.send(Message::Text(cancel.to_string().into()))
            .await
            .expect("send run/cancel");
        let cancel_resp = next_json(&mut ws).await;
        assert_eq!(
            cancel_resp["result"]["outcome"].as_str(),
            Some("accepted"),
            "cancel before worker start is accepted — body: {cancel_resp}"
        );
        ws.close(None).await.ok();

        let mut ws = core.connect().await;
        let subscribe = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "run/subscribe",
            "params": { "run_id": run_id },
        });
        ws.send(Message::Text(subscribe.to_string().into()))
            .await
            .expect("send run/subscribe");

        let sub_resp = next_json(&mut ws).await;
        assert_eq!(
            sub_resp["result"]["status"].as_str(),
            Some("cancelled"),
            "fresh subscribe sees cancelled status — body: {sub_resp}"
        );
        let snapshot = next_json(&mut ws).await;
        assert_eq!(
            snapshot["params"]["event"]["kind"].as_str(),
            Some("text_delta"),
            "cancelled run still sends a text snapshot — body: {snapshot}"
        );
        let terminal = next_json(&mut ws).await;
        assert_eq!(
            terminal["params"]["event"]["kind"].as_str(),
            Some("cancelled"),
            "fresh subscribe terminates with cancelled — body: {terminal}"
        );
        ws.close(None).await.ok();

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

        let row = sqlx::query(
            "SELECT r.status AS run_status, m.status AS message_status, mp.text AS text \
             FROM runs r \
             JOIN messages m ON m.run_id = r.id AND m.role = 'assistant' \
             JOIN message_parts mp ON mp.message_id = m.id AND mp.seq = 0 \
             WHERE r.id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("run/message rows exist");
        let run_status: String = row.get("run_status");
        let message_status: String = row.get("message_status");
        let text: String = row.get("text");

        assert_eq!(run_status, "cancelled", "run remains cancelled");
        assert_eq!(
            message_status, "incomplete",
            "assistant message is incomplete"
        );
        assert_eq!(text, "", "worker produced no text after pre-spawn cancel");
    });
}

#[test]
fn cancel_loses_to_completed_worker_is_already_terminal() {
    // The mirror race: the Worker reaches `done` BEFORE run/cancel arrives, so
    // the guarded `running -> cancelled` transition loses to the committed
    // completion. The cancel command must report `already_terminal` and the
    // Run must stay `completed` — "a later cancel does not un-complete a Run."
    let workspace = Workspace::new();

    // Ungated fixture: one chunk + done, no gate → the Run completes on its own.
    let core = workspace
        .core()
        .worker_fixture("slow-worker.ts")
        .env("INKSTONE_FIXTURE_CHUNKS", "1")
        .spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let run_id = rt.block_on(async {
        let mut ws = core.connect().await;

        let create = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "thread/create",
            "params": { "prompt": "hello" },
        });
        ws.send(Message::Text(create.to_string().into()))
            .await
            .expect("send thread/create");
        let create_resp = next_json(&mut ws).await;
        let run_id = create_resp["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — body: {create_resp}"))
            .to_string();

        let subscribe = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "run/subscribe",
            "params": { "run_id": run_id },
        });
        ws.send(Message::Text(subscribe.to_string().into()))
            .await
            .expect("send run/subscribe");
        // Drain subscribe response + events until the terminal `done` lands, so
        // the Run is provably `completed` before we cancel.
        loop {
            let frame = next_json(&mut ws).await;
            if frame["params"]["event"]["kind"].as_str() == Some("done") {
                break;
            }
            assert_ne!(
                frame["params"]["event"]["kind"].as_str(),
                Some("cancelled"),
                "an uncancelled Run must not emit cancelled — body: {frame}"
            );
        }

        // Now cancel the already-completed Run → already_terminal.
        let cancel = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "run/cancel",
            "params": { "run_id": run_id },
        });
        ws.send(Message::Text(cancel.to_string().into()))
            .await
            .expect("send run/cancel");
        let cancel_resp = next_json(&mut ws).await;
        assert_eq!(
            cancel_resp["result"]["outcome"].as_str(),
            Some("already_terminal"),
            "cancel after completion is already_terminal — body: {cancel_resp}"
        );
        ws.close(None).await.ok();
        run_id
    });

    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        let run = sqlx::query("SELECT status, terminal_reason FROM runs WHERE id = ?1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .expect("run row exists");
        let status: String = run.get("status");
        let terminal_reason: String = run.get("terminal_reason");
        assert_eq!(status, "completed", "run stays completed after a late cancel");
        assert_eq!(terminal_reason, "completed", "terminal reason unchanged");

        // No cancellation was recorded in the Run Log.
        let cancelled_logs: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM run_log WHERE run_id = ?1 AND kind = 'cancelled'",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("count cancelled log rows");
        assert_eq!(cancelled_logs, 0, "no cancellation run_log row for a lost cancel");
    });
}

#[test]
fn cancel_during_tool_dispatch_wins_and_keeps_tool_rows() {
    // Cancel a Run mid-turn, AFTER a real tool dispatch persisted its rows but
    // before the turn completes. Proves the run_loop's in-flight cancel checks
    // (around the tool_request arm) release the gate and end the Run cancelled
    // without a late `done`, and that the persisted tool history is preserved.
    let workspace = Workspace::new();
    let gate_path = workspace.path().join("tool-gate");
    assert!(!gate_path.exists(), "gate must not exist before release");

    // tool-worker requests the allowlisted `read_thread` with the unknown
    // "t-dummy" thread id → Core dispatches it (persisting a tool_calls row) and
    // it resolves `errored`; the fixture then BLOCKS on the gate before `done`.
    let core = workspace
        .core()
        .worker_fixture("tool-worker.ts")
        .env("INKSTONE_TOOLWORKER_GATE", &gate_path)
        .spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let run_id = rt.block_on(async {
        let mut ws = core.connect().await;

        let create = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "thread/create",
            "params": { "prompt": "hello" },
        });
        ws.send(Message::Text(create.to_string().into()))
            .await
            .expect("send thread/create");
        let create_resp = next_json(&mut ws).await;
        let run_id = create_resp["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — body: {create_resp}"))
            .to_string();

        let subscribe = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "run/subscribe",
            "params": { "run_id": run_id },
        });
        ws.send(Message::Text(subscribe.to_string().into()))
            .await
            .expect("send run/subscribe");
        let sub_resp = next_json(&mut ws).await;
        assert_eq!(
            sub_resp["result"]["status"].as_str(),
            Some("running"),
            "subscribe reports running before cancel — body: {sub_resp}"
        );

        // Drain events until the tool dispatch FINISHED (its terminal `error`
        // boundary). At that point the dispatch persisted + resolved its rows
        // and the fixture is now blocked on the gate — a deterministic mid-turn
        // hold. A premature `done`/`cancelled` here is a failure.
        loop {
            let event = next_json(&mut ws).await;
            assert_eq!(
                event["method"].as_str(),
                Some("run/event"),
                "expected run/event while awaiting tool boundary — body: {event}"
            );
            let kind = event["params"]["event"]["kind"].as_str();
            assert!(
                kind != Some("done") && kind != Some("cancelled"),
                "no terminal event before cancel — body: {event}"
            );
            if kind == Some("tool_call")
                && event["params"]["event"]["status"].as_str() == Some("error")
            {
                break;
            }
        }

        let cancel = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "run/cancel",
            "params": { "run_id": run_id },
        });
        ws.send(Message::Text(cancel.to_string().into()))
            .await
            .expect("send run/cancel");
        let cancel_resp = next_json(&mut ws).await;
        assert_eq!(
            cancel_resp["result"]["outcome"].as_str(),
            Some("accepted"),
            "cancel of a mid-dispatch Run is accepted — body: {cancel_resp}"
        );

        let terminal = next_json(&mut ws).await;
        assert_eq!(
            terminal["params"]["event"]["kind"].as_str(),
            Some("cancelled"),
            "mid-dispatch cancel emits terminal cancelled — body: {terminal}"
        );

        // Release the gate: the worker would now emit its `text_delta`/`done`.
        // Core must have already shut it down — no late frame may arrive.
        no_text_frame(&mut ws, Duration::from_millis(250)).await;
        std::fs::write(&gate_path, b"go").expect("release worker gate");
        no_text_frame(&mut ws, Duration::from_millis(500)).await;

        ws.close(None).await.ok();
        run_id
    });

    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        let run = sqlx::query("SELECT status, terminal_reason FROM runs WHERE id = ?1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .expect("run row exists");
        let status: String = run.get("status");
        let terminal_reason: String = run.get("terminal_reason");
        assert_eq!(status, "cancelled", "run cancelled mid-dispatch");
        assert_eq!(terminal_reason, "cancelled", "terminal reason");

        // The dispatched tool's rows survive the cancellation: the call was
        // persisted and resolved before the gate, so cancel does not erase
        // in-flight tool history.
        let row = sqlx::query(
            "SELECT name, status FROM tool_calls WHERE run_id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("a tool_calls row persisted before cancel");
        let tool_name: String = row.get("name");
        let tool_status: String = row.get("status");
        assert_eq!(tool_name, "read_thread", "the dispatched tool is recorded");
        assert_eq!(
            tool_status, "errored",
            "the dispatch resolved before cancel (unknown thread id)"
        );

        // Exactly one cancellation was recorded.
        let cancelled_logs: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM run_log WHERE run_id = ?1 AND kind = 'cancelled'",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("count cancelled log rows");
        assert_eq!(cancelled_logs, 1, "one cancellation run_log row");
    });
}
