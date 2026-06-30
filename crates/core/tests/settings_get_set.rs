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
fn settings_get_enabled_models_defaults_to_uncurated_empty() {
    // A fresh Workspace has no `enabled_models` set, so `settings/get` returns the
    // empty "uncurated" sentinel (ADR-0024) — meaning "all models enabled". Core
    // does NOT materialize today's catalog into the response, so an uncurated user
    // is never frozen to the catalog as it was at read time; the client expands
    // empty → all itself (the composer ModelPicker).
    let workspace = Workspace::new();
    let core = workspace.core().spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let mut ws = core.connect().await;

        let got = request(&mut ws, 1, "settings/get", serde_json::json!({})).await;
        assert_eq!(
            got["result"]["enabled_models"],
            serde_json::json!([]),
            "fresh DB reports the uncurated empty set: {got}"
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
        .bind(serde_json::json!(["gpt-5.5"]).to_string())
        .execute(&pool)
        .await
        .expect("seed enabled_models");
        pool.close().await;

        let core = workspace.core().spawn();
        let mut ws = core.connect().await;

        let got = request(&mut ws, 1, "settings/get", serde_json::json!({})).await;
        assert_eq!(
            got["result"]["enabled_models"],
            serde_json::json!(["gpt-5.5"]),
            "stored enabled_models round-trips exactly: {got}"
        );

        ws.close(None).await.ok();
    });
}

#[test]
fn settings_set_enabled_models_persists_and_enforces_default_membership() {
    // `settings/set` accepts an `enabled_models` set, round-trips it, and rejects
    // (invalid_params, no write) any update whose effective preferred model would
    // not be a member of the effective enabled set (ADR-0024).
    let workspace = Workspace::new();
    let core = workspace.core().spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let mut ws = core.connect().await;

        // The pi-ai 0.80.2 (#292) openai-codex chat catalog ships a single
        // selectable model (gpt-5.5), which is also the per-provider default. An
        // EMPTY enabled set is the "uncurated = all enabled" sentinel (ADR-0024),
        // never "enable nothing", so it imposes no membership constraint. The cases
        // provable against a one-model catalog: a curated set containing the
        // default, a reset to the empty/uncurated set, and an unknown member id.
        // The "curate a set EXCLUDING the default" rejection needs a second known
        // catalog id and is unprovable until a second model/provider exists; the
        // invariant's non-empty `effective_model ∈ effective_enabled` check covers
        // it by construction (see crates/core/src/runs/settings.rs).

        // (a) A curated set INCLUDING the current default (gpt-5.5) succeeds and
        // round-trips verbatim via settings/get.
        let set = request(
            &mut ws,
            1,
            "settings/set",
            serde_json::json!({ "enabled_models": ["gpt-5.5"] }),
        )
        .await;
        assert_eq!(
            set["result"]["enabled_models"],
            serde_json::json!(["gpt-5.5"]),
            "set echoes the persisted enabled_models: {set}"
        );
        let got = request(&mut ws, 2, "settings/get", serde_json::json!({})).await;
        assert_eq!(
            got["result"]["enabled_models"],
            serde_json::json!(["gpt-5.5"]),
            "enabled_models round-trips via settings/get: {got}"
        );

        // (b) The EMPTY set is accepted as "reset to uncurated" (all enabled), NOT
        // rejected — empty never means "exclude the default". It persists as [] and
        // round-trips as the uncurated sentinel.
        let reset = request(
            &mut ws,
            3,
            "settings/set",
            serde_json::json!({ "enabled_models": [] }),
        )
        .await;
        assert_eq!(
            reset["result"]["enabled_models"],
            serde_json::json!([]),
            "the empty (uncurated) set is accepted and persists as []: {reset}"
        );
        let got2 = request(&mut ws, 4, "settings/get", serde_json::json!({})).await;
        assert_eq!(
            got2["result"]["enabled_models"],
            serde_json::json!([]),
            "uncurated enabled_models round-trips as []: {got2}"
        );

        // (c) An enabled_models member that is not a known catalog id → invalid_params,
        // and nothing persists (the prior uncurated [] stands).
        let bad_id = request(
            &mut ws,
            5,
            "settings/set",
            serde_json::json!({ "enabled_models": ["gpt-5.5", "totally-not-a-model"] }),
        )
        .await;
        assert_eq!(
            bad_id["error"]["code"],
            serde_json::json!(-32602),
            "unknown enabled_models member is rejected: {bad_id}"
        );
        let got3 = request(&mut ws, 6, "settings/get", serde_json::json!({})).await;
        assert_eq!(
            got3["result"]["enabled_models"],
            serde_json::json!([]),
            "rejected enabled_models persisted nothing: {got3}"
        );

        // (d) A submitted set with DUPLICATE ids is normalized to a true set
        // (order-preserving dedup) before persisting, not stored/echoed verbatim.
        let dup = request(
            &mut ws,
            7,
            "settings/set",
            serde_json::json!({ "enabled_models": ["gpt-5.5", "gpt-5.5"] }),
        )
        .await;
        assert_eq!(
            dup["result"]["enabled_models"],
            serde_json::json!(["gpt-5.5"]),
            "duplicate enabled_models ids are deduped: {dup}"
        );
        let got4 = request(&mut ws, 8, "settings/get", serde_json::json!({})).await;
        assert_eq!(
            got4["result"]["enabled_models"],
            serde_json::json!(["gpt-5.5"]),
            "deduped enabled_models round-trips as a set: {got4}"
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
