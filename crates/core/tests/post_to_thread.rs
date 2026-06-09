//! Slice 4 RED test: `run/post_message({thread_id, prompt})` adds a SECOND
//! Run to an EXISTING Thread (ADR-0022 — post_message is existing-thread-only;
//! `thread_id` is never optional).
//!
//! `post_message_starts_second_run_in_existing_thread`: `thread/create` mints
//! a Thread + its first Run, then `run/post_message` against that `thread_id`
//! starts a second Run in the SAME Thread (same `thread_id`, new `run_id`).
//! The DB shows exactly one Thread and exactly two Runs, both carrying that
//! `thread_id`, with the two distinct run ids the WS responses returned.
//!
//! `post_message_unknown_thread_rejected`: `run/post_message` with a
//! well-formed but never-created `thread_id` is rejected with the
//! `unknown_thread` error (code `-32001`, ADR-0014's `-32000..-32099` Inkstone
//! server-error band) and writes ZERO rows — distinct from `invalid_params`
//! (`-32602`), which is for a malformed thread_id.
//!
//! Uses the REAL echo Worker (no fixture/gate) — this slice asserts the
//! create-then-post round trip and the persisted rows, not mid-stream timing.

use futures_util::SinkExt;
use sqlx::sqlite::SqlitePoolOptions;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{Workspace, Ws, next_text};

/// Subscribe to `run_id` and drain the snapshot + tail until the terminal
/// `done`, so the Worker finishes cleanly before Core is killed.
async fn drain_run_to_done(ws: &mut Ws, sub_id: u32, run_id: &str) {
    let subscribe = format!(
        r#"{{"jsonrpc":"2.0","id":{sub_id},"method":"run/subscribe","params":{{"run_id":"{run_id}"}}}}"#
    );
    ws.send(Message::Text(subscribe.into()))
        .await
        .expect("send run/subscribe frame");
    let _sub_resp = next_text(ws).await; // subscribe response
    loop {
        let body = next_text(ws).await;
        let v: serde_json::Value = serde_json::from_str(&body)
            .unwrap_or_else(|e| panic!("tail frame is JSON: {e} — body: {body}"));
        if v["params"]["event"]["kind"] == serde_json::json!("done") {
            break;
        }
    }
}

#[test]
fn post_message_starts_second_run_in_existing_thread() {
    let workspace = Workspace::new();

    let core = workspace.core().worker_fixture("slow-worker.ts").spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let (thread_id, run_id_1, run_id_2) = rt.block_on(async {
        let mut ws = core.connect().await;

        // ---- thread/create: mint the Thread + its first Run ----
        let create =
            r#"{"jsonrpc":"2.0","id":1,"method":"thread/create","params":{"prompt":"first"}}"#;
        ws.send(Message::Text(create.into()))
            .await
            .expect("send thread/create frame");
        let create_body = next_text(&mut ws).await;
        let create_resp: serde_json::Value = serde_json::from_str(&create_body)
            .unwrap_or_else(|e| panic!("create response is JSON: {e} — body: {create_body}"));
        assert!(
            create_resp.get("error").is_none(),
            "thread/create with a real prompt is not an error — body: {create_body}"
        );
        let thread_id = create_resp["result"]["thread_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.thread_id is a string — body: {create_body}"))
            .to_string();
        let run_id_1 = create_resp["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — body: {create_body}"))
            .to_string();

        // ---- post_message into that Thread: a SECOND Run, new run_id ----
        let post = format!(
            r#"{{"jsonrpc":"2.0","id":2,"method":"run/post_message","params":{{"thread_id":"{thread_id}","prompt":"second"}}}}"#
        );
        ws.send(Message::Text(post.into()))
            .await
            .expect("send run/post_message frame");
        let post_body = next_text(&mut ws).await;
        let post_resp: serde_json::Value = serde_json::from_str(&post_body)
            .unwrap_or_else(|e| panic!("post response is JSON: {e} — body: {post_body}"));
        assert_eq!(post_resp["id"], serde_json::json!(2), "echoed id");
        assert!(
            post_resp.get("error").is_none(),
            "post into an existing thread is not an error — body: {post_body}"
        );
        let run_id_2 = post_resp["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — body: {post_body}"))
            .to_string();

        // The second Run's id is a fresh UUIDv7 distinct from the first.
        let parsed_2 = uuid::Uuid::parse_str(&run_id_2).expect("run_id_2 parses as UUID");
        assert_eq!(
            parsed_2.get_version(),
            Some(uuid::Version::SortRand),
            "run_id_2 is UUIDv7"
        );
        assert_ne!(run_id_2, run_id_1, "second run has a distinct run_id");

        // Drain both runs to done so the Workers finish cleanly.
        drain_run_to_done(&mut ws, 3, &run_id_1).await;
        drain_run_to_done(&mut ws, 4, &run_id_2).await;

        ws.close(None).await.ok();
        (thread_id, run_id_1, run_id_2)
    });

    drop(core);

    // Open the DB read-only and assert one Thread, two Runs in it.
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
        assert_eq!(thread_count, 1, "exactly one thread row");

        let run_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM runs")
            .fetch_one(&pool)
            .await
            .expect("count runs");
        assert_eq!(run_count, 2, "exactly two run rows in the existing thread");

        // Both runs carry the same thread_id, and their ids are exactly the
        // two run ids the WS responses returned.
        let rows: Vec<(String, String)> =
            sqlx::query_as("SELECT id, thread_id FROM runs ORDER BY id")
                .fetch_all(&pool)
                .await
                .expect("read run rows");
        for (_id, run_thread_id) in &rows {
            assert_eq!(
                run_thread_id, &thread_id,
                "every run carries the existing thread_id"
            );
        }
        let mut ids: Vec<&str> = rows.iter().map(|(id, _)| id.as_str()).collect();
        ids.sort_unstable();
        let mut expected = [run_id_1.as_str(), run_id_2.as_str()];
        expected.sort_unstable();
        assert_eq!(ids, expected, "the two run ids match the WS responses");
    });
}

#[test]
fn post_message_unknown_thread_rejected() {
    let workspace = Workspace::new();

    let core = workspace.core().worker_fixture("slow-worker.ts").spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let mut ws = core.connect().await;

        // A well-formed UUIDv7 that was never created → unknown_thread.
        let bogus_thread = uuid::Uuid::now_v7().to_string();
        let post = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"run/post_message","params":{{"thread_id":"{bogus_thread}","prompt":"x"}}}}"#
        );
        ws.send(Message::Text(post.into()))
            .await
            .expect("send run/post_message frame");

        let body = next_text(&mut ws).await;
        let resp: serde_json::Value = serde_json::from_str(&body)
            .unwrap_or_else(|e| panic!("response is JSON: {e} — body: {body}"));
        assert_eq!(resp["id"], serde_json::json!(1), "echoed id");
        assert!(
            resp.get("result").is_none(),
            "rejected post carries no result — body: {body}"
        );
        assert_eq!(
            resp["error"]["code"],
            serde_json::json!(-32001),
            "unknown thread_id is rejected with unknown_thread (-32001) — body: {body}"
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

        let run_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM runs")
            .fetch_one(&pool)
            .await
            .expect("count runs");
        assert_eq!(run_count, 0, "unknown-thread rejection writes zero run rows");

        let thread_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM threads")
            .fetch_one(&pool)
            .await
            .expect("count threads");
        assert_eq!(
            thread_count, 0,
            "unknown-thread rejection writes zero thread rows"
        );
    });
}
