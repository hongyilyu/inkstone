//! `thread/get(thread_id)` returns `{thread_id, title, messages}` in
//! chronological order (`created_at, rowid`) with each message's text assembled
//! from its parts (ADR-0022, ADR-0017). Completed Runs yield full text;
//! mid-stream Runs yield a `streaming` assistant message with partial text +
//! `run_id` for resubscribe.

use std::time::{Duration, Instant};

mod common;
use common::{Workspace, next_text, read_response_with_id, rt, send};

/// The concatenated text of a Message's `text` segments (ADR-0045): `MessageView`
/// no longer carries a flat `text` field, so a test reads the reply text from the
/// ordered `segments[]` (the same `concatText` the Web client derives).
fn segment_text(message: &serde_json::Value) -> String {
    message["segments"]
        .as_array()
        .map(|segments| {
            segments
                .iter()
                .filter(|seg| seg["kind"] == serde_json::json!("text"))
                .filter_map(|seg| seg["text"].as_str())
                .collect::<String>()
        })
        .unwrap_or_default()
}

#[test]
fn thread_get_completed_run_returns_full_text() {
    let workspace = Workspace::new();

    let core = workspace.core().worker_fixture("slow-worker.ts").spawn();

    let rt = rt();

    rt.block_on(async {
        let mut ws = core.connect().await;

        send(
            &mut ws,
            r#"{"jsonrpc":"2.0","id":1,"method":"thread/create","params":{"prompt":"hi"}}"#
                .to_string(),
        )
        .await;
        let create = read_response_with_id(&mut ws, 1).await;
        let thread_id = create["result"]["thread_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.thread_id is a string — {create}"))
            .to_string();
        let run_id = create["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — {create}"))
            .to_string();

        // Subscribe + drain to done so the assistant text is persisted and its
        // status flips to completed.
        send(
            &mut ws,
            format!(
                r#"{{"jsonrpc":"2.0","id":2,"method":"run/subscribe","params":{{"run_id":"{run_id}"}}}}"#
            ),
        )
        .await;
        let _sub_resp = read_response_with_id(&mut ws, 2).await;
        loop {
            let body = next_text(&mut ws).await;
            let v: serde_json::Value = serde_json::from_str(&body)
                .unwrap_or_else(|e| panic!("tail frame is JSON: {e} — body: {body}"));
            if v["params"]["event"]["kind"] == serde_json::json!("done") {
                break;
            }
        }

        // `done` is published before the terminal tx commits the status flip,
        // so the assistant may still read `streaming` for a beat. Poll
        // thread/get (~5s) until it settles to `completed`.
        let got = {
            let mut req_id = 50;
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                send(
                    &mut ws,
                    format!(
                        r#"{{"jsonrpc":"2.0","id":{req_id},"method":"thread/get","params":{{"thread_id":"{thread_id}"}}}}"#
                    ),
                )
                .await;
                let resp = read_response_with_id(&mut ws, req_id).await;
                let settled = resp["result"]["messages"]
                    .as_array()
                    .and_then(|m| m.get(1))
                    .map(|asst| asst["status"] == serde_json::json!("completed"))
                    .unwrap_or(false);
                if settled || Instant::now() > deadline {
                    break resp;
                }
                req_id += 1;
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        };

        assert!(
            got.get("error").is_none(),
            "thread/get for a known thread is not an error — {got}"
        );
        assert_eq!(
            got["result"]["thread_id"],
            serde_json::json!(thread_id),
            "result.thread_id echoes the requested thread_id — {got}"
        );
        let title = got["result"]["title"]
            .as_str()
            .unwrap_or_else(|| panic!("result.title is a string — {got}"));
        assert!(!title.is_empty(), "title is non-empty — {got}");

        let messages = got["result"]["messages"]
            .as_array()
            .unwrap_or_else(|| panic!("result.messages is an array — {got}"));
        assert_eq!(messages.len(), 2, "two messages (user + assistant) — {got}");

        // [0] = user, completed, text == "hi", run_id == run_id
        let user = &messages[0];
        assert_eq!(user["role"], serde_json::json!("user"), "messages[0] role — {got}");
        assert_eq!(
            user["status"],
            serde_json::json!("completed"),
            "user message completed — {got}"
        );
        assert_eq!(segment_text(user), "hi", "user text segment — {got}");
        assert_eq!(
            user["run_id"],
            serde_json::json!(run_id),
            "user run_id — {got}"
        );
        assert!(
            user["id"].as_str().is_some_and(|s| !s.is_empty()),
            "user message id present — {got}"
        );

        // [1] = assistant, completed, text == "echo: hi", run_id == run_id
        let asst = &messages[1];
        assert_eq!(
            asst["role"],
            serde_json::json!("assistant"),
            "messages[1] role — {got}"
        );
        assert_eq!(
            asst["status"],
            serde_json::json!("completed"),
            "assistant completed after done — {got}"
        );
        assert_eq!(
            segment_text(asst),
            "echo: hi",
            "assistant assembled text segment — {got}"
        );
        assert_eq!(
            asst["run_id"],
            serde_json::json!(run_id),
            "assistant run_id — {got}"
        );

        ws.close(None).await.ok();
    });
}

#[test]
fn thread_get_midstream_run_returns_streaming_partial() {
    let workspace = Workspace::new();
    let gate_path = workspace.path().join("gate");
    assert!(!gate_path.exists(), "gate must not exist before release");

    // chunks=2: chunk1 "echo: ", block on gate, chunk2 "hello" + done. Holding
    // the gate keeps the Run mid-stream.
    let core = workspace
        .core()
        .worker_fixture("slow-worker.ts")
        .env("INKSTONE_FIXTURE_CHUNKS", "2")
        .env("INKSTONE_FIXTURE_GATE", &gate_path)
        .spawn();

    let rt = rt();

    rt.block_on(async {
        // Connection A: create + subscribe (held mid-stream on the gate).
        let mut ws_a = core.connect().await;
        // Connection B: thread/get runs here with NO subscribe, so its only
        // frame is the response (no interleaved events).
        let mut ws_b = core.connect().await;

        send(
            &mut ws_a,
            r#"{"jsonrpc":"2.0","id":1,"method":"thread/create","params":{"prompt":"hello"}}"#
                .to_string(),
        )
        .await;
        let create = read_response_with_id(&mut ws_a, 1).await;
        let thread_id = create["result"]["thread_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.thread_id is a string — {create}"))
            .to_string();
        let run_id = create["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — {create}"))
            .to_string();

        // Subscribe on A; accumulate text_deltas until chunk1 ("echo: ") lands,
        // which (persist-before-publish) proves it is persisted. The gate is
        // not tripped, so the Worker blocks after chunk1.
        send(
            &mut ws_a,
            format!(
                r#"{{"jsonrpc":"2.0","id":2,"method":"run/subscribe","params":{{"run_id":"{run_id}"}}}}"#
            ),
        )
        .await;
        let _sub_resp = read_response_with_id(&mut ws_a, 2).await;
        let mut assembled = String::new();
        while assembled != "echo: " {
            let body = next_text(&mut ws_a).await;
            let v: serde_json::Value = serde_json::from_str(&body)
                .unwrap_or_else(|e| panic!("A tail frame is JSON: {e} — body: {body}"));
            if v["params"]["event"]["kind"] == serde_json::json!("text_delta") {
                assembled.push_str(
                    v["params"]["event"]["delta"]
                        .as_str()
                        .unwrap_or_else(|| panic!("text_delta carries a string — {body}")),
                );
            }
        }

        // thread/get on B without tripping the gate.
        send(
            &mut ws_b,
            format!(
                r#"{{"jsonrpc":"2.0","id":60,"method":"thread/get","params":{{"thread_id":"{thread_id}"}}}}"#
            ),
        )
        .await;
        let got = read_response_with_id(&mut ws_b, 60).await;

        assert!(
            got.get("error").is_none(),
            "thread/get mid-stream is not an error — {got}"
        );
        let messages = got["result"]["messages"]
            .as_array()
            .unwrap_or_else(|| panic!("result.messages is an array — {got}"));
        assert_eq!(messages.len(), 2, "two messages (user + assistant) — {got}");

        // user: completed, text == "hello"
        let user = &messages[0];
        assert_eq!(user["role"], serde_json::json!("user"), "messages[0] role — {got}");
        assert_eq!(
            user["status"],
            serde_json::json!("completed"),
            "user completed — {got}"
        );
        assert_eq!(segment_text(user), "hello", "user text segment — {got}");

        // assistant: streaming, text is a non-empty prefix of "echo: hello"
        // (not the full text), carrying run_id for resubscribe.
        let asst = &messages[1];
        assert_eq!(
            asst["role"],
            serde_json::json!("assistant"),
            "messages[1] role — {got}"
        );
        assert_eq!(
            asst["status"],
            serde_json::json!("streaming"),
            "assistant still streaming mid-run — {got}"
        );
        let asst_text = segment_text(asst);
        assert!(!asst_text.is_empty(), "assistant partial text non-empty — {got}");
        assert!(
            "echo: hello".starts_with(asst_text.as_str()),
            "assistant text is a prefix of the full output — got {asst_text:?}"
        );
        assert_ne!(
            asst_text, "echo: hello",
            "assistant text is still PARTIAL (not the full output) — {got}"
        );
        assert_eq!(
            asst["run_id"],
            serde_json::json!(run_id),
            "assistant carries run_id so the Client can resubscribe — {got}"
        );

        // Trip the gate + drain A to done so Core finishes cleanly.
        std::fs::write(&gate_path, b"go").expect("create gate file");
        loop {
            let body = next_text(&mut ws_a).await;
            let v: serde_json::Value = serde_json::from_str(&body)
                .unwrap_or_else(|e| panic!("A drain frame is JSON: {e} — body: {body}"));
            if v["params"]["event"]["kind"] == serde_json::json!("done") {
                break;
            }
        }

        ws_a.close(None).await.ok();
        ws_b.close(None).await.ok();
    });
}
