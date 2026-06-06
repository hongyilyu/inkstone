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
use crate::hub::{self, Hubs};
use crate::protocol::{
    ManifestMessage, RunEvent, ToolCallStatus, ToolErrorWire, ToolOutcome, ToolResult,
    WorkerManifest, WorkerStdout, WorkflowManifest,
};
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
    workflow: Workflow,
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

/// Resume a parked Run after its Proposal is decided (ADR-0025). Reads the
/// run's assistant message + reconstructs the transcript from tier 2, flips the
/// Run `parked → running`, creates a FRESH per-run hub (ADR-0022), and spawns a
/// resume Worker seeded with a `mode:"resume"` manifest. The shared
/// [`stream_worker`] then continues appending into the run's assistant message
/// and commits the terminal tx on `done`.
///
/// Returns an error only on a pre-spawn failure (the assistant message is
/// missing, or the run-running flip fails) — the caller has already committed
/// the atomic apply, so a resume failure leaves a durably-accepted Proposal on
/// a still-parked Run (a later idempotent decide retry can re-resume).
pub async fn resume(
    run_id: Uuid,
    pool: &SqlitePool,
    hubs: &Hubs,
) -> anyhow::Result<()> {
    let workflow = crate::workflow::default_workflow().clone();

    let assistant_message_id = db::assistant_message_id_for_run(pool, run_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("run {run_id} has no assistant message to resume into"))?;

    // Reconstruct the transcript (ADR-0025): every tool_call resolved, final
    // message the Decision tool_result. Built from the persisted timeline.
    let transcript = crate::resume::reconstruct(pool, run_id).await?;

    // Flip parked → running BEFORE creating the hub/spawning, so a
    // `run/subscribe` in the window sees `running` (live stream) not `parked`.
    db::mark_run_running(pool, run_id).await?;

    // Fresh hub for the resume segment (ADR-0022): created before the Worker
    // spawns so a fast subscribe finds it.
    let run_hub = hub::create(hubs, run_id);

    let cmd = std::env::var("INKSTONE_WORKER_CMD").unwrap_or_else(|_| {
        "packages/worker/node_modules/.bin/tsx packages/worker/src/cli.ts".to_string()
    });

    let pool = pool.clone();
    let hubs = hubs.clone();
    tokio::spawn(async move {
        run_resume_worker(
            run_id,
            cmd,
            workflow,
            transcript,
            pool,
            assistant_message_id,
            hubs,
            run_hub.tx,
            run_hub.gate,
        )
        .await;
    });

    Ok(())
}

/// The resume Worker task: spawn the Worker, write a `mode:"resume"` manifest
/// carrying the reconstructed transcript (and an empty prompt), then delegate
/// to the shared [`stream_worker`]. Mirrors [`run_worker`] but for the resume
/// manifest shape (ADR-0025).
#[allow(clippy::too_many_arguments)]
async fn run_resume_worker(
    run_id: Uuid,
    cmd: String,
    workflow: Workflow,
    transcript: Vec<crate::resume::Block>,
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
            eprintln!("failed to spawn resume worker {program:?}: {e}");
            finalize_error(&pool, &hubs, run_id).await;
            return;
        }
    };

    let mut stdin = child.stdin.take();
    {
        let messages: Vec<ManifestMessage> =
            transcript.iter().map(crate::resume::Block::as_message).collect();
        let access_token =
            match crate::provider_auth::resolve_access_token(&workflow.provider, db::now_ms()).await
            {
                Ok(token) => token,
                Err(e) => {
                    eprintln!("access token resolution failed for resume run {run_id}: {e}");
                    finalize_error(&pool, &hubs, run_id).await;
                    return;
                }
            };
        let manifest = WorkerManifest {
            workflow: WorkflowManifest {
                name: &workflow.name,
                version: &workflow.version,
                provider: &workflow.provider,
                model: workflow.model.as_deref().unwrap_or_default(),
                system_prompt: &workflow.system_prompt,
                thinking_level: workflow.thinking_level.as_deref().unwrap_or_default(),
                tools: crate::tools::descriptors_for(&workflow.tools),
            },
            prompt: "",
            messages,
            mode: Some("resume"),
            access_token: access_token.as_deref(),
        };
        let mut line = serde_json::to_string(&manifest).expect("WorkerManifest serializes");
        line.push('\n');
        if let Some(ref mut si) = stdin {
            if let Err(e) = si.write_all(line.as_bytes()).await {
                eprintln!("failed to write resume worker stdin: {e}");
            }
            let _ = si.flush().await;
        }
    }

    stream_worker(
        run_id,
        child,
        stdin,
        workflow,
        pool,
        assistant_message_id,
        hubs,
        tx,
        gate,
    )
    .await;
}

#[allow(clippy::too_many_arguments)]
async fn run_worker(
    run_id: Uuid,
    cmd: String,
    workflow: Workflow,
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

    // Keep the Worker's stdin open for the lifetime of the Run. After the
    // manifest, Core writes `tool_result` lines back over it (ADR-0013
    // bidirectional stdio); it is dropped when this task ends.
    let mut stdin = child.stdin.take();
    {
        // Build the spawn manifest (ADR-0018 as-built): the Workflow fields,
        // the current prompt, the assembled prior history, the tool
        // descriptors (filtered by the Workflow's allowlist), and — for OAuth
        // providers — a short-lived access token resolved by Core (ADR-0023).
        // Fresh-path history: each (role, text) becomes a typed-block
        // `ManifestMessage` (ADR-0025). The fresh path only ever emits
        // `user{text}` / `assistant{text}`; resume blocks are slice 3.
        let messages: Vec<ManifestMessage> = history
            .iter()
            .map(|(role, text)| match role.as_str() {
                "assistant" => ManifestMessage::Assistant {
                    text: Some(text),
                    tool_calls: None,
                },
                _ => ManifestMessage::User { text },
            })
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
                model: workflow.model.as_deref().unwrap_or_default(),
                system_prompt: &workflow.system_prompt,
                thinking_level: workflow.thinking_level.as_deref().unwrap_or_default(),
                tools: crate::tools::descriptors_for(&workflow.tools),
            },
            prompt: &prompt,
            messages,
            mode: None,
            access_token: access_token.as_deref(),
        };
        let mut line = serde_json::to_string(&manifest).expect("WorkerManifest serializes");
        line.push('\n');
        if let Some(ref mut si) = stdin {
            if let Err(e) = si.write_all(line.as_bytes()).await {
                eprintln!("failed to write worker stdin: {e}");
            }
            let _ = si.flush().await;
        }
        // Deliberately NOT dropped — kept open for `tool_result` writes.
    }

    stream_worker(
        run_id,
        child,
        stdin,
        workflow,
        pool,
        assistant_message_id,
        hubs,
        tx,
        gate,
    )
    .await;
}

/// Stream a spawned Worker's stdout to completion: read NDJSON lines, append
/// `text_delta`s under the per-run gate, dispatch (or park on) `tool_request`s,
/// and commit the terminal tx (`complete_run`/`error_run`) unless the Run
/// parked. Shared by the fresh spawn ([`run_worker`]) and the resume spawn
/// ([`run_resume_worker`]) — the only difference between them is the manifest
/// written before this runs. `child` already has its manifest on stdin; `stdin`
/// is the kept-open handle for `tool_result` writes (None once a terminal event
/// arrives).
#[allow(clippy::too_many_arguments)]
async fn stream_worker(
    run_id: Uuid,
    mut child: tokio::process::Child,
    mut stdin: Option<tokio::process::ChildStdin>,
    workflow: Workflow,
    pool: SqlitePool,
    assistant_message_id: Uuid,
    hubs: Hubs,
    tx: broadcast::Sender<RunEvent>,
    gate: Arc<tokio::sync::Mutex<()>>,
) {
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
    // Park (ADR-0025): set when a `propose_entity` tool_request is intercepted.
    // A parked Run is a third Worker exit — neither clean `done` nor
    // stdout-EOF-without-`done` — so the post-loop terminal branch must run
    // NEITHER `complete_run` NOR `error_run`, and publish no terminal Run
    // Event. The loop breaks immediately after parking; dropping `stdin`
    // (below) tears the Worker down.
    let mut parked = false;

    while let Ok(Some(line)) = lines.next_line().await {
        let msg: WorkerStdout = match serde_json::from_str(&line) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("worker emitted unknown line {line:?}: {e}");
                continue;
            }
        };

        match msg {
            // Per-event critical section (ADR-0022 exactly-once): hold the
            // per-run gate across persist + publish so a concurrent
            // `run/subscribe` snapshot/attach sees this delta either wholly in
            // the snapshot or wholly in the tail, never split or duplicated.
            WorkerStdout::TextDelta { delta } => {
                let guard = gate.lock().await;
                if let Err(e) = db::append_assistant_text(&pool, assistant_message_id, &delta).await
                {
                    eprintln!(
                        "text_delta append failed for assistant message {assistant_message_id}: {e}"
                    );
                }
                let _ = tx.send(RunEvent::TextDelta { delta });
                drop(guard);
            }
            // Terminal events are recorded as flags and published AFTER the
            // terminal tx commits (below) — see the comment on that branch.
            // Dropping stdin here sends the Worker EOF: a terminal event means
            // no further `tool_request`s can come, and workers that block on
            // stdin EOF to exit (e.g. the fixtures) must be released so their
            // stdout closes and this loop can break.
            WorkerStdout::Done => {
                saw_done = true;
                stdin = None;
            }
            WorkerStdout::Error { message } => {
                worker_error = Some(message);
                stdin = None;
            }
            // Tool Request (ADR-0018): execute the Core-owned tool and write a
            // `tool_result` back on the kept-open stdin, correlated by
            // `tool_call_id`. The dispatch itself rides a separate stdio
            // channel (not the hub) and must not block `run/subscribe`, so it
            // stays OUTSIDE the per-delta gate. We DO publish two ephemeral
            // `tool_call` Run Events onto the hub around it — `started` before
            // dispatch, then the terminal `completed`/`error` — so a connected
            // Client can surface "a tool is running" live (ADR-0006). These are
            // not persisted, so a late/reconnecting subscriber won't replay
            // them (ADR-0022:38). One tool at a time is sufficient for this
            // slice (the single `read_thread` tool).
            WorkerStdout::ToolRequest {
                tool_call_id,
                name,
                params,
                ..
            } => {
                // Proposal tools park the Run instead of dispatching (ADR-0025).
                // Persist the tool_call + a pending Proposal, set the Run to
                // `parked` recording the waitpoint, then break the read loop
                // with the `parked` flag so the post-loop branch runs neither
                // `complete_run` nor `error_run` and publishes no terminal Run
                // Event. The auto-approve seam returns false (every Proposal is
                // manual this slice), so every `propose_entity` parks.
                if crate::tools::is_proposal(&name) && !db::should_auto_approve() {
                    park_on_proposal(&pool, run_id, &tool_call_id, &name, &params).await;
                    parked = true;
                    // Drop stdin → EOF tears the Worker down (it blocks on
                    // stdin awaiting a tool_result that will never come).
                    drop(stdin.take());
                    break;
                }

                let _ = tx.send(RunEvent::ToolCall {
                    tool_call_id: tool_call_id.clone(),
                    name: name.clone(),
                    status: ToolCallStatus::Started,
                });
                let outcome =
                    handle_tool_request(&pool, run_id, &workflow, &tool_call_id, &name, params)
                        .await;
                let _ = tx.send(RunEvent::ToolCall {
                    tool_call_id: tool_call_id.clone(),
                    name,
                    status: match &outcome {
                        ToolOutcome::Ok { .. } => ToolCallStatus::Completed,
                        ToolOutcome::Err { .. } => ToolCallStatus::Error,
                    },
                });
                let result = ToolResult {
                    kind: "tool_result",
                    run_id: run_id.to_string(),
                    tool_call_id,
                    outcome,
                };
                if let Some(ref mut si) = stdin {
                    match serde_json::to_string(&result) {
                        Ok(mut l) => {
                            l.push('\n');
                            if let Err(e) = si.write_all(l.as_bytes()).await {
                                eprintln!("failed to write tool_result to worker stdin: {e}");
                            }
                            let _ = si.flush().await;
                        }
                        Err(e) => eprintln!("failed to serialize tool_result: {e}"),
                    }
                }
            }
        }
    }

    // Terminal-state tx. Either path commits the runs/messages/run_events
    // triple in a single transaction (ADR-0017's atomic recovery
    // invariant). A worker-emitted `error` takes precedence over the
    // EOF-without-done path and carries its own message.
    //
    // Park (ADR-0025) short-circuits this entirely: a parked Run already
    // committed `status='parked'` in `park_on_proposal`, and park is NOT a
    // terminal state — so neither `complete_run` nor `error_run` runs, and no
    // terminal Run Event is published. The hub is still removed below so a
    // later `run/subscribe` falls through to the persisted `parked` status.
    if !parked {
        let now_ms = db::now_ms();
        let result = if let Some(ref message) = worker_error {
            db::error_run_with_message(&pool, run_id, "errored", "worker_error", message, now_ms)
                .await
        } else if saw_done {
            db::complete_run(&pool, run_id, now_ms).await
        } else {
            db::error_run(&pool, run_id, now_ms).await
        };
        if let Err(e) = result {
            eprintln!("terminal tx failed for run {run_id}: {e}");
        }

        // Publish the terminal Run Event to the hub ONLY AFTER the terminal tx
        // commits (ordering matters — see the per-event match above). A Client
        // that receives this `done`/`error` is now guaranteed that tier 2
        // reflects the terminal state. The EOF-without-`done` path published
        // nothing (the Worker emitted no terminal event); its subscribers get a
        // synthesized `done` on `hub::remove` below.
        match (&worker_error, saw_done) {
            (Some(message), _) => {
                let _ = tx.send(RunEvent::Error {
                    message: message.clone(),
                });
            }
            (None, true) => {
                let _ = tx.send(RunEvent::Done);
            }
            (None, false) => {}
        }
    }

    // Remove the hub entry AFTER publishing the terminal event. Dropping the
    // broadcast sender lets attached subscribers observe `RecvError::Closed`
    // once they have drained the tail (including the terminal event published
    // just above).
    crate::hub::remove(&hubs, run_id);

    let _ = child.wait().await;
}

/// Handle one Tool Request (ADR-0018): enforce the Workflow's allowlist,
/// persist the call, dispatch it to the Rust tool registry, persist the
/// outcome, and return the `ToolOutcome` to write back to the Worker.
///
/// Allowlist enforcement (ADR-0003 chokepoint) uses Core's own copy of the
/// Workflow — a `tool_request` for a tool not in this Workflow's allowlist (or
/// not registered at all) is rejected with an `err` outcome and persists
/// nothing. The Worker can't tell whether the answer came from a tool or a
/// policy refusal — it just receives a `tool_result` (ADR-0016 shape).
async fn handle_tool_request(
    pool: &SqlitePool,
    run_id: Uuid,
    workflow: &Workflow,
    tool_call_id: &str,
    name: &str,
    params: serde_json::Value,
) -> ToolOutcome {
    let allowed =
        workflow.tools.iter().any(|t| t.as_str() == name) && crate::tools::is_registered(name);
    if !allowed {
        return ToolOutcome::Err {
            err: ToolErrorWire {
                code: "tool_not_allowed".to_string(),
                message: format!("tool {name:?} is not in this workflow's allowlist"),
            },
        };
    }

    // Persist the pending call + its run_step before executing, so the
    // timeline reflects an in-flight tool call (ADR-0017). A persistence
    // failure is logged but does not abort the call — the Worker still gets a
    // result so the Run can make progress.
    let request_payload = params.to_string();
    if let Err(e) =
        db::persist_tool_call(pool, run_id, tool_call_id, name, &request_payload, db::now_ms()).await
    {
        eprintln!("persist_tool_call failed for {tool_call_id}: {e}");
    }

    match crate::tools::execute(pool, name, params).await {
        Ok(result) => {
            let payload = serde_json::to_string(&result).unwrap_or_else(|_| "{}".to_string());
            if let Err(e) =
                db::resolve_tool_call(pool, tool_call_id, "completed", &payload, db::now_ms()).await
            {
                eprintln!("resolve_tool_call (completed) failed for {tool_call_id}: {e}");
            }
            ToolOutcome::Ok { ok: result }
        }
        Err(te) => {
            let payload =
                serde_json::json!({ "code": te.code, "message": te.message }).to_string();
            if let Err(e) =
                db::resolve_tool_call(pool, tool_call_id, "errored", &payload, db::now_ms()).await
            {
                eprintln!("resolve_tool_call (errored) failed for {tool_call_id}: {e}");
            }
            ToolOutcome::Err {
                err: ToolErrorWire {
                    code: te.code,
                    message: te.message,
                },
            }
        }
    }
}

/// Park the Run on a Proposal tool request (ADR-0025). Persists the Proposal's
/// `tool_calls` row (`pending`), a sidecar `proposals` row (`pending`,
/// `change_kind='create'`, `kind` from the proposed `type`), then sets
/// `runs.status='parked'` recording `awaiting_tool_call_id`. The proposed
/// `data`/`rationale` ride on the tool call's `request_payload`, so
/// `proposal/get` reconstructs them without a duplicate column. Persistence
/// failures are logged but do not abort — the loop still breaks and tears the
/// Worker down; a half-parked Run is recoverable on a later sweep.
async fn park_on_proposal(
    pool: &SqlitePool,
    run_id: Uuid,
    tool_call_id: &str,
    name: &str,
    params: &serde_json::Value,
) {
    let now = db::now_ms();
    let request_payload = params.to_string();
    if let Err(e) =
        db::persist_tool_call(pool, run_id, tool_call_id, name, &request_payload, now).await
    {
        eprintln!("persist_tool_call (proposal) failed for {tool_call_id}: {e}");
    }

    // The proposed entity type becomes the Proposal `kind`; `change_kind` is
    // `create` (propose_entity only creates). A missing/malformed `type`
    // degrades to an empty kind rather than aborting the park.
    let kind = params
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let proposal_id = Uuid::now_v7().to_string();
    if let Err(e) = db::persist_proposal(pool, &proposal_id, tool_call_id, kind, "create").await {
        eprintln!("persist_proposal failed for {tool_call_id}: {e}");
    }

    if let Err(e) = db::mark_run_parked(pool, run_id, tool_call_id).await {
        eprintln!("mark_run_parked failed for run {run_id}: {e}");
    }
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
