//! Slice 7 (real-worker-codex): Core-orchestrated, single-flight token
//! refresh (ADR-0023). When the stored `openai-codex` token is expired, Core
//! refreshes it exactly once even under concurrent Runs (global lock +
//! double-checked expiry), persists the rotated credential (0600), and
//! injects the fresh access token into each Run's manifest.
//!
//! Offline via two stubs: `refresh-helper.ts` (counts invocations, echoes a
//! rotated token) stands in for the Provider Helper; `manifest-echo.ts`
//! stands in for the Worker and streams back the `access_token` Core put in
//! the manifest. No real OpenAI contact.

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

fn tsx() -> PathBuf {
    let p = repo_root().join("packages/worker/node_modules/.bin/tsx");
    if !p.exists() {
        panic!("worker tsx not installed — run `pnpm install`");
    }
    p
}

fn write_codex_workflow(dir: &Path) {
    std::fs::create_dir_all(dir).expect("create workflows dir");
    std::fs::write(
        dir.join("default.toml"),
        r#"
name = "default"
version = "1.0.0"
provider = "openai-codex"
model = "gpt-5.5"
thinking_level = "off"
system_prompt = "test"
tools = []
"#,
    )
    .expect("write codex default.toml");
}

fn write_credential(dir: &Path, access: &str, refresh: &str, expires: i64) {
    std::fs::create_dir_all(dir).expect("create creds dir");
    std::fs::write(
        dir.join("openai-codex.json"),
        serde_json::json!({
            "access": access,
            "refresh": refresh,
            "expires": expires,
            "account_id": "acct_test"
        })
        .to_string(),
    )
    .expect("write credential");
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

#[allow(clippy::too_many_arguments)]
fn spawn_core(
    db_path: &Path,
    workflows_dir: &Path,
    creds_dir: &Path,
    counter_path: &Path,
) -> (CoreChild, String) {
    let root = repo_root();
    let manifest_echo = root.join("crates/core/tests/fixtures/manifest-echo.ts");
    let refresh_helper = root.join("crates/core/tests/fixtures/refresh-helper.ts");
    let worker_cmd = format!("{} {}", tsx().display(), manifest_echo.display());
    let helper_cmd = format!("{} {} refresh", tsx().display(), refresh_helper.display());

    let mut child = std::process::Command::cargo_bin("core")
        .expect("core binary exists")
        .current_dir(&root)
        .env("INKSTONE_PORT", "0")
        .env("INKSTONE_DB_PATH", db_path)
        .env("INKSTONE_WORKFLOWS_DIR", workflows_dir)
        .env("INKSTONE_CREDENTIALS_DIR", creds_dir)
        .env("INKSTONE_WORKER_CMD", &worker_cmd)
        .env("INKSTONE_PROVIDER_HELPER_CMD", &helper_cmd)
        .env("INKSTONE_REFRESH_COUNTER", counter_path)
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
            panic!("core stdout closed before INKSTONE_LISTENING");
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

async fn connect(ws_url: &str) -> Ws {
    let (ws, _resp) = tokio_tungstenite::connect_async(ws_url)
        .await
        .expect("ws handshake");
    ws
}

async fn next_text(ws: &mut Ws) -> String {
    let frame = tokio::time::timeout(Duration::from_secs(10), ws.next())
        .await
        .expect("frame within 10s")
        .expect("frame present")
        .expect("frame ok");
    match frame {
        Message::Text(t) => t.to_string(),
        other => panic!("expected text frame, got {other:?}"),
    }
}

/// thread/create on a fresh connection; return (run_id, ws) — the caller
/// drains the stream. Using one connection per run lets the two runs race.
async fn create_run(ws: &mut Ws, prompt: &str, id: u64) -> String {
    let req = format!(
        r#"{{"jsonrpc":"2.0","id":{id},"method":"thread/create","params":{{"prompt":"{prompt}"}}}}"#
    );
    ws.send(Message::Text(req.into())).await.expect("send create");
    let body = next_text(ws).await;
    let v: serde_json::Value = serde_json::from_str(&body).expect("create json");
    v["result"]["run_id"].as_str().expect("run_id").to_string()
}

async fn drain_to_token(ws: &mut Ws, run_id: &str) -> String {
    let sub = format!(
        r#"{{"jsonrpc":"2.0","id":77,"method":"run/subscribe","params":{{"run_id":"{run_id}"}}}}"#
    );
    ws.send(Message::Text(sub.into())).await.expect("send subscribe");
    let _ack = next_text(ws).await;
    let mut text = String::new();
    loop {
        let body = next_text(ws).await;
        let v: serde_json::Value = serde_json::from_str(&body).expect("event json");
        match v["params"]["event"]["kind"].as_str() {
            Some("text_delta") => {
                text.push_str(v["params"]["event"]["delta"].as_str().unwrap_or(""));
            }
            Some("done") => break,
            Some("error") => panic!("run errored: {body}"),
            _ => {}
        }
    }
    text
}

fn read_counter(path: &Path) -> i64 {
    match std::fs::read_to_string(path) {
        Ok(s) if !s.trim().is_empty() => s.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

#[test]
fn expired_token_refreshes_once_under_contention() {
    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");
    let workflows_dir = tmp.path().join("workflows");
    let creds_dir = tmp.path().join("credentials");
    let counter_path = tmp.path().join("refresh-count");
    write_codex_workflow(&workflows_dir);
    // Expired credential (expires far in the past).
    write_credential(&creds_dir, "stale_access", "refresh_v1", 1);

    let (_child, ws_url) = spawn_core(&db_path, &workflows_dir, &creds_dir, &counter_path);

    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let (t1, t2) = rt.block_on(async {
        // Two concurrent runs, each on its own connection, both observing the
        // expired token at nearly the same instant.
        let mut wsa = connect(&ws_url).await;
        let mut wsb = connect(&ws_url).await;
        let run_a = create_run(&mut wsa, "one", 1).await;
        let run_b = create_run(&mut wsb, "two", 2).await;
        let (ta, tb) = tokio::join!(
            drain_to_token(&mut wsa, &run_a),
            drain_to_token(&mut wsb, &run_b)
        );
        wsa.close(None).await.ok();
        wsb.close(None).await.ok();
        (ta, tb)
    });

    // Both runs' manifests carried the REFRESHED access token (the stub
    // rotates `refresh_v1` → `rotated:refresh_v1`).
    assert_eq!(t1, "rotated:refresh_v1", "run A manifest carried the refreshed token");
    assert_eq!(t2, "rotated:refresh_v1", "run B manifest carried the refreshed token");

    // Single-flight: exactly one refresh happened despite two expired runs.
    assert_eq!(
        read_counter(&counter_path),
        1,
        "the provider helper refresh ran exactly once under contention"
    );

    // The rotated credential was persisted (0600), replacing the stale one.
    let persisted: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(creds_dir.join("openai-codex.json")).expect("read persisted cred"),
    )
    .expect("persisted cred json");
    assert_eq!(persisted["access"], serde_json::json!("rotated:refresh_v1"));
    assert_eq!(persisted["refresh"], serde_json::json!("refresh_v1:next"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(creds_dir.join("openai-codex.json"))
            .expect("stat cred")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "persisted credential is 0600");
    }
}

#[test]
fn valid_token_used_without_refresh() {
    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");
    let workflows_dir = tmp.path().join("workflows");
    let creds_dir = tmp.path().join("credentials");
    let counter_path = tmp.path().join("refresh-count");
    write_codex_workflow(&workflows_dir);
    // Valid credential (expires far in the future).
    write_credential(&creds_dir, "fresh_access", "refresh_v1", 9_999_999_999_999);

    let (_child, ws_url) = spawn_core(&db_path, &workflows_dir, &creds_dir, &counter_path);

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let token = rt.block_on(async {
        let mut ws = connect(&ws_url).await;
        let run = create_run(&mut ws, "hi", 1).await;
        let t = drain_to_token(&mut ws, &run).await;
        ws.close(None).await.ok();
        t
    });

    assert_eq!(token, "fresh_access", "valid token used as-is");
    assert_eq!(read_counter(&counter_path), 0, "no refresh for a valid token");
}
