//! Slice 5 RED test: after Core handles a message and exits cleanly,
//! restarting Core against the same DB file finds the prior Thread, Run, and
//! Messages intact and starts cleanly (migration is a no-op the second time).
//!
//! This is a cross-restart durability check. Slices 1–4 already realize each
//! individual write; slice 5 proves they survive process exit and re-open.

use std::time::Duration;

use futures_util::SinkExt;
use sqlx::Row;
use sqlx::sqlite::SqlitePoolOptions;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{Workspace, next_text};

#[test]
fn run_history_survives_restart() {
    let workspace = Workspace::new();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    // ---- First Core spawn: post a message, await done, kill Core ----
    let run_id = {
        let mut core = workspace.core().worker_fixture("slow-worker.ts").spawn();

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

            // Pure-subscribe (ADR-0022): post_message returns {run_id} only;
            // subscribe by run_id and read until the terminal done.
            let subscribe = format!(
                r#"{{"jsonrpc":"2.0","id":2,"method":"run/subscribe","params":{{"run_id":"{run_id}"}}}}"#
            );
            ws.send(Message::Text(subscribe.into()))
                .await
                .expect("send subscribe frame");

            let _sub_response = next_text(&mut ws).await;

            // The loop only exits via the `done` arm's `break`; reaching the
            // line after it proves the subscribe stream ended with a `done`.
            loop {
                let body = next_text(&mut ws).await;
                let v: serde_json::Value = serde_json::from_str(&body)
                    .unwrap_or_else(|e| panic!("event is JSON: {e} — body: {body}"));
                if v["params"]["event"]["kind"] == serde_json::json!("done") {
                    break;
                }
            }

            ws.close(None).await.ok();
            // Slice-4 ordering: terminal tx commits in Core's per-Run task
            // after the worker child reports stdout EOF. Sleep so the commit
            // lands before we kill Core.
            tokio::time::sleep(Duration::from_millis(200)).await;

            run_id
        });

        core.kill();
        run_id
    };

    // ---- Second Core spawn: prove migration is a no-op, then exit ----
    {
        let mut core = workspace.core().worker_fixture("slow-worker.ts").spawn();
        // The mere fact that spawn returned means INKSTONE_LISTENING was
        // emitted, which means `sqlx::migrate!()` succeeded against the
        // already-migrated DB. Nothing else to do here.
        core.kill();
    }

    // ---- Assert against the on-disk DB via a fresh read-only pool ----
    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        // threads ------------------------------------------------------
        let thread_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM threads")
            .fetch_one(&pool)
            .await
            .expect("count threads");
        assert_eq!(thread_count, 1, "exactly one thread row");

        // runs ---------------------------------------------------------
        let run_row = sqlx::query(
            "SELECT id, status, terminal_reason, ended_at FROM runs",
        )
        .fetch_one(&pool)
        .await
        .expect("read run row");
        let id_from_db: String = run_row.get("id");
        assert_eq!(id_from_db, run_id, "runs.id matches the run_id from the WS response");
        let status: String = run_row.get("status");
        assert_eq!(status, "completed", "runs.status='completed' survived restart");
        let terminal_reason: Option<String> = run_row.get("terminal_reason");
        assert_eq!(
            terminal_reason.as_deref(),
            Some("completed"),
            "terminal_reason='completed' survived restart"
        );
        let ended_at: Option<i64> = run_row.get("ended_at");
        assert!(ended_at.is_some(), "ended_at is set");

        // messages -----------------------------------------------------
        let msg_rows = sqlx::query(
            "SELECT id, role, status FROM messages WHERE run_id = ?1 ORDER BY created_at",
        )
        .bind(&run_id)
        .fetch_all(&pool)
        .await
        .expect("read message rows");
        assert_eq!(msg_rows.len(), 2, "exactly two messages for the run");

        let user_id: String = msg_rows[0].get("id");
        let user_role: String = msg_rows[0].get("role");
        let user_status: String = msg_rows[0].get("status");
        assert_eq!(user_role, "user", "first message is the user prompt");
        assert_eq!(user_status, "completed", "user message status='completed'");

        let assistant_id: String = msg_rows[1].get("id");
        let assistant_role: String = msg_rows[1].get("role");
        let assistant_status: String = msg_rows[1].get("status");
        assert_eq!(assistant_role, "assistant", "second message is the assistant reply");
        assert_eq!(
            assistant_status, "completed",
            "assistant message status='completed' survived restart"
        );

        // message_parts ------------------------------------------------
        let user_parts = sqlx::query(
            "SELECT seq, type, text FROM message_parts WHERE message_id = ?1 ORDER BY seq",
        )
        .bind(&user_id)
        .fetch_all(&pool)
        .await
        .expect("read user message_parts");
        assert_eq!(user_parts.len(), 1, "user message has exactly one part");
        let user_seq: i64 = user_parts[0].get("seq");
        let user_type: String = user_parts[0].get("type");
        let user_text: Option<String> = user_parts[0].get("text");
        assert_eq!(user_seq, 0);
        assert_eq!(user_type, "text");
        assert_eq!(user_text.as_deref(), Some("hi"));

        let asst_parts = sqlx::query(
            "SELECT seq, type, text FROM message_parts WHERE message_id = ?1 ORDER BY seq",
        )
        .bind(&assistant_id)
        .fetch_all(&pool)
        .await
        .expect("read assistant message_parts");
        assert_eq!(asst_parts.len(), 1, "assistant message has exactly one part");
        let asst_seq: i64 = asst_parts[0].get("seq");
        let asst_type: String = asst_parts[0].get("type");
        let asst_text: Option<String> = asst_parts[0].get("text");
        assert_eq!(asst_seq, 0);
        assert_eq!(asst_type, "text");
        assert_eq!(asst_text.as_deref(), Some("echo: hi"));

        // run_log ------------------------------------------------------
        let event_kinds: Vec<String> = sqlx::query_scalar(
            "SELECT kind FROM run_log WHERE run_id = ?1 ORDER BY run_seq",
        )
        .bind(&run_id)
        .fetch_all(&pool)
        .await
        .expect("read run_log");
        assert!(
            event_kinds.len() >= 2,
            "at least two run_log rows: running (slice 2) + done (slice 4); got {event_kinds:?}"
        );
        assert_eq!(
            event_kinds.first().map(String::as_str),
            Some("running"),
            "first run_log row is the slice-2 running row"
        );
        assert_eq!(
            event_kinds.last().map(String::as_str),
            Some("done"),
            "last run_event is the slice-4 terminal done row"
        );
    });
}
