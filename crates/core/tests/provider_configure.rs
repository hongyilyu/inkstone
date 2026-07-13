//! `provider/configure` + two-provider `provider/status` (ADR-0062): OpenRouter
//! is a key-configurable provider. `provider/status` enumerates BOTH known
//! providers; `provider/configure` persists a static API key for OpenRouter and
//! flips its row live; `provider/login_start` (OAuth) and `provider/configure`
//! reject the wrong auth kind. Uses a per-test `INKSTONE_CREDENTIALS_DIR`.

use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{next_text, rt, Workspace, Ws};

/// Send `provider/status` and return its `providers` array.
async fn status_providers(ws: &mut Ws, id: u64) -> Vec<serde_json::Value> {
    let req = format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"provider/status","params":{{}}}}"#);
    ws.send(Message::Text(req.into()))
        .await
        .expect("send provider/status");
    let body = next_text(ws).await;
    let v: serde_json::Value = serde_json::from_str(&body).expect("provider/status json");
    v["result"]["providers"]
        .as_array()
        .expect("providers array")
        .clone()
}

/// The `connected` flag of one provider id within a `providers` array.
fn connected_of(providers: &[serde_json::Value], id: &str) -> bool {
    providers
        .iter()
        .find(|p| p["id"] == serde_json::json!(id))
        .unwrap_or_else(|| panic!("{id} present in providers"))
        ["connected"]
        .as_bool()
        .expect("connected is a bool")
}

/// Send a request and return the JSON-RPC RESPONSE frame (result or error),
/// skipping any notifications queued ahead of it. `provider/configure` pushes a
/// `provider/connected` notification (ADR-0049) before framing its response, so
/// the response is not necessarily the next frame — match on the request `id`.
async fn rpc(ws: &mut Ws, id: u64, method: &str, params: serde_json::Value) -> serde_json::Value {
    let req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    ws.send(Message::Text(req.to_string().into()))
        .await
        .expect("send rpc");
    loop {
        let body = next_text(ws).await;
        let v: serde_json::Value = serde_json::from_str(&body).expect("rpc json");
        if v["id"] == serde_json::json!(id) {
            return v;
        }
        // A run-less notification (e.g. provider/connected) — keep reading.
    }
}

#[test]
fn provider_configure_stores_api_key_and_status_lists_both() {
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

        // Fresh DB: status lists BOTH known providers, both disconnected.
        let providers = status_providers(&mut ws, 1).await;
        assert_eq!(providers.len(), 2, "both known providers are enumerated");
        assert!(
            !connected_of(&providers, "openai-codex"),
            "openai-codex disconnected on a fresh DB"
        );
        assert!(
            !connected_of(&providers, "openrouter"),
            "openrouter disconnected on a fresh DB"
        );

        // login_start rejects openrouter (OAuth is codex-only) with invalid_params.
        let v = rpc(
            &mut ws,
            2,
            "provider/login_start",
            serde_json::json!({ "provider": "openrouter" }),
        )
        .await;
        assert_eq!(
            v["error"]["code"],
            serde_json::json!(-32602),
            "provider/login_start rejects openrouter as invalid_params"
        );

        // configure rejects openai-codex (OAuth-only — uses login, not configure).
        let v = rpc(
            &mut ws,
            3,
            "provider/configure",
            serde_json::json!({ "provider": "openai-codex", "api_key": "sk-x" }),
        )
        .await;
        assert_eq!(
            v["error"]["code"],
            serde_json::json!(-32602),
            "provider/configure rejects openai-codex (OAuth-only) as invalid_params"
        );

        // configure rejects an unknown provider with invalid_params.
        let v = rpc(
            &mut ws,
            4,
            "provider/configure",
            serde_json::json!({ "provider": "acme", "api_key": "sk-x" }),
        )
        .await;
        assert_eq!(
            v["error"]["code"],
            serde_json::json!(-32602),
            "provider/configure rejects an unknown provider as invalid_params"
        );

        // configure openrouter: returns the refreshed status with openrouter connected.
        let v = rpc(
            &mut ws,
            5,
            "provider/configure",
            serde_json::json!({ "provider": "openrouter", "api_key": "sk-or-secret" }),
        )
        .await;
        let providers = v["result"]["providers"]
            .as_array()
            .expect("configure result carries the refreshed providers array")
            .clone();
        assert_eq!(providers.len(), 2, "configure result enumerates both providers");
        assert!(
            connected_of(&providers, "openrouter"),
            "openrouter connected in the configure result"
        );

        // The credential persisted at 0600 as an ApiKey carrying the key.
        let cred_path = creds_dir.join("openrouter.json");
        assert!(cred_path.exists(), "openrouter credential file written");
        let stored: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&cred_path).expect("read credential"))
                .expect("credential json");
        assert_eq!(stored["kind"], serde_json::json!("api_key"));
        assert_eq!(stored["key"], serde_json::json!("sk-or-secret"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&cred_path)
                .expect("stat credential file")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "openrouter credential file is 0600");
        }

        // A follow-up status shows the persisted connection.
        let providers = status_providers(&mut ws, 6).await;
        assert!(
            connected_of(&providers, "openrouter"),
            "openrouter connected persists across a fresh status read"
        );
        assert!(
            !connected_of(&providers, "openai-codex"),
            "openai-codex still disconnected (configure touched only openrouter)"
        );

        ws.close(None).await.ok();
    });
}

/// An empty or whitespace-only `api_key` is rejected with `invalid_params`
/// BEFORE any write (reject-before-write, ADR-0014): a credential that reports
/// `connected: true` but fails at request time must never be persisted. The
/// provider-validity check still comes first — a bad provider AND an empty key
/// both reject, but provider is validated ahead of the key.
#[test]
fn provider_configure_rejects_empty_api_key() {
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

        // An empty api_key rejects as invalid_params.
        let v = rpc(
            &mut ws,
            1,
            "provider/configure",
            serde_json::json!({ "provider": "openrouter", "api_key": "" }),
        )
        .await;
        assert_eq!(
            v["error"]["code"],
            serde_json::json!(-32602),
            "provider/configure rejects an empty api_key as invalid_params"
        );

        // A whitespace-only api_key rejects too.
        let v = rpc(
            &mut ws,
            2,
            "provider/configure",
            serde_json::json!({ "provider": "openrouter", "api_key": "   " }),
        )
        .await;
        assert_eq!(
            v["error"]["code"],
            serde_json::json!(-32602),
            "provider/configure rejects a whitespace-only api_key as invalid_params"
        );

        // Nothing persisted: status still shows openrouter disconnected, and no
        // credential file was written (reject-before-write).
        let providers = status_providers(&mut ws, 3).await;
        assert!(
            !connected_of(&providers, "openrouter"),
            "openrouter still disconnected after a rejected empty-key configure"
        );
        assert!(
            !creds_dir.join("openrouter.json").exists(),
            "no openrouter credential file written on a rejected configure"
        );

        ws.close(None).await.ok();
    });
}

/// A pasted key with surrounding whitespace/newlines is TRIMMED before it is
/// stored, so the persisted credential holds the exact key bytes (not "  sk…\n"
/// which would be sent as invalid auth at request time while reporting connected).
#[test]
fn provider_configure_trims_the_api_key() {
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

        let v = rpc(
            &mut ws,
            1,
            "provider/configure",
            serde_json::json!({ "provider": "openrouter", "api_key": "  sk-or-secret\n" }),
        )
        .await;
        assert!(v.get("result").is_some(), "configure succeeded — {v}");

        let stored: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(creds_dir.join("openrouter.json")).expect("read credential"),
        )
        .expect("credential json");
        assert_eq!(
            stored["key"],
            serde_json::json!("sk-or-secret"),
            "the stored key is trimmed, not the raw padded input"
        );

        ws.close(None).await.ok();
    });
}
