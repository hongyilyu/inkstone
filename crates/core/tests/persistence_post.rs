//! Slice 2 RED test: posting a message via `run/post_message` writes one
//! Thread, one Run (`status='running'`), one user Message (`status='completed'`),
//! one user `message_parts` row, one `run_steps` row, and one `run_events`
//! row — all in a single transaction with deferred FK enforcement.

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use assert_cmd::cargo::CommandCargoExt;
use futures_util::{SinkExt, StreamExt};
use sqlx::Row;
use sqlx::sqlite::SqlitePoolOptions;
use tempfile::TempDir;
use tokio_tungstenite::tungstenite::Message;

#[test]
fn post_message_writes_initial_rows() {
    // Resolve worker tsx + cli paths from this crate's manifest dir so the
    // test passes regardless of cargo's CWD.
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .expect("repo root resolves from <repo>/crates/core");
    let tsx = repo_root.join("packages/worker/node_modules/.bin/tsx");
    let cli = repo_root.join("packages/worker/src/cli.ts");
    if !tsx.exists() {
        panic!(
            "worker tsx not installed at {} — run `pnpm install` at repo root",
            tsx.display()
        );
    }
    if !cli.exists() {
        panic!("worker cli not found at {}", cli.display());
    }
    let worker_cmd = format!("{} {}", tsx.display(), cli.display());

    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");

    let mut child = std::process::Command::cargo_bin("core")
        .expect("core binary exists")
        .current_dir(repo_root)
        .env("INKSTONE_WORKER_CMD", &worker_cmd)
        .env("INKSTONE_DB_PATH", &db_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("core spawns");

    let stdout = child.stdout.take().expect("piped stdout");
    let mut reader = BufReader::new(stdout);

    let deadline = Instant::now() + Duration::from_secs(5);
    let http_url = loop {
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("timed out waiting for INKSTONE_LISTENING line");
        }
        let mut line = String::new();
        let read = reader.read_line(&mut line).expect("read stdout");
        if read == 0 {
            let _ = child.kill();
            let _ = child.wait();
            panic!("core stdout closed before announcing INKSTONE_LISTENING");
        }
        let trimmed = line.trim_end_matches('\n').trim_end_matches('\r');
        if let Some(rest) = trimmed.strip_prefix("INKSTONE_LISTENING ") {
            break rest.to_string();
        }
    };

    let ws_url = http_url
        .strip_prefix("http://")
        .map(|host| format!("ws://{host}/ws"))
        .expect("INKSTONE_LISTENING URL has http:// prefix");

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let run_id = rt.block_on(async {
        let (mut ws, _resp) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .expect("ws handshake succeeds");

        let request =
            r#"{"jsonrpc":"2.0","id":1,"method":"thread/create","params":{"prompt":"hello"}}"#;
        ws.send(Message::Text(request.into()))
            .await
            .expect("send request frame");

        let frame = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("response frame within 5s")
            .expect("response frame present")
            .expect("response frame ok");
        let body = match frame {
            Message::Text(t) => t.to_string(),
            other => panic!("expected text frame, got {other:?}"),
        };

        ws.close(None).await.ok();

        let v: serde_json::Value = serde_json::from_str(&body)
            .unwrap_or_else(|e| panic!("response is JSON: {e} — body: {body}"));
        v["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — body: {body}"))
            .to_string()
    });

    let _ = child.kill();
    let _ = child.wait();

    // Open the DB read-only and assert via direct queries.
    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", db_path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        // Threads ----------------------------------------------------------
        let thread_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM threads")
            .fetch_one(&pool)
            .await
            .expect("count threads");
        assert_eq!(thread_count, 1, "exactly one thread row");
        let title: String = sqlx::query_scalar("SELECT title FROM threads")
            .fetch_one(&pool)
            .await
            .expect("read thread title");
        assert!(!title.is_empty(), "thread title is non-empty");

        // Runs -------------------------------------------------------------
        let run_row = sqlx::query(
            "SELECT id, status, workflow_name, workflow_version, provider, model, \
             started_at, user_message_id FROM runs",
        )
        .fetch_all(&pool)
        .await
        .expect("query runs");
        assert_eq!(run_row.len(), 1, "exactly one run row");
        let r = &run_row[0];
        let id: String = r.get("id");
        assert_eq!(id, run_id, "runs.id matches response run_id");
        let status: String = r.get("status");
        // slice 4: Core may finish the terminal tx before the test kills it; both states are acceptable here.
        assert!(
            matches!(status.as_str(), "running" | "completed"),
            "runs.status is 'running' or 'completed' (slice-4 race), got {status:?}"
        );
        let wf_name: String = r.get("workflow_name");
        assert_eq!(wf_name, "default");
        let wf_ver: String = r.get("workflow_version");
        assert_eq!(wf_ver, "1.0.0");
        let provider: String = r.get("provider");
        assert_eq!(provider, "openai-codex");
        let model: String = r.get("model");
        assert_eq!(model, "gpt-5.5");
        let started_at: Option<i64> = r.get("started_at");
        assert!(started_at.is_some(), "started_at is set");
        let user_msg_id: Option<String> = r.get("user_message_id");
        let user_msg_id = user_msg_id.expect("user_message_id is non-null");

        // Messages ---------------------------------------------------------
        let user_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE role='user'")
                .fetch_one(&pool)
                .await
                .expect("count user messages");
        assert_eq!(user_count, 1, "exactly one user message");
        let user_row = sqlx::query("SELECT id, status, run_id FROM messages WHERE role='user'")
            .fetch_one(&pool)
            .await
            .expect("read user message");
        let m_id: String = user_row.get("id");
        assert_eq!(m_id, user_msg_id, "user message id matches runs.user_message_id");
        let m_status: String = user_row.get("status");
        assert_eq!(m_status, "completed");
        let m_run: String = user_row.get("run_id");
        assert_eq!(m_run, run_id, "user message run_id matches");

        // Message parts ----------------------------------------------------
        let part_row = sqlx::query(
            "SELECT seq, type, text FROM message_parts WHERE message_id = ?1",
        )
        .bind(&user_msg_id)
        .fetch_all(&pool)
        .await
        .expect("read message parts");
        assert_eq!(part_row.len(), 1, "exactly one user message_part");
        let p = &part_row[0];
        let seq: i64 = p.get("seq");
        assert_eq!(seq, 0);
        let ptype: String = p.get("type");
        assert_eq!(ptype, "text");
        let ptext: String = p.get("text");
        assert_eq!(ptext, "hello");

        // Run steps --------------------------------------------------------
        let step_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM run_steps WHERE run_id = ?1 AND kind='message'",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("count run_steps");
        assert!(step_count >= 1, "at least one message run_step");
        let step0 = sqlx::query(
            "SELECT message_id FROM run_steps WHERE run_id = ?1 AND seq = 0",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("read run_step seq=0");
        let step_msg_id: Option<String> = step0.get("message_id");
        assert_eq!(
            step_msg_id.as_deref(),
            Some(user_msg_id.as_str()),
            "run_steps[seq=0].message_id is the user message"
        );

        // Run events -------------------------------------------------------
        let event_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM run_events WHERE run_id = ?1 AND kind='status'",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("count run_events");
        assert!(event_count >= 1, "at least one status run_event");
    });
}
