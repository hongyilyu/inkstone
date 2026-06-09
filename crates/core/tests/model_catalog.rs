//! Slice 1 (models-settings, ADR-0024): `model/catalog` serves the embedded
//! `openai-codex` model catalog over the WebSocket. Read-only, no params.
//! Drives a real Core over the wire; the catalog content is drift-tested
//! against `pi-ai` in `packages/worker/src/models-catalog.test.ts`.

use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{Workspace, next_text};

#[test]
fn model_catalog_returns_openai_codex_models() {
    let workspace = Workspace::new();
    let core = workspace.core().spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let mut ws = core.connect().await;

        ws.send(Message::Text(
            r#"{"jsonrpc":"2.0","id":1,"method":"model/catalog","params":{}}"#.into(),
        ))
        .await
        .expect("send model/catalog");

        let body = next_text(&mut ws).await;
        let v: serde_json::Value = serde_json::from_str(&body).expect("model/catalog json");

        let providers = v["result"]["providers"]
            .as_array()
            .expect("providers array");
        let codex = providers
            .iter()
            .find(|p| p["id"] == serde_json::json!("openai-codex"))
            .expect("openai-codex provider present");

        let models = codex["models"].as_array().expect("models array");
        assert_eq!(models.len(), 10, "openai-codex ships 10 models");

        let gpt55 = models
            .iter()
            .find(|m| m["id"] == serde_json::json!("gpt-5.5"))
            .expect("gpt-5.5 present in catalog");
        assert_eq!(gpt55["name"], serde_json::json!("GPT-5.5"));
        assert_eq!(
            gpt55["reasoning"],
            serde_json::json!(true),
            "gpt-5.5 is reasoning-capable"
        );
        assert!(
            gpt55["cost_input"].is_number(),
            "cost_input is a bare number"
        );

        ws.close(None).await.ok();
    });
}
