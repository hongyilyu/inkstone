//! Slice 3 RED test (Proposal accept): `proposal/decide{decision:"accept"}` on
//! a parked Run applies the Proposal atomically (a Todo entity lands in tier 2)
//! and resumes the Run in a FRESH Worker seeded with the reconstructed
//! transcript (ending in the Decision `tool_result`). The Run reaches
//! `completed`. A second decide with the same `decision_idempotency_key`
//! returns the prior result and does NOT double-apply.
//!
//! Driven by the (now two-spawn) `tests/fixtures/propose-worker.ts` over
//! `INKSTONE_WORKER_CMD`: spawn 1 proposes & blocks (park); spawn 2 detects
//! `mode === "resume"` and finishes (a `text_delta` + `done`).

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
    spawn_core_with_env(worker_cmd, db_path, &[])
}

fn spawn_core_with_env(
    worker_cmd: &str,
    db_path: &Path,
    extra_env: &[(&str, &str)],
) -> (CoreChild, String) {
    let repo_root = repo_root();
    let mut cmd = std::process::Command::cargo_bin("core").expect("core binary exists");
    cmd.current_dir(&repo_root)
        .env("INKSTONE_WORKER_CMD", worker_cmd)
        .env("INKSTONE_DB_PATH", db_path)
        .env("INKSTONE_PORT", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
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

/// Poll run/subscribe until the Run reaches `completed` (terminal). Panics on
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
fn accept_applies_and_resumes() {
    let worker_cmd = propose_worker_cmd();
    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");
    let (_child, ws_url) = spawn_core(&worker_cmd, &db_path);

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let (run_id, entity_id) = rt.block_on(async {
        let run_id = create_and_park(&ws_url).await;

        // Learn the proposal_id.
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

        // Decide: accept.
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
        let result = &resp["result"];
        assert_eq!(
            result["status"].as_str(),
            Some("accepted"),
            "decide result status — body: {resp}"
        );
        let entity_id = result["entity_id"]
            .as_str()
            .unwrap_or_else(|| panic!("entity_id is a string — body: {resp}"))
            .to_string();

        // The Run resumes in a fresh Worker and reaches completed.
        await_completed(&ws_url, &run_id).await;

        (run_id, entity_id)
    });

    // White-box DB assertions.
    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", db_path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        // One todo entity, created via the proposal, data.title="buy milk".
        let row = sqlx::query(
            "SELECT type, data, created_by, created_via_proposal_id FROM entities WHERE id = ?1",
        )
        .bind(&entity_id)
        .fetch_one(&pool)
        .await
        .expect("entity row exists");
        let etype: String = row.get("type");
        let data: String = row.get("data");
        let created_by: String = row.get("created_by");
        let via: Option<String> = row.get("created_via_proposal_id");
        assert_eq!(etype, "todo", "entity type is todo");
        assert_eq!(created_by, "proposal", "entity created_by=proposal");
        assert!(via.is_some(), "entity carries created_via_proposal_id");
        let data_json: serde_json::Value = serde_json::from_str(&data).expect("entity data is JSON");
        assert_eq!(
            data_json["title"].as_str(),
            Some("buy milk"),
            "entity data.title — got {data}"
        );

        // entity_revisions seq 1.
        let rev_seq: i64 = sqlx::query_scalar(
            "SELECT seq FROM entity_revisions WHERE entity_id = ?1 ORDER BY seq DESC LIMIT 1",
        )
        .bind(&entity_id)
        .fetch_one(&pool)
        .await
        .expect("entity_revision row exists");
        assert_eq!(rev_seq, 1, "first entity revision is seq 1");

        // proposals.status='accepted'.
        let prop_status: String = sqlx::query_scalar(
            "SELECT p.status FROM proposals p \
             JOIN tool_calls tc ON tc.id = p.tool_call_id WHERE tc.run_id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("proposal row exists");
        assert_eq!(prop_status, "accepted", "proposal accepted");

        // tool_calls resolved (completed).
        let tc_status: String =
            sqlx::query_scalar("SELECT status FROM tool_calls WHERE run_id = ?1")
                .bind(&run_id)
                .fetch_one(&pool)
                .await
                .expect("tool_call row exists");
        assert_eq!(tc_status, "completed", "tool_call resolved");

        // runs.status='completed'.
        let run_status: String = sqlx::query_scalar("SELECT status FROM runs WHERE id = ?1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .expect("run row exists");
        assert_eq!(run_status, "completed", "run completed");
    });
}

/// Slice 4 (Proposal reject): `proposal/decide{decision:"reject"}` on a parked
/// Run resolves the Decision WITHOUT applying — no entity lands in tier 2, the
/// Proposal becomes `rejected`, the awaited tool_call resolves as a NORMAL
/// (non-error) declined result, and the Run resumes in a fresh Worker to
/// `completed` (the model reads the decline and wraps up conversationally).
#[test]
fn reject_resumes_without_applying() {
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

        // Learn the proposal_id.
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

        // Decide: reject.
        let resp = rpc(
            &ws_url,
            4,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "reject",
                "decision_idempotency_key": "r1",
            }),
        )
        .await;
        let result = &resp["result"];
        assert_eq!(
            result["status"].as_str(),
            Some("rejected"),
            "decide result status — body: {resp}"
        );
        assert!(
            result["entity_id"].is_null() || result.get("entity_id").is_none(),
            "reject result carries no entity_id — body: {resp}"
        );

        // The Run resumes in a fresh Worker and reaches completed.
        await_completed(&ws_url, &run_id).await;
        run_id
    });

    // White-box DB assertions.
    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", db_path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        // ZERO entities for this run's proposal — reject applies nothing.
        let entity_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM entities WHERE created_via_proposal_id IN \
             (SELECT p.id FROM proposals p JOIN tool_calls tc ON tc.id = p.tool_call_id \
              WHERE tc.run_id = ?1)",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("count entities");
        assert_eq!(entity_count, 0, "reject created no entity");

        // proposals.status='rejected'.
        let prop_status: String = sqlx::query_scalar(
            "SELECT p.status FROM proposals p \
             JOIN tool_calls tc ON tc.id = p.tool_call_id WHERE tc.run_id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("proposal row exists");
        assert_eq!(prop_status, "rejected", "proposal rejected");

        // tool_calls resolved (completed) — a NORMAL result, not errored.
        let row = sqlx::query("SELECT status, result_payload FROM tool_calls WHERE run_id = ?1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .expect("tool_call row exists");
        let tc_status: String = row.get("status");
        let result_payload: Option<String> = row.get("result_payload");
        assert_eq!(tc_status, "completed", "tool_call resolved (not errored)");
        let payload = result_payload.expect("tool_call carries a result_payload");
        let payload_json: serde_json::Value =
            serde_json::from_str(&payload).expect("result_payload is JSON");
        // The decline result must NOT be flagged as an error (ADR-0025): a
        // normal Tool Result so the resumed model continues conversationally.
        assert_ne!(
            payload_json["is_error"].as_bool(),
            Some(true),
            "decline result is not an error — payload: {payload}"
        );
        assert_ne!(
            payload_json["decision"].as_str(),
            Some("accept"),
            "decline result is a reject decision — payload: {payload}"
        );

        // runs.status='completed'.
        let run_status: String = sqlx::query_scalar("SELECT status FROM runs WHERE id = ?1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .expect("run row exists");
        assert_eq!(run_status, "completed", "run completed after reject resume");
    });
}

#[test]
fn accept_is_idempotent() {
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

        let first = rpc(
            &ws_url,
            4,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "same-key",
            }),
        )
        .await;
        let first_entity = first["result"]["entity_id"]
            .as_str()
            .unwrap_or_else(|| panic!("first decide entity_id — body: {first}"))
            .to_string();

        await_completed(&ws_url, &run_id).await;

        // Second decide, same key → same result, no second entity.
        let second = rpc(
            &ws_url,
            5,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "same-key",
            }),
        )
        .await;
        assert_eq!(
            second["result"]["status"].as_str(),
            Some("accepted"),
            "second decide returns accepted — body: {second}"
        );
        assert_eq!(
            second["result"]["entity_id"].as_str(),
            Some(first_entity.as_str()),
            "second decide returns the SAME entity_id — body: {second}"
        );

        run_id
    });

    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", db_path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        let entity_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM entities WHERE created_via_proposal_id IN \
             (SELECT p.id FROM proposals p JOIN tool_calls tc ON tc.id = p.tool_call_id \
              WHERE tc.run_id = ?1)",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("count entities");
        assert_eq!(entity_count, 1, "idempotent decide created exactly one entity");
    });
}

/// Multi-step reconstruction (ADR-0025 core risk): the worker's first spawn
/// does a real `read_thread` tool_call (Core executes + resolves it
/// synchronously) BEFORE the `propose_entity` that parks. On accept the Run
/// resumes, and Core must rebuild a provider-valid MULTI-step transcript — a
/// prior resolved tool_call rendered as a paired `tool_result`, the
/// text-then-tool_call assistant split, and the Decision `tool_result` last,
/// with NO orphan `tool_result`. If reconstruction emitted an orphan or dropped
/// a pair the resume Worker's provider would reject the transcript and the Run
/// would not reach `completed`; reaching `completed` proves the transcript is
/// well-formed.
#[test]
fn accept_resumes_after_multistep_transcript() {
    let worker_cmd = propose_worker_cmd();
    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");
    let (_child, ws_url) = spawn_core_with_env(&worker_cmd, &db_path, &[("INKSTONE_MULTISTEP", "1")]);

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let run_id = rt.block_on(async {
        let run_id = create_and_park(&ws_url).await;

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
                "decision_idempotency_key": "k-multistep",
            }),
        )
        .await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "decide result status — body: {resp}"
        );

        // The Run resumes from the reconstructed MULTI-step transcript and
        // reaches completed — proving the transcript is provider-valid.
        await_completed(&ws_url, &run_id).await;
        run_id
    });

    // White-box: the read_thread tool_call AND the propose tool_call both
    // resolved (no orphan), and the run completed.
    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", db_path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        let resolved: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM tool_calls WHERE run_id = ?1 AND status IN ('completed','errored')",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("count tool_calls");
        assert_eq!(resolved, 2, "both read_thread and propose tool_calls resolved");

        let run_status: String = sqlx::query_scalar("SELECT status FROM runs WHERE id = ?1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .expect("run row exists");
        assert_eq!(run_status, "completed", "run completed after multi-step resume");
    });
}
