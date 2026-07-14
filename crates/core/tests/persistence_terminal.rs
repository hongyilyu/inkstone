//! However the Worker exits — clean `done` or stdout EOF without `done` — Core
//! writes the terminal `runs.status`, matching `terminal_reason`, the terminal
//! `run_log` row, and (for the EOF path) flips streaming messages to
//! `incomplete`, all in one transaction.

use std::path::Path;
use std::time::{Duration, Instant};

use futures_util::SinkExt;
use sqlx::Row;
use sqlx::sqlite::SqlitePoolOptions;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{next_text, rt, Workspace};

fn false_binary() -> &'static str {
    if Path::new("/usr/bin/false").exists() {
        "/usr/bin/false"
    } else if Path::new("/bin/false").exists() {
        "/bin/false"
    } else {
        panic!("no `false` binary found at /usr/bin/false or /bin/false");
    }
}

#[test]
fn done_event_completes_run() {
    let workspace = Workspace::new();

    let core = workspace.core().worker_fixture("slow-worker.ts").spawn();

    let rt = rt();

    let run_id = rt.block_on(async {
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
        // Pure-subscribe (ADR-0022): no events on the response.
        assert!(
            response["params"].get("event").is_none(),
            "post_message response carries no event — body: {response_body}"
        );

        // Subscribe by run_id and read until the terminal done.
        let subscribe = format!(
            r#"{{"jsonrpc":"2.0","id":2,"method":"run/subscribe","params":{{"run_id":"{run_id}"}}}}"#
        );
        ws.send(Message::Text(subscribe.into()))
            .await
            .expect("send subscribe frame");

        let _sub_response = next_text(&mut ws).await;

        loop {
            let body = next_text(&mut ws).await;
            let v: serde_json::Value = serde_json::from_str(&body)
                .unwrap_or_else(|e| panic!("event is JSON: {e} — body: {body}"));
            if v["params"]["event"]["kind"] == serde_json::json!("done") {
                break;
            }
        }

        ws.close(None).await.ok();
        // Give Core's per-Run task time to commit the terminal tx.
        tokio::time::sleep(Duration::from_millis(200)).await;

        run_id
    });

    // The terminal tx already committed during the sleep, so a fresh ro pool
    // sees the final state.
    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        // runs ----------------------------------------------------------
        let run_row = sqlx::query(
            "SELECT status, terminal_reason, ended_at FROM runs WHERE id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("read run row");
        let status: String = run_row.get("status");
        assert_eq!(status, "completed", "runs.status flipped to completed");
        let terminal_reason: Option<String> = run_row.get("terminal_reason");
        assert_eq!(
            terminal_reason.as_deref(),
            Some("completed"),
            "terminal_reason='completed'"
        );
        let ended_at: Option<i64> = run_row.get("ended_at");
        assert!(ended_at.is_some(), "ended_at is set");

        // assistant message --------------------------------------------
        let assistant_status: String = sqlx::query_scalar(
            "SELECT status FROM messages WHERE role='assistant' AND run_id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("read assistant message status");
        assert_eq!(
            assistant_status, "completed",
            "assistant message flipped to completed"
        );

        // run_log ---------------------------------------------------
        let done_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM run_log WHERE run_id = ?1 AND kind='done'",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("count done events");
        assert_eq!(done_count, 1, "exactly one terminal done run_event");
    });
}

#[test]
fn worker_eof_errors_run_and_marks_message_incomplete() {
    let workspace = Workspace::new();

    let core = workspace.core().worker_cmd(false_binary()).spawn();

    let rt = rt();

    let run_id = rt.block_on(async {
        let mut ws = core.connect().await;

        let request =
            r#"{"jsonrpc":"2.0","id":1,"method":"thread/create","params":{"prompt":"hi"}}"#;
        ws.send(Message::Text(request.into()))
            .await
            .expect("send request frame");

        let body = next_text(&mut ws).await;

        let v: serde_json::Value = serde_json::from_str(&body)
            .unwrap_or_else(|e| panic!("response is JSON: {e} — body: {body}"));
        let run_id = v["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — body: {body}"))
            .to_string();

        // Worker exits immediately with no stdout. Poll the DB until the run
        // leaves 'running' (bounded at 5s).
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let status: String = sqlx::query_scalar(
                "SELECT status FROM runs WHERE id = ?1",
            )
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .expect("poll run status");
            if status != "running" {
                break;
            }
            if Instant::now() > deadline {
                panic!(
                    "timed out waiting for runs.status to leave 'running' (still {status:?})"
                );
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

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

        // runs ----------------------------------------------------------
        let run_row = sqlx::query(
            "SELECT status, terminal_reason, error_code, ended_at FROM runs WHERE id = ?1",
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
            Some("worker_disconnected"),
            "terminal_reason='worker_disconnected'"
        );
        let error_code: Option<String> = run_row.get("error_code");
        assert_eq!(
            error_code.as_deref(),
            Some("worker_disconnected"),
            "error_code='worker_disconnected'"
        );
        let ended_at: Option<i64> = run_row.get("ended_at");
        assert!(ended_at.is_some(), "ended_at is set");

        // assistant message --------------------------------------------
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

        // run_log ---------------------------------------------------
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

/// Regression: a Worker that fails to spawn hits a `run_worker` pre-loop
/// early-return path. Without `finalize_error` those paths skipped the terminal
/// tx and left the run `running` / assistant `streaming` forever (ADR-0017).
#[test]
fn worker_spawn_failure_errors_run() {
    let workspace = Workspace::new();

    // Nonexistent path → spawn() returns Err, hitting the pre-loop
    // early-return path in run_worker.
    let core = workspace
        .core()
        .worker_cmd("/nonexistent/inkstone-test-worker")
        .spawn();

    let rt = rt();

    let run_id = rt.block_on(async {
        let mut ws = core.connect().await;

        let request =
            r#"{"jsonrpc":"2.0","id":1,"method":"thread/create","params":{"prompt":"hi"}}"#;
        ws.send(Message::Text(request.into()))
            .await
            .expect("send request frame");

        let body = next_text(&mut ws).await;
        let v: serde_json::Value = serde_json::from_str(&body)
            .unwrap_or_else(|e| panic!("response is JSON: {e} — body: {body}"));
        let run_id = v["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — body: {body}"))
            .to_string();

        // Poll for terminal status.
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let status: String =
                sqlx::query_scalar("SELECT status FROM runs WHERE id = ?1")
                    .bind(&run_id)
                    .fetch_one(&pool)
                    .await
                    .expect("poll run status");
            if status != "running" {
                break;
            }
            if Instant::now() > deadline {
                panic!(
                    "timed out waiting for runs.status to leave 'running' (still {status:?})"
                );
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

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

        let run_row =
            sqlx::query("SELECT status, terminal_reason FROM runs WHERE id = ?1")
                .bind(&run_id)
                .fetch_one(&pool)
                .await
                .expect("read run row");
        let status: String = run_row.get("status");
        assert_eq!(status, "errored", "spawn failure flips runs.status to errored");
        let terminal_reason: Option<String> = run_row.get("terminal_reason");
        assert_eq!(
            terminal_reason.as_deref(),
            Some("worker_disconnected"),
            "terminal_reason='worker_disconnected'"
        );

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
    });
}
