//! Core-orchestrated single-flight token refresh (ADR-0023): when the stored
//! `openai-codex` token is expired, Core refreshes it exactly once even under
//! concurrent Runs (global lock + double-checked expiry), persists the rotated
//! credential (0600), and injects the fresh access token into each manifest.
//!
//! Offline via two stubs: `refresh-helper.ts` (Provider Helper, counts
//! invocations) and `manifest-echo.ts` (Worker, streams back the manifest's
//! `access_token`).

use std::path::Path;

use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{Workspace, Ws, next_text};

fn write_codex_workflow(dir: &Path) {
    std::fs::create_dir_all(dir).expect("create workflows dir");
    std::fs::write(
        dir.join("default.toml"),
        r#"
name = "default"
version = "1.0.0"
provider = "openai-codex"
model = "gpt-5.5"
thinking_level = "off"
system_prompt = "test"
tools = []
"#,
    )
    .expect("write codex default.toml");
}

fn write_credential(dir: &Path, access: &str, refresh: &str, expires: i64) {
    std::fs::create_dir_all(dir).expect("create creds dir");
    std::fs::write(
        dir.join("openai-codex.json"),
        serde_json::json!({
            "access": access,
            "refresh": refresh,
            "expires": expires,
            "account_id": "acct_test"
        })
        .to_string(),
    )
    .expect("write credential");
}

/// thread/create on a fresh connection, returning the run_id. One connection
/// per run lets the two runs race.
async fn create_run(ws: &mut Ws, prompt: &str, id: u64) -> String {
    let req = format!(
        r#"{{"jsonrpc":"2.0","id":{id},"method":"thread/create","params":{{"prompt":"{prompt}"}}}}"#
    );
    ws.send(Message::Text(req.into())).await.expect("send create");
    let body = next_text(ws).await;
    let v: serde_json::Value = serde_json::from_str(&body).expect("create json");
    v["result"]["run_id"].as_str().expect("run_id").to_string()
}

async fn drain_to_token(ws: &mut Ws, run_id: &str) -> String {
    let sub = format!(
        r#"{{"jsonrpc":"2.0","id":77,"method":"run/subscribe","params":{{"run_id":"{run_id}"}}}}"#
    );
    ws.send(Message::Text(sub.into())).await.expect("send subscribe");
    let _ack = next_text(ws).await;
    let mut text = String::new();
    loop {
        let body = next_text(ws).await;
        let v: serde_json::Value = serde_json::from_str(&body).expect("event json");
        match v["params"]["event"]["kind"].as_str() {
            Some("text_delta") => {
                text.push_str(v["params"]["event"]["delta"].as_str().unwrap_or(""));
            }
            Some("done") => break,
            Some("error") => panic!("run errored: {body}"),
            _ => {}
        }
    }
    text
}

/// Count Provider-Helper invocations via marker files. Each invocation writes a
/// unique file, so this is race-free (a shared counter could lose an update and
/// mask a single-flight bug).
fn refresh_count(dir: &Path) -> usize {
    match std::fs::read_dir(dir) {
        Ok(entries) => entries.filter(|e| e.is_ok()).count(),
        Err(_) => 0,
    }
}

#[test]
fn expired_token_refreshes_once_under_contention() {
    let workspace = Workspace::new();
    let workflows_dir = workspace.path().join("workflows");
    let creds_dir = workspace.path().join("credentials");
    let counter_dir = workspace.path().join("refresh-markers");
    write_codex_workflow(&workflows_dir);
    // Expired credential (expires far in the past).
    write_credential(&creds_dir, "stale_access", "refresh_v1", 1);

    let core = workspace
        .core()
        .worker_fixture("manifest-echo.ts")
        .env("INKSTONE_WORKFLOWS_DIR", &workflows_dir)
        .env("INKSTONE_CREDENTIALS_DIR", &creds_dir)
        .env(
            "INKSTONE_PROVIDER_HELPER_CMD",
            common::fixture_cmd("refresh-helper.ts", &["refresh"]),
        )
        .env("INKSTONE_REFRESH_COUNTER", &counter_dir)
        .spawn();

    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let (t1, t2) = rt.block_on(async {
        // Two concurrent runs, each on its own connection, observing the expired
        // token at nearly the same instant.
        let mut wsa = core.connect().await;
        let mut wsb = core.connect().await;
        let run_a = create_run(&mut wsa, "one", 1).await;
        let run_b = create_run(&mut wsb, "two", 2).await;
        let (ta, tb) = tokio::join!(
            drain_to_token(&mut wsa, &run_a),
            drain_to_token(&mut wsb, &run_b)
        );
        wsa.close(None).await.ok();
        wsb.close(None).await.ok();
        (ta, tb)
    });

    // Both runs' manifests carried the REFRESHED access token (the stub
    // rotates `refresh_v1` → `rotated:refresh_v1`).
    assert_eq!(t1, "rotated:refresh_v1", "run A manifest carried the refreshed token");
    assert_eq!(t2, "rotated:refresh_v1", "run B manifest carried the refreshed token");

    // Single-flight: exactly one refresh happened despite two expired runs.
    assert_eq!(
        refresh_count(&counter_dir),
        1,
        "the provider helper refresh ran exactly once under contention"
    );

    // The rotated credential was persisted (0600), replacing the stale one.
    let persisted: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(creds_dir.join("openai-codex.json")).expect("read persisted cred"),
    )
    .expect("persisted cred json");
    assert_eq!(persisted["access"], serde_json::json!("rotated:refresh_v1"));
    assert_eq!(persisted["refresh"], serde_json::json!("refresh_v1:next"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(creds_dir.join("openai-codex.json"))
            .expect("stat cred")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "persisted credential is 0600");
    }
}

#[test]
fn valid_token_used_without_refresh() {
    let workspace = Workspace::new();
    let workflows_dir = workspace.path().join("workflows");
    let creds_dir = workspace.path().join("credentials");
    let counter_dir = workspace.path().join("refresh-markers");
    write_codex_workflow(&workflows_dir);
    // Valid credential (expires far in the future).
    write_credential(&creds_dir, "fresh_access", "refresh_v1", 9_999_999_999_999);

    let core = workspace
        .core()
        .worker_fixture("manifest-echo.ts")
        .env("INKSTONE_WORKFLOWS_DIR", &workflows_dir)
        .env("INKSTONE_CREDENTIALS_DIR", &creds_dir)
        .env(
            "INKSTONE_PROVIDER_HELPER_CMD",
            common::fixture_cmd("refresh-helper.ts", &["refresh"]),
        )
        .env("INKSTONE_REFRESH_COUNTER", &counter_dir)
        .spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let token = rt.block_on(async {
        let mut ws = core.connect().await;
        let run = create_run(&mut ws, "hi", 1).await;
        let t = drain_to_token(&mut ws, &run).await;
        ws.close(None).await.ok();
        t
    });

    assert_eq!(token, "fresh_access", "valid token used as-is");
    assert_eq!(refresh_count(&counter_dir), 0, "no refresh for a valid token");
}
