//! Worker process spawn (ADR-0013) behind the transport seam (ADR-0026). One
//! Worker process per Run, stdio transport with NDJSON framing. `spawn`/`resume`
//! build the spawn manifest (the only fresh-vs-resume difference), hand it to a
//! [`child::ChildWorker`] (the sole `Command::spawn` site), and drive it with
//! the shared generic [`run::run_loop`]. The loop publishes each Run Event into
//! the Run's hub (ADR-0022) — the live stream is owned by Core and observable by
//! any connection, not bound to the socket that issued `run/post_message`.

mod child;
mod port;
mod run;

use sqlx::SqlitePool;
use uuid::Uuid;

use crate::db;
use crate::hub::{self, Hubs, RunHub};
use crate::protocol::{ManifestMessage, WorkerManifest, WorkflowManifest};
use crate::workflow::Workflow;

use child::ChildWorker;
use run::run_loop;

/// The Worker command line. `INKSTONE_WORKER_CMD` overrides it (tests point it
/// at a fixture worker); otherwise the bundled `tsx` entrypoint.
fn worker_cmd() -> String {
    std::env::var("INKSTONE_WORKER_CMD").unwrap_or_else(|_| {
        "packages/worker/node_modules/.bin/tsx packages/worker/src/cli.ts".to_string()
    })
}

/// Spawn a Worker for `run_id` (fresh path). Returns immediately; a Tokio task
/// builds the fresh-spawn manifest, spawns the Worker, and drives it to a
/// terminal state via [`run::run_loop`]. A pre-spawn failure (token resolution
/// or process spawn) terminates the Run via [`finalize_error`].
///
/// `pool` + `assistant_message_id` append each `text_delta` to the assistant
/// `message_parts.text` row pre-inserted at `seq=0`; the per-event critical
/// section (ADR-0022) lives inside `run_loop`.
#[allow(clippy::too_many_arguments)]
pub fn spawn(
    run_id: Uuid,
    workflow: Workflow,
    prompt: String,
    history: Vec<(String, String)>,
    pool: SqlitePool,
    assistant_message_id: Uuid,
    hubs: Hubs,
    run_hub: RunHub,
) {
    tokio::spawn(async move {
        pre_spawn_delay_if_configured().await;
        if run_hub.is_cancelled() {
            hub::remove(&hubs, run_id);
            return;
        }
        let Some(line) = fresh_manifest_line(&workflow, &prompt, &history).await else {
            finalize_error(&pool, &hubs, run_id).await;
            return;
        };
        if run_hub.is_cancelled() {
            hub::remove(&hubs, run_id);
            return;
        }
        match ChildWorker::spawn(&worker_cmd(), line).await {
            Ok(worker) => {
                if run_hub.is_cancelled() {
                    drop(worker);
                    hub::remove(&hubs, run_id);
                    return;
                }
                run_loop(
                    worker,
                    run_id,
                    workflow,
                    pool,
                    assistant_message_id,
                    hubs,
                    run_hub.tx.clone(),
                    run_hub.gate.clone(),
                    run_hub.cancel_rx(),
                )
                .await;
            }
            Err(()) => finalize_error(&pool, &hubs, run_id).await,
        }
    });
}

/// Resume a parked Run after its Proposal is decided (ADR-0025). Reconstructs
/// the transcript from tier 2, flips the Run `parked → running` (self-guarded —
/// bails if another resume already won the race), creates a FRESH per-run hub,
/// and spawns a `mode:"resume"` Worker driven by the shared [`run::run_loop`].
///
/// Returns an error only on a pre-spawn failure (assistant message missing).
/// The caller has already committed the atomic apply, so a resume failure
/// leaves a durably-accepted Proposal on a still-parked Run (an idempotent
/// decide retry can re-resume).
pub async fn resume(run_id: Uuid, pool: &SqlitePool, hubs: &Hubs) -> anyhow::Result<()> {
    // Resolve the effective Workflow (ADR-0024) exactly as the fresh path does;
    // the raw `default_workflow()` leaves model/thinking_level `None`, which the
    // resume manifest would serialize as `""`/`off` and the real Worker rejects.
    let workflow =
        crate::dispatcher::resolve_effective_workflow(pool, crate::workflow::default_workflow())
            .await;

    let assistant_message_id = db::assistant_message_id_for_run(pool, run_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("run {run_id} has no assistant message to resume into"))?;

    // Reconstruct the transcript (ADR-0025): every tool_call resolved, the final
    // message the Decision tool_result.
    let transcript = crate::resume::reconstruct(pool, run_id).await?;

    // Build the manifest line (token resolution + serialization) BEFORE the
    // `parked → running` flip. This is the realistic pre-spawn failure (e.g. an
    // expired credential), and doing it here lets it propagate as `Err` while
    // the Run is still `parked`: `decide::apply` maps it to an error, so
    // `proposal/decide` reports failure (no `proposal/changed`) and the Client
    // retries — the still-parked recovery branch then re-resumes. Wedging the
    // Run `errored` (the old behavior) instead stranded a durably-accepted
    // Proposal whose model never saw the Decision (ADR-0025).
    let Some(line) = resume_manifest_line(&workflow, &transcript).await else {
        anyhow::bail!("resume manifest build failed for run {run_id} (token resolution)");
    };

    // Flip parked → running BEFORE creating the hub/spawning. Self-guarded on
    // `status = 'parked'`: if 0 rows matched, another resume already won the
    // race — bail so exactly one resume Worker runs.
    let flipped = db::mark_run_running(pool, run_id).await?;
    if !flipped.won() {
        return Ok(());
    }

    let run_hub = hub::create(hubs, run_id);
    let pool = pool.clone();
    let hubs = hubs.clone();
    tokio::spawn(async move {
        pre_spawn_delay_if_configured().await;
        if run_hub.is_cancelled() {
            hub::remove(&hubs, run_id);
            return;
        }
        match ChildWorker::spawn(&worker_cmd(), line).await {
            Ok(worker) => {
                run_loop(
                    worker,
                    run_id,
                    workflow,
                    pool,
                    assistant_message_id,
                    hubs,
                    run_hub.tx.clone(),
                    run_hub.gate.clone(),
                    run_hub.cancel_rx(),
                )
                .await;
            }
            // A post-flip ChildWorker::spawn failure is the rare residual case:
            // the realistic pre-spawn failure (token/manifest) is handled BEFORE
            // the flip above and propagates as `Err` while still parked. By the
            // time we are here the decide RPC has already reported success, so
            // re-parking would leave a decided card over a silently hung turn (no
            // pending Proposal for `run/subscribe` to surface). Finalize `errored`
            // instead: the synthesized terminal event makes the failure visible
            // and the user can re-send, rather than the turn hanging forever.
            Err(()) => finalize_error(&pool, &hubs, run_id).await,
        }
    });

    Ok(())
}

/// Build the fresh-spawn manifest line (ADR-0018): the Workflow fields, the
/// current prompt, the assembled prior history as typed message blocks, the
/// allowlisted tool descriptors, and — for OAuth providers — a short-lived
/// access token (ADR-0023). `None` if token resolution fails (the caller
/// terminates the Run via `finalize_error`).
async fn fresh_manifest_line(
    workflow: &Workflow,
    prompt: &str,
    history: &[(String, String)],
) -> Option<String> {
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
    let access_token = resolve_token(workflow).await?;
    let manifest = WorkerManifest {
        workflow: workflow_manifest(workflow),
        prompt,
        messages,
        mode: None,
        access_token: access_token.as_deref(),
    };
    Some(serialize_manifest(&manifest))
}

/// Build the resume manifest line (ADR-0025): an empty prompt, the reconstructed
/// transcript as typed message blocks, and `mode:"resume"`. `None` on token
/// failure.
async fn resume_manifest_line(
    workflow: &Workflow,
    transcript: &[crate::resume::Block],
) -> Option<String> {
    let messages: Vec<ManifestMessage> = transcript.iter().map(crate::resume::Block::as_message).collect();
    let access_token = resolve_token(workflow).await?;
    let manifest = WorkerManifest {
        workflow: workflow_manifest(workflow),
        prompt: "",
        messages,
        mode: Some("resume"),
        access_token: access_token.as_deref(),
    };
    Some(serialize_manifest(&manifest))
}

fn workflow_manifest(workflow: &Workflow) -> WorkflowManifest<'_> {
    WorkflowManifest {
        name: &workflow.name,
        version: &workflow.version,
        provider: &workflow.provider,
        model: workflow.model.as_deref().unwrap_or_default(),
        system_prompt: &workflow.system_prompt,
        thinking_level: workflow.thinking_level.as_deref().unwrap_or("off"),
        tools: crate::tools::descriptors_for(&workflow.tools),
    }
}

async fn resolve_token(workflow: &Workflow) -> Option<Option<String>> {
    match crate::provider_auth::resolve_access_token(&workflow.provider, db::now_ms()).await {
        Ok(token) => Some(token),
        Err(e) => {
            eprintln!("access token resolution failed for provider {:?}: {e}", workflow.provider);
            None
        }
    }
}

fn serialize_manifest(manifest: &WorkerManifest<'_>) -> String {
    let mut line = serde_json::to_string(manifest).expect("WorkerManifest serializes");
    line.push('\n');
    line
}

async fn pre_spawn_delay_if_configured() {
    // Test-only hook for forcing the cancel-before-worker-start race.
    let Ok(raw) = std::env::var("INKSTONE_WORKER_PRE_SPAWN_DELAY_MS") else {
        return;
    };
    let Ok(ms) = raw.parse::<u64>() else {
        return;
    };
    if ms > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
    }
}

/// Pre-loop spawn-failure path: the Worker never produced any output, so the
/// Run terminates immediately as `worker_disconnected` (ADR-0017 atomic
/// recovery), then the hub entry is removed so a subscriber falls through to
/// the persisted snapshot + `done`.
async fn finalize_error(pool: &SqlitePool, hubs: &Hubs, run_id: Uuid) {
    if let Err(e) = db::error_run(pool, run_id, db::now_ms()).await {
        eprintln!("error_run after pre-loop spawn failure for run {run_id}: {e}");
    }
    crate::hub::remove(hubs, run_id);
}
