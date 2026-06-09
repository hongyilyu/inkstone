//! Slice 3 RED test: a `text_delta` Run Event from the Worker is appended
//! to the assistant `message_parts.text` row inside a `messages` row with
//! `role='assistant'`, `status='streaming'`, BEFORE Core forwards the WS
//! `run/event` Notification — so a test that observes the WS frame can
//! immediately query the DB and see the same delta committed.

use futures_util::SinkExt;
use sqlx::Row;
use sqlx::sqlite::SqlitePoolOptions;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{Workspace, next_text};

#[test]
fn text_delta_appends_to_message_parts() {
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("slow-worker.ts").spawn();

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
        // Pure-subscribe (ADR-0022): no events on the post_message response.
        assert!(
            response["params"].get("event").is_none(),
            "post_message response carries no event — body: {response_body}"
        );

        // Subscribe by run_id, then drain the snapshot + tail until done.
        let subscribe = format!(
            r#"{{"jsonrpc":"2.0","id":2,"method":"run/subscribe","params":{{"run_id":"{run_id}"}}}}"#
        );
        ws.send(Message::Text(subscribe.into()))
            .await
            .expect("send subscribe frame");

        let _sub_response = next_text(&mut ws).await;

        let mut assembled = String::new();
        // The loop only exits via the `done` arm's `break`; every other path
        // panics, so reaching the line after it proves the terminal frame was
        // a `done`.
        loop {
            let body = next_text(&mut ws).await;
            let v: serde_json::Value = serde_json::from_str(&body)
                .unwrap_or_else(|e| panic!("event is JSON: {e} — body: {body}"));
            assert_eq!(
                v["method"],
                serde_json::json!("run/event"),
                "frame is a run/event — body: {body}"
            );
            match v["params"]["event"]["kind"].as_str() {
                Some("text_delta") => {
                    assembled.push_str(
                        v["params"]["event"]["delta"]
                            .as_str()
                            .unwrap_or_else(|| panic!("text_delta carries a string — body: {body}")),
                    );
                }
                Some("done") => break,
                other => panic!("unexpected event kind {other:?} — body: {body}"),
            }
        }
        // snapshot + tail reassembles to the full echo output.
        assert_eq!(assembled, "echo: hi", "reassembled stream is 'echo: hi'");

        ws.close(None).await.ok();

        run_id
    });

    drop(core);

    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        // Assistant message ------------------------------------------------
        let assistant_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE role='assistant'")
                .fetch_one(&pool)
                .await
                .expect("count assistant messages");
        assert_eq!(assistant_count, 1, "exactly one assistant message");

        let assistant_row =
            sqlx::query("SELECT id, status FROM messages WHERE role='assistant'")
                .fetch_one(&pool)
                .await
                .expect("read assistant message");
        let assistant_message_id: String = assistant_row.get("id");
        let status: String = assistant_row.get("status");
        // slice 4: Core may finish the terminal tx before the test kills it, flipping
        // assistant status='streaming' → 'completed'; both states are acceptable here.
        assert!(
            matches!(status.as_str(), "streaming" | "completed"),
            "assistant status is 'streaming' or 'completed' (slice-4 race), got {status:?}"
        );

        // Assistant message_parts ------------------------------------------
        let parts = sqlx::query(
            "SELECT seq, type, text FROM message_parts WHERE message_id = ?1 ORDER BY seq",
        )
        .bind(&assistant_message_id)
        .fetch_all(&pool)
        .await
        .expect("read assistant message_parts");
        assert_eq!(parts.len(), 1, "exactly one assistant message_part");
        let p = &parts[0];
        let seq: i64 = p.get("seq");
        assert_eq!(seq, 0);
        let ptype: String = p.get("type");
        assert_eq!(ptype, "text");
        let ptext: String = p.get("text");
        assert_eq!(ptext, "echo: hi", "delta appended to message_parts.text");

        // User message id (for run_steps[seq=0] cross-check) ---------------
        let user_message_id: String =
            sqlx::query_scalar("SELECT id FROM messages WHERE role='user'")
                .fetch_one(&pool)
                .await
                .expect("read user message id");

        // Run steps --------------------------------------------------------
        let steps = sqlx::query(
            "SELECT seq, kind, message_id FROM run_steps WHERE run_id = ?1 ORDER BY seq",
        )
        .bind(&run_id)
        .fetch_all(&pool)
        .await
        .expect("read run_steps for run");
        assert!(
            steps.len() >= 2,
            "at least two run_steps (user + assistant), got {}",
            steps.len()
        );
        let s0 = &steps[0];
        let s0_seq: i64 = s0.get("seq");
        let s0_kind: String = s0.get("kind");
        let s0_msg: Option<String> = s0.get("message_id");
        assert_eq!(s0_seq, 0);
        assert_eq!(s0_kind, "message");
        assert_eq!(s0_msg.as_deref(), Some(user_message_id.as_str()));
        let s1 = &steps[1];
        let s1_seq: i64 = s1.get("seq");
        let s1_kind: String = s1.get("kind");
        let s1_msg: Option<String> = s1.get("message_id");
        assert_eq!(s1_seq, 1);
        assert_eq!(s1_kind, "message");
        assert_eq!(s1_msg.as_deref(), Some(assistant_message_id.as_str()));
    });
}
