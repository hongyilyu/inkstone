//! Tool Protocol: Core dispatches a `tool_request` to the Rust tool registry,
//! writes a `tool_result` correlated by `tool_call_id`, and persists a
//! `tool_calls` row + a `tool_call` `run_steps` row.
//!
//! Driven by `tests/fixtures/tool-worker.ts`: emit a `tool_request`, block for
//! the `tool_result`, then echo the outcome as a `text_delta` so the round-trip
//! is observable on the subscribe stream and in the DB.

use std::time::Duration;

use futures_util::SinkExt;
use sqlx::Row;
use sqlx::sqlite::SqlitePoolOptions;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{CoreHandle, Workspace, next_text};

/// Create a Thread, subscribe, drain to `done`; return (thread_id, run_id, text
/// deltas, tool_call `(name, status)` boundaries in arrival order). tsx boots
/// long after subscribe attaches, so the ephemeral `tool_call` events are
/// reliably seen on the live tail.
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
        // Thread A's own read_thread call fails (id-file absent) — we just need
        // A persisted.
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
        // The live tool_call boundaries reach the stream: started → completed.
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
fn search_entities_dispatches_to_its_own_handler() {
    // A second, distinctly-shaped tool through the real worker + the collapsed
    // tool registry. `search_entities` and `read_thread` are BOTH allowlisted
    // `Pool`-variant dispatches, so a registry entry that wired one to the
    // other's `execute` would still compile and still pass the unit tests — only
    // an end-to-end dispatch catches the mis-wire. This asserts the request
    // reaches `search_entities::execute` specifically: its `{ "results": [...] }`
    // payload shape is one `read_thread` never emits.
    let workspace = Workspace::new();
    let core = workspace
        .core()
        .worker_fixture("tool-worker.ts")
        .env("INKSTONE_TOOLWORKER_TOOL", "search_entities")
        .spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let run = rt.block_on(async {
        // No entities exist, so the search succeeds with an empty result set —
        // the dispatch reached search_entities, not a not_found from read_thread.
        let (_thread, run, text, tools) = run_and_collect(&core, "hi").await;
        assert!(
            text.contains(r#"tool_outcome=ok:{"results":[]}"#),
            "search_entities dispatched to its own handler, returning a results payload — got {text:?}"
        );
        assert_eq!(
            tools,
            vec![
                ("search_entities".to_string(), "started".to_string()),
                ("search_entities".to_string(), "completed".to_string()),
            ],
            "search_entities surfaced started→completed on the stream — got {tools:?}",
        );
        run
    });

    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        let row =
            sqlx::query("SELECT name, status, result_payload FROM tool_calls WHERE run_id = ?1")
                .bind(&run)
                .fetch_one(&pool)
                .await
                .expect("a tool_calls row exists for the run");
        let name: String = row.get("name");
        let status: String = row.get("status");
        let result_payload: Option<String> = row.get("result_payload");
        assert_eq!(name, "search_entities");
        assert_eq!(status, "completed");
        // The persisted payload is the serialized AgentToolResult, carrying the
        // tool's `results` shape as nested text — a discriminator read_thread
        // (which returns thread_id/title/messages) never produces.
        assert!(
            result_payload.as_deref().unwrap_or("").contains("results"),
            "result_payload carries the search_entities results shape — got {result_payload:?}"
        );
    });
}

#[test]
fn unknown_thread_id_returns_error_outcome() {
    let workspace = Workspace::new();
    // No id-file → the fixture reads an unknown id; read_thread must return an
    // error outcome and the Run must still complete cleanly.
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
        // read_thread is allowlisted and dispatched, but the unknown id fails:
        // started → error.
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
        // Rejected before dispatch, but still surfaces started→error (Core emits
        // `started` on arrival, then `error` from the allowlist refusal).
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
