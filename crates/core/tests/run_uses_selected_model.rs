//! A Run uses the user's selected model and global effort (ADR-0024), and its
//! provider is DERIVED from that model (ADR-0062): selecting an OpenRouter model
//! routes the Run to the `openrouter` provider, not the default `openai-codex`.
//!
//! After `settings/set`, a new Run's `runs.model` is the selected model (not the
//! per-provider default), `runs.provider` is the provider whose catalog group
//! contains that model, and the manifest carries the selected model + effort +
//! provider — observed via a manifest-capture worker that echoes
//! `model=<m>|effort=<e>|provider=<p>`.

use std::time::{Duration, Instant};

use futures_util::SinkExt;
use sqlx::Row;
use sqlx::sqlite::SqlitePoolOptions;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{Workspace, Ws, next_text};

async fn request(ws: &mut Ws, id: u64, method: &str, params: serde_json::Value) -> serde_json::Value {
    let req = serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    ws.send(Message::Text(req.to_string().into()))
        .await
        .expect("send request");
    let body = next_text(ws).await;
    serde_json::from_str(&body).expect("json response")
}

/// Drive one selection→run and assert the resolved model + provider. Sets the
/// model (effort "high" — a non-default that proves the selection won, not the
/// fallback), creates a Run, then polls the DB for `runs.model`/`runs.provider`
/// and the assistant text echoing the manifest the Worker received.
fn assert_run_resolves(model: &str, expected_provider: &str) {
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("manifest-capture.ts").spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let run_id = rt.block_on(async {
        let mut ws = core.connect().await;

        let set = request(
            &mut ws,
            1,
            "settings/set",
            serde_json::json!({ "model": model, "effort": "high" }),
        )
        .await;
        assert_eq!(set["result"]["model"], serde_json::json!(model));

        let created = request(&mut ws, 2, "thread/create", serde_json::json!({ "prompt": "hi" })).await;
        let run_id = created["result"]["run_id"]
            .as_str()
            .expect("run_id string")
            .to_string();

        ws.close(None).await.ok();
        run_id
    });

    // Poll the DB: the run row records the selected model + derived provider, and
    // once the worker completes, the assistant text echoes the model + effort +
    // provider the manifest carried.
    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let row = sqlx::query(
                "SELECT r.model AS model, r.provider AS provider, mp.text AS text \
                 FROM runs r \
                 JOIN messages m ON m.run_id = r.id AND m.role = 'assistant' \
                 JOIN message_parts mp ON mp.message_id = m.id AND mp.seq = 0 \
                 WHERE r.id = ?1",
            )
            .bind(&run_id)
            .fetch_optional(&pool)
            .await
            .expect("query run + assistant text");

            if let Some(row) = row {
                let db_model: String = row.get("model");
                let db_provider: String = row.get("provider");
                let text: String = row.get("text");
                assert_eq!(db_model, model, "runs.model is the SELECTED model");
                assert_eq!(
                    db_provider, expected_provider,
                    "runs.provider is DERIVED from the selected model"
                );
                if !text.is_empty() {
                    assert_eq!(
                        text,
                        format!("model={model}|effort=high|provider={expected_provider}"),
                        "manifest carried the selected model + global effort + derived provider"
                    );
                    break;
                }
            }
            if Instant::now() > deadline {
                panic!("timed out waiting for the assistant text to reflect the manifest");
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    });
}

#[test]
fn run_uses_selected_model_and_effort() {
    // A codex catalog model derives the default `openai-codex` provider (no
    // regression from before provider derivation existed).
    assert_run_resolves("gpt-5.5", "openai-codex");
}

#[test]
fn openrouter_model_routes_to_openrouter_provider() {
    // An OpenRouter catalog model (known after slice 3) derives the `openrouter`
    // provider — NOT the default `openai-codex` from the Workflow TOML.
    assert_run_resolves("anthropic/claude-opus-4.8", "openrouter");
}
