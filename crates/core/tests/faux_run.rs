//! Slice 4 (real-worker-codex): the Core cutover. Core spawns the generic
//! `pi-agent-core` interpreter (the test-only faux entry
//! packages/worker/src/faux-worker.ts) with a manifest
//! on stdin, and a real agent-loop Run streams a completion back through the
//! hub end-to-end. Determinism comes from pi-ai's `faux` provider
//! (ADR-0019 as-built): the workflow declares `provider="faux"` and the
//! canned response rides `INKSTONE_FAUX_RESPONSE`, inherited Core → Worker.
//!
//! This proves the interpreter path (manifest parse → runAgentLoop tools=[]
//! → message_update/text_delta → done) without touching a real provider.

use std::path::Path;

use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{Workspace, next_text};

/// Write a faux workflow into a fixture dir so the interpreter takes the
/// offline faux path (provider="faux").
fn write_faux_workflow(dir: &Path) {
    std::fs::create_dir_all(dir).expect("create workflows dir");
    std::fs::write(
        dir.join("default.toml"),
        r#"
name = "default"
version = "1.0.0"
provider = "faux"
model = "faux-1"
thinking_level = "off"
system_prompt = "You are a test assistant."
tools = []
"#,
    )
    .expect("write faux default.toml");
}

#[test]
fn faux_completion_streams_through_core() {
    let workspace = Workspace::new();
    let workflows_dir = workspace.path().join("workflows");
    write_faux_workflow(&workflows_dir);
    let faux_response = "hello from faux";

    let core = workspace
        .core()
        .worker_faux()
        .env("INKSTONE_WORKFLOWS_DIR", &workflows_dir)
        // Inherited by the spawned Worker; the faux provider replies with it.
        .env("INKSTONE_FAUX_RESPONSE", faux_response)
        .spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let assembled = rt.block_on(async {
        let mut ws = core.connect().await;

        let request =
            r#"{"jsonrpc":"2.0","id":1,"method":"thread/create","params":{"prompt":"hi there"}}"#;
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

        // Reassemble text_delta payloads until the terminal done. The loop
        // exits only via the done arm; an error event fails the test.
        let mut assembled = String::new();
        loop {
            let body = next_text(&mut ws).await;
            let v: serde_json::Value = serde_json::from_str(&body)
                .unwrap_or_else(|e| panic!("event is JSON: {e} — body: {body}"));
            match v["params"]["event"]["kind"].as_str() {
                Some("text_delta") => {
                    assembled.push_str(
                        v["params"]["event"]["delta"]
                            .as_str()
                            .unwrap_or_else(|| panic!("text_delta carries a string — body: {body}")),
                    );
                }
                Some("done") => break,
                Some("error") => {
                    panic!("faux run errored unexpectedly — body: {body}");
                }
                other => panic!("unexpected event kind {other:?} — body: {body}"),
            }
        }

        ws.close(None).await.ok();
        assembled
    });

    // The snapshot rides as the first text_delta (cumulative), and the faux
    // provider streams the response in token chunks; either way the
    // reassembled text equals the canned faux response.
    assert_eq!(
        assembled, faux_response,
        "reassembled stream equals the faux provider's response"
    );
}
