use std::io::{BufRead, BufReader};
use std::process::Stdio;
use std::time::{Duration, Instant};

use assert_cmd::cargo::CommandCargoExt;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

#[test]
fn post_message_returns_uuidv7_run_id_with_no_followups() {
    let mut child = std::process::Command::cargo_bin("core")
        .expect("core binary exists")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
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
            r#"{"jsonrpc":"2.0","id":1,"method":"run/post_message","params":{"prompt":"hi"}}"#;
        ws.send(Message::Text(request.into()))
            .await
            .expect("send request frame");

        let frame = ws
            .next()
            .await
            .expect("response frame received")
            .expect("response frame ok");

        let body = match frame {
            Message::Text(t) => t.to_string(),
            other => panic!("expected text frame, got {other:?}"),
        };

        // No further frames should arrive — slice 4 only mints and replies.
        let next = tokio::time::timeout(Duration::from_millis(200), ws.next()).await;
        let no_followup = matches!(next, Err(_) | Ok(None));

        ws.close(None).await.ok();

        (body, no_followup)
    });

    let _ = child.kill();
    let _ = child.wait();

    let (body, no_followup) = outcome;
    let v: serde_json::Value = serde_json::from_str(&body)
        .unwrap_or_else(|e| panic!("response is JSON: {e} — body: {body}"));

    assert_eq!(v["jsonrpc"], serde_json::json!("2.0"), "jsonrpc field");
    assert_eq!(v["id"], serde_json::json!(1), "echoed id");

    let run_id = v["result"]["run_id"]
        .as_str()
        .unwrap_or_else(|| panic!("result.run_id is a string — body: {body}"));

    let parsed = uuid::Uuid::parse_str(run_id).expect("run_id parses as UUID");
    assert_eq!(
        parsed.get_version(),
        Some(uuid::Version::SortRand),
        "run_id is UUIDv7 (got version {:?})",
        parsed.get_version()
    );

    assert!(
        no_followup,
        "no further frames should follow the response in slice 4"
    );
}
