//! `settings/get` + `settings/set` (ADR-0024): the preferred model and global
//! effort persist in tier-2 and round-trip over the wire; an unknown model or
//! invalid effort is rejected with `invalid_params` (-32602) and writes
//! nothing.

use futures_util::SinkExt;
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

        // Defaults before any set: no model *chosen* (preference null), but the
        // per-provider default is reported so the composer shows what a Run would
        // use; effort "off", provider is the default Workflow's (openai-codex).
        let got = request(&mut ws, 1, "settings/get", serde_json::json!({})).await;
        assert_eq!(got["result"]["provider"], serde_json::json!("openai-codex"));
        assert_eq!(got["result"]["model"], serde_json::Value::Null);
        assert_eq!(got["result"]["default_model"], serde_json::json!("gpt-5.5"));
        assert_eq!(got["result"]["effort"], serde_json::json!("off"));

        // Set both; the response echoes the updated state.
        let set = request(
            &mut ws,
            2,
            "settings/set",
            serde_json::json!({ "model": "gpt-5.4", "effort": "high" }),
        )
        .await;
        assert_eq!(set["result"]["model"], serde_json::json!("gpt-5.4"));
        assert_eq!(set["result"]["effort"], serde_json::json!("high"));

        // A fresh get reads the persisted values.
        let got2 = request(&mut ws, 3, "settings/get", serde_json::json!({})).await;
        assert_eq!(got2["result"]["model"], serde_json::json!("gpt-5.4"));
        assert_eq!(got2["result"]["effort"], serde_json::json!("high"));

        // Partial update: changing only the effort leaves the model intact.
        let set_effort = request(
            &mut ws,
            4,
            "settings/set",
            serde_json::json!({ "effort": "low" }),
        )
        .await;
        assert_eq!(set_effort["result"]["model"], serde_json::json!("gpt-5.4"));
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
        assert_eq!(got3["result"]["model"], serde_json::json!("gpt-5.4"));
        assert_eq!(got3["result"]["effort"], serde_json::json!("low"));

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
