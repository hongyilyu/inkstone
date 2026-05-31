//! Slice 3 RED test: a `text_delta` Run Event from the Worker is appended
//! to the assistant `message_parts.text` row inside a `messages` row with
//! `role='assistant'`, `status='streaming'`, BEFORE Core forwards the WS
//! `run/event` Notification — so a test that observes the WS frame can
//! immediately query the DB and see the same delta committed.

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
fn text_delta_appends_to_message_parts() {
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
            r#"{"jsonrpc":"2.0","id":1,"method":"run/post_message","params":{"prompt":"hi"}}"#;
        ws.send(Message::Text(request.into()))
            .await
            .expect("send request frame");

        async fn next_text(
            ws: &mut tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
        ) -> String {
            let frame = tokio::time::timeout(Duration::from_secs(5), ws.next())
                .await
                .expect("frame within 5s")
                .expect("frame present")
                .expect("frame ok");
            match frame {
                Message::Text(t) => t.to_string(),
                other => panic!("expected text frame, got {other:?}"),
            }
        }

        let response_body = next_text(&mut ws).await;
        let event1_body = next_text(&mut ws).await;
        let event2_body = next_text(&mut ws).await;

        ws.close(None).await.ok();

        let response: serde_json::Value = serde_json::from_str(&response_body)
            .unwrap_or_else(|e| panic!("response is JSON: {e} — body: {response_body}"));
        let run_id = response["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — body: {response_body}"))
            .to_string();

        let event1: serde_json::Value = serde_json::from_str(&event1_body)
            .unwrap_or_else(|e| panic!("event1 is JSON: {e} — body: {event1_body}"));
        assert_eq!(
            event1["params"]["event"]["kind"],
            serde_json::json!("text_delta"),
            "frame 1 is text_delta"
        );
        assert_eq!(
            event1["params"]["event"]["delta"],
            serde_json::json!("echo: hi"),
            "text_delta carries 'echo: hi'"
        );

        let event2: serde_json::Value = serde_json::from_str(&event2_body)
            .unwrap_or_else(|e| panic!("event2 is JSON: {e} — body: {event2_body}"));
        assert_eq!(
            event2["params"]["event"]["kind"],
            serde_json::json!("done"),
            "frame 2 is done"
        );

        run_id
    });

    let _ = child.kill();
    let _ = child.wait();

    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", db_path.display());
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
