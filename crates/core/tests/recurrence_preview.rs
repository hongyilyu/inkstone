//! `recurrence/preview` (ADR-0039 amendment, #227): a read-only RPC that takes a
//! draft Recurrence Rule + the current `defer_at`/`due_at` and returns the next
//! occurrence's dates, reusing Core's pure `next_occurrence` date math. The
//! handler is pure (no DB, no worker), so these tests drive Core directly over
//! the WS and assert the over-the-wire shape: a continuing series returns
//! `ended:false` + the advanced dates; a terminated series (or a malformed draft
//! rule) returns `ended:true` and is never a JSON-RPC error.

use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{Workspace, Ws, next_text};

/// Read until the `id:want_id` response frame (guards stray notifications).
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

/// Send a `recurrence/preview` request with the given params object, returning
/// the response frame.
async fn preview(ws: &mut Ws, id: i64, params: serde_json::Value) -> serde_json::Value {
    let req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "recurrence/preview",
        "params": params,
    });
    ws.send(Message::Text(req.to_string().into()))
        .await
        .expect("send recurrence/preview frame");
    read_response(ws, id).await
}

#[test]
fn recurrence_preview_returns_the_next_occurrence_for_a_continuing_series() {
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("slow-worker.ts").spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let mut ws = core.connect().await;

        // Weekly, anchored to defer; defer present, due absent → next defer is
        // exactly one week later; due stays absent.
        let resp = preview(
            &mut ws,
            1,
            serde_json::json!({
                "recurrence": { "interval": 1, "unit": "week", "anchor": "defer_at" },
                "defer_at": "2026-07-01T00:00:00",
            }),
        )
        .await;

        assert!(
            resp.get("error").is_none(),
            "a valid continuing series is read-only, not an error — body: {resp}"
        );
        assert_eq!(
            resp["result"]["ended"],
            serde_json::json!(false),
            "the series continues — body: {resp}"
        );
        assert_eq!(
            resp["result"]["defer_at"].as_str(),
            Some("2026-07-08T00:00:00"),
            "next defer is one week later — body: {resp}"
        );
        assert!(
            resp["result"]["due_at"].is_null(),
            "due was absent, so the next due is absent — body: {resp}"
        );

        ws.close(None).await.ok();
    });
}

#[test]
fn recurrence_preview_reports_ended_when_after_count_is_one() {
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("slow-worker.ts").spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let mut ws = core.connect().await;

        // after_count: 1 means THIS is the last occurrence → no successor.
        let resp = preview(
            &mut ws,
            2,
            serde_json::json!({
                "recurrence": {
                    "interval": 1,
                    "unit": "week",
                    "anchor": "defer_at",
                    "end": { "after_count": 1 },
                },
                "defer_at": "2026-07-01T00:00:00",
            }),
        )
        .await;

        assert!(
            resp.get("error").is_none(),
            "a terminated series is a normal result, not an error — body: {resp}"
        );
        assert_eq!(
            resp["result"]["ended"],
            serde_json::json!(true),
            "after_count 1 ends the series — body: {resp}"
        );
        assert!(
            resp["result"]["defer_at"].is_null(),
            "an ended series carries no next defer — body: {resp}"
        );

        ws.close(None).await.ok();
    });
}

#[test]
fn recurrence_preview_reports_ended_past_the_until_bound() {
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("slow-worker.ts").spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let mut ws = core.connect().await;

        // The next anchor (2026-07-08) is strictly after `until` (2026-07-05),
        // so the series has ended.
        let resp = preview(
            &mut ws,
            3,
            serde_json::json!({
                "recurrence": {
                    "interval": 1,
                    "unit": "week",
                    "anchor": "defer_at",
                    "end": { "until": "2026-07-05T00:00:00" },
                },
                "defer_at": "2026-07-01T00:00:00",
            }),
        )
        .await;

        assert!(resp.get("error").is_none(), "not an error — body: {resp}");
        assert_eq!(
            resp["result"]["ended"],
            serde_json::json!(true),
            "next anchor strictly past until ends the series — body: {resp}"
        );

        ws.close(None).await.ok();
    });
}

#[test]
fn recurrence_preview_treats_a_malformed_draft_rule_as_ended_not_an_error() {
    // The editor sends an in-progress draft; a partial rule (no unit) must not
    // error — `next_occurrence` is fail-safe (returns None), surfaced as ended.
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("slow-worker.ts").spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let mut ws = core.connect().await;

        let resp = preview(
            &mut ws,
            4,
            serde_json::json!({
                "recurrence": { "interval": 1, "anchor": "defer_at" },
                "defer_at": "2026-07-01T00:00:00",
            }),
        )
        .await;

        assert!(
            resp.get("error").is_none(),
            "a partial draft rule is fail-safe (ended), not invalid_params — body: {resp}"
        );
        assert_eq!(
            resp["result"]["ended"],
            serde_json::json!(true),
            "a malformed rule yields no successor → ended — body: {resp}"
        );

        ws.close(None).await.ok();
    });
}
