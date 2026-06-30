//! `settings/get` + `settings/set` (ADR-0024): the preferred model and global
//! effort persist in tier-2 and round-trip over the wire; an unknown model or
//! invalid effort is rejected with `invalid_params` (-32602) and writes
//! nothing.

use futures_util::SinkExt;
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{Workspace, Ws, next_text};

/// The full set of catalog model ids, mirroring `models::catalog()` flattened.
/// Hand-listed so the test pins the catalog shape rather than re-deriving it.
const ALL_CATALOG_IDS: &[&str] = &[
    "gpt-5.1",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
    "gpt-5.2",
    "gpt-5.2-codex",
    "gpt-5.3-codex",
    "gpt-5.3-codex-spark",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.5",
];

/// Open a migrated pool against the Workspace DB so a test can seed a setting
/// row directly before Core spawns (mirrors `current_thread_journal_entries`).
async fn migrated_pool(workspace: &Workspace) -> SqlitePool {
    let options = SqliteConnectOptions::new()
        .filename(workspace.db_path())
        .create_if_missing(true)
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("open sqlite pool");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("run migrations");
    pool
}

async fn request(ws: &mut Ws, id: u64, method: &str, params: serde_json::Value) -> serde_json::Value {
    let req = serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    ws.send(Message::Text(req.to_string().into()))
        .await
        .expect("send request");
    let body = next_text(ws).await;
    serde_json::from_str(&body).expect("json response")
}

#[test]
fn settings_get_set_round_trips_and_validates() {
    let workspace = Workspace::new();
    let core = workspace.core().spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let mut ws = core.connect().await;

        // Defaults before any set: model falls back to the per-provider default
        // (gpt-5.5), effort "off", provider is the default Workflow's (openai-codex).
        let got = request(&mut ws, 1, "settings/get", serde_json::json!({})).await;
        assert_eq!(got["result"]["provider"], serde_json::json!("openai-codex"));
        assert_eq!(got["result"]["model"], serde_json::json!("gpt-5.5"));
        assert_eq!(got["result"]["effort"], serde_json::json!("off"));

        // Set both; the response echoes the updated state.
        let set = request(
            &mut ws,
            2,
            "settings/set",
            serde_json::json!({ "model": "gpt-5.5", "effort": "high" }),
        )
        .await;
        assert_eq!(set["result"]["model"], serde_json::json!("gpt-5.5"));
        assert_eq!(set["result"]["effort"], serde_json::json!("high"));

        // A fresh get reads the persisted values.
        let got2 = request(&mut ws, 3, "settings/get", serde_json::json!({})).await;
        assert_eq!(got2["result"]["model"], serde_json::json!("gpt-5.5"));
        assert_eq!(got2["result"]["effort"], serde_json::json!("high"));

        // Partial update: changing only the effort leaves the model intact.
        let set_effort = request(
            &mut ws,
            4,
            "settings/set",
            serde_json::json!({ "effort": "low" }),
        )
        .await;
        assert_eq!(set_effort["result"]["model"], serde_json::json!("gpt-5.5"));
        assert_eq!(set_effort["result"]["effort"], serde_json::json!("low"));

        // Unknown model → invalid_params (-32602), and the prior value stands.
        let bad_model = request(
            &mut ws,
            5,
            "settings/set",
            serde_json::json!({ "model": "totally-not-a-model" }),
        )
        .await;
        assert_eq!(bad_model["error"]["code"], serde_json::json!(-32602));

        // Invalid effort → invalid_params (-32602).
        let bad_effort = request(
            &mut ws,
            6,
            "settings/set",
            serde_json::json!({ "effort": "ludicrous" }),
        )
        .await;
        assert_eq!(bad_effort["error"]["code"], serde_json::json!(-32602));

        // The rejected writes changed nothing.
        let got3 = request(&mut ws, 7, "settings/get", serde_json::json!({})).await;
        assert_eq!(got3["result"]["model"], serde_json::json!("gpt-5.5"));
        assert_eq!(got3["result"]["effort"], serde_json::json!("low"));

        ws.close(None).await.ok();
    });
}

#[test]
fn settings_get_enabled_models_defaults_to_full_catalog() {
    // A fresh Workspace has no `enabled_models` set, so `settings/get` reports
    // every catalog model id as enabled (the default-fill branch).
    let workspace = Workspace::new();
    let core = workspace.core().spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let mut ws = core.connect().await;

        let got = request(&mut ws, 1, "settings/get", serde_json::json!({})).await;
        let enabled = got["result"]["enabled_models"]
            .as_array()
            .expect("enabled_models is an array")
            .iter()
            .map(|v| v.as_str().expect("model id is a string").to_string())
            .collect::<Vec<_>>();
        let expected = ALL_CATALOG_IDS
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            enabled, expected,
            "fresh DB reports the full catalog as enabled: {got}"
        );

        ws.close(None).await.ok();
    });
}

#[test]
fn settings_get_enabled_models_returns_stored_set() {
    // With an `enabled_models` value already stored (seeded directly — the
    // wire write path lands in slice 2), `settings/get` returns exactly it.
    let workspace = Workspace::new();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        // Seed the KV row before Core spawns: a JSON-encoded one-element array.
        let pool = migrated_pool(&workspace).await;
        sqlx::query(
            "INSERT INTO settings (key, value) VALUES ('enabled_models', ?1) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(serde_json::json!(["gpt-5.4"]).to_string())
        .execute(&pool)
        .await
        .expect("seed enabled_models");
        pool.close().await;

        let core = workspace.core().spawn();
        let mut ws = core.connect().await;

        let got = request(&mut ws, 1, "settings/get", serde_json::json!({})).await;
        assert_eq!(
            got["result"]["enabled_models"],
            serde_json::json!(["gpt-5.4"]),
            "stored enabled_models round-trips exactly: {got}"
        );

        ws.close(None).await.ok();
    });
}

#[test]
fn settings_set_malformed_params_rejected() {
    let workspace = Workspace::new();
    let core = workspace.core().spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let mut ws = core.connect().await;

        // Malformed params (wrong type, fails to decode) → invalid_params
        // (-32602), where the pre-ADR-0029 dispatch silently dropped it.
        let bad = request(&mut ws, 1, "settings/set", serde_json::json!({ "model": 123 })).await;
        assert_eq!(bad["id"], serde_json::json!(1));
        assert!(
            bad.get("result").is_none(),
            "malformed set carries no result: {bad}"
        );
        assert_eq!(
            bad["error"]["code"],
            serde_json::json!(-32602),
            "malformed settings/set params rejected with invalid_params: {bad}"
        );

        ws.close(None).await.ok();
    });
}
