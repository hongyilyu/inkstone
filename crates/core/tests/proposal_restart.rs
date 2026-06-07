//! Slice 7 RED test (Parked Run survives a Core restart): a parked Run is
//! durable across a real Core process restart on the same DB. Core #1 parks a
//! Run on a `propose_entity` Proposal; Core #1 is KILLED; Core #2 boots on the
//! SAME `INKSTONE_DB_PATH`. The ADR-0012 boot recovery sweep errors any
//! interrupted `running`/`pending` Runs but MUST preserve `parked` — so via
//! Core #2 the Proposal is still `pending`, `runs.status` is still `parked`
//! (NOT `errored`/`core_restarted`), and `proposal/decide{accept}` resumes the
//! Run to `completed` with a Todo entity in tier 2.
//!
//! This is the property that justifies Strategy B over keep-alive (ADR-0025):
//! durable park across a Core restart. The sweep's `parked` exclusion is the
//! unit under test.
//!
//! Driven by `tests/fixtures/propose-worker.ts` over `INKSTONE_WORKER_CMD`
//! (same fixture the park/decide slices use): spawn 1 proposes & blocks (park);
//! the resume spawn detects `mode === "resume"` and finishes (a `text_delta` +
//! `done`).

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

/// A spawned Core process. Killed on drop (SIGKILL + reap) so a panicking test
/// never leaks a Core. [`kill_and_wait`] performs the explicit restart kill the
/// test relies on (drop is the panic-safety net).
struct CoreChild(Option<Child>);

impl CoreChild {
    /// Explicitly kill Core #1 and wait for it to exit before Core #2 boots on
    /// the same DB — proves a *real* process restart, not a graceful handoff.
    fn kill_and_wait(&mut self) {
        if let Some(c) = self.0.as_mut() {
            let _ = c.kill();
            let _ = c.wait();
        }
        self.0 = None;
    }
}

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

/// Drive a Run to a park on `ws_url`: thread/create, then poll run/subscribe
/// until status=parked. Returns the run_id.
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

/// Poll run/subscribe on `ws_url` until the Run reaches `completed`. Panics on
/// timeout.
async fn await_completed(ws_url: &str, run_id: &str) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if Instant::now() > deadline {
            panic!("timed out waiting for run to complete");
        }
        let resp = rpc(
            ws_url,
            9,
            "run/subscribe",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        if resp["result"]["status"].as_str() == Some("completed") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

#[test]
fn parked_survives_restart() {
    let worker_cmd = propose_worker_cmd();
    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    // ── Core #1: park a Run, then KILL the process. ──────────────────────
    let (mut core1, ws_url_1) = spawn_core(&worker_cmd, &db_path);
    let run_id = rt.block_on(create_and_park(&ws_url_1));
    core1.kill_and_wait();

    // ── Core #2: boot on the SAME DB. The boot recovery sweep runs here. ──
    let (_core2, ws_url_2) = spawn_core(&worker_cmd, &db_path);

    let entity_id = rt.block_on(async {
        // The parked Run survived the restart: its Proposal is still pending.
        let resp = rpc(
            &ws_url_2,
            3,
            "proposal/get",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("pending"),
            "Proposal still pending after restart — body: {resp}"
        );
        let proposal_id = resp["result"]["proposal_id"]
            .as_str()
            .unwrap_or_else(|| panic!("proposal_id is a string — body: {resp}"))
            .to_string();

        // White-box (same sqlite file, ro): the boot sweep PRESERVED the
        // parked Run — it is still `parked`, NOT swept to errored/core_restarted.
        {
            let url = format!("sqlite://{}?mode=ro", db_path.display());
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect(&url)
                .await
                .expect("connect to migrated DB");
            let row = sqlx::query("SELECT status, terminal_reason FROM runs WHERE id = ?1")
                .bind(&run_id)
                .fetch_one(&pool)
                .await
                .expect("run row exists");
            let status: String = row.get("status");
            let terminal_reason: Option<String> = row.get("terminal_reason");
            assert_eq!(
                status, "parked",
                "boot recovery sweep preserved the parked Run (not swept to errored)"
            );
            assert!(
                terminal_reason.is_none(),
                "parked Run has no terminal_reason after the sweep — got {terminal_reason:?}"
            );
        }

        // The parked Run is still DECIDABLE on Core #2: accept resumes it.
        let resp = rpc(
            &ws_url_2,
            4,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "restart-k1",
            }),
        )
        .await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "decide accepted on Core #2 — body: {resp}"
        );
        let entity_id = resp["result"]["entity_id"]
            .as_str()
            .unwrap_or_else(|| panic!("entity_id is a string — body: {resp}"))
            .to_string();

        // The Run resumes in a fresh Worker on Core #2 and reaches completed.
        await_completed(&ws_url_2, &run_id).await;
        entity_id
    });

    // ── White-box: Run completed and the Todo entity exists in tier 2. ───
    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", db_path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        let run_status: String = sqlx::query_scalar("SELECT status FROM runs WHERE id = ?1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .expect("run row exists");
        assert_eq!(run_status, "completed", "run completed after restart + accept resume");

        let row = sqlx::query("SELECT type, data, created_by FROM entities WHERE id = ?1")
            .bind(&entity_id)
            .fetch_one(&pool)
            .await
            .expect("entity row exists");
        let etype: String = row.get("type");
        let created_by: String = row.get("created_by");
        let data: String = row.get("data");
        assert_eq!(etype, "todo", "Todo entity created in tier 2");
        assert_eq!(created_by, "proposal", "entity created_by=proposal");
        let data_json: serde_json::Value = serde_json::from_str(&data).expect("entity data is JSON");
        assert_eq!(
            data_json["title"].as_str(),
            Some("buy milk"),
            "entity data.title — got {data}"
        );
    });
}
