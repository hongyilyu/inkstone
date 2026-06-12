//! Multi-turn: Core assembles the Thread's prior completed Messages into the
//! second Run's manifest `messages[]`, so the model sees the earlier exchange.
//! Proven offline with the faux provider in history-echo mode
//! (`INKSTONE_FAUX_ECHO_HISTORY=1`), which reports the prior turns it saw in its
//! context. Run 1 establishes the history; Run 2's reply must contain it.

use std::path::Path;

use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{Workspace, Ws, next_text};

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
    let workspace = Workspace::new();
    let workflows_dir = workspace.path().join("workflows");
    write_faux_workflow(&workflows_dir);

    let core = workspace
        .core()
        .worker_faux()
        .env("INKSTONE_WORKFLOWS_DIR", &workflows_dir)
        // History-echo mode: faux replies with the prior user texts it saw.
        .env("INKSTONE_FAUX_ECHO_HISTORY", "1")
        .spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let run2_text = rt.block_on(async {
        let mut ws = core.connect().await;

        // Run 1: create the thread, drain to done so its user+assistant messages
        // are `completed` before run 2 starts.
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

    // The faux reply is `history:<role=text|...>` for every prior turn; run 1's
    // (no prior turns) is `history:`. Run 2's prior turns are run 1's user prompt
    // and assistant reply, so run 2's reply must contain both. The
    // `assistant=history:` half only appears if run 1's assistant message was
    // `completed` before run 2's history read (the terminal-ordering fix).
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
