//! Slice 1 RED test (Proposal park): when the Worker emits a `propose_entity`
//! `tool_request`, Core persists a Proposal (`pending`) + a `tool_calls` row,
//! sets `runs.status='parked'` + `awaiting_tool_call_id`, and tears the Worker
//! down WITHOUT erroring the Run (ADR-0025: park is a third Worker exit). A
//! Client that subscribes sees `status:"parked"` and NO `done`/`error`;
//! `proposal/get(run_id)` returns the pending Todo Proposal.
//!
//! Driven by `tests/fixtures/propose-worker.ts` over `INKSTONE_WORKER_CMD`,
//! spawned by Core exactly as the real Worker would be.

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

/// Open a fresh socket, send a single request, and return the response body
/// (the first text frame).
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

#[test]
fn parks_on_propose_entity() {
    let worker_cmd = propose_worker_cmd();
    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");
    let (_child, ws_url) = spawn_core(&worker_cmd, &db_path);

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let run_id = rt.block_on(async {
        // Start a Run via thread/create.
        let resp = rpc(
            &ws_url,
            1,
            "thread/create",
            serde_json::json!({ "prompt": "remember to buy milk" }),
        )
        .await;
        let run_id = resp["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — body: {resp}"))
            .to_string();

        // Poll run/subscribe until the Run reports status:"parked" (the Worker
        // boots tsx, then emits the propose_entity request, then Core parks).
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if Instant::now() > deadline {
                panic!("timed out waiting for run to park");
            }
            let resp = rpc(
                &ws_url,
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

        // Subscribe again and assert NO done/error event arrives within a
        // short window (the park is not a terminal Run Event).
        let (mut ws, _r) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .expect("ws handshake");
        let sub = serde_json::json!({
            "jsonrpc": "2.0", "id": 3, "method": "run/subscribe",
            "params": { "run_id": run_id },
        });
        ws.send(Message::Text(sub.to_string().into()))
            .await
            .expect("send subscribe");
        let sub_resp = next_text(&mut ws).await;
        let sub_v: serde_json::Value =
            serde_json::from_str(&sub_resp).expect("subscribe response is JSON");
        assert_eq!(
            sub_v["result"]["status"].as_str(),
            Some("parked"),
            "subscribe response carries status:parked — body: {sub_resp}"
        );

        // Drain events for ~1.5s; none may be a terminal done/error.
        let window = Instant::now() + Duration::from_millis(1500);
        while Instant::now() < window {
            match tokio::time::timeout(Duration::from_millis(300), ws.next()).await {
                Ok(Some(Ok(Message::Text(t)))) => {
                    let v: serde_json::Value = serde_json::from_str(&t).unwrap_or_default();
                    let kind = v["params"]["event"]["kind"].as_str();
                    assert!(
                        kind != Some("done") && kind != Some("error"),
                        "parked run must not emit a terminal done/error — got {t}"
                    );
                }
                Ok(Some(Ok(_))) => {}
                Ok(Some(Err(_))) | Ok(None) => break,
                Err(_) => {} // timeout: no event, keep waiting out the window
            }
        }
        ws.close(None).await.ok();

        // proposal/get returns the pending Todo proposal.
        let resp = rpc(
            &ws_url,
            4,
            "proposal/get",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        let p = &resp["result"];
        assert_eq!(p["kind"].as_str(), Some("todo"), "proposal kind — {resp}");
        assert_eq!(p["status"].as_str(), Some("pending"), "proposal status — {resp}");
        assert_eq!(p["run_id"].as_str(), Some(run_id.as_str()), "proposal run_id — {resp}");
        assert_eq!(p["change_kind"].as_str(), Some("create"), "change_kind — {resp}");
        assert_eq!(p["data"]["title"].as_str(), Some("buy milk"), "data.title — {resp}");

        run_id
    });

    // White-box DB assertions over the same SQLite file.
    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", db_path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        let row = sqlx::query("SELECT status, awaiting_tool_call_id FROM runs WHERE id = ?1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .expect("run row exists");
        let status: String = row.get("status");
        let awaiting: Option<String> = row.get("awaiting_tool_call_id");
        assert_eq!(status, "parked", "runs.status is parked");
        assert!(awaiting.is_some(), "runs.awaiting_tool_call_id is set");

        let prop_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM proposals p \
             JOIN tool_calls tc ON tc.id = p.tool_call_id \
             WHERE tc.run_id = ?1 AND p.status = 'pending'",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("count proposals");
        assert_eq!(prop_count, 1, "exactly one pending proposal");

        let tc_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM tool_calls WHERE run_id = ?1 AND status = 'pending'",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("count tool_calls");
        assert_eq!(tc_count, 1, "exactly one pending tool_call");

        let terminal_events: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM run_events WHERE run_id = ?1 AND kind IN ('done','error')",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("count terminal run_events");
        assert_eq!(terminal_events, 0, "no done/error run_event for a parked run");
    });
}
