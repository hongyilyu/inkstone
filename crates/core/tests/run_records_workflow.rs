//! Slice 3 (real-worker-codex): a Run records the loaded Workflow's
//! `provider` and `model` in the `runs` row — no longer the hardcoded
//! `echo`/`echo`. The echo worker is still spawned this slice (cutover is
//! slice 4), so the Run streams `echo: <prompt>`; what this test pins is the
//! persisted `runs.provider` / `runs.model`, sourced from the loaded
//! `default.toml` via the Dispatcher.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

use assert_cmd::cargo::CommandCargoExt;
use futures_util::{SinkExt, StreamExt};
use sqlx::Row;
use sqlx::sqlite::SqlitePoolOptions;
use tempfile::TempDir;
use tokio_tungstenite::tungstenite::Message;

fn repo_root() -> PathBuf {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .and_then(Path::parent)
        .expect("repo root resolves from <repo>/crates/core")
        .to_path_buf()
}

fn worker_cmd_real() -> String {
    let repo_root = repo_root();
    let tsx = repo_root.join("packages/worker/node_modules/.bin/tsx");
    let cli = repo_root.join("packages/worker/src/cli.ts");
    if !tsx.exists() {
        panic!("worker tsx not installed — run `pnpm install`");
    }
    format!("{} {}", tsx.display(), cli.display())
}

struct CoreChild(Option<Child>);
impl Drop for CoreChild {
    fn drop(&mut self) {
        if let Some(mut c) = self.0.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

/// Spawn Core on an ephemeral port (INKSTONE_PORT=0) so this binary never
/// collides with the fixed-port test binaries. Uses the crate's real
/// `workflows/` dir (no INKSTONE_WORKFLOWS_DIR override) so the assertion
/// pins the shipped default.toml's provider/model.
fn spawn_core(worker_cmd: &str, db_path: &Path) -> (CoreChild, String) {
    let mut child = std::process::Command::cargo_bin("core")
        .expect("core binary exists")
        .current_dir(repo_root())
        .env("INKSTONE_PORT", "0")
        .env("INKSTONE_WORKER_CMD", worker_cmd)
        .env("INKSTONE_DB_PATH", db_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("core spawns");

    let stdout = child.stdout.take().expect("piped stdout");
    let mut reader = BufReader::new(stdout);
    let deadline = Instant::now() + Duration::from_secs(8);
    let http_url = loop {
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("timed out waiting for INKSTONE_LISTENING");
        }
        let mut line = String::new();
        let read = reader.read_line(&mut line).expect("read stdout");
        if read == 0 {
            let _ = child.kill();
            let _ = child.wait();
            panic!("core stdout closed before announcing INKSTONE_LISTENING");
        }
        let trimmed = line.trim_end_matches('\n').trim_end_matches('\r');
        if let Some(rest) = trimmed.strip_prefix("INKSTONE_LISTENING ") {
            break rest.to_string();
        }
    };
    let ws_url = http_url
        .strip_prefix("http://")
        .map(|host| format!("ws://{host}/ws"))
        .expect("INKSTONE_LISTENING URL has http:// prefix");
    (CoreChild(Some(child)), ws_url)
}

#[test]
fn run_row_records_workflow_provider_and_model() {
    let worker_cmd = worker_cmd_real();
    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");
    let (_child, ws_url) = spawn_core(&worker_cmd, &db_path);

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let run_id = rt.block_on(async {
        let (mut ws, _resp) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .expect("ws handshake succeeds");

        let request =
            r#"{"jsonrpc":"2.0","id":1,"method":"thread/create","params":{"prompt":"hi"}}"#;
        ws.send(Message::Text(request.into()))
            .await
            .expect("send request frame");

        let frame = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("response within 5s")
            .expect("frame present")
            .expect("frame ok");
        let body = match frame {
            Message::Text(t) => t.to_string(),
            other => panic!("expected text frame, got {other:?}"),
        };
        let v: serde_json::Value = serde_json::from_str(&body)
            .unwrap_or_else(|e| panic!("response is JSON: {e} — body: {body}"));
        let run_id = v["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — body: {body}"))
            .to_string();

        // Give the initial-run insert time to commit.
        let url = format!("sqlite://{}?mode=ro", db_path.display());
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
        let url = format!("sqlite://{}?mode=ro", db_path.display());
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
