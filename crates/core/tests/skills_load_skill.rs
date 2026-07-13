//! End-to-end Skills activation (ADR-0036): the agent calls `load_skill` by name
//! mid-Run and the SKILL.md body comes back through the *real* dispatch path.
//!
//! This proves the round-trip the unit tests can't: `load_skill` is AMBIENT — it
//! is in NO Workflow's `tools` allowlist (the shipped default.toml lists only
//! domain tools), yet Core must ship its descriptor in the manifest and dispatch
//! the call. The Workspace harness defaults `INKSTONE_SKILLS_DIR` into a fresh
//! tempdir, so Core's boot `seed_if_absent` plants the bundled `weekly-review`
//! skill there; the fixture loads it and echoes the body back on the stream.
//!
//! Driven by `tests/fixtures/tool-worker.ts` with `INKSTONE_TOOLWORKER_TOOL=
//! load_skill`, which asserts the descriptor is present in the manifest before
//! requesting it.

use std::time::Duration;

use futures_util::SinkExt;
use sqlx::Row;
use sqlx::sqlite::SqlitePoolOptions;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{CoreHandle, next_text, rt, Workspace};

/// Create a Thread, subscribe, drain to `done`; return (run_id, assembled text,
/// tool_call `(name, status)` boundaries in arrival order).
async fn run_and_collect(core: &CoreHandle) -> (String, String, Vec<(String, String)>) {
    let mut ws = core.connect().await;

    let request = r#"{"jsonrpc":"2.0","id":1,"method":"thread/create","params":{"prompt":"do my weekly review"}}"#;
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
                let name = v["params"]["event"]["name"]
                    .as_str()
                    .unwrap_or("")
                    .to_string();
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
    (run_id, text, tool_calls)
}

#[test]
fn load_skill_round_trips_the_seeded_skill_body_through_dispatch() {
    let workspace = Workspace::new();
    let core = workspace
        .core()
        .worker_fixture("tool-worker.ts")
        .env("INKSTONE_TOOLWORKER_TOOL", "load_skill")
        .env("INKSTONE_TOOLWORKER_SKILL_NAME", "weekly-review")
        .spawn();

    let rt = rt();

    let run_id = rt.block_on(async {
        let (run_id, text, tools) = run_and_collect(&core).await;

        // The body of the seeded weekly-review SKILL.md came back as tool output
        // (the fixture echoes `tool_outcome=ok:<body>`). The body starts at the
        // markdown heading (frontmatter stripped) and carries its first step.
        assert!(
            text.contains("tool_outcome=ok:"),
            "load_skill dispatched and returned ok — got {text:?}"
        );
        assert!(
            text.contains("# Weekly review"),
            "the stripped SKILL.md body came back — got {text:?}"
        );
        assert!(
            text.contains("search_entities"),
            "the body carries the skill's procedure — got {text:?}"
        );
        // Live tool_call boundaries: load_skill started → completed, proving Core
        // dispatched the ambient tool (it is NOT in the Workflow allowlist).
        assert_eq!(
            tools,
            vec![
                ("load_skill".to_string(), "started".to_string()),
                ("load_skill".to_string(), "completed".to_string()),
            ],
            "ambient load_skill surfaced started→completed — got {tools:?}",
        );
        run_id
    });

    // The dispatch persisted a completed tool_calls row whose payload carries the
    // skill body — the durable side of the round-trip.
    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        let row =
            sqlx::query("SELECT name, status, result_payload FROM tool_calls WHERE run_id = ?1")
                .bind(&run_id)
                .fetch_one(&pool)
                .await
                .expect("a tool_calls row exists for the run");
        let name: String = row.get("name");
        let status: String = row.get("status");
        let result_payload: Option<String> = row.get("result_payload");
        assert_eq!(name, "load_skill");
        assert_eq!(status, "completed");
        assert!(
            result_payload
                .as_deref()
                .unwrap_or("")
                .contains("# Weekly review"),
            "result_payload carries the skill body — got {result_payload:?}"
        );
    });
}

#[test]
fn unknown_skill_name_returns_error_outcome_without_failing_the_run() {
    let workspace = Workspace::new();
    let core = workspace
        .core()
        .worker_fixture("tool-worker.ts")
        .env("INKSTONE_TOOLWORKER_TOOL", "load_skill")
        .env("INKSTONE_TOOLWORKER_SKILL_NAME", "does-not-exist")
        .spawn();

    let rt = rt();

    rt.block_on(async {
        let (_run_id, text, tools) = run_and_collect(&core).await;
        // An unknown skill is a clean tool error, and the Run still completes.
        assert!(
            text.contains("tool_outcome=err:unknown_skill"),
            "an unknown skill yields an unknown_skill error outcome — got {text:?}"
        );
        assert_eq!(
            tools,
            vec![
                ("load_skill".to_string(), "started".to_string()),
                ("load_skill".to_string(), "error".to_string()),
            ],
            "the errored dispatch surfaces started→error — got {tools:?}",
        );
    });
}
