//! `ticktick/status` + `ticktick/tasks/list` end-to-end (external-task-views
//! S2): a fake TickTick OpenAPI server serves small hand-authored wire
//! responses. Core reads them through the real `TickTickClient` +
//! normalization and answers the two verbs over the WS. Also covers the
//! not-connected gate.

use std::io::{Read, Write};
use std::net::TcpListener;

use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{next_text, rt, Workspace, Ws};

fn project_response() -> String {
    serde_json::json!([{ "id": "list-1", "name": "Work" }]).to_string()
}

fn task_response() -> String {
    let mut tasks = vec![serde_json::json!({
        "id": "timed",
        "projectId": "list-1",
        "title": "Timed task",
        "kind": "TEXT",
        "priority": 0,
        "tags": ["advanced"],
        "dueDate": "2026-08-20T17:30:00.000+0000",
        "isAllDay": false,
        "timeZone": "America/Los_Angeles"
    })];
    tasks.extend((0..198).map(|i| {
        serde_json::json!({
            "id": format!("task-{i}"),
            "projectId": "list-1",
            "title": format!("Task {i}"),
            "kind": "TEXT",
            "priority": 0,
            "tags": []
        })
    }));
    tasks.push(serde_json::json!({
        "id": "note-1",
        "projectId": "list-1",
        "title": "Hidden note",
        "kind": "NOTE"
    }));
    serde_json::to_string(&tasks).expect("task response serializes")
}

/// A blocking HTTP/1.1 fake of TickTick's OpenAPI on a background thread.
fn start_fake_ticktick(expected_requests: usize) -> (String, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake ticktick");
    let addr = listener.local_addr().expect("addr");
    let projects = project_response();
    let tasks = task_response();

    let handle = std::thread::spawn(move || {
        // Two reads per fetch (projects, then filter): serve EXACTLY the test's
        // request count so the thread returns (joinable) instead of blocking in
        // `accept()` past the test — a detached thread + listener leak.
        for _ in 0..expected_requests {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut buf = [0u8; 8192];
            let n = stream.read(&mut buf).unwrap_or(0);
            let head = String::from_utf8_lossy(&buf[..n]);
            let body = if head.starts_with("GET /open/v1/project") {
                &projects
            } else {
                &tasks
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
    (format!("http://{addr}"), handle)
}

async fn call(ws: &mut Ws, id: u64, method: &str) -> serde_json::Value {
    let req = format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"{method}","params":{{}}}}"#);
    ws.send(Message::Text(req.into())).await.expect("send");
    let body = next_text(ws).await;
    serde_json::from_str(&body).expect("json")
}

#[test]
fn tasks_list_normalizes_a_full_page_and_flags_truncation() {
    // One `ticktick/tasks/list` = two OpenAPI reads (projects + filter).
    let (api_url, server) = start_fake_ticktick(2);
    let workspace = Workspace::new();
    let creds_dir = workspace.path().join("credentials");
    std::fs::create_dir_all(&creds_dir).expect("mk creds dir");
    let cred_path = creds_dir.join("ticktick.json");
    std::fs::write(
        &cred_path,
        r#"{"access_token":"tok_e2e","token_type":"bearer","scope":"tasks:read tasks:write"}"#,
    )
    .expect("write ticktick credential");
    // The custody gate (review R12 #5) rejects group/world-readable tokens.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cred_path, std::fs::Permissions::from_mode(0o600))
            .expect("chmod 0600");
    }

    let core = workspace
        .core()
        .no_seeded_credential()
        .env("INKSTONE_CREDENTIALS_DIR", &creds_dir)
        .env("INKSTONE_TICKTICK_API_URL", &api_url)
        .spawn();

    rt().block_on(async {
        let mut ws = core.connect().await;

        let status = call(&mut ws, 1, "ticktick/status").await;
        assert_eq!(status["result"]["state"], serde_json::json!("connected"));
        let connection_id = status["result"]["connection_id"]
            .as_str()
            .expect("connected status carries a connection_id");
        assert!(!connection_id.is_empty());

        let list = call(&mut ws, 2, "ticktick/tasks/list").await;
        let tasks = list["result"]["tasks"].as_array().expect("tasks array");
        assert_eq!(tasks.len(), 199, "200 raw rows minus the one NOTE");
        assert_eq!(
            list["result"]["source_limit_reached"],
            serde_json::json!(true),
            "a 200-row page flags truncation (raw count, pre-filter)"
        );
        assert!(
            tasks
                .iter()
                .all(|t| t["kind"] == "TEXT" || t["kind"] == "CHECKLIST"),
            "NOTE rows are discarded"
        );
        assert!(
            tasks
                .iter()
                .any(|t| t["title"] == "Timed task" && t["list_name"] == "Work"),
            "project ids resolve to list names"
        );
    });
    // Storage claim (A2/A6): Core persists NO task authority or cache. This is
    // structural, not a runtime check — the `ticktick/status` +
    // `ticktick/tasks/list` handlers take no `pool` (crates/core/src/runs/
    // ticktick.rs), so they cannot write task state; the read is computed per
    // call from TickTick's OpenAPI. No task/cache table exists to assert over.

    // The server thread served its exact request budget — joining proves it
    // exited (no detached thread/listener outlives the test).
    server.join().expect("fake TickTick server thread exits");
}

/// Not connected (no credential file): `ticktick/status` reports
/// `not_connected` with no id, and `ticktick/tasks/list` is rejected `-32004`
/// (the provider-not-connected code) so the Web shows the disconnected state.
#[test]
fn not_connected_reports_state_and_rejects_tasks_list() {
    let workspace = Workspace::new();
    let creds_dir = workspace.path().join("credentials");

    let core = workspace
        .core()
        .no_seeded_credential()
        .env("INKSTONE_CREDENTIALS_DIR", &creds_dir)
        .spawn();

    rt().block_on(async {
        let mut ws = core.connect().await;

        let status = call(&mut ws, 1, "ticktick/status").await;
        assert_eq!(
            status["result"]["state"],
            serde_json::json!("not_connected")
        );
        assert!(status["result"]["connection_id"].is_null());

        let list = call(&mut ws, 2, "ticktick/tasks/list").await;
        assert_eq!(
            list["error"]["code"],
            serde_json::json!(-32004),
            "tasks/list on a disconnected account is provider-not-connected"
        );
    });
}

/// A 401 from TickTick (expired/revoked credential — A5: no re-read, restart to
/// change) surfaces as the verb's internal error, never a hang or a false empty
/// list (review R12 #6).
#[test]
fn upstream_401_surfaces_as_an_error() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind fake");
    let addr = listener.local_addr().expect("addr");
    let server = std::thread::spawn(move || {
        for _ in 0..2 {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf);
            let _ = stream.write_all(
                b"HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
            );
        }
    });

    let workspace = Workspace::new();
    let creds_dir = workspace.path().join("credentials");
    std::fs::create_dir_all(&creds_dir).expect("mk creds dir");
    let cred_path = creds_dir.join("ticktick.json");
    std::fs::write(&cred_path, r#"{"access_token":"tok_expired"}"#).expect("write cred");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cred_path, std::fs::Permissions::from_mode(0o600))
            .expect("chmod");
    }

    let core = workspace
        .core()
        .no_seeded_credential()
        .env("INKSTONE_CREDENTIALS_DIR", &creds_dir)
        .env("INKSTONE_TICKTICK_API_URL", format!("http://{addr}"))
        .spawn();

    rt().block_on(async {
        let mut ws = core.connect().await;
        let list = call(&mut ws, 1, "ticktick/tasks/list").await;
        assert!(
            list["error"]["code"].is_i64(),
            "a 401 read maps to an error response — body: {list}"
        );
    });
    server.join().expect("fake 401 server exits");
}

/// A STALLED upstream is bounded by the A7 timeout knob
/// (`INKSTONE_TICKTICK_TIMEOUT_MS`, review R12 #6): with a tiny bound the read
/// errors promptly instead of hanging the verb for the default 30s.
#[test]
fn stalled_upstream_is_bounded_by_the_timeout_knob() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind fake");
    let addr = listener.local_addr().expect("addr");
    let server = std::thread::spawn(move || {
        // Accept both reads, read the requests, respond to NEITHER — hold the
        // sockets past the client's 250ms bound, then exit.
        let mut held = Vec::new();
        for _ in 0..2 {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf);
            held.push(stream);
        }
        std::thread::sleep(std::time::Duration::from_millis(1_500));
        drop(held);
    });

    let workspace = Workspace::new();
    let creds_dir = workspace.path().join("credentials");
    std::fs::create_dir_all(&creds_dir).expect("mk creds dir");
    let cred_path = creds_dir.join("ticktick.json");
    std::fs::write(&cred_path, r#"{"access_token":"tok_stall"}"#).expect("write cred");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cred_path, std::fs::Permissions::from_mode(0o600))
            .expect("chmod");
    }

    let core = workspace
        .core()
        .no_seeded_credential()
        .env("INKSTONE_CREDENTIALS_DIR", &creds_dir)
        .env("INKSTONE_TICKTICK_API_URL", format!("http://{addr}"))
        .env("INKSTONE_TICKTICK_TIMEOUT_MS", "250")
        .spawn();

    rt().block_on(async {
        let mut ws = core.connect().await;
        let started = std::time::Instant::now();
        let list = call(&mut ws, 1, "ticktick/tasks/list").await;
        assert!(
            list["error"]["code"].is_i64(),
            "a stalled read maps to an error response — body: {list}"
        );
        assert!(
            started.elapsed() < std::time::Duration::from_secs(10),
            "the knob bounds the stall (not the 30s default)"
        );
    });
    server.join().expect("fake stall server exits");
}
