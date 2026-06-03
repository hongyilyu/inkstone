//! Slice 5 (real-worker-codex): multi-turn. Core assembles the Thread's
//! prior completed Messages into the second Run's manifest `messages[]`, so
//! the model sees the earlier exchange. Proven offline with the faux
//! provider in history-echo mode (`INKSTONE_FAUX_ECHO_HISTORY=1`): the faux
//! response factory reports the prior USER texts it received in its context,
//! which Core sourced from the manifest history it built. Run 1 establishes
//! the history; Run 2's streamed reply must contain Run 1's prompt.

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

fn interpreter_worker_cmd() -> String {
    let root = repo_root();
    let tsx = root.join("packages/worker/node_modules/.bin/tsx");
    let cli = root.join("packages/worker/src/cli.ts");
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

fn write_faux_workflow(dir: &Path) {
    std::fs::create_dir_all(dir).expect("create workflows dir");
    std::fs::write(
        dir.join("default.toml"),
        r#"
name = "default"
version = "1.0.0"
provider = "faux"
model = "faux-1"
thinking_level = "off"
system_prompt = "test"
tools = []
"#,
    )
    .expect("write faux default.toml");
}

fn spawn_core(worker_cmd: &str, db_path: &Path, workflows_dir: &Path) -> (CoreChild, String) {
    let mut child = std::process::Command::cargo_bin("core")
        .expect("core binary exists")
        .current_dir(repo_root())
        .env("INKSTONE_PORT", "0")
        .env("INKSTONE_WORKER_CMD", worker_cmd)
        .env("INKSTONE_DB_PATH", db_path)
        .env("INKSTONE_WORKFLOWS_DIR", workflows_dir)
        // History-echo mode: faux replies with the prior user texts it saw.
        .env("INKSTONE_FAUX_ECHO_HISTORY", "1")
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

type Ws = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

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

/// Drain a run's subscribe stream, returning the reassembled text at `done`.
async fn run_to_text(ws: &mut Ws, run_id: &str) -> String {
    let subscribe = format!(
        r#"{{"jsonrpc":"2.0","id":99,"method":"run/subscribe","params":{{"run_id":"{run_id}"}}}}"#
    );
    ws.send(Message::Text(subscribe.into()))
        .await
        .expect("send subscribe");
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

#[test]
fn second_run_sees_prior_exchange() {
    let worker_cmd = interpreter_worker_cmd();
    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");
    let workflows_dir = tmp.path().join("workflows");
    write_faux_workflow(&workflows_dir);

    let (_child, ws_url) = spawn_core(&worker_cmd, &db_path, &workflows_dir);

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let run2_text = rt.block_on(async {
        let (mut ws, _resp) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .expect("ws handshake");

        // Run 1: create the thread with a memorable prompt, drain to done so
        // its user+assistant messages are `completed` before run 2 starts.
        let create =
            r#"{"jsonrpc":"2.0","id":1,"method":"thread/create","params":{"prompt":"remember pineapple"}}"#;
        ws.send(Message::Text(create.into()))
            .await
            .expect("send create");
        let create_resp = next_text(&mut ws).await;
        let cv: serde_json::Value = serde_json::from_str(&create_resp).expect("create resp json");
        let thread_id = cv["result"]["thread_id"].as_str().expect("thread_id").to_string();
        let run1_id = cv["result"]["run_id"].as_str().expect("run1_id").to_string();
        let _run1_text = run_to_text(&mut ws, &run1_id).await;

        // Run 2: post a follow-up into the same thread. Core must assemble
        // run 1's completed messages into run 2's manifest history.
        let post = format!(
            r#"{{"jsonrpc":"2.0","id":2,"method":"run/post_message","params":{{"thread_id":"{thread_id}","prompt":"what did I say"}}}}"#
        );
        ws.send(Message::Text(post.into()))
            .await
            .expect("send post_message");
        let post_resp = next_text(&mut ws).await;
        let pv: serde_json::Value = serde_json::from_str(&post_resp).expect("post resp json");
        let run2_id = pv["result"]["run_id"].as_str().expect("run2_id").to_string();
        let text = run_to_text(&mut ws, &run2_id).await;

        ws.close(None).await.ok();
        text
    });

    // The faux history-echo reply is `history:<role=text|...>` for every
    // prior turn. Run 1's reply (no prior turns) is `history:`. Run 2's prior
    // turns are run 1's user prompt AND run 1's assistant reply, so run 2's
    // reply must contain BOTH:
    //   - `user=remember pineapple`  (the prior user turn — always present)
    //   - `assistant=history:`       (the prior ASSISTANT turn — only present
    //                                 if run 1's assistant message was
    //                                 `completed` before run 2's history read,
    //                                 i.e. the slice-9 terminal-ordering fix)
    assert!(
        run2_text.contains("user=remember pineapple"),
        "run 2 must see run 1's user prompt in its assembled history; got {run2_text:?}"
    );
    assert!(
        run2_text.contains("assistant=history:"),
        "run 2 must see run 1's ASSISTANT reply in its assembled history \
         (terminal `done` must be published only after complete_run commits, \
         so the assistant message is `completed` before run 2's history read); \
         got {run2_text:?}"
    );
}
