//! `provider/login_start` orchestration (ADR-0023, ADR-0014). Core spawns the
//! Provider Helper in login mode, relays its authorize URL to the Client, and
//! persists the credentials the helper later emits as the single writer. The
//! Client learns the outcome by re-querying `provider/status`. Driven offline
//! by a stub login helper (no real :1455).

use std::path::Path;
use std::time::{Duration, Instant};

use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{CoreHandle, next_text, rt, try_next_text, Workspace, Ws};

/// Spawn Core wired to the stub login helper (no Worker — login never starts a
/// Run). `login_error`, when set, makes the stub emit a sanitized error line
/// instead of an authorize URL.
fn login_core(workspace: &Workspace, creds_dir: &Path, login_error: Option<&str>) -> CoreHandle {
    let mut builder = workspace
        .core()
        .no_seeded_credential()
        .env("INKSTONE_CREDENTIALS_DIR", creds_dir)
        .env(
            "INKSTONE_PROVIDER_LOGIN_CMD",
            common::fixture_cmd("login-helper.ts", &["login"]),
        );
    // Failure-path tests inject a helper error via the stub's env flag.
    if let Some(message) = login_error {
        builder = builder.env("INKSTONE_LOGIN_STUB_ERROR", message);
    }
    builder.spawn()
}

/// Like [`login_core`] but the stub helper emits the authorize URL then exits
/// WITHOUT a credentials line (`INKSTONE_LOGIN_STUB_NO_CREDS`) — Core's drain
/// task sees `Ok(None)` and must push NO `provider/connected`.
fn login_core_no_creds(workspace: &Workspace, creds_dir: &Path) -> CoreHandle {
    workspace
        .core()
        .no_seeded_credential()
        .env("INKSTONE_CREDENTIALS_DIR", creds_dir)
        .env(
            "INKSTONE_PROVIDER_LOGIN_CMD",
            common::fixture_cmd("login-helper.ts", &["login"]),
        )
        .env("INKSTONE_LOGIN_STUB_NO_CREDS", "1")
        .spawn()
}

/// Parse a frame's JSON-RPC `method`, or `""` for a response/error frame.
fn frame_method(body: &str) -> String {
    let v: serde_json::Value = serde_json::from_str(body).expect("frame json");
    v["method"].as_str().unwrap_or("").to_string()
}

async fn codex_connected(ws: &mut Ws, id: u64) -> bool {
    let req = format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"provider/status","params":{{}}}}"#);
    ws.send(Message::Text(req.into())).await.expect("send status");
    // Read until THIS request's response — a `provider/connected` push
    // (ADR-0049) can interleave on an idle connection, so skip notifications
    // (no `id`) and any stale response until the matching `id` arrives.
    let v = loop {
        let body = next_text(ws).await;
        let v: serde_json::Value = serde_json::from_str(&body).expect("status json");
        if v["id"] == serde_json::json!(id) {
            break v;
        }
    };
    v["result"]["providers"]
        .as_array()
        .expect("providers")
        .iter()
        .find(|p| p["id"] == serde_json::json!("openai-codex"))
        .expect("openai-codex present")["connected"]
        .as_bool()
        .expect("connected bool")
}

#[test]
fn login_start_returns_authorize_url_then_persists() {
    let workspace = Workspace::new();
    let creds_dir = workspace.path().join("credentials");

    let core = login_core(&workspace, &creds_dir, None);

    let rt = rt();

    rt.block_on(async {
        let mut ws = core.connect().await;

        // Disconnected to start.
        assert!(!codex_connected(&mut ws, 1).await, "disconnected before login");

        // login_start → reply carries the stub helper's authorize URL.
        let req = r#"{"jsonrpc":"2.0","id":2,"method":"provider/login_start","params":{"provider":"openai-codex"}}"#;
        ws.send(Message::Text(req.into())).await.expect("send login_start");
        let body = next_text(&mut ws).await;
        let v: serde_json::Value = serde_json::from_str(&body).expect("login_start json");
        assert_eq!(
            v["result"]["authorize_url"].as_str(),
            Some("https://auth.openai.com/oauth/authorize?stub=1"),
            "login_start returns the helper's authorize URL — body: {body}"
        );

        // The helper emits credentials ~100ms later; Core persists them. Poll
        // provider/status until it flips to connected (bounded).
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut connected = false;
        let mut id = 3;
        while Instant::now() < deadline {
            if codex_connected(&mut ws, id).await {
                connected = true;
                break;
            }
            id += 1;
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(connected, "provider/status flips to connected after the helper persists");

        ws.close(None).await.ok();
    });

    // The persisted credential is the one the login helper produced, 0600.
    let persisted: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(creds_dir.join("openai-codex.json")).expect("read persisted"),
    )
    .expect("persisted json");
    assert_eq!(persisted["access"], serde_json::json!("logged-in-access"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(creds_dir.join("openai-codex.json"))
            .expect("stat")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "persisted credential is 0600");
    }
}

#[test]
fn login_start_helper_error_surfaces_provider_login_failed() {
    let workspace = Workspace::new();
    let creds_dir = workspace.path().join("credentials");

    // The stub helper emits a sanitized error line before any authorize URL.
    let core = login_core(&workspace, &creds_dir, Some("account is locked"));

    let rt = rt();

    rt.block_on(async {
        let mut ws = core.connect().await;

        let req = r#"{"jsonrpc":"2.0","id":1,"method":"provider/login_start","params":{"provider":"openai-codex"}}"#;
        ws.send(Message::Text(req.into())).await.expect("send login_start");
        let body = next_text(&mut ws).await;
        let v: serde_json::Value = serde_json::from_str(&body).expect("login_start json");

        // A named provider-login error (-32003, ADR-0014), not a generic
        // internal error, carrying the helper's message for the settings UI.
        assert!(
            v.get("result").is_none(),
            "a failed login carries no result — body: {body}"
        );
        assert_eq!(
            v["error"]["code"],
            serde_json::json!(-32003),
            "helper error → provider_login_failed (-32003) — body: {body}"
        );
        assert_eq!(
            v["error"]["message"],
            serde_json::json!("provider login failed: account is locked"),
            "the sanitized helper message reaches the client — body: {body}"
        );

        ws.close(None).await.ok();
    });
}

#[test]
fn login_start_pushes_provider_connected_on_persist() {
    let workspace = Workspace::new();
    let creds_dir = workspace.path().join("credentials");

    let core = login_core(&workspace, &creds_dir, None);

    let rt = rt();

    rt.block_on(async {
        let mut ws = core.connect().await;

        // login_start → reply with the authorize URL.
        let req = r#"{"jsonrpc":"2.0","id":1,"method":"provider/login_start","params":{"provider":"openai-codex"}}"#;
        ws.send(Message::Text(req.into())).await.expect("send login_start");
        let body = next_text(&mut ws).await;
        assert_eq!(frame_method(&body), "", "first frame is the login_start response — body: {body}");

        // The helper emits credentials ~100ms later; once Core persists them it
        // pushes `provider/connected` onto THIS connection (ADR-0047/0049). Read
        // frames on the same WS until that notification arrives (bounded by
        // next_text's timeout; nothing else is pushed on this idle connection).
        let mut params_provider = None;
        for _ in 0..4 {
            let body = next_text(&mut ws).await;
            if frame_method(&body) == "provider/connected" {
                let v: serde_json::Value = serde_json::from_str(&body).expect("frame json");
                params_provider = v["params"]["provider"].as_str().map(str::to_owned);
                break;
            }
        }
        assert_eq!(
            params_provider.as_deref(),
            Some("openai-codex"),
            "provider/connected push carries params.provider == openai-codex"
        );

        ws.close(None).await.ok();
    });
}

#[test]
fn login_start_no_credentials_pushes_nothing() {
    let workspace = Workspace::new();
    let creds_dir = workspace.path().join("credentials");

    // The stub emits the authorize URL then exits without credentials — the
    // OAuth flow never completes, so Core's drain task hits `Ok(None)`.
    let core = login_core_no_creds(&workspace, &creds_dir);

    let rt = rt();

    rt.block_on(async {
        let mut ws = core.connect().await;

        let req = r#"{"jsonrpc":"2.0","id":1,"method":"provider/login_start","params":{"provider":"openai-codex"}}"#;
        ws.send(Message::Text(req.into())).await.expect("send login_start");
        let body = next_text(&mut ws).await;
        assert_eq!(frame_method(&body), "", "first frame is the login_start response — body: {body}");

        // The helper has already exited (it never delays — it returns right after
        // the authorize URL), so the drain task has run to `Ok(None)` well within
        // this window. Any frame that DOES arrive must not be provider/connected;
        // most runs see none at all. Deterministic: the stub never emits
        // credentials, so there is no late push to race.
        let window = Duration::from_millis(500);
        while let Some(body) = try_next_text(&mut ws, window).await {
            assert_ne!(
                frame_method(&body),
                "provider/connected",
                "no provider/connected when the helper finished without credentials — body: {body}"
            );
        }

        ws.close(None).await.ok();
    });
}
