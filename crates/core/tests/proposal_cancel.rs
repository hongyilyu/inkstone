//! Slice 6 RED test (cancel a parked Run): `run/cancel{run_id}` on a parked
//! Run cancels the Run and its pending Proposal in one transaction. The
//! response is `{outcome:"accepted"}`; white-box, `runs.status='cancelled'` and
//! the Proposal `status='cancelled'`. A subsequent `proposal/decide{accept}`
//! then returns `proposal_not_pending` and creates NO entity (the Proposal is
//! no longer pending — the decide validation reuses that gate).
//!
//! Driven by `tests/fixtures/propose-worker.ts` over `INKSTONE_WORKER_CMD`:
//! spawn 1 proposes & blocks (park). No resume Worker runs — cancel is pure
//! tier-2 (the parked Worker is already torn down on park).

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

use assert_cmd::cargo::CommandCargoExt;
use futures_util::{SinkExt, StreamExt};
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

#[test]
fn cancel_parked_run() {
    let worker_cmd = propose_worker_cmd();
    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");
    let (_child, ws_url) = spawn_core(&worker_cmd, &db_path);

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let run_id = rt.block_on(async {
        let run_id = create_and_park(&ws_url).await;

        // Learn the proposal_id (used to attempt a post-cancel decide).
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

        // run/cancel the parked Run → outcome accepted.
        let resp = rpc(
            &ws_url,
            4,
            "run/cancel",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        assert_eq!(
            resp["result"]["outcome"].as_str(),
            Some("accepted"),
            "cancel outcome — body: {resp}"
        );

        // A subsequent proposal/decide{accept} → proposal_not_pending.
        let resp = rpc(
            &ws_url,
            5,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "after-cancel",
            }),
        )
        .await;
        assert_eq!(
            resp["error"]["code"].as_i64(),
            Some(-32002),
            "decide after cancel → proposal_not_pending — body: {resp}"
        );

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

        // runs.status='cancelled'.
        let run_status: String = sqlx::query_scalar("SELECT status FROM runs WHERE id = ?1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .expect("run row exists");
        assert_eq!(run_status, "cancelled", "run cancelled");

        // The Proposal status='cancelled'.
        let prop_status: String = sqlx::query_scalar(
            "SELECT p.status FROM proposals p \
             JOIN tool_calls tc ON tc.id = p.tool_call_id WHERE tc.run_id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("proposal row exists");
        assert_eq!(prop_status, "cancelled", "proposal cancelled");

        // No entity was created (the post-cancel decide was rejected).
        let entity_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM entities WHERE created_via_proposal_id IN \
             (SELECT p.id FROM proposals p JOIN tool_calls tc ON tc.id = p.tool_call_id \
              WHERE tc.run_id = ?1)",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("count entities");
        assert_eq!(entity_count, 0, "cancel + failed decide created no entity");
    });
}
