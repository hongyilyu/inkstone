//! Slice 5 RED test: `thread/list` returns Thread summaries ordered by
//! most-recent activity first (newest `last_activity_at` first).
//!
//! `thread_list_returns_threads_newest_first`: create two Threads via
//! `thread/create` ("alpha" then "beta"), then `run/post_message` into the
//! FIRST Thread ("alpha") to bump its `last_activity_at` strictly newest.
//! `thread/list` (no params) then returns `{threads: [...]}` with the two
//! summaries ordered [alpha, beta] — alpha first because its activity was
//! bumped last — each carrying `{id, title, last_activity_at}`.
//!
//! Determinism: ms-granularity ties at create time are possible, so the test
//! does not rely on create order. After creating both Threads it sleeps ~10ms
//! and posts a "bump" message into alpha, which writes a strictly-later
//! `last_activity_at` (each new Run touches the Thread). Order is then
//! unambiguous: [alpha (bumped), beta].
//!
//! `thread/create` and `run/post_message` are pure-subscribe (ADR-0022): each
//! returns exactly ONE response frame and streams NO Run Events unless the
//! Client subscribes (this test never does). So the frames arrive in request
//! order and every read is bounded by a timeout.
//!
//! Uses the REAL echo Worker (no fixture/gate) — this slice asserts the list
//! read, not mid-stream timing.

use std::time::Duration;

use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{Workspace, Ws, next_text};

/// Send a `thread/create` with `prompt`, read the single response frame, and
/// return its `thread_id`. Pure-subscribe: no events ride the response.
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

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let mut ws = core.connect().await;

        // ---- Create thread A ("alpha") then thread B ("beta") ----
        let thread_a = create_thread(&mut ws, 1, "alpha").await;
        let thread_b = create_thread(&mut ws, 2, "beta").await;

        // ---- Bump A's activity strictly newest ----
        // ms-granularity ties at create time are possible. Sleep ~10ms so the
        // bump's `now_ms()` is strictly greater, then post into A: each new
        // Run touches the Thread's `last_activity_at`, making A most-recent.
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

        // ---- thread/list (no params): read until the id:99 response ----
        let list = r#"{"jsonrpc":"2.0","id":99,"method":"thread/list","params":{}}"#;
        ws.send(Message::Text(list.into()))
            .await
            .expect("send thread/list frame");

        // Read bounded frames until the thread/list response (id:99) arrives.
        // (No events stream on this connection — nothing was subscribed — so
        // this resolves on the very next frame; the loop just guards against
        // any stray frame and keeps every read bounded.)
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

        // Newest-first: A ("alpha", bumped) precedes B ("beta").
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
