//! The correlation chain's final link (ADR-0036, slice 6): when Core spawns a
//! Worker for a Run, it passes the Run's `run_id` to the child as the
//! `INKSTONE_RUN_ID` spawn-time env var. Slice 5 made the Worker READ that var
//! to stamp its `worker.jsonl` lines; this proves Core SETS it to the true
//! run_id, so a real Worker's `worker.jsonl` joins to `core.jsonl` by run.
//!
//! Mechanism (A) FILE ECHO: the `run-id-echo-worker.ts` fixture writes whatever
//! Core put in `INKSTONE_RUN_ID` to a sink file (path passed via
//! `INKSTONE_TEST_RUNID_SINK`), then drives the Run to `done`. The test captures
//! the Run's `run_id` from the `thread/create` response, drives the Run to
//! `done`, kills Core, reads the sink, and asserts its trimmed contents EQUAL
//! the Run's run_id and are non-empty. Before child.rs sets the env var the
//! fixture writes "" (RED); once set, the echoed value matches (GREEN).
//!
//! Reads the sink *after* `core.kill()`: the fixture writes it before the
//! terminal `done`, and the Workspace TempDir outlives Core (mirrors
//! `worker_logging.rs`'s read-after-kill).

use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{Workspace, fixture_cmd, next_text};

#[test]
fn worker_child_receives_run_id_env() {
    let workspace = Workspace::new();
    let sink_path = workspace.path().join("runid-sink");
    let core = workspace
        .core()
        .worker_cmd(fixture_cmd("run-id-echo-worker.ts", &[]))
        .env("INKSTONE_TEST_RUNID_SINK", &sink_path)
        .spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

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

        let subscribe = format!(
            r#"{{"jsonrpc":"2.0","id":2,"method":"run/subscribe","params":{{"run_id":"{run_id}"}}}}"#
        );
        ws.send(Message::Text(subscribe.into()))
            .await
            .expect("send subscribe frame");
        let _sub_response = next_text(&mut ws).await;

        // Drive the Run to `done`. The fixture writes the sink BEFORE it reads
        // stdin and emits `done`, so reaching `done` is a barrier guaranteeing
        // the sink was written.
        loop {
            let body = next_text(&mut ws).await;
            let v: serde_json::Value = serde_json::from_str(&body)
                .unwrap_or_else(|e| panic!("event is JSON: {e} — body: {body}"));
            if v["params"]["event"]["kind"].as_str() == Some("done") {
                break;
            }
        }

        ws.close(None).await.ok();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        run_id
    });

    // SIGKILL + reap; the fixture already wrote the sink before `done`.
    drop(core);

    let echoed = std::fs::read_to_string(&sink_path)
        .unwrap_or_else(|e| panic!("read sink {}: {e}", sink_path.display()));
    let echoed = echoed.trim();
    assert!(
        !echoed.is_empty(),
        "worker child received a NON-EMPTY INKSTONE_RUN_ID — sink was {echoed:?}"
    );
    assert_eq!(
        echoed, run_id,
        "the worker child's INKSTONE_RUN_ID equals the Run's run_id (joinable to core.jsonl)"
    );
}
