//! A worker-emitted `error` Run Event terminates the Run as `errored` with the
//! worker's message persisted, and the subscribe stream delivers the `error`
//! event then closes. Distinct from `persistence_terminal.rs`'s
//! `worker_eof_errors_run` (stdout EOF → `worker_disconnected`): here the worker
//! emits an explicit `error`, recorded with `terminal_reason='errored'`.

use futures_util::SinkExt;
use sqlx::Row;
use sqlx::sqlite::SqlitePoolOptions;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{next_text, rt, Workspace};

#[test]
fn worker_error_event_marks_run_errored_with_message() {
    let workspace = Workspace::new();
    let gate_path = workspace.path().join("gate");
    let error_message = "provider rejected the request";

    // CHUNKS=2 + GATE pauses the stream mid-flight: the fixture emits chunk 1,
    // blocks until the gate file appears, then emits chunk 2 + the terminal
    // error. The test opens the gate only after subscribing, so the error is
    // delivered strictly after the subscriber attaches (no reliance on tsx
    // cold-start timing).
    let core = workspace
        .core()
        .worker_fixture("slow-worker.ts")
        .env("INKSTONE_FIXTURE_ERROR", error_message)
        .env("INKSTONE_FIXTURE_CHUNKS", "2")
        .env("INKSTONE_FIXTURE_GATE", &gate_path)
        .spawn();

    let rt = rt();

    let (run_id, saw_error_on_stream) = rt.block_on(async {
        let mut ws = core.connect().await;

        let request =
            r#"{"jsonrpc":"2.0","id":1,"method":"thread/create","params":{"prompt":"hi"}}"#;
        ws.send(Message::Text(request.into()))
            .await
            .expect("send request frame");

        let response_body = next_text(&mut ws).await;
        let response: serde_json::Value = serde_json::from_str(&response_body)
            .unwrap_or_else(|e| panic!("response is JSON: {e} — body: {response_body}"));
        let run_id = response["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — body: {response_body}"))
            .to_string();

        let subscribe = format!(
            r#"{{"jsonrpc":"2.0","id":2,"method":"run/subscribe","params":{{"run_id":"{run_id}"}}}}"#
        );
        ws.send(Message::Text(subscribe.into()))
            .await
            .expect("send subscribe frame");
        let _sub_response = next_text(&mut ws).await;

        // Subscribed; trip the gate so the error is delivered after the
        // subscriber attached.
        std::fs::write(&gate_path, b"go").expect("create gate file");

        // The stream must carry an `error` event then close. A `done` before any
        // error fails: a worker that errored must not also complete.
        let saw_error;
        loop {
            let body = next_text(&mut ws).await;
            let v: serde_json::Value = serde_json::from_str(&body)
                .unwrap_or_else(|e| panic!("event is JSON: {e} — body: {body}"));
            match v["params"]["event"]["kind"].as_str() {
                Some("error") => {
                    assert_eq!(
                        v["params"]["event"]["message"].as_str(),
                        Some(error_message),
                        "error event carries the worker's message — body: {body}"
                    );
                    saw_error = true;
                    break;
                }
                Some("done") => {
                    panic!("worker errored; stream must not emit done — body: {body}");
                }
                _ => {}
            }
        }

        ws.close(None).await.ok();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        (run_id, saw_error)
    });

    assert!(saw_error_on_stream, "subscribe stream delivered the error event");

    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        let run_row = sqlx::query(
            "SELECT status, terminal_reason, error_code, error_message, ended_at \
             FROM runs WHERE id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("read run row");
        let status: String = run_row.get("status");
        assert_eq!(status, "errored", "runs.status flipped to errored");
        let terminal_reason: Option<String> = run_row.get("terminal_reason");
        assert_eq!(
            terminal_reason.as_deref(),
            Some("errored"),
            "terminal_reason='errored' (worker-emitted, not disconnect)"
        );
        let error_message_col: Option<String> = run_row.get("error_message");
        assert_eq!(
            error_message_col.as_deref(),
            Some(error_message),
            "runs.error_message carries the worker's message"
        );
        let ended_at: Option<i64> = run_row.get("ended_at");
        assert!(ended_at.is_some(), "ended_at is set");

        // assistant message flipped streaming → incomplete
        let assistant_status: String = sqlx::query_scalar(
            "SELECT status FROM messages WHERE role='assistant' AND run_id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("read assistant message status");
        assert_eq!(
            assistant_status, "incomplete",
            "assistant message flipped to incomplete"
        );

        // exactly one terminal error run_event
        let error_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM run_log WHERE run_id = ?1 AND kind='error'",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("count error events");
        assert_eq!(error_count, 1, "exactly one terminal error run_event");
    });
}
