//! Slice 2 RED test (Tool Protocol): Core keeps the Worker's stdin open,
//! parses stdout as `RunEvent | ToolRequest`, dispatches a `tool_request` to
//! the Rust tool registry, writes a `tool_result` back correlated by
//! `tool_call_id`, and persists a `tool_calls` row + a `run_steps` row of
//! kind `tool_call`. The `read_thread` tool is a stub here (returns
//! `{"messages":[]}`); the real query lands in slice 3.
//!
//! Driven by `tests/fixtures/tool-worker.ts` over `INKSTONE_WORKER_CMD`,
//! spawned by Core exactly as the real Worker would be. The fixture emits a
//! `tool_request`, blocks for the `tool_result`, then echoes the outcome it
//! received as a `text_delta` so the round-trip is observable on the
//! subscribe stream as well as in the DB.

use std::time::Duration;

use futures_util::SinkExt;
use sqlx::Row;
use sqlx::sqlite::SqlitePoolOptions;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{CoreHandle, Workspace, next_text};

/// Create a Thread with `prompt`, subscribe to its Run, drain to `done`, and
/// return (thread_id, run_id, concatenated text deltas, tool_call boundaries).
/// Each tool_call boundary is captured as `(name, status)` in arrival order —
/// the Worker boots tsx (hundreds of ms) long after this subscribe attaches,
/// so the ephemeral `tool_call` events are reliably observed on the live tail.
async fn run_and_collect(
    core: &CoreHandle,
    prompt: &str,
) -> (String, String, String, Vec<(String, String)>) {
    let mut ws = core.connect().await;

    let request = format!(
        r#"{{"jsonrpc":"2.0","id":1,"method":"thread/create","params":{{"prompt":"{prompt}"}}}}"#
    );
    ws.send(Message::Text(request.into()))
        .await
        .expect("send request frame");

    let response_body = next_text(&mut ws).await;
    let response: serde_json::Value = serde_json::from_str(&response_body)
        .unwrap_or_else(|e| panic!("response is JSON: {e} — body: {response_body}"));
    let thread_id = response["result"]["thread_id"]
        .as_str()
        .unwrap_or_else(|| panic!("result.thread_id is a string — body: {response_body}"))
        .to_string();
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

    let mut text = String::new();
    let mut tool_calls: Vec<(String, String)> = Vec::new();
    loop {
        let body = next_text(&mut ws).await;
        let v: serde_json::Value = serde_json::from_str(&body)
            .unwrap_or_else(|e| panic!("event is JSON: {e} — body: {body}"));
        match v["params"]["event"]["kind"].as_str() {
            Some("text_delta") => {
                if let Some(d) = v["params"]["event"]["delta"].as_str() {
                    text.push_str(d);
                }
            }
            Some("tool_call") => {
                let name = v["params"]["event"]["name"].as_str().unwrap_or("").to_string();
                let status = v["params"]["event"]["status"]
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                tool_calls.push((name, status));
            }
            Some("done") => break,
            Some("error") => panic!("run errored unexpectedly — body: {body}"),
            _ => {}
        }
    }
    ws.close(None).await.ok();
    tokio::time::sleep(Duration::from_millis(200)).await;
    (thread_id, run_id, text, tool_calls)
}

#[test]
fn read_thread_returns_another_threads_messages() {
    let workspace = Workspace::new();
    let id_file = workspace.path().join("tid");
    let core = workspace
        .core()
        .worker_fixture("tool-worker.ts")
        .env("INKSTONE_TOOLWORKER_THREAD_ID_FILE", &id_file)
        .spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let run_b = rt.block_on(async {
        // Thread A carries a distinctive prompt. Its own Run calls read_thread
        // with the default unknown id (the id-file doesn't exist yet) → an
        // error outcome it ignores; we just need A persisted.
        let (thread_a, _run_a, _text_a, _tools_a) =
            run_and_collect(&core, "alpha-secret-123").await;

        // Point the fixture at A, then run Thread B — B's Run reads A.
        std::fs::write(&id_file, &thread_a).expect("write id file");
        let (_thread_b, run_b, text_b, tools_b) = run_and_collect(&core, "beta").await;

        assert!(
            text_b.contains("tool_outcome=ok:"),
            "B's read_thread call succeeded — got {text_b:?}"
        );
        assert!(
            text_b.contains("alpha-secret-123"),
            "read_thread returned A's message text — got {text_b:?}"
        );
        // The live tool_call boundaries reach the subscribe stream: a `started`
        // when Core dispatches read_thread, then a terminal `completed`.
        assert_eq!(
            tools_b,
            vec![
                ("read_thread".to_string(), "started".to_string()),
                ("read_thread".to_string(), "completed".to_string()),
            ],
            "B's run surfaced read_thread started→completed on the stream",
        );
        run_b
    });

    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        let row = sqlx::query(
            "SELECT name, status, result_payload FROM tool_calls WHERE run_id = ?1",
        )
        .bind(&run_b)
        .fetch_one(&pool)
        .await
        .expect("a tool_calls row exists for B's run");
        let name: String = row.get("name");
        let status: String = row.get("status");
        let result_payload: Option<String> = row.get("result_payload");
        assert_eq!(name, "read_thread");
        assert_eq!(status, "completed");
        assert!(
            result_payload.as_deref().unwrap_or("").contains("alpha-secret-123"),
            "result_payload carries A's content — got {result_payload:?}"
        );

        let step_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM run_steps WHERE run_id = ?1 AND kind = 'tool_call'",
        )
        .bind(&run_b)
        .fetch_one(&pool)
        .await
        .expect("count tool_call run_steps");
        assert_eq!(step_count, 1, "exactly one tool_call run_step");
    });
}

#[test]
fn unknown_thread_id_returns_error_outcome() {
    let workspace = Workspace::new();
    // No id-file → the fixture reads the unknown "t-dummy"; read_thread must
    // return an error outcome and the Run must still complete cleanly.
    let core = workspace.core().worker_fixture("tool-worker.ts").spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let (_thread, _run, text, tools) = run_and_collect(&core, "hi").await;
        assert!(
            text.contains("tool_outcome=err:"),
            "unknown thread id yields an error outcome — got {text:?}"
        );
        // The terminal `error` boundary reaches the stream (read_thread is
        // allowlisted and dispatched, but the unknown thread id fails).
        assert_eq!(
            tools,
            vec![
                ("read_thread".to_string(), "started".to_string()),
                ("read_thread".to_string(), "error".to_string()),
            ],
            "an errored dispatch surfaces started→error — got {tools:?}",
        );
    });
}

#[test]
fn off_allowlist_tool_returns_error_outcome() {
    let workspace = Workspace::new();
    // The fixture requests a tool not in the Workflow allowlist; Core must
    // reject it with an `err` outcome rather than dispatching.
    let core = workspace
        .core()
        .worker_fixture("tool-worker.ts")
        .env("INKSTONE_TOOLWORKER_TOOL", "nonexistent")
        .spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let (_thread, _run, text, tools) = run_and_collect(&core, "hi").await;
        assert!(
            text.contains("tool_outcome=err:"),
            "off-allowlist tool yields an error outcome — got {text:?}"
        );
        // The boundary still reaches the stream as started→error even though the
        // tool is rejected before dispatch (Core emits `started` on arrival,
        // then `error` from the allowlist refusal). The Client shows a brief
        // running→failed flash, never a stuck row.
        assert_eq!(
            tools,
            vec![
                ("nonexistent".to_string(), "started".to_string()),
                ("nonexistent".to_string(), "error".to_string()),
            ],
            "off-allowlist request surfaces started→error — got {tools:?}",
        );
    });
}
