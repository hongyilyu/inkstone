//! `provider/test { provider, model }` liveness (ADR-0062): resolve the
//! credential, spawn a ONE-SHOT ephemeral Worker with a fixed ping prompt, and
//! return `{ alive: true }` on a reply or `{ alive: false, message }` on
//! error/no-credential — creating NO Thread and NO Run row. Provider-agnostic:
//! works for an openrouter static key AND a codex OAuth credential.
//!
//! The load-bearing property (what distinguishes this from `run/post_message`):
//! a `provider/test` call persists nothing. Each case asserts `threads` + `runs`
//! row-counts are UNCHANGED across the call.

use futures_util::SinkExt;
use sqlx::sqlite::SqlitePoolOptions;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{next_text, rt, Workspace, Ws};

/// Send a request and return the JSON-RPC RESPONSE frame (result or error),
/// skipping any notifications (e.g. `provider/connected` from `provider/configure`)
/// queued ahead of it — match on the request `id`.
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
        // A run-less notification — keep reading.
    }
}

/// Count `threads` + `runs` rows in the Workspace DB via a fresh read-only pool.
/// The DB file exists once Core has booted (migrated); the pool is opened and
/// dropped per call so it never holds a connection across the probe.
async fn row_counts(db_path: &std::path::Path) -> (i64, i64) {
    let url = format!("sqlite://{}?mode=ro", db_path.display());
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .expect("connect to migrated DB");
    let threads: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM threads")
        .fetch_one(&pool)
        .await
        .expect("count threads");
    let runs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM runs")
        .fetch_one(&pool)
        .await
        .expect("count runs");
    pool.close().await;
    (threads, runs)
}

/// A `text_delta`+`done` reply → `{ alive: true }`, and the call creates NO
/// Thread and NO Run row (row-counts unchanged before/after).
#[test]
fn provider_test_alive_on_reply_persists_nothing() {
    let workspace = Workspace::new();
    let creds_dir = workspace.path().join("credentials");
    let db_path = workspace.db_path().to_path_buf();

    let core = workspace
        .core()
        .no_seeded_credential()
        .worker_fixture("liveness-worker.ts")
        .env("INKSTONE_CREDENTIALS_DIR", &creds_dir)
        .spawn();

    let rt = rt();

    rt.block_on(async {
        let mut ws = core.connect().await;

        // Configure openrouter so a credential resolves.
        let v = rpc(
            &mut ws,
            1,
            "provider/configure",
            serde_json::json!({ "provider": "openrouter", "api_key": "sk-or-secret" }),
        )
        .await;
        assert!(v.get("result").is_some(), "configure succeeded — {v}");

        let before = row_counts(&db_path).await;

        let v = rpc(
            &mut ws,
            2,
            "provider/test",
            serde_json::json!({ "provider": "openrouter", "model": "anthropic/claude-opus-4.8" }),
        )
        .await;
        assert_eq!(
            v["result"]["alive"],
            serde_json::json!(true),
            "a text_delta+done reply is alive — {v}"
        );
        assert!(
            v["result"].get("message").is_none(),
            "alive result omits message — {v}"
        );

        let after = row_counts(&db_path).await;
        assert_eq!(
            before, after,
            "provider/test created no threads/runs rows (before {before:?}, after {after:?})"
        );

        ws.close(None).await.ok();
    });
}

/// A worker `error` frame → `{ alive: false, message }` carrying the worker's
/// message, and the call still persists nothing.
#[test]
fn provider_test_dead_on_error_frame() {
    let workspace = Workspace::new();
    let creds_dir = workspace.path().join("credentials");
    let db_path = workspace.db_path().to_path_buf();

    let core = workspace
        .core()
        .no_seeded_credential()
        .worker_fixture("liveness-worker.ts")
        .env("INKSTONE_CREDENTIALS_DIR", &creds_dir)
        .env("INKSTONE_LIVENESS_ERROR", "provider rejected the key")
        .spawn();

    let rt = rt();

    rt.block_on(async {
        let mut ws = core.connect().await;

        let v = rpc(
            &mut ws,
            1,
            "provider/configure",
            serde_json::json!({ "provider": "openrouter", "api_key": "sk-or-bad" }),
        )
        .await;
        assert!(v.get("result").is_some(), "configure succeeded — {v}");

        let before = row_counts(&db_path).await;

        let v = rpc(
            &mut ws,
            2,
            "provider/test",
            serde_json::json!({ "provider": "openrouter", "model": "anthropic/claude-opus-4.8" }),
        )
        .await;
        assert_eq!(
            v["result"]["alive"],
            serde_json::json!(false),
            "an error frame is dead — {v}"
        );
        assert_eq!(
            v["result"]["message"],
            serde_json::json!("provider rejected the key"),
            "dead result carries the worker's error message — {v}"
        );

        let after = row_counts(&db_path).await;
        assert_eq!(before, after, "provider/test created no rows even on the dead path");

        ws.close(None).await.ok();
    });
}

/// An UNCONFIGURED provider (no stored credential) → `{ alive: false }` with a
/// "not configured" message, WITHOUT spawning a Worker. Uses a worker command
/// that would FAIL if spawned (a non-existent program), proving the probe
/// short-circuits before the spawn.
#[test]
fn provider_test_unconfigured_is_dead_without_spawning() {
    let workspace = Workspace::new();
    let creds_dir = workspace.path().join("credentials");
    let db_path = workspace.db_path().to_path_buf();

    let core = workspace
        .core()
        .no_seeded_credential()
        // If the probe spawned for an unconfigured provider, this command would
        // fail — but it must never be reached (Ok(None) short-circuits).
        .worker_cmd("/nonexistent/liveness-worker-should-not-run")
        .env("INKSTONE_CREDENTIALS_DIR", &creds_dir)
        .spawn();

    let rt = rt();

    rt.block_on(async {
        let mut ws = core.connect().await;

        let before = row_counts(&db_path).await;

        let v = rpc(
            &mut ws,
            1,
            "provider/test",
            serde_json::json!({ "provider": "openrouter", "model": "anthropic/claude-opus-4.8" }),
        )
        .await;
        assert_eq!(
            v["result"]["alive"],
            serde_json::json!(false),
            "an unconfigured provider is dead — {v}"
        );
        assert!(
            v["result"]["message"]
                .as_str()
                .is_some_and(|m| m.contains("not configured")),
            "dead result explains the provider is not configured — {v}"
        );

        let after = row_counts(&db_path).await;
        assert_eq!(before, after, "an unconfigured provider/test persists nothing");

        ws.close(None).await.ok();
    });
}

/// Provider-agnostic: a codex OAuth credential (seeded on disk) + a reply →
/// `{ alive: true }`. The same probe path works for OAuth as for a static key.
#[test]
fn provider_test_alive_for_codex_oauth() {
    let workspace = Workspace::new();
    let creds_dir = workspace.path().join("credentials");
    let db_path = workspace.db_path().to_path_buf();

    // Seed a valid (non-expired) codex OAuth credential file directly, in the
    // tagged on-disk shape the credential store reads.
    std::fs::create_dir_all(&creds_dir).expect("create creds dir");
    let oauth = serde_json::json!({
        "kind": "oauth",
        "access": "tok_access",
        "refresh": "tok_refresh",
        "expires": 9_999_999_999_999i64,
        "account_id": "acct_1"
    });
    std::fs::write(
        creds_dir.join("openai-codex.json"),
        serde_json::to_string(&oauth).expect("serialize oauth"),
    )
    .expect("write codex credential");

    let core = workspace
        .core()
        .no_seeded_credential()
        .worker_fixture("liveness-worker.ts")
        .env("INKSTONE_CREDENTIALS_DIR", &creds_dir)
        .spawn();

    let rt = rt();

    rt.block_on(async {
        let mut ws = core.connect().await;

        let before = row_counts(&db_path).await;

        let v = rpc(
            &mut ws,
            1,
            "provider/test",
            serde_json::json!({ "provider": "openai-codex", "model": "gpt-5.5" }),
        )
        .await;
        assert_eq!(
            v["result"]["alive"],
            serde_json::json!(true),
            "a codex OAuth credential + a reply is alive — {v}"
        );

        let after = row_counts(&db_path).await;
        assert_eq!(before, after, "codex provider/test persists nothing");

        ws.close(None).await.ok();
    });
}

/// An unknown provider id — including a path-traversal attempt — is rejected with
/// invalid_params BEFORE any credential-store read, so `provider/test` can never
/// be used to probe an arbitrary `.json` file via `credentials/{provider}.json`.
#[test]
fn provider_test_rejects_unknown_provider_id() {
    let workspace = Workspace::new();
    let creds_dir = workspace.path().join("credentials");

    let core = workspace
        .core()
        .no_seeded_credential()
        .worker_fixture("liveness-worker.ts")
        .env("INKSTONE_CREDENTIALS_DIR", &creds_dir)
        .spawn();

    let rt = rt();

    rt.block_on(async {
        let mut ws = core.connect().await;

        // A path-traversal provider must be rejected, not resolved into a file read.
        let v = rpc(
            &mut ws,
            1,
            "provider/test",
            serde_json::json!({ "provider": "../../secret", "model": "x" }),
        )
        .await;
        assert_eq!(
            v["error"]["code"],
            serde_json::json!(-32602),
            "a path-traversal provider id is invalid_params, not a probe — {v}"
        );

        // A plain unknown provider is likewise invalid_params.
        let v2 = rpc(
            &mut ws,
            2,
            "provider/test",
            serde_json::json!({ "provider": "acme", "model": "x" }),
        )
        .await;
        assert_eq!(
            v2["error"]["code"],
            serde_json::json!(-32602),
            "an unknown provider is invalid_params — {v2}"
        );

        ws.close(None).await.ok();
    });
}
