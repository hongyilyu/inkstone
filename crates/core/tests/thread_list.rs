//! `thread/list` returns Thread summaries `{id, title, last_activity_at}`
//! ordered by most-recent activity first. The test creates two Threads ("alpha"
//! then "beta"), sleeps ~10ms, then posts a bump into alpha so its
//! `last_activity_at` is strictly newest — making the order unambiguously
//! [alpha, beta] despite possible ms-granularity create-time ties.

use std::time::Duration;

use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{next_text, rt, Workspace, Ws};

/// Send a `thread/create` with `prompt` and return its `thread_id`.
async fn create_thread(ws: &mut Ws, id: u32, prompt: &str) -> String {
    let create = format!(
        r#"{{"jsonrpc":"2.0","id":{id},"method":"thread/create","params":{{"prompt":"{prompt}"}}}}"#
    );
    ws.send(Message::Text(create.into()))
        .await
        .expect("send thread/create frame");
    let body = next_text(ws).await;
    let resp: serde_json::Value = serde_json::from_str(&body)
        .unwrap_or_else(|e| panic!("create response is JSON: {e} — body: {body}"));
    assert!(
        resp.get("error").is_none(),
        "thread/create with a real prompt is not an error — body: {body}"
    );
    resp["result"]["thread_id"]
        .as_str()
        .unwrap_or_else(|| panic!("result.thread_id is a string — body: {body}"))
        .to_string()
}

#[test]
fn thread_list_returns_threads_newest_first() {
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("slow-worker.ts").spawn();

    let rt = rt();

    rt.block_on(async {
        let mut ws = core.connect().await;

        let thread_a = create_thread(&mut ws, 1, "alpha").await;
        let thread_b = create_thread(&mut ws, 2, "beta").await;

        // Bump A's activity strictly newest: sleep ~10ms so the bump's `now_ms`
        // is strictly greater, then post into A.
        tokio::time::sleep(Duration::from_millis(10)).await;
        let bump = format!(
            r#"{{"jsonrpc":"2.0","id":3,"method":"run/post_message","params":{{"thread_id":"{thread_a}","prompt":"bump"}}}}"#
        );
        ws.send(Message::Text(bump.into()))
            .await
            .expect("send run/post_message bump frame");
        let bump_body = next_text(&mut ws).await;
        let bump_resp: serde_json::Value = serde_json::from_str(&bump_body)
            .unwrap_or_else(|e| panic!("bump response is JSON: {e} — body: {bump_body}"));
        assert!(
            bump_resp.get("error").is_none(),
            "post_message into an existing thread is not an error — body: {bump_body}"
        );

        let list = r#"{"jsonrpc":"2.0","id":99,"method":"thread/list","params":{}}"#;
        ws.send(Message::Text(list.into()))
            .await
            .expect("send thread/list frame");

        // Read until the id:99 response. Nothing is subscribed, so this
        // resolves on the next frame; the loop just guards stray frames.
        let resp = loop {
            let body = next_text(&mut ws).await;
            let v: serde_json::Value = serde_json::from_str(&body)
                .unwrap_or_else(|e| panic!("thread/list frame is JSON: {e} — body: {body}"));
            if v["id"] == serde_json::json!(99) {
                break v;
            }
        };

        assert!(
            resp.get("error").is_none(),
            "thread/list is read-only and must not error — body: {resp}"
        );
        assert!(
            resp.get("method").is_none(),
            "thread/list response is a result, not a notification — body: {resp}"
        );

        let threads = resp["result"]["threads"]
            .as_array()
            .unwrap_or_else(|| panic!("result.threads is an array — body: {resp}"));
        assert_eq!(threads.len(), 2, "exactly two threads — body: {resp}");

        // Newest-first: A (bumped) precedes B.
        let first_id = threads[0]["id"]
            .as_str()
            .unwrap_or_else(|| panic!("threads[0].id is a string — body: {resp}"));
        let first_title = threads[0]["title"]
            .as_str()
            .unwrap_or_else(|| panic!("threads[0].title is a string — body: {resp}"));
        let first_activity = threads[0]["last_activity_at"]
            .as_i64()
            .unwrap_or_else(|| panic!("threads[0].last_activity_at is an integer — body: {resp}"));

        let second_id = threads[1]["id"]
            .as_str()
            .unwrap_or_else(|| panic!("threads[1].id is a string — body: {resp}"));
        let second_title = threads[1]["title"]
            .as_str()
            .unwrap_or_else(|| panic!("threads[1].title is a string — body: {resp}"));
        let second_activity = threads[1]["last_activity_at"]
            .as_i64()
            .unwrap_or_else(|| panic!("threads[1].last_activity_at is an integer — body: {resp}"));

        assert_eq!(first_id, thread_a, "newest thread is A — body: {resp}");
        assert_eq!(first_title, "alpha", "A's title is its prompt — body: {resp}");
        assert_eq!(second_id, thread_b, "older thread is B — body: {resp}");
        assert_eq!(second_title, "beta", "B's title is its prompt — body: {resp}");
        assert!(
            first_activity >= second_activity,
            "threads are ordered by last_activity_at DESC ({first_activity} >= {second_activity}) — body: {resp}"
        );

        ws.close(None).await.ok();
    });
}
