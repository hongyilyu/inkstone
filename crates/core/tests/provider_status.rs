//! Credential Store + `provider/status` (ADR-0023): reports `openai-codex`
//! disconnected when no credential file exists, connected once one does. Uses a
//! per-test `INKSTONE_CREDENTIALS_DIR` and writes the fixture file directly to
//! drive the status read (the store's 0600/0700 `write()` is unit-tested in
//! `credentials.rs`).

use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{next_text, rt, Workspace, Ws};

/// Send `provider/status` and return the `openai-codex` connected flag.
async fn codex_connected(ws: &mut Ws, id: u64) -> bool {
    let req = format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"provider/status","params":{{}}}}"#);
    ws.send(Message::Text(req.into()))
        .await
        .expect("send provider/status");
    let body = next_text(ws).await;
    let v: serde_json::Value = serde_json::from_str(&body).expect("provider/status json");
    let providers = v["result"]["providers"].as_array().expect("providers array");
    let codex = providers
        .iter()
        .find(|p| p["id"] == serde_json::json!("openai-codex"))
        .expect("openai-codex present in providers");
    codex["connected"].as_bool().expect("connected is a bool")
}

#[test]
fn provider_status_reflects_credential_presence() {
    let workspace = Workspace::new();
    let creds_dir = workspace.path().join("credentials");

    let core = workspace
        .core()
        .no_seeded_credential()
        .env("INKSTONE_CREDENTIALS_DIR", &creds_dir)
        .spawn();

    let rt = rt();

    rt.block_on(async {
        let mut ws = core.connect().await;

        // No credential file yet → disconnected.
        assert!(
            !codex_connected(&mut ws, 1).await,
            "openai-codex must be disconnected before any credential is written"
        );

        // Write a valid credential file (simulating a completed login; the
        // login/refresh path that actually writes this lands in slice 7).
        std::fs::create_dir_all(&creds_dir).expect("create creds dir");
        let cred_path = creds_dir.join("openai-codex.json");
        std::fs::write(
            &cred_path,
            r#"{"kind":"oauth","access":"tok_access","refresh":"tok_refresh","expires":9999999999999,"account_id":"acct_1"}"#,
        )
        .expect("write credential file");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&cred_path, std::fs::Permissions::from_mode(0o600))
                .expect("chmod 0600");
        }

        // Now → connected.
        assert!(
            codex_connected(&mut ws, 2).await,
            "openai-codex must be connected once a credential file exists"
        );

        ws.close(None).await.ok();
    });
}
