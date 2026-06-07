//! Slice 11 RED test (`entity/list_todos`): after a proposed Todo is accepted
//! (the ADR-0025 park → `proposal/decide{accept}` path), `entity/list_todos`
//! returns it as an `EntityListResult { entities: [...] }` row carrying the
//! Todo's `id`, `type='todo'`, its `data` JSON (`{title:"buy milk", …}`), and
//! the `created_at`/`updated_at` stamps. This is the read the Library's Todos
//! collection consumes live (replacing the mock).
//!
//! Reuses the (two-spawn) `tests/fixtures/propose-worker.ts` over
//! `INKSTONE_WORKER_CMD` to mint the accepted Todo end-to-end, then reads it
//! back over the same wire with the new method.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

use assert_cmd::cargo::CommandCargoExt;
use futures_util::{SinkExt, StreamExt};
use tempfile::TempDir;
use tokio_tungstenite::tungstenite::Message;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("repo root resolves from <repo>/crates/core")
        .to_path_buf()
}

fn propose_worker_cmd() -> String {
    let repo_root = repo_root();
    let tsx = repo_root.join("packages/worker/node_modules/.bin/tsx");
    let fixture = repo_root.join("crates/core/tests/fixtures/propose-worker.ts");
    if !tsx.exists() {
        panic!(
            "worker tsx not installed at {} — run `pnpm install` at repo root",
            tsx.display()
        );
    }
    format!("{} {}", tsx.display(), fixture.display())
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

fn spawn_core(worker_cmd: &str, db_path: &Path) -> (CoreChild, String) {
    let repo_root = repo_root();
    let mut cmd = std::process::Command::cargo_bin("core").expect("core binary exists");
    cmd.current_dir(&repo_root)
        .env("INKSTONE_WORKER_CMD", worker_cmd)
        .env("INKSTONE_DB_PATH", db_path)
        .env("INKSTONE_PORT", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    let mut child = cmd.spawn().expect("core spawns");

    let stdout = child.stdout.take().expect("piped stdout");
    let mut reader = BufReader::new(stdout);
    let deadline = Instant::now() + Duration::from_secs(5);
    let http_url = loop {
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("timed out waiting for INKSTONE_LISTENING line");
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

type Ws = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

async fn next_text(ws: &mut Ws) -> String {
    let frame = tokio::time::timeout(Duration::from_secs(8), ws.next())
        .await
        .expect("frame within 8s")
        .expect("frame present")
        .expect("frame ok");
    match frame {
        Message::Text(t) => t.to_string(),
        other => panic!("expected text frame, got {other:?}"),
    }
}

/// Open a fresh socket, send a single request, return the response body.
async fn rpc(ws_url: &str, id: u64, method: &str, params: serde_json::Value) -> serde_json::Value {
    let (mut ws, _resp) = tokio_tungstenite::connect_async(ws_url)
        .await
        .expect("ws handshake succeeds");
    let req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    ws.send(Message::Text(req.to_string().into()))
        .await
        .expect("send request frame");
    let body = next_text(&mut ws).await;
    ws.close(None).await.ok();
    serde_json::from_str(&body).unwrap_or_else(|e| panic!("response is JSON: {e} — body: {body}"))
}

/// Drive a Run to a park: thread/create, then poll run/subscribe until
/// status=parked. Returns the run_id.
async fn create_and_park(ws_url: &str) -> String {
    let resp = rpc(
        ws_url,
        1,
        "thread/create",
        serde_json::json!({ "prompt": "remember to buy milk" }),
    )
    .await;
    let run_id = resp["result"]["run_id"]
        .as_str()
        .unwrap_or_else(|| panic!("result.run_id is a string — body: {resp}"))
        .to_string();

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if Instant::now() > deadline {
            panic!("timed out waiting for run to park");
        }
        let resp = rpc(
            ws_url,
            2,
            "run/subscribe",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        if resp["result"]["status"].as_str() == Some("parked") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    run_id
}

/// Slice 11: an accepted Todo is returned by `entity/list_todos`. Mint it via
/// the park → accept path, then read it back over the new method and assert the
/// row carries `type='todo'`, the Todo `data` (`title="buy milk"`), and the
/// timestamps.
#[test]
fn list_todos_returns_accepted() {
    let worker_cmd = propose_worker_cmd();
    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");
    let (_child, ws_url) = spawn_core(&worker_cmd, &db_path);

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let run_id = create_and_park(&ws_url).await;

        // Learn the proposal_id and accept it (creates the Todo entity).
        let resp = rpc(
            &ws_url,
            3,
            "proposal/get",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        let proposal_id = resp["result"]["proposal_id"]
            .as_str()
            .unwrap_or_else(|| panic!("proposal_id is a string — body: {resp}"))
            .to_string();

        let resp = rpc(
            &ws_url,
            4,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "k1",
            }),
        )
        .await;
        let entity_id = resp["result"]["entity_id"]
            .as_str()
            .unwrap_or_else(|| panic!("entity_id is a string — body: {resp}"))
            .to_string();

        // The accepted Todo is now visible to `entity/list_todos`.
        let resp = rpc(&ws_url, 5, "entity/list_todos", serde_json::json!({})).await;
        let entities = resp["result"]["entities"]
            .as_array()
            .unwrap_or_else(|| panic!("result.entities is an array — body: {resp}"));
        assert_eq!(entities.len(), 1, "exactly one Todo listed — body: {resp}");

        let row = &entities[0];
        assert_eq!(
            row["id"].as_str(),
            Some(entity_id.as_str()),
            "row id matches the accepted entity — body: {resp}"
        );
        assert_eq!(row["type"].as_str(), Some("todo"), "row type is todo");
        assert_eq!(
            row["data"]["title"].as_str(),
            Some("buy milk"),
            "row data.title is the proposed Todo title — body: {resp}"
        );
        assert!(
            row["created_at"].is_number(),
            "row carries a numeric created_at — body: {resp}"
        );
        assert!(
            row["updated_at"].is_number(),
            "row carries a numeric updated_at — body: {resp}"
        );
    });
}
