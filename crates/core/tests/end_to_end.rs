use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{next_text, rt, Workspace};

#[test]
fn end_to_end_post_message_streams_text_delta_then_done() {
    let workspace = Workspace::new();

    // The echo-shaped assertions ride the slow-worker fixture, which reads the
    // manifest's `.prompt` and emits `echo: <prompt>` — the deterministic
    // stand-in (ADR-0019). Real providers are manual smoke.
    let core = workspace.core().worker_fixture("slow-worker.ts").spawn();

    let rt = rt();

    let outcome = rt.block_on(async {
        let mut ws = core.connect().await;

        let request =
            r#"{"jsonrpc":"2.0","id":1,"method":"thread/create","params":{"prompt":"hello"}}"#;
        ws.send(Message::Text(request.into()))
            .await
            .expect("send request frame");

        // Pure-subscribe (ADR-0022): post_message returns {run_id} only; read
        // the response, then subscribe and reassemble the snapshot + tail.
        let response = next_text(&mut ws).await;

        let resp_v: serde_json::Value = serde_json::from_str(&response)
            .unwrap_or_else(|e| panic!("response is JSON: {e} — body: {response}"));
        let run_id = resp_v["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — body: {response}"))
            .to_string();

        let subscribe = format!(
            r#"{{"jsonrpc":"2.0","id":2,"method":"run/subscribe","params":{{"run_id":"{run_id}"}}}}"#
        );
        ws.send(Message::Text(subscribe.into()))
            .await
            .expect("send subscribe frame");

        let sub_response = next_text(&mut ws).await;

        // Drain run/event notifications until done; reassemble the text.
        let mut events = Vec::new();
        loop {
            let body = next_text(&mut ws).await;
            let v: serde_json::Value = serde_json::from_str(&body)
                .unwrap_or_else(|e| panic!("event is JSON: {e} — body: {body}"));
            let is_done = v["params"]["event"]["kind"] == serde_json::json!("done");
            events.push(body);
            if is_done {
                break;
            }
        }

        ws.close(None).await.ok();
        (response, sub_response, run_id, events)
    });

    drop(core);

    let (response_body, sub_response_body, run_id, event_bodies) = outcome;

    let response: serde_json::Value = serde_json::from_str(&response_body)
        .unwrap_or_else(|e| panic!("response is JSON: {e} — body: {response_body}"));
    assert_eq!(response["jsonrpc"], serde_json::json!("2.0"), "jsonrpc");
    assert_eq!(response["id"], serde_json::json!(1), "echoed id");
    // The post_message response frame is NOT a run/event notification and
    // carries no events.
    assert!(
        response.get("method").is_none(),
        "post_message response is not a notification — body: {response_body}"
    );
    assert!(
        response["params"].get("event").is_none(),
        "post_message response carries no event — body: {response_body}"
    );
    let parsed = uuid::Uuid::parse_str(&run_id).expect("run_id parses as UUID");
    assert_eq!(
        parsed.get_version(),
        Some(uuid::Version::SortRand),
        "run_id is UUIDv7"
    );

    // The subscribe request resolves with its own response frame.
    let sub_response: serde_json::Value = serde_json::from_str(&sub_response_body)
        .unwrap_or_else(|e| panic!("subscribe response is JSON: {e} — body: {sub_response_body}"));
    assert_eq!(sub_response["id"], serde_json::json!(2), "subscribe id");
    assert!(
        sub_response.get("method").is_none(),
        "subscribe response is a response, not a notification — body: {sub_response_body}"
    );

    // Every event arrives as a run/event for this run_id. Reassemble the
    // snapshot + tail text and assert it equals the full echo output, and
    // that the terminal frame is done.
    let mut assembled = String::new();
    let mut saw_done = false;
    for body in &event_bodies {
        let v: serde_json::Value = serde_json::from_str(body)
            .unwrap_or_else(|e| panic!("event is JSON: {e} — body: {body}"));
        assert_eq!(v["jsonrpc"], serde_json::json!("2.0"), "event jsonrpc");
        assert_eq!(
            v["method"],
            serde_json::json!("run/event"),
            "event method — body: {body}"
        );
        assert_eq!(
            v["params"]["run_id"],
            serde_json::json!(run_id),
            "event run_id matches — body: {body}"
        );
        match v["params"]["event"]["kind"].as_str() {
            Some("text_delta") => {
                assembled.push_str(
                    v["params"]["event"]["delta"]
                        .as_str()
                        .unwrap_or_else(|| panic!("text_delta carries a string — body: {body}")),
                );
            }
            Some("done") => saw_done = true,
            other => panic!("unexpected event kind {other:?} — body: {body}"),
        }
    }
    assert!(saw_done, "terminal frame is done");
    assert_eq!(
        assembled, "echo: hello",
        "snapshot + tail reassembles to the echo output"
    );
}
