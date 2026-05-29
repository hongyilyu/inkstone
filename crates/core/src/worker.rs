//! Worker process spawn (per ADR-0013). One Worker process per Run, stdio
//! transport with NDJSON framing. The spawned task owns the child handle,
//! reads stdout line-by-line, and forwards each line as a `run/event`
//! JSON-RPC Notification on the per-connection outbound channel.

use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc::UnboundedSender;
use uuid::Uuid;

use crate::protocol::WorkerInbound;
use crate::runs::{RunHandle, Runs};
use crate::workflow::Workflow;

/// Spawn a Worker for `run_id`. Returns immediately with a placeholder
/// `RunHandle`; a Tokio task drives the child to completion and forwards
/// stdout NDJSON events as `run/event` Notifications via `ws_sender`.
/// On stdout EOF, removes the Run from `runs`.
pub fn spawn(
    run_id: Uuid,
    _workflow: &'static Workflow,
    prompt: String,
    ws_sender: UnboundedSender<String>,
    runs: Runs,
) -> RunHandle {
    let cmd = std::env::var("INKSTONE_WORKER_CMD")
        .unwrap_or_else(|_| "node_modules/.bin/tsx packages/worker/src/cli.ts".to_string());

    tokio::spawn(async move {
        run_worker(run_id, cmd, prompt, ws_sender, runs).await;
    });

    RunHandle
}

async fn run_worker(
    run_id: Uuid,
    cmd: String,
    prompt: String,
    ws_sender: UnboundedSender<String>,
    runs: Runs,
) {
    let mut parts = cmd.split_whitespace();
    let Some(program) = parts.next() else {
        eprintln!("INKSTONE_WORKER_CMD is empty");
        remove_run(&runs, run_id);
        return;
    };
    let args: Vec<&str> = parts.collect();

    let mut child = match Command::new(program)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("failed to spawn worker {program:?}: {e}");
            remove_run(&runs, run_id);
            return;
        }
    };

    if let Some(mut stdin) = child.stdin.take() {
        let inbound = WorkerInbound { prompt: &prompt };
        let mut line = serde_json::to_string(&inbound).expect("WorkerInbound serializes");
        line.push('\n');
        if let Err(e) = stdin.write_all(line.as_bytes()).await {
            eprintln!("failed to write worker stdin: {e}");
        }
        // Drop stdin so the Worker sees EOF on its input stream.
        drop(stdin);
    }

    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            eprintln!("worker child has no stdout");
            let _ = child.wait().await;
            remove_run(&runs, run_id);
            return;
        }
    };
    let mut lines = BufReader::new(stdout).lines();

    while let Ok(Some(line)) = lines.next_line().await {
        let event: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("worker emitted invalid json line {line:?}: {e}");
                continue;
            }
        };
        let notification = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "run/event",
            "params": {
                "run_id": run_id.to_string(),
                "event": event,
            },
        });
        let body = serde_json::to_string(&notification).expect("notification serializes");
        if ws_sender.send(body).is_err() {
            // Connection dropped; nothing more to do.
            break;
        }
    }

    let _ = child.wait().await;
    remove_run(&runs, run_id);
}

fn remove_run(runs: &Runs, run_id: Uuid) {
    if let Ok(mut map) = runs.0.lock() {
        map.remove(&run_id);
    }
}
