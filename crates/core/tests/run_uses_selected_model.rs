//! A Run uses the user's selected model and global effort (ADR-0024). After
//! `settings/set`, a new Run's `runs.model` is the selected model (not the
//! per-provider default) and the manifest carries the selected model + effort —
//! observed via a manifest-capture worker that echoes `model=<m>|effort=<e>`.

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

#[test]
fn run_uses_selected_model_and_effort() {
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("manifest-capture.ts").spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let run_id = rt.block_on(async {
        let mut ws = core.connect().await;

        // A non-default model + effort, so the assertions prove the selection
        // won, not the fallback.
        let set = request(
            &mut ws,
            1,
            "settings/set",
            serde_json::json!({ "model": "gpt-5.4", "effort": "high" }),
        )
        .await;
        assert_eq!(set["result"]["model"], serde_json::json!("gpt-5.4"));

        let created = request(&mut ws, 2, "thread/create", serde_json::json!({ "prompt": "hi" })).await;
        let run_id = created["result"]["run_id"]
            .as_str()
            .expect("run_id string")
            .to_string();

        ws.close(None).await.ok();
        run_id
    });

    // Poll the DB: the run row records the selected model, and once the worker
    // completes, the assistant text echoes the model + effort the manifest
    // carried.
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
                "SELECT r.model AS model, mp.text AS text \
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
                let model: String = row.get("model");
                let text: String = row.get("text");
                assert_eq!(model, "gpt-5.4", "runs.model is the SELECTED model");
                if !text.is_empty() {
                    assert_eq!(
                        text, "model=gpt-5.4|effort=high",
                        "manifest carried the selected model + global effort"
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
