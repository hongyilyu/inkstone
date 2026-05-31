use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use assert_cmd::cargo::CommandCargoExt;
use futures_util::{SinkExt, StreamExt};
use tempfile::TempDir;
use tokio_tungstenite::tungstenite::Message;

#[test]
fn end_to_end_post_message_streams_text_delta_then_done() {
    // Resolve repo paths from this crate's manifest dir so tests work regardless
    // of cargo's CWD (cargo runs integration tests with CWD = crate directory).
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .expect("repo root resolves from <repo>/crates/core");

    // tsx is a worker dev-dependency; pnpm's isolated mode lands the binary
    // under packages/worker/node_modules/.bin/tsx (not the workspace root).
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

    let outcome = rt.block_on(async {
        let (mut ws, _resp) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .expect("ws handshake succeeds");

        let request =
            r#"{"jsonrpc":"2.0","id":1,"method":"run/post_message","params":{"prompt":"hello"}}"#;
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

        let response = next_text(&mut ws).await;
        let event1 = next_text(&mut ws).await;
        let event2 = next_text(&mut ws).await;

        ws.close(None).await.ok();
        (response, event1, event2)
    });

    let _ = child.kill();
    let _ = child.wait();

    let (response_body, event1_body, event2_body) = outcome;

    let response: serde_json::Value = serde_json::from_str(&response_body)
        .unwrap_or_else(|e| panic!("response is JSON: {e} — body: {response_body}"));
    assert_eq!(response["jsonrpc"], serde_json::json!("2.0"), "jsonrpc");
    assert_eq!(response["id"], serde_json::json!(1), "echoed id");
    let run_id = response["result"]["run_id"]
        .as_str()
        .unwrap_or_else(|| panic!("result.run_id is a string — body: {response_body}"))
        .to_string();
    let parsed = uuid::Uuid::parse_str(&run_id).expect("run_id parses as UUID");
    assert_eq!(
        parsed.get_version(),
        Some(uuid::Version::SortRand),
        "run_id is UUIDv7"
    );

    let event1: serde_json::Value = serde_json::from_str(&event1_body)
        .unwrap_or_else(|e| panic!("event1 is JSON: {e} — body: {event1_body}"));
    assert_eq!(event1["jsonrpc"], serde_json::json!("2.0"), "event1 jsonrpc");
    assert_eq!(
        event1["method"],
        serde_json::json!("run/event"),
        "event1 method"
    );
    assert_eq!(
        event1["params"]["run_id"],
        serde_json::json!(run_id),
        "event1 run_id matches"
    );
    assert_eq!(
        event1["params"]["event"],
        serde_json::json!({"kind": "text_delta", "delta": "echo: hello"}),
        "event1 event payload"
    );

    let event2: serde_json::Value = serde_json::from_str(&event2_body)
        .unwrap_or_else(|e| panic!("event2 is JSON: {e} — body: {event2_body}"));
    assert_eq!(event2["jsonrpc"], serde_json::json!("2.0"), "event2 jsonrpc");
    assert_eq!(
        event2["method"],
        serde_json::json!("run/event"),
        "event2 method"
    );
    assert_eq!(
        event2["params"]["run_id"],
        serde_json::json!(run_id),
        "event2 run_id matches"
    );
    assert_eq!(
        event2["params"]["event"],
        serde_json::json!({"kind": "done"}),
        "event2 event payload"
    );
}
