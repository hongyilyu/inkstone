use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{Workspace, next_text};

#[test]
fn post_message_returns_uuidv7_run_id() {
    let workspace = Workspace::new();
    let core = workspace.core().spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let body = rt.block_on(async {
        let mut ws = core.connect().await;

        let request =
            r#"{"jsonrpc":"2.0","id":1,"method":"thread/create","params":{"prompt":"hi"}}"#;
        ws.send(Message::Text(request.into()))
            .await
            .expect("send request frame");

        let body = next_text(&mut ws).await;

        ws.close(None).await.ok();

        body
    });

    drop(core);

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
}
