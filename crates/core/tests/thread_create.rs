//! `thread/create({prompt})` with a non-empty prompt mints a Thread, starts its
//! first Run, and returns `{thread_id, run_id}`, persisting one Thread (with a
//! derived title), one Run, and the user Message + text part (ADR-0022). A
//! whitespace-only prompt is rejected with `invalid_params` (-32602) before any
//! row is written.

use futures_util::SinkExt;
use sqlx::sqlite::SqlitePoolOptions;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{Workspace, next_text};

#[test]
fn thread_create_mints_thread_and_first_message() {
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("slow-worker.ts").spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let (thread_id, run_id) = rt.block_on(async {
        let mut ws = core.connect().await;

        let create =
            r#"{"jsonrpc":"2.0","id":1,"method":"thread/create","params":{"prompt":"hi"}}"#;
        ws.send(Message::Text(create.into()))
            .await
            .expect("send thread/create frame");

        let response_body = next_text(&mut ws).await;
        let response: serde_json::Value = serde_json::from_str(&response_body)
            .unwrap_or_else(|e| panic!("response is JSON: {e} — body: {response_body}"));
        assert_eq!(response["jsonrpc"], serde_json::json!("2.0"), "jsonrpc");
        assert_eq!(response["id"], serde_json::json!(1), "echoed id");
        // Pure-subscribe: the response is a result, not a notification.
        assert!(
            response.get("method").is_none(),
            "thread/create response has no method — body: {response_body}"
        );
        assert!(
            response.get("error").is_none(),
            "thread/create with a real prompt is not an error — body: {response_body}"
        );

        let thread_id = response["result"]["thread_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.thread_id is a string — body: {response_body}"))
            .to_string();
        let run_id = response["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — body: {response_body}"))
            .to_string();

        let parsed_thread = uuid::Uuid::parse_str(&thread_id).expect("thread_id parses as UUID");
        assert_eq!(
            parsed_thread.get_version(),
            Some(uuid::Version::SortRand),
            "thread_id is UUIDv7"
        );
        let parsed_run = uuid::Uuid::parse_str(&run_id).expect("run_id parses as UUID");
        assert_eq!(
            parsed_run.get_version(),
            Some(uuid::Version::SortRand),
            "run_id is UUIDv7"
        );

        // Drain the run to `done` so the Worker finishes cleanly before we
        // kill Core.
        let subscribe = format!(
            r#"{{"jsonrpc":"2.0","id":2,"method":"run/subscribe","params":{{"run_id":"{run_id}"}}}}"#
        );
        ws.send(Message::Text(subscribe.into()))
            .await
            .expect("send run/subscribe frame");
        let _sub_resp = next_text(&mut ws).await;
        loop {
            let body = next_text(&mut ws).await;
            let v: serde_json::Value = serde_json::from_str(&body)
                .unwrap_or_else(|e| panic!("tail frame is JSON: {e} — body: {body}"));
            if v["params"]["event"]["kind"] == serde_json::json!("done") {
                break;
            }
        }

        ws.close(None).await.ok();
        (thread_id, run_id)
    });

    drop(core);

    // Open the DB read-only and assert the persisted rows.
    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        // Threads: exactly one, with a non-empty derived title. ----------
        let thread_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM threads")
            .fetch_one(&pool)
            .await
            .expect("count threads");
        assert_eq!(thread_count, 1, "exactly one thread row");
        let (db_thread_id, title): (String, String) =
            sqlx::query_as("SELECT id, title FROM threads")
                .fetch_one(&pool)
                .await
                .expect("read thread row");
        assert_eq!(db_thread_id, thread_id, "threads.id matches returned thread_id");
        assert!(!title.is_empty(), "thread title is non-empty (derived from the prompt)");

        // Runs: exactly one, carrying the returned thread_id. -------------
        let run_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM runs")
            .fetch_one(&pool)
            .await
            .expect("count runs");
        assert_eq!(run_count, 1, "exactly one run row");
        let (db_run_id, db_run_thread_id): (String, String) =
            sqlx::query_as("SELECT id, thread_id FROM runs")
                .fetch_one(&pool)
                .await
                .expect("read run row");
        assert_eq!(db_run_id, run_id, "runs.id matches returned run_id");
        assert_eq!(
            db_run_thread_id, thread_id,
            "runs.thread_id matches returned thread_id"
        );

        // User message: exactly one, seq=0 text part == "hi". ------------
        let user_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE role='user'")
                .fetch_one(&pool)
                .await
                .expect("count user messages");
        assert_eq!(user_count, 1, "exactly one user message");
        let user_msg_id: String =
            sqlx::query_scalar("SELECT id FROM messages WHERE role='user'")
                .fetch_one(&pool)
                .await
                .expect("read user message id");
        let part_text: String = sqlx::query_scalar(
            "SELECT text FROM message_parts WHERE message_id = ?1 AND seq = 0",
        )
        .bind(&user_msg_id)
        .fetch_one(&pool)
        .await
        .expect("read user message_part seq=0");
        assert_eq!(part_text, "hi", "user message seq=0 text part is the prompt");
    });
}

#[test]
fn thread_create_empty_prompt_rejected() {
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("slow-worker.ts").spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let mut ws = core.connect().await;

        // Whitespace-only prompt: rejected with invalid_params (-32602) before
        // any row is written.
        let create =
            r#"{"jsonrpc":"2.0","id":2,"method":"thread/create","params":{"prompt":"   "}}"#;
        ws.send(Message::Text(create.into()))
            .await
            .expect("send thread/create frame");

        let response_body = next_text(&mut ws).await;
        let response: serde_json::Value = serde_json::from_str(&response_body)
            .unwrap_or_else(|e| panic!("response is JSON: {e} — body: {response_body}"));
        assert_eq!(response["id"], serde_json::json!(2), "echoed id");
        assert!(
            response.get("result").is_none(),
            "rejected create carries no result — body: {response_body}"
        );
        assert_eq!(
            response["error"]["code"],
            serde_json::json!(-32602),
            "empty prompt is rejected with invalid_params (-32602) — body: {response_body}"
        );

        ws.close(None).await.ok();
    });

    drop(core);

    // Open the DB read-only and assert zero rows were written.
    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        let thread_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM threads")
            .fetch_one(&pool)
            .await
            .expect("count threads");
        assert_eq!(thread_count, 0, "rejection writes zero thread rows");

        let run_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM runs")
            .fetch_one(&pool)
            .await
            .expect("count runs");
        assert_eq!(run_count, 0, "rejection writes zero run rows");
    });
}

#[test]
fn thread_create_malformed_params_rejected() {
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("slow-worker.ts").spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let mut ws = core.connect().await;

        // Malformed params (prompt is the wrong type) → invalid_params (-32602)
        // (ADR-0029; previously silently dropped).
        let create =
            r#"{"jsonrpc":"2.0","id":7,"method":"thread/create","params":{"prompt":123}}"#;
        ws.send(Message::Text(create.into()))
            .await
            .expect("send thread/create frame");

        let body = next_text(&mut ws).await;
        let v: serde_json::Value = serde_json::from_str(&body)
            .unwrap_or_else(|e| panic!("response is JSON: {e} — body: {body}"));
        assert_eq!(v["id"], serde_json::json!(7), "echoed id");
        assert!(
            v.get("result").is_none(),
            "malformed create carries no result — body: {body}"
        );
        assert_eq!(
            v["error"]["code"],
            serde_json::json!(-32602),
            "malformed params rejected with invalid_params (-32602) — body: {body}"
        );

        ws.close(None).await.ok();
    });
}
