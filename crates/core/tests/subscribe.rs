//! `run/subscribe(run_id)` is snapshot-then-tail (ADR-0022): the cumulative
//! `text_delta` snapshot, then live tail deltas, then a terminal `done`, with
//! `post_message` carrying no events on its frame.
//!
//! The slow-worker fixture (`INKSTONE_FIXTURE_CHUNKS=2`) emits chunk 1 then
//! blocks on a gate file before chunk 2 + `done`. The test trips the gate
//! after subscribing, so `snapshot ++ tail` must equal `echo: hello` exactly.

use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{Workspace, next_text};

#[test]
fn subscribe_malformed_run_id_is_invalid_params() {
    let workspace = Workspace::new();
    let core = workspace
        .core()
        .worker_fixture("slow-worker.ts")
        .env("INKSTONE_FIXTURE_CHUNKS", "1")
        .env("INKSTONE_FIXTURE_GATE", workspace.path().join("gate"))
        .spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let mut ws = core.connect().await;

        // A malformed run_id must be invalid_params (-32602), not an internal
        // error, like every other method (ADR-0029).
        let sub =
            r#"{"jsonrpc":"2.0","id":9,"method":"run/subscribe","params":{"run_id":"not-a-uuid"}}"#;
        ws.send(Message::Text(sub.into()))
            .await
            .expect("send subscribe");

        let body = next_text(&mut ws).await;
        let v: serde_json::Value = serde_json::from_str(&body).expect("json response");
        assert_eq!(v["id"], serde_json::json!(9), "echoed id");
        assert_eq!(
            v["error"]["code"],
            serde_json::json!(-32602),
            "malformed run_id rejected with invalid_params (-32602) — body: {body}"
        );

        ws.close(None).await.ok();
    });
}

#[test]
fn subscribe_snapshot_then_tail() {
    let workspace = Workspace::new();
    let gate_path = workspace.path().join("gate");
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

    rt.block_on(async {
        let mut ws = core.connect().await;

        // post_message: returns {run_id}, NO events on the frame.
        let post = r#"{"jsonrpc":"2.0","id":1,"method":"thread/create","params":{"prompt":"hello"}}"#;
        ws.send(Message::Text(post.into()))
            .await
            .expect("send post_message frame");

        let response_body = next_text(&mut ws).await;
        let response: serde_json::Value = serde_json::from_str(&response_body)
            .unwrap_or_else(|e| panic!("response is JSON: {e} — body: {response_body}"));
        assert_eq!(response["jsonrpc"], serde_json::json!("2.0"), "jsonrpc");
        assert_eq!(response["id"], serde_json::json!(1), "echoed id");
        // The response frame carries ONLY the result, not a run/event.
        assert!(
            response.get("method").is_none(),
            "post_message response has no method (not a notification) — body: {response_body}"
        );
        assert!(
            response["params"].get("event").is_none(),
            "post_message response carries no event — body: {response_body}"
        );
        let run_id = response["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — body: {response_body}"))
            .to_string();
        let parsed = uuid::Uuid::parse_str(&run_id).expect("run_id parses as UUID");
        assert_eq!(
            parsed.get_version(),
            Some(uuid::Version::SortRand),
            "run_id is UUIDv7"
        );

        // subscribe: response, then snapshot text_delta, then tail.
        let subscribe = format!(
            r#"{{"jsonrpc":"2.0","id":2,"method":"run/subscribe","params":{{"run_id":"{run_id}"}}}}"#
        );
        ws.send(Message::Text(subscribe.into()))
            .await
            .expect("send run/subscribe frame");

        // First frame back is the subscribe RESPONSE.
        let sub_resp_body = next_text(&mut ws).await;
        let sub_resp: serde_json::Value = serde_json::from_str(&sub_resp_body)
            .unwrap_or_else(|e| panic!("subscribe response is JSON: {e} — body: {sub_resp_body}"));
        assert_eq!(sub_resp["id"], serde_json::json!(2), "subscribe response id");
        assert!(
            sub_resp.get("method").is_none(),
            "subscribe response is a response, not a notification — body: {sub_resp_body}"
        );

        // The SNAPSHOT: a cumulative text_delta. Its content may be "" or
        // "echo: " depending on the gate race — do NOT hard-assert it.
        let snapshot_body = next_text(&mut ws).await;
        let snapshot: serde_json::Value = serde_json::from_str(&snapshot_body)
            .unwrap_or_else(|e| panic!("snapshot is JSON: {e} — body: {snapshot_body}"));
        assert_eq!(
            snapshot["method"],
            serde_json::json!("run/event"),
            "snapshot is a run/event — body: {snapshot_body}"
        );
        assert_eq!(
            snapshot["params"]["run_id"],
            serde_json::json!(run_id),
            "snapshot run_id matches"
        );
        assert_eq!(
            snapshot["params"]["event"]["kind"],
            serde_json::json!("text_delta"),
            "snapshot is a text_delta — body: {snapshot_body}"
        );
        let mut assembled = snapshot["params"]["event"]["delta"]
            .as_str()
            .unwrap_or_else(|| panic!("snapshot text_delta carries a string — body: {snapshot_body}"))
            .to_string();

        // Trip the gate so the worker emits chunk 2 + done.
        std::fs::write(&gate_path, b"go").expect("create gate file");

        // Read the tail. The loop only exits via the `done` arm's `break`, so
        // reaching the line after it proves the terminal frame was a `done`.
        loop {
            let body = next_text(&mut ws).await;
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

        ws.close(None).await.ok();

        assert_eq!(
            assembled, "echo: hello",
            "snapshot + tail reassembles to the full echo output exactly once"
        );
    });
}

/// Regression: a `run/subscribe` that attaches at or after a Run's terminal
/// `done` must still receive a `done` and never hang. The bug was a subscribe
/// landing after `Done` was broadcast but before the hub entry was removed: it
/// took the streaming branch and `tx.subscribe()`d past the (non-replayed)
/// `Done`, blocking forever. Fix: the forwarder synthesizes a `done` on channel
/// close if it never forwarded one.
///
/// Bounding: A drains to `done` (proving it was published), then a pre-opened B
/// subscribes the instant that `done` is observed — landing in the race window.
/// Every read is timeout-bounded, so a regression fails fast as a timeout.
#[test]
fn late_subscribe_after_terminal_still_gets_done() {
    let workspace = Workspace::new();
    // chunks=1: emit the sole chunk, block on the gate, then emit `done` —
    // tripping the gate gives a controlled "done published" instant.
    let gate_path = workspace.path().join("gate");

    let core = workspace
        .core()
        .worker_fixture("slow-worker.ts")
        .env("INKSTONE_FIXTURE_CHUNKS", "1")
        .env("INKSTONE_FIXTURE_GATE", &gate_path)
        .spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        // A: post + first subscribe, drained to done.
        let mut ws_a = core.connect().await;

        // B: pre-open so there is no setup latency before the late subscribe,
        // maximizing the chance of landing in the race window.
        let mut ws_b = core.connect().await;

        let post = r#"{"jsonrpc":"2.0","id":1,"method":"thread/create","params":{"prompt":"hello"}}"#;
        ws_a.send(Message::Text(post.into()))
            .await
            .expect("send post_message frame");
        let response_body = next_text(&mut ws_a).await;
        let response: serde_json::Value = serde_json::from_str(&response_body)
            .unwrap_or_else(|e| panic!("response is JSON: {e} — body: {response_body}"));
        let run_id = response["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — body: {response_body}"))
            .to_string();

        // First subscribe on A, then trip the gate so the Worker publishes `done`.
        let subscribe_a = format!(
            r#"{{"jsonrpc":"2.0","id":2,"method":"run/subscribe","params":{{"run_id":"{run_id}"}}}}"#
        );
        ws_a.send(Message::Text(subscribe_a.into()))
            .await
            .expect("send subscribe A frame");
        let _sub_a_resp = next_text(&mut ws_a).await; // subscribe response
        let _snapshot_a = next_text(&mut ws_a).await; // snapshot text_delta

        std::fs::write(&gate_path, b"go").expect("create gate file");

        // Drain A to its terminal done — this proves the Worker published it.
        loop {
            let body = next_text(&mut ws_a).await;
            let v: serde_json::Value = serde_json::from_str(&body)
                .unwrap_or_else(|e| panic!("A tail frame is JSON: {e} — body: {body}"));
            if v["params"]["event"]["kind"] == serde_json::json!("done") {
                break;
            }
        }

        // The instant A's done is observed, issue B's late subscribe: the
        // Worker is mid terminal tx (hub not yet removed), so B may attach
        // AFTER the broadcast `Done` — the exact race the fix closes.
        let subscribe_b = format!(
            r#"{{"jsonrpc":"2.0","id":3,"method":"run/subscribe","params":{{"run_id":"{run_id}"}}}}"#
        );
        ws_b.send(Message::Text(subscribe_b.into()))
            .await
            .expect("send subscribe B frame");

        // B's subscribe response.
        let sub_b_resp_body = next_text(&mut ws_b).await;
        let sub_b_resp: serde_json::Value = serde_json::from_str(&sub_b_resp_body)
            .unwrap_or_else(|e| panic!("B subscribe response is JSON: {e} — body: {sub_b_resp_body}"));
        assert_eq!(sub_b_resp["id"], serde_json::json!(3), "B subscribe response id");

        // B must receive a snapshot text_delta then a terminal done within the
        // timeout, never hang. The loop only exits via the `done` arm's
        // `break`, so reaching the line after it proves a `done` was delivered.
        let mut assembled = String::new();
        loop {
            let body = next_text(&mut ws_b).await;
            let v: serde_json::Value = serde_json::from_str(&body)
                .unwrap_or_else(|e| panic!("B frame is JSON: {e} — body: {body}"));
            assert_eq!(
                v["method"],
                serde_json::json!("run/event"),
                "B frame is a run/event — body: {body}"
            );
            match v["params"]["event"]["kind"].as_str() {
                Some("text_delta") => {
                    assembled.push_str(
                        v["params"]["event"]["delta"]
                            .as_str()
                            .unwrap_or_else(|| panic!("B text_delta carries a string — body: {body}")),
                    );
                }
                Some("done") => break,
                other => panic!("unexpected B event kind {other:?} — body: {body}"),
            }
        }

        ws_a.close(None).await.ok();
        ws_b.close(None).await.ok();

        assert_eq!(
            assembled, "echo: hello",
            "late subscriber's snapshot reassembles to the full echo output"
        );
    });
}
