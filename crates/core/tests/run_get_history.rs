//! `run/get_history` (ADR-0028 as-built) returns the recent-Runs feed: one entry
//! per Run carrying its latest Run Log milestone `kind` verbatim and its Thread
//! title, ordered newest-first. This drives two Runs to `done` through a real
//! Core + slow-worker, then asserts the over-the-wire shape and order; a second
//! test proves a fresh Workspace returns an empty feed.

use std::time::Duration;

use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{Workspace, Ws, next_text};

/// Send a `thread/create` with `prompt`, returning `(run_id, thread_id)`.
async fn create_thread(ws: &mut Ws, id: u32, prompt: &str) -> (String, String) {
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
    let run_id = resp["result"]["run_id"]
        .as_str()
        .unwrap_or_else(|| panic!("result.run_id is a string — body: {body}"))
        .to_string();
    let thread_id = resp["result"]["thread_id"]
        .as_str()
        .unwrap_or_else(|| panic!("result.thread_id is a string — body: {body}"))
        .to_string();
    (run_id, thread_id)
}

/// Subscribe to `run_id` and drain its stream until the terminal `done`. The
/// slow-worker always reaches `done`, writing the run's latest Run Log
/// milestone.
async fn drain_to_done(ws: &mut Ws, sub_id: u32, run_id: &str) {
    let subscribe = format!(
        r#"{{"jsonrpc":"2.0","id":{sub_id},"method":"run/subscribe","params":{{"run_id":"{run_id}"}}}}"#
    );
    ws.send(Message::Text(subscribe.into()))
        .await
        .expect("send subscribe");
    loop {
        let body = next_text(ws).await;
        let v: serde_json::Value = serde_json::from_str(&body).expect("event json");
        match v["params"]["event"]["kind"].as_str() {
            Some("done") => break,
            Some("error") => panic!("run errored unexpectedly: {body}"),
            _ => {}
        }
    }
}

/// Read until the `id:want_id` response, returning that frame (guards stray
/// notification frames).
async fn read_response(ws: &mut Ws, want_id: i64) -> serde_json::Value {
    loop {
        let body = next_text(ws).await;
        let v: serde_json::Value = serde_json::from_str(&body)
            .unwrap_or_else(|e| panic!("frame is JSON: {e} — body: {body}"));
        if v["id"] == serde_json::json!(want_id) {
            break v;
        }
    }
}

#[test]
fn run_get_history_returns_runs_newest_first_with_verbatim_kind() {
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("slow-worker.ts").spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let mut ws = core.connect().await;

        // Run A first (older), then Run B (newer); each driven to `done` so its
        // latest milestone is `done`.
        let (run_a, thread_a) = create_thread(&mut ws, 1, "first run alpha").await;
        drain_to_done(&mut ws, 11, &run_a).await;

        // Sleep so B's `done` milestone created_at is strictly greater than A's,
        // making the newest-first order unambiguous despite ms ties.
        tokio::time::sleep(Duration::from_millis(10)).await;

        let (run_b, thread_b) = create_thread(&mut ws, 2, "second run beta").await;
        drain_to_done(&mut ws, 22, &run_b).await;

        // run/get_history with no params (defaults apply).
        let list = r#"{"jsonrpc":"2.0","id":99,"method":"run/get_history","params":{}}"#;
        ws.send(Message::Text(list.into()))
            .await
            .expect("send run/get_history frame");
        let resp = read_response(&mut ws, 99).await;

        assert!(
            resp.get("error").is_none(),
            "run/get_history is read-only and must not error — body: {resp}"
        );
        assert!(
            resp.get("method").is_none(),
            "run/get_history response is a result, not a notification — body: {resp}"
        );

        let runs = resp["result"]["runs"]
            .as_array()
            .unwrap_or_else(|| panic!("result.runs is an array — body: {resp}"));
        assert_eq!(runs.len(), 2, "exactly two runs — body: {resp}");

        // Newest-first: B precedes A.
        assert_eq!(
            runs[0]["run_id"].as_str(),
            Some(run_b.as_str()),
            "newest run is B — body: {resp}"
        );
        assert_eq!(
            runs[0]["thread_id"].as_str(),
            Some(thread_b.as_str()),
            "B's thread_id — body: {resp}"
        );
        assert_eq!(
            runs[0]["title"].as_str(),
            Some("second run beta"),
            "B's title is its Thread title — body: {resp}"
        );
        assert_eq!(
            runs[0]["kind"].as_str(),
            Some("done"),
            "B's latest milestone kind is verbatim `done` — body: {resp}"
        );
        assert!(
            runs[0]["at"].as_i64().is_some(),
            "at is an integer ms-epoch — body: {resp}"
        );

        assert_eq!(
            runs[1]["run_id"].as_str(),
            Some(run_a.as_str()),
            "older run is A — body: {resp}"
        );
        assert_eq!(
            runs[1]["title"].as_str(),
            Some("first run alpha"),
            "A's title — body: {resp}"
        );
        assert_eq!(
            runs[1]["kind"].as_str(),
            Some("done"),
            "A's latest milestone kind — body: {resp}"
        );

        // The recency key is monotone with the order.
        let at_b = runs[0]["at"].as_i64().unwrap();
        let at_a = runs[1]["at"].as_i64().unwrap();
        assert!(
            at_b >= at_a,
            "runs ordered by latest-milestone created_at DESC ({at_b} >= {at_a}) — body: {resp}"
        );

        ws.close(None).await.ok();
    });
}

#[test]
fn run_get_history_clamps_non_positive_limit_to_the_default() {
    // A `limit` of 0 or negative is a display cap, not a security boundary, and
    // must fall back to the default rather than producing an empty (or backwards)
    // feed — guards the handler's `Some(n) if n > 0 => n, _ => DEFAULT` clamp.
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("slow-worker.ts").spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let mut ws = core.connect().await;

        let (run_a, _t_a) = create_thread(&mut ws, 1, "alpha run").await;
        drain_to_done(&mut ws, 11, &run_a).await;
        let (run_b, _t_b) = create_thread(&mut ws, 2, "beta run").await;
        drain_to_done(&mut ws, 22, &run_b).await;

        for (id, limit) in [(50_i64, 0_i64), (51, -5)] {
            let req = format!(
                r#"{{"jsonrpc":"2.0","id":{id},"method":"run/get_history","params":{{"limit":{limit}}}}}"#
            );
            ws.send(Message::Text(req.into()))
                .await
                .expect("send run/get_history frame");
            let resp = read_response(&mut ws, id).await;
            assert!(
                resp.get("error").is_none(),
                "limit={limit} is clamped to the default, not an error — body: {resp}"
            );
            let runs = resp["result"]["runs"]
                .as_array()
                .unwrap_or_else(|| panic!("result.runs is an array — body: {resp}"));
            assert_eq!(
                runs.len(),
                2,
                "limit={limit} falls back to the default and returns both runs (not LIMIT 0) — body: {resp}"
            );
        }

        ws.close(None).await.ok();
    });
}

#[test]
fn run_get_history_rejects_a_malformed_limit_with_invalid_params() {
    // A present-but-wrong-typed `limit` (a string) is a real `invalid_params`
    // (-32602), not a silent default — guards the handler's decode arm.
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("slow-worker.ts").spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let mut ws = core.connect().await;

        let req = r#"{"jsonrpc":"2.0","id":5,"method":"run/get_history","params":{"limit":"oops"}}"#;
        ws.send(Message::Text(req.into()))
            .await
            .expect("send run/get_history frame");
        let resp = read_response(&mut ws, 5).await;

        assert!(
            resp.get("result").is_none(),
            "a malformed limit carries no result — body: {resp}"
        );
        assert_eq!(
            resp["error"]["code"],
            serde_json::json!(-32602),
            "malformed limit is rejected with invalid_params (-32602) — body: {resp}"
        );

        ws.close(None).await.ok();
    });
}

#[test]
fn run_get_history_accepts_omitted_params() {
    // `run/get_history` with NO `params` member at all: JsonRpcRequest.params
    // defaults to Null, and the handler treats Null as defaults — a successful
    // (non-error) read, not an invalid_params from decoding Null into a struct.
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("slow-worker.ts").spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let mut ws = core.connect().await;

        let req = r#"{"jsonrpc":"2.0","id":6,"method":"run/get_history"}"#;
        ws.send(Message::Text(req.into()))
            .await
            .expect("send run/get_history frame");
        let resp = read_response(&mut ws, 6).await;

        assert!(
            resp.get("error").is_none(),
            "omitted params is treated as defaults, not an error — body: {resp}"
        );
        assert!(
            resp["result"]["runs"].is_array(),
            "result.runs is an array — body: {resp}"
        );

        ws.close(None).await.ok();
    });
}

#[test]
fn run_get_history_is_empty_for_a_fresh_workspace() {
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("slow-worker.ts").spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let mut ws = core.connect().await;

        let list = r#"{"jsonrpc":"2.0","id":7,"method":"run/get_history","params":{}}"#;
        ws.send(Message::Text(list.into()))
            .await
            .expect("send run/get_history frame");
        let resp = read_response(&mut ws, 7).await;

        assert!(
            resp.get("error").is_none(),
            "an empty Workspace is not an error — body: {resp}"
        );
        let runs = resp["result"]["runs"]
            .as_array()
            .unwrap_or_else(|| panic!("result.runs is an array — body: {resp}"));
        assert!(
            runs.is_empty(),
            "a never-run Workspace returns an empty feed — body: {resp}"
        );

        ws.close(None).await.ok();
    });
}
