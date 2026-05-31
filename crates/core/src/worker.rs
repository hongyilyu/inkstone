//! Worker process spawn (per ADR-0013). One Worker process per Run, stdio
//! transport with NDJSON framing. The spawned task owns the child handle,
//! reads stdout line-by-line, and forwards each line as a `run/event`
//! JSON-RPC Notification on the per-connection outbound channel.

use std::process::Stdio;

use sqlx::SqlitePool;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc::UnboundedSender;
use uuid::Uuid;

use crate::db;
use crate::protocol::WorkerInbound;
use crate::workflow::Workflow;

/// Spawn a Worker for `run_id`. Returns immediately; a Tokio task drives
/// the child to completion and forwards stdout NDJSON events as
/// `run/event` Notifications via `ws_sender`. Whichever way the loop
/// exits — clean `done`, stdout EOF, or a pre-loop spawn failure — the
/// terminal tx (`db::complete_run` / `db::error_run`) commits before the
/// task ends.
///
/// `pool` + `assistant_message_id` are used to append each `text_delta`
/// to the assistant `message_parts.text` row that `persist_initial_run`
/// pre-inserted at `seq=0`. The UPDATE commits BEFORE the matching WS
/// Notification is forwarded, so a test that observes the WS frame can
/// immediately query the DB and see the same delta.
pub fn spawn(
    run_id: Uuid,
    _workflow: &'static Workflow,
    prompt: String,
    pool: SqlitePool,
    assistant_message_id: Uuid,
    ws_sender: UnboundedSender<String>,
) {
    let cmd = std::env::var("INKSTONE_WORKER_CMD").unwrap_or_else(|_| {
        "packages/worker/node_modules/.bin/tsx packages/worker/src/cli.ts".to_string()
    });

    tokio::spawn(async move {
        run_worker(run_id, cmd, prompt, pool, assistant_message_id, ws_sender).await;
    });
}

async fn run_worker(
    run_id: Uuid,
    cmd: String,
    prompt: String,
    pool: SqlitePool,
    assistant_message_id: Uuid,
    ws_sender: UnboundedSender<String>,
) {
    let mut parts = cmd.split_whitespace();
    let Some(program) = parts.next() else {
        eprintln!("INKSTONE_WORKER_CMD is empty");
        finalize_error(&pool, run_id).await;
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
            finalize_error(&pool, run_id).await;
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
            finalize_error(&pool, run_id).await;
            return;
        }
    };
    let mut lines = BufReader::new(stdout).lines();

    // Slice 4: track whether the Worker emitted a terminal `done` event so
    // the post-loop branch can pick `complete_run` vs `error_run`.
    let mut saw_done = false;

    while let Ok(Some(line)) = lines.next_line().await {
        let event: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("worker emitted invalid json line {line:?}: {e}");
                continue;
            }
        };

        let kind = event.get("kind").and_then(serde_json::Value::as_str);

        // For `text_delta`, append to the assistant `message_parts.text`
        // BEFORE forwarding the WS frame so a test that observes the
        // frame and then queries the DB sees the committed delta.
        // Persistence loss here is logged but not fatal — the WS frame
        // is the user's observable channel for slice 3.
        if kind == Some("text_delta") {
            if let Some(delta) = event.get("delta").and_then(serde_json::Value::as_str) {
                if let Err(e) = db::append_assistant_text(&pool, assistant_message_id, delta).await
                {
                    eprintln!(
                        "text_delta append failed for assistant message {assistant_message_id}: {e}"
                    );
                }
            }
        } else if kind == Some("done") {
            saw_done = true;
        }

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

    // Slice 4: terminal-state tx. Either path commits the runs/messages/
    // run_events triple in a single transaction (ADR-0017's atomic
    // recovery invariant). The tx fires AFTER the WS forwarder has
    // drained, so a slice-4 test that wants to assert post-terminal DB
    // state must close the WS and let Core finish (e.g. by killing it
    // and reaping, or by polling the DB) before querying.
    let now_ms = db::now_ms();
    let result = if saw_done {
        db::complete_run(&pool, run_id, now_ms).await
    } else {
        db::error_run(&pool, run_id, now_ms).await
    };
    if let Err(e) = result {
        eprintln!("terminal tx failed for run {run_id}: {e}");
    }

    let _ = child.wait().await;
}

/// Pre-loop spawn-failure path: the Worker never produced any output, so
/// the run terminates immediately with `worker_disconnected`. Honors the
/// ADR-0017 atomic recovery invariant — without this, an empty
/// `INKSTONE_WORKER_CMD` or a missing worker binary would leave
/// `runs.status='running'` and the assistant `messages.status='streaming'`
/// forever.
async fn finalize_error(pool: &SqlitePool, run_id: Uuid) {
    if let Err(e) = db::error_run(pool, run_id, db::now_ms()).await {
        eprintln!("error_run after pre-loop spawn failure for run {run_id}: {e}");
    }
}
