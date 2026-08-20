//! The TickTick write family end-to-end over a REAL Core process + a fake
//! TickTick OpenAPI server (ticktick-writes W2): propose → park → accept →
//! ONE POST → settle → resume, with the detached decide keeping the socket
//! live during phase B, the Stop-mid-write refusal, and credential-swap
//! honesty across real process restarts.
//!
//! Driven by `tests/fixtures/propose-ticktick-worker.ts`: spawn 1 proposes
//! `propose_ticktick_task` & parks; spawn 2 detects `mode === "resume"` and
//! echoes the Decision tool_result content (`resume-result=…`).

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

mod common;
use common::{
    Workspace, await_completed, await_parked, next_text, proposal_id_for, read_response_with_id,
    rpc, rt, send,
};

/// One request → the response with the SAME id, skipping interleaved
/// notifications (`rpc` takes the FIRST frame, which for a write-family
/// decide may be a `proposal/changed`).
async fn rpc_skipping_notifications(
    core: &common::CoreHandle,
    id: i64,
    method: &str,
    params: serde_json::Value,
) -> serde_json::Value {
    let mut ws = core.connect().await;
    send(
        &mut ws,
        serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
            .to_string(),
    )
    .await;
    let response = read_response_with_id(&mut ws, id).await;
    ws.close(None).await.ok();
    response
}

/// A blocking fake of TickTick's `POST /open/v1/task` on a background thread:
/// serves `budget` requests (then exits, joinable), counts them, optionally
/// delaying each response. Non-POST/unknown paths get a 200 `[]` (the filter
/// read, unused here). Returns `(base_url, post_count, join_handle)`.
/// A joinable fake server: `stop()` unblocks a thread still waiting in
/// `accept()` (a test that expects ZERO requests would otherwise leak the
/// thread + listener on every run) and then joins it.
struct FakeServer {
    handle: std::thread::JoinHandle<()>,
    addr: std::net::SocketAddr,
}

impl FakeServer {
    fn stop(self) {
        // Spend the server's remaining budget with throwaway connections so a
        // blocked `accept()` returns, then join.
        while !self.handle.is_finished() {
            if std::net::TcpStream::connect(self.addr).is_err() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        self.handle.join().expect("fake server thread joins");
    }
}

fn start_fake_ticktick_write(
    budget: usize,
    delay: Duration,
) -> (String, Arc<AtomicUsize>, FakeServer) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake ticktick");
    let addr = listener.local_addr().expect("addr");
    let posts = Arc::new(AtomicUsize::new(0));
    let posts_in_server = posts.clone();

    let handle = std::thread::spawn(move || {
        for _ in 0..budget {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut buf = [0u8; 16384];
            let n = stream.read(&mut buf).unwrap_or(0);
            let head = String::from_utf8_lossy(&buf[..n]).to_string();
            let body = if head.starts_with("POST /open/v1/task ")
                || head.starts_with("POST /open/v1/task\r")
            {
                posts_in_server.fetch_add(1, Ordering::SeqCst);
                std::thread::sleep(delay);
                // The created task, as W1 observed it (200 + the task body).
                r#"{"id":"tt-e2e-1","projectId":"inbox-e2e","title":"buy milk","status":0}"#
                    .to_string()
            } else {
                std::thread::sleep(delay);
                "[]".to_string()
            };
            let resp = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.flush();
        }
    });
    (format!("http://{addr}"), posts, FakeServer { handle, addr })
}

/// Write the boot-read TickTick credential (0600) into `creds_dir`.
fn write_ticktick_credential(creds_dir: &std::path::Path, token: &str) {
    std::fs::create_dir_all(creds_dir).expect("mk creds dir");
    let cred_path = creds_dir.join("ticktick.json");
    std::fs::write(
        &cred_path,
        format!(
            r#"{{"access_token":"{token}","token_type":"bearer","scope":"tasks:read tasks:write"}}"#
        ),
    )
    .expect("write ticktick credential");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cred_path, std::fs::Permissions::from_mode(0o600))
            .expect("chmod 0600");
    }
}

/// The fake-HTTP e2e (the plan's W2 verify): propose → park → accept → the
/// POST hits the fake server (exactly once) → the decide response carries
/// `ticktick_write.created` + the task id → the resumed transcript carries
/// the created Decision content → the Run completes. The deciding socket also
/// receives `proposal/changed` TWICE (executing, then created).
#[test]
fn accept_posts_once_and_resumes_with_created_content() {
    let (api_url, posts, server) = start_fake_ticktick_write(1, Duration::ZERO);
    let workspace = Workspace::new();
    let creds_dir = workspace.path().join("credentials");
    write_ticktick_credential(&creds_dir, "tok_write_e2e");

    let core = workspace
        .core()
        .worker_fixture("propose-ticktick-worker.ts")
        .env("INKSTONE_CREDENTIALS_DIR", &creds_dir)
        .env("INKSTONE_TICKTICK_API_URL", &api_url)
        .spawn();

    let rt = rt();
    rt.block_on(async {
        // Propose + park.
        let resp = rpc(
            &core,
            1,
            "thread/create",
            serde_json::json!({ "prompt": "remind me to buy milk" }),
        )
        .await;
        let run_id = resp["result"]["run_id"].as_str().unwrap().to_string();
        await_parked(&core, &run_id).await;

        // The pending proposal reads the derived kind + the fresh `proposed`
        // write state (stale_connection false — same boot, same credential).
        let proposal = rpc(
            &core,
            2,
            "proposal/get",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        assert_eq!(
            proposal["result"]["mutation_kind"],
            serde_json::json!("create_ticktick_task")
        );
        assert_eq!(
            proposal["result"]["ticktick_write"],
            serde_json::json!({ "state": "proposed", "stale_connection": false })
        );
        let proposal_id = proposal["result"]["proposal_id"].as_str().unwrap();

        // Accept on ONE socket, reading the interleaved frames: the response
        // carries the created outcome; proposal/changed fires twice.
        let mut ws = core.connect().await;
        send(
            &mut ws,
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 10,
                "method": "proposal/decide",
                "params": {
                    "proposal_id": proposal_id,
                    "decision": "accept",
                    "decision_idempotency_key": "k-e2e",
                },
            })
            .to_string(),
        )
        .await;

        // Read frames until the response AND both notifications arrived: the
        // accept notification (executing) precedes the response; the settle
        // notification follows it.
        let mut changed = Vec::new();
        let mut response = None;
        while changed.len() < 2 || response.is_none() {
            let body = next_text(&mut ws).await;
            let frame: serde_json::Value = serde_json::from_str(&body).expect("frame is JSON");
            if frame["method"] == serde_json::json!("proposal/changed") {
                changed.push(frame["params"].clone());
                continue;
            }
            if frame["id"] == serde_json::json!(10) {
                response = Some(frame);
            }
        }
        let response = response.unwrap();
        assert_eq!(response["result"]["status"], serde_json::json!("accepted"));
        assert_eq!(
            response["result"]["ticktick_write"],
            serde_json::json!({ "state": "created", "task_id": "tt-e2e-1" }),
            "the decide response carries the created outcome — body: {response}"
        );
        assert_eq!(posts.load(Ordering::SeqCst), 1, "exactly one POST");

        // proposal/changed ×2 on the deciding connection: executing → created.
        assert_eq!(changed.len(), 2, "accept + settle notifications: {changed:?}");
        assert_eq!(
            changed[0]["ticktick_write"]["state"],
            serde_json::json!("executing")
        );
        assert!(
            changed[0]["ticktick_write"]["deadline_at"].is_i64(),
            "the executing notification carries the Core-computed deadline"
        );
        assert_eq!(
            changed[1]["ticktick_write"],
            serde_json::json!({ "state": "created", "task_id": "tt-e2e-1" })
        );
        ws.close(None).await.ok();

        // The resumed Worker echoed the Decision tool_result content.
        await_completed(&core, &run_id).await;
        let thread = rpc(
            &core,
            20,
            "thread/get",
            serde_json::json!({ "thread_id": resp["result"]["thread_id"] }),
        )
        .await;
        let text = thread["result"]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|m| m["segments"].as_array().unwrap())
            .filter(|s| s["kind"] == serde_json::json!("text"))
            .map(|s| s["text"].as_str().unwrap_or_default())
            .collect::<String>();
        assert!(
            text.contains("Accepted. Created \\\"buy milk\\\" in TickTick (task tt-e2e-1).")
                || text.contains("Accepted. Created \"buy milk\" in TickTick (task tt-e2e-1)."),
            "the resume transcript carried the created content: {text}"
        );

        // The durable segment carries the created state (reload == live).
        let proposal_segment = thread["result"]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|m| m["segments"].as_array().unwrap())
            .find(|s| s["kind"] == serde_json::json!("proposal"))
            .expect("the decided proposal rehydrates");
        assert_eq!(
            proposal_segment["ticktick_write"],
            serde_json::json!({ "state": "created", "task_id": "tt-e2e-1" })
        );
    });

    drop(core);
    server.stop();
}

/// THE SOCKET STAYS LIVE DURING PHASE B (W-A3's detached decide): with the
/// fake server holding the POST open, a second request on the SAME socket is
/// answered while the decide is still in flight — and a same-socket
/// `run/cancel` mid-B is refused `write_in_flight` (the accept → held-POST →
/// Stop race, same-socket shape), after which the real outcome lands.
#[test]
fn socket_stays_live_and_stop_mid_b_is_refused() {
    let (api_url, posts, server) = start_fake_ticktick_write(1, Duration::from_millis(1200));
    let workspace = Workspace::new();
    let creds_dir = workspace.path().join("credentials");
    write_ticktick_credential(&creds_dir, "tok_write_e2e");

    let core = workspace
        .core()
        .worker_fixture("propose-ticktick-worker.ts")
        .env("INKSTONE_CREDENTIALS_DIR", &creds_dir)
        .env("INKSTONE_TICKTICK_API_URL", &api_url)
        .spawn();

    let rt = rt();
    rt.block_on(async {
        let resp = rpc(
            &core,
            1,
            "thread/create",
            serde_json::json!({ "prompt": "remind me to buy milk" }),
        )
        .await;
        let run_id = resp["result"]["run_id"].as_str().unwrap().to_string();
        await_parked(&core, &run_id).await;
        let proposal_id = proposal_id_for(&core, &run_id).await;

        let mut ws = core.connect().await;
        // The decide (held by the fake server for ~1.2s)…
        send(
            &mut ws,
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 10,
                "method": "proposal/decide",
                "params": {
                    "proposal_id": proposal_id,
                    "decision": "accept",
                    "decision_idempotency_key": "k-stop",
                },
            })
            .to_string(),
        )
        .await;
        // …then, on the SAME socket, a status read and a Stop.
        send(
            &mut ws,
            serde_json::json!({
                "jsonrpc": "2.0", "id": 11, "method": "ticktick/status", "params": {}
            })
            .to_string(),
        )
        .await;
        send(
            &mut ws,
            serde_json::json!({
                "jsonrpc": "2.0", "id": 12, "method": "run/cancel",
                "params": { "run_id": run_id },
            })
            .to_string(),
        )
        .await;

        // Both answers arrive BEFORE the decide's — the socket loop is not
        // frozen by phase B — and the Stop is refused write_in_flight.
        let mut order = Vec::new();
        let mut cancel_outcome = None;
        while cancel_outcome.is_none() {
            let body = next_text(&mut ws).await;
            let frame: serde_json::Value = serde_json::from_str(&body).expect("frame is JSON");
            match frame["id"].as_i64() {
                Some(11) => order.push(11),
                Some(12) => {
                    order.push(12);
                    cancel_outcome = Some(frame["result"]["outcome"].clone());
                }
                Some(10) => order.push(10),
                _ => {}
            }
        }
        assert_eq!(
            order,
            vec![11, 12],
            "status and Stop answered while the decide held the POST"
        );
        assert_eq!(
            cancel_outcome.unwrap(),
            serde_json::json!("write_in_flight"),
            "Stop mid-B is refused honestly"
        );

        // The SECOND-CONNECTION Stop shape (the other half of the W-A4 race):
        // with the write CONFIRMED mid-B (the refusal above), a fresh socket's
        // cancel is refused the same way while the POST is still held. (A Stop
        // that instead beats phase A legitimately cancels a still-pending
        // proposal — that is the matrix's `proposed` arm, not this test.)
        let second_cancel = rpc(
            &core,
            13,
            "run/cancel",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        assert_eq!(
            second_cancel["result"]["outcome"],
            serde_json::json!("write_in_flight"),
            "a second connection's Stop mid-B is refused honestly — body: {second_cancel}"
        );

        // The real outcome still lands on the deciding socket.
        let mut decide_result = None;
        while decide_result.is_none() {
            let body = next_text(&mut ws).await;
            let frame: serde_json::Value = serde_json::from_str(&body).expect("frame is JSON");
            if frame["id"] == serde_json::json!(10) {
                decide_result = Some(frame["result"].clone());
            }
        }
        let decide_result = decide_result.unwrap();
        assert_eq!(
            decide_result["ticktick_write"]["state"],
            serde_json::json!("created"),
            "the real outcome still lands after the refused Stop"
        );
        assert_eq!(posts.load(Ordering::SeqCst), 1, "the refused Stop changed nothing");
        ws.close(None).await.ok();

        await_completed(&core, &run_id).await;
    });

    drop(core);
    server.stop();
}

/// ACCOUNT HONESTY across REAL restarts, both directions (the plan's demo
/// proof 6): a plain restart with the SAME credential accepts (the overnight
/// flow); a swapped credential file + restart refuses with the DEDICATED
/// -32005 `stale_connection` error — accept never POSTs (zero requests reach
/// the fake), and reject still works.
#[test]
fn credential_swap_across_restart_refuses_typed_and_same_credential_accepts() {
    let workspace = Workspace::new();
    let creds_dir = workspace.path().join("credentials");
    write_ticktick_credential(&creds_dir, "tok_original");

    // Boot 1: propose + park, then die (the overnight park).
    let mut core = workspace
        .core()
        .worker_fixture("propose-ticktick-worker.ts")
        .env("INKSTONE_CREDENTIALS_DIR", &creds_dir)
        .spawn();
    let rt = rt();
    let (run_id, proposal_id) = rt.block_on(async {
        let resp = rpc(
            &core,
            1,
            "thread/create",
            serde_json::json!({ "prompt": "remind me to buy milk" }),
        )
        .await;
        let run_id = resp["result"]["run_id"].as_str().unwrap().to_string();
        await_parked(&core, &run_id).await;
        let proposal_id = proposal_id_for(&core, &run_id).await;
        (run_id, proposal_id)
    });
    core.kill();

    // Boot 2: the credential file was SWAPPED to another account.
    let (api_url, posts, server) = start_fake_ticktick_write(1, Duration::ZERO);
    write_ticktick_credential(&creds_dir, "tok_swapped");
    let mut core = workspace
        .core()
        .worker_fixture("propose-ticktick-worker.ts")
        .env("INKSTONE_CREDENTIALS_DIR", &creds_dir)
        .env("INKSTONE_TICKTICK_API_URL", &api_url)
        .spawn();
    rt.block_on(async {
        // The reloaded pending card derives STALE on first read.
        let proposal = rpc(
            &core,
            2,
            "proposal/get",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        assert_eq!(
            proposal["result"]["ticktick_write"],
            serde_json::json!({ "state": "proposed", "stale_connection": true }),
            "a swapped credential derives stale on FIRST render"
        );

        // Accept refuses with the DEDICATED code; nothing POSTs.
        let resp = rpc_skipping_notifications(
            &core,
            3,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "k-swap",
            }),
        )
        .await;
        assert_eq!(
            resp["error"]["code"].as_i64(),
            Some(-32005),
            "stale_connection is its own code, never proposal_not_pending — body: {resp}"
        );
        assert!(
            resp["error"]["message"]
                .as_str()
                .unwrap()
                .contains("TickTick connection changed"),
            "the message names the fix — body: {resp}"
        );
        assert_eq!(posts.load(Ordering::SeqCst), 0, "zero POSTs under a stale review");

        // Reject still works.
        let resp = rpc_skipping_notifications(
            &core,
            4,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "reject",
                "decision_idempotency_key": "k-swap-reject",
            }),
        )
        .await;
        assert_eq!(resp["result"]["status"], serde_json::json!("rejected"));
        await_completed(&core, &run_id).await;
    });
    core.kill();
    // Zero requests were served, so the thread is still in `accept()`: stop()
    // unblocks and joins it rather than leaking the listener.
    server.stop();

    // Boot 3 (fresh workspace half): the SAME-credential restart accepts —
    // the overnight flow. New park, kill, restart with the file untouched.
    let workspace2 = Workspace::new();
    let creds_dir2 = workspace2.path().join("credentials");
    write_ticktick_credential(&creds_dir2, "tok_morning");
    let mut core = workspace2
        .core()
        .worker_fixture("propose-ticktick-worker.ts")
        .env("INKSTONE_CREDENTIALS_DIR", &creds_dir2)
        .spawn();
    let (run_id, proposal_id) = rt.block_on(async {
        let resp = rpc(
            &core,
            1,
            "thread/create",
            serde_json::json!({ "prompt": "remind me to buy milk" }),
        )
        .await;
        let run_id = resp["result"]["run_id"].as_str().unwrap().to_string();
        await_parked(&core, &run_id).await;
        let proposal_id = proposal_id_for(&core, &run_id).await;
        (run_id, proposal_id)
    });
    core.kill();

    let (api_url, posts, server) = start_fake_ticktick_write(1, Duration::ZERO);
    let core = workspace2
        .core()
        .worker_fixture("propose-ticktick-worker.ts")
        .env("INKSTONE_CREDENTIALS_DIR", &creds_dir2)
        .env("INKSTONE_TICKTICK_API_URL", &api_url)
        .spawn();
    rt.block_on(async {
        let resp = rpc_skipping_notifications(
            &core,
            5,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "k-morning",
            }),
        )
        .await;
        assert_eq!(
            resp["result"]["status"],
            serde_json::json!("accepted"),
            "the morning accept succeeds — the guard never strands an overnight Proposal: {resp}"
        );
        assert_eq!(
            resp["result"]["ticktick_write"]["state"],
            serde_json::json!("created")
        );
        assert_eq!(posts.load(Ordering::SeqCst), 1);
        await_completed(&core, &run_id).await;
    });
    drop(core);
    server.stop();
}
