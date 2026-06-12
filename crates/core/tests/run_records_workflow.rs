//! A Run records the loaded Workflow's `provider` and `model` in the `runs`
//! row, sourced from `default.toml` via the Dispatcher (not hardcoded).

use std::time::{Duration, Instant};

use futures_util::SinkExt;
use sqlx::Row;
use sqlx::sqlite::SqlitePoolOptions;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{Workspace, next_text};

#[test]
fn run_row_records_workflow_provider_and_model() {
    let workspace = Workspace::new();
    // No INKSTONE_WORKFLOWS_DIR override: pins the shipped default.toml's
    // provider/model.
    let core = workspace.core().worker_fixture("slow-worker.ts").spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let run_id = rt.block_on(async {
        let mut ws = core.connect().await;

        let request =
            r#"{"jsonrpc":"2.0","id":1,"method":"thread/create","params":{"prompt":"hi"}}"#;
        ws.send(Message::Text(request.into()))
            .await
            .expect("send request frame");

        let body = next_text(&mut ws).await;
        let v: serde_json::Value = serde_json::from_str(&body)
            .unwrap_or_else(|e| panic!("response is JSON: {e} — body: {body}"));
        let run_id = v["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — body: {body}"))
            .to_string();

        // Give the initial-run insert time to commit.
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let exists: Option<String> =
                sqlx::query_scalar("SELECT id FROM runs WHERE id = ?1")
                    .bind(&run_id)
                    .fetch_optional(&pool)
                    .await
                    .expect("poll run row");
            if exists.is_some() {
                break;
            }
            if Instant::now() > deadline {
                panic!("timed out waiting for the run row to be inserted");
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        ws.close(None).await.ok();
        run_id
    });

    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");
        let row = sqlx::query(
            "SELECT workflow_name, workflow_version, provider, model FROM runs WHERE id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("read run row");
        let name: String = row.get("workflow_name");
        let version: String = row.get("workflow_version");
        let provider: String = row.get("provider");
        let model: String = row.get("model");
        assert_eq!(name, "default", "workflow_name from default.toml");
        assert_eq!(version, "1.0.0", "workflow_version from default.toml");
        assert_eq!(
            provider, "openai-codex",
            "runs.provider sourced from the workflow, not hardcoded echo"
        );
        assert_eq!(
            model, "gpt-5.5",
            "runs.model sourced from the workflow, not hardcoded echo"
        );
    });
}
