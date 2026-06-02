//! Worker process spawn (per ADR-0013). One Worker process per Run, stdio
//! transport with NDJSON framing. The spawned task owns the child handle,
//! reads stdout line-by-line, and publishes each Run Event into the Run's
//! hub (ADR-0022) — the live stream is owned by Core and observable by any
//! connection, not bound to the socket that issued `run/post_message`.

use std::process::Stdio;
use std::sync::Arc;

use sqlx::SqlitePool;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::db;
use crate::hub::Hubs;
use crate::protocol::{ManifestMessage, RunEvent, WorkerManifest, WorkflowManifest};
use crate::workflow::Workflow;

/// Spawn a Worker for `run_id`. Returns immediately; a Tokio task drives
/// the child to completion and publishes stdout NDJSON events into the
/// Run's hub. Whichever way the loop exits — clean `done`, stdout EOF, or a
/// pre-loop spawn failure — the terminal tx (`db::complete_run` /
/// `db::error_run`) commits, then the hub entry is removed (dropping the
/// broadcast sender so subscribers see the channel close after `done`).
///
/// `pool` + `assistant_message_id` are used to append each `text_delta`
/// to the assistant `message_parts.text` row that `persist_initial_run`
/// pre-inserted at `seq=0`. Per ADR-0022 the per-event critical section is
/// `lock gate → persist delta → publish to hub → unlock`, so a concurrent
/// `run/subscribe`'s `snapshot → attach` falls wholly before or after each
/// delta — exactly-once across the snapshot/tail boundary.
pub fn spawn(
    run_id: Uuid,
    workflow: &'static Workflow,
    prompt: String,
    history: Vec<(String, String)>,
    pool: SqlitePool,
    assistant_message_id: Uuid,
    hubs: Hubs,
    tx: broadcast::Sender<RunEvent>,
    gate: Arc<tokio::sync::Mutex<()>>,
) {
    let cmd = std::env::var("INKSTONE_WORKER_CMD").unwrap_or_else(|_| {
        "packages/worker/node_modules/.bin/tsx packages/worker/src/cli.ts".to_string()
    });

    tokio::spawn(async move {
        run_worker(
            run_id,
            cmd,
            workflow,
            prompt,
            history,
            pool,
            assistant_message_id,
            hubs,
            tx,
            gate,
        )
        .await;
    });
}

#[allow(clippy::too_many_arguments)]
async fn run_worker(
    run_id: Uuid,
    cmd: String,
    workflow: &'static Workflow,
    prompt: String,
    history: Vec<(String, String)>,
    pool: SqlitePool,
    assistant_message_id: Uuid,
    hubs: Hubs,
    tx: broadcast::Sender<RunEvent>,
    gate: Arc<tokio::sync::Mutex<()>>,
) {
    let mut parts = cmd.split_whitespace();
    let Some(program) = parts.next() else {
        eprintln!("INKSTONE_WORKER_CMD is empty");
        finalize_error(&pool, &hubs, run_id).await;
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
            finalize_error(&pool, &hubs, run_id).await;
            return;
        }
    };

    if let Some(mut stdin) = child.stdin.take() {
        // Build the spawn manifest (ADR-0018 as-built): the Workflow fields,
        // the current prompt, the assembled prior history (multi-turn,
        // slice 5), and — for OAuth providers — a short-lived access token
        // resolved by Core (ADR-0023): valid token used as-is, expired token
        // refreshed single-flight before spawn. Written as one NDJSON line.
        let messages: Vec<ManifestMessage> = history
            .iter()
            .map(|(role, text)| ManifestMessage { role, text })
            .collect();
        let access_token =
            match crate::provider_auth::resolve_access_token(&workflow.provider, db::now_ms()).await
            {
                Ok(token) => token,
                Err(e) => {
                    // Token resolution/refresh failed — the Run cannot reach
                    // the provider. Terminate it as errored rather than
                    // spawning a Worker that will fail opaquely.
                    eprintln!("access token resolution failed for run {run_id}: {e}");
                    finalize_error(&pool, &hubs, run_id).await;
                    return;
                }
            };
        let manifest = WorkerManifest {
            workflow: WorkflowManifest {
                name: &workflow.name,
                version: &workflow.version,
                provider: &workflow.provider,
                model: &workflow.model,
                system_prompt: &workflow.system_prompt,
                thinking_level: &workflow.thinking_level,
                tools: &workflow.tools,
            },
            prompt: &prompt,
            messages,
            access_token: access_token.as_deref(),
        };
        let mut line = serde_json::to_string(&manifest).expect("WorkerManifest serializes");
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
            finalize_error(&pool, &hubs, run_id).await;
            return;
        }
    };
    let mut lines = BufReader::new(stdout).lines();

    // Track whether the Worker emitted a terminal `done` event so the
    // post-loop branch can pick `complete_run` vs `error_run`. A worker-
    // emitted `error` event captures its message here so the terminal tx
    // records it (ADR-0006 lists errors as a Run Event; this is the
    // real-provider error path) instead of the generic `worker_disconnected`.
    let mut saw_done = false;
    let mut worker_error: Option<String> = None;

    while let Ok(Some(line)) = lines.next_line().await {
        let event: RunEvent = match serde_json::from_str(&line) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("worker emitted unknown event {line:?}: {e}");
                continue;
            }
        };

        // Per-event critical section (ADR-0022 exactly-once). Hold the
        // per-run gate across persist + publish so a concurrent
        // `run/subscribe` snapshot/attach sees this delta either wholly in
        // the snapshot or wholly in the tail, never split or duplicated.
        let guard = gate.lock().await;

        match &event {
            RunEvent::TextDelta { delta } => {
                // Persist BEFORE publishing so the persisted text (the
                // snapshot floor) is never behind a delta a subscriber
                // already saw on the tail.
                if let Err(e) =
                    db::append_assistant_text(&pool, assistant_message_id, delta).await
                {
                    eprintln!(
                        "text_delta append failed for assistant message {assistant_message_id}: {e}"
                    );
                }
            }
            RunEvent::Done => {
                saw_done = true;
            }
            RunEvent::Error { message } => {
                worker_error = Some(message.clone());
            }
        }

        // Publish to the hub. `SendError` (no receivers attached) is fine —
        // the persisted text is the durable floor; a late subscriber reads
        // it from the snapshot.
        let _ = tx.send(event);

        drop(guard);
    }

    // Terminal-state tx. Either path commits the runs/messages/run_events
    // triple in a single transaction (ADR-0017's atomic recovery
    // invariant). A worker-emitted `error` takes precedence over the
    // EOF-without-done path and carries its own message.
    let now_ms = db::now_ms();
    let result = if let Some(message) = worker_error {
        db::error_run_with_message(&pool, run_id, "errored", "worker_error", &message, now_ms).await
    } else if saw_done {
        db::complete_run(&pool, run_id, now_ms).await
    } else {
        db::error_run(&pool, run_id, now_ms).await
    };
    if let Err(e) = result {
        eprintln!("terminal tx failed for run {run_id}: {e}");
    }

    // Remove the hub entry AFTER the terminal tx. Dropping the broadcast
    // sender lets attached subscribers observe `RecvError::Closed` once they
    // have drained the tail (including the terminal `done` published above).
    crate::hub::remove(&hubs, run_id);

    let _ = child.wait().await;
}

/// Pre-loop spawn-failure path: the Worker never produced any output, so
/// the run terminates immediately with `worker_disconnected`. Honors the
/// ADR-0017 atomic recovery invariant, then removes the hub entry so any
/// subscriber falls through to the persisted snapshot + `done`.
async fn finalize_error(pool: &SqlitePool, hubs: &Hubs, run_id: Uuid) {
    if let Err(e) = db::error_run(pool, run_id, db::now_ms()).await {
        eprintln!("error_run after pre-loop spawn failure for run {run_id}: {e}");
    }
    crate::hub::remove(hubs, run_id);
}
