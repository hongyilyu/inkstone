//! Worker process spawn (ADR-0013) behind the transport seam (ADR-0026). One
//! Worker process per Run, stdio transport with NDJSON framing. `spawn`/`resume`
//! build the spawn manifest (the only fresh-vs-resume difference), hand it to a
//! [`child::ChildWorker`] (the sole `Command::spawn` site), and drive it with
//! the shared generic [`run::run_loop`]. The loop publishes each Run Event into
//! the Run's hub (ADR-0022) — the live stream is owned by Core, observable by
//! any connection, not bound to the issuing socket.

mod child;
mod port;
mod run;
mod title;

pub use title::spawn_title_generation;

use sqlx::SqlitePool;
use tracing::Instrument;
use uuid::Uuid;

use crate::db;
use crate::hub::{self, Hubs, RunHub};
use crate::protocol::{ManifestMessage, WorkerManifest, WorkflowManifest};
use crate::workflow::Workflow;

use crate::launch::{self, Role};
use child::ChildWorker;
use run::run_loop;

/// Resolve the Worker launch command (ADR-0041): the `INKSTONE_WORKER_CMD`
/// override (shlex-parsed) or the bundled `tsx` entrypoint. An empty override is
/// an error; logged as `worker.cmd_empty` (preserving the old guard's event) and
/// surfaced as `None` so the caller runs `finalize_error`.
fn resolve_worker_cmd(run_id: Uuid) -> Option<launch::ResolvedCommand> {
    match launch::resolve(Role::Worker) {
        Ok(cmd) => Some(cmd),
        Err(e) => {
            tracing::error!(event = "worker.cmd_empty", %run_id, error = ?e);
            None
        }
    }
}

/// Spawn a Worker for `run_id` (fresh path). Returns immediately; a Tokio task
/// builds the manifest, spawns the Worker, and drives it via [`run::run_loop`].
/// A pre-spawn failure (token resolution or process spawn) terminates the Run
/// via [`finalize_error`]. `text_delta`s append to the assistant row
/// pre-inserted at `seq=0`.
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
    // Correlation span (ADR-0038): every Diagnostic Log event emitted inside this
    // task — including `child.rs`'s stdout-reader sites where `run_id` is not a
    // parameter — inherits `run_id` from this span. `tokio::spawn` does NOT
    // propagate the current span, so the future is explicitly `.instrument`'d.
    let span = tracing::info_span!("worker_run", %run_id);
    tokio::spawn(
        async move {
            pre_spawn_delay_if_configured().await;
            if run_hub.is_cancelled() {
                hub::remove(&hubs, run_id);
                return;
            }
            let Some(line) = fresh_manifest_line(run_id, &workflow, &prompt, &history).await else {
                finalize_error(&pool, &hubs, run_id).await;
                return;
            };
            if run_hub.is_cancelled() {
                hub::remove(&hubs, run_id);
                return;
            }
            let Some(cmd) = resolve_worker_cmd(run_id) else {
                finalize_error(&pool, &hubs, run_id).await;
                return;
            };
            match ChildWorker::spawn(run_id, &cmd.program, &cmd.args, line).await {
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
        }
        .instrument(span),
    );
}

/// Resume a parked Run after its Proposal is decided (ADR-0025). Reconstructs
/// the transcript, flips `parked → running` (self-guarded — bails if another
/// resume won the race), creates a fresh per-run hub, and spawns a
/// `mode:"resume"` Worker driven by [`run::run_loop`].
///
/// Errors only on a pre-spawn failure (assistant message missing). The atomic
/// apply is already committed, so a resume failure leaves a durably-accepted
/// Proposal on a still-parked Run (an idempotent decide retry re-resumes).
pub async fn resume(run_id: Uuid, pool: &SqlitePool, hubs: &Hubs) -> anyhow::Result<()> {
    // Rebuild the effective Workflow from the Run's PERSISTED snapshot (ADR-0024),
    // NOT by re-resolving live settings: a model/effort change between park and
    // decide must affect the next Run, not this resumed one. The snapshot carries
    // the resolved model/thinking_level; the static base of the same name supplies
    // the un-tunable system_prompt/tools.
    let workflow =
        crate::db::run_workflow_snapshot(pool, run_id, crate::workflow::default_workflow())
            .await?
            .ok_or_else(|| anyhow::anyhow!("run {run_id} has no Workflow snapshot to resume"))?;

    let assistant_message_id = db::assistant_message_id_for_run(pool, run_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("run {run_id} has no assistant message to resume into"))?;

    // Reconstruct the transcript (ADR-0025): every tool_call resolved, the
    // final message the Decision tool_result.
    let transcript = crate::resume::reconstruct(pool, run_id).await?;

    // Build the manifest line BEFORE the flip so the realistic pre-spawn
    // failure (e.g. an expired credential) propagates as `Err` while still
    // `parked`: `decide::apply` maps it to an error, `proposal/decide` reports
    // failure, and the Client retries — the still-parked recovery branch then
    // re-resumes. (Wedging the Run `errored` here would strand a
    // durably-accepted Proposal whose model never saw the Decision.)
    let Some(line) = resume_manifest_line(run_id, &workflow, &transcript).await else {
        anyhow::bail!("resume manifest build failed for run {run_id} (token resolution)");
    };

    // Flip parked → running before creating the hub/spawning. Self-guarded on
    // `status = 'parked'`: if 0 rows matched, another resume won the race —
    // bail so exactly one resume Worker runs.
    let flipped = db::mark_run_running(pool, run_id).await?;
    if !flipped.won() {
        return Ok(());
    }

    let run_hub = hub::create(hubs, run_id);
    let pool = pool.clone();
    let hubs = hubs.clone();
    // Correlation span (ADR-0038), mirroring `spawn`: `run_id` reaches the
    // child.rs reader sites only via this explicitly-`.instrument`'d span.
    let span = tracing::info_span!("worker_run", %run_id);
    tokio::spawn(
        async move {
            pre_spawn_delay_if_configured().await;
            if run_hub.is_cancelled() {
                hub::remove(&hubs, run_id);
                return;
            }
            let Some(cmd) = resolve_worker_cmd(run_id) else {
                finalize_error(&pool, &hubs, run_id).await;
                return;
            };
            match ChildWorker::spawn(run_id, &cmd.program, &cmd.args, line).await {
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
                // Rare residual case: a post-flip spawn failure (the realistic
                // token/manifest failure is handled before the flip). The decide
                // RPC already reported success, so re-parking would leave a decided
                // card over a silently hung turn. Finalize `errored` instead so the
                // failure is visible and the user can re-send.
                Err(()) => finalize_error(&pool, &hubs, run_id).await,
            }
        }
        .instrument(span),
    );

    Ok(())
}

/// Build the fresh-spawn manifest line (ADR-0018): Workflow fields, prompt,
/// prior history as typed message blocks, allowlisted tool descriptors, and —
/// for OAuth providers — a short-lived access token (ADR-0023). `None` if token
/// resolution fails (the caller runs `finalize_error`).
async fn fresh_manifest_line(
    run_id: Uuid,
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
    let access_token = resolve_token(run_id, workflow).await?;
    // Scan the skills dir and inject the <available_skills> block per spawn
    // (ADR-0036): fresh AND resume both build the manifest here, so both see the
    // current skill set without snapshotting a stale one. The augmented String
    // must outlive the borrowing manifest, so it is bound here.
    let system_prompt = crate::skills::augmented_system_prompt(workflow);
    let manifest = WorkerManifest {
        run_id,
        workflow: workflow_manifest(workflow, &system_prompt),
        prompt,
        messages,
        mode: None,
        access_token: access_token.as_deref(),
    };
    Some(serialize_manifest(&manifest))
}

/// Build the resume manifest line (ADR-0025): empty prompt, reconstructed
/// transcript as typed message blocks, `mode:"resume"`. `None` on token failure.
async fn resume_manifest_line(
    run_id: Uuid,
    workflow: &Workflow,
    transcript: &[crate::resume::Block],
) -> Option<String> {
    let messages: Vec<ManifestMessage> = transcript.iter().map(crate::resume::Block::as_message).collect();
    let access_token = resolve_token(run_id, workflow).await?;
    let system_prompt = crate::skills::augmented_system_prompt(workflow);
    let manifest = WorkerManifest {
        run_id,
        workflow: workflow_manifest(workflow, &system_prompt),
        prompt: "",
        messages,
        mode: Some("resume"),
        access_token: access_token.as_deref(),
    };
    Some(serialize_manifest(&manifest))
}

/// Build the `WorkflowManifest` (ADR-0018). `system_prompt` is passed in (not
/// taken from `workflow`) because it carries the per-spawn `<available_skills>`
/// injection (ADR-0036) and must be owned by the caller to outlive this borrow.
/// `tools` is the Run descriptor set: the Workflow's own allowlist plus ambient
/// `load_skill`.
fn workflow_manifest<'a>(workflow: &'a Workflow, system_prompt: &'a str) -> WorkflowManifest<'a> {
    WorkflowManifest {
        name: &workflow.name,
        version: &workflow.version,
        provider: &workflow.provider,
        model: workflow.model.as_deref().unwrap_or_default(),
        system_prompt,
        thinking_level: workflow.thinking_level.as_deref().unwrap_or("off"),
        tools: crate::tools::run_descriptors(&workflow.tools),
    }
}

async fn resolve_token(run_id: Uuid, workflow: &Workflow) -> Option<Option<String>> {
    match crate::provider_auth::resolve_access_token(&workflow.provider, db::now_ms()).await {
        Ok(token) => Some(token),
        Err(e) => {
            // `run_id` is threaded in so the resume path (which resolves the
            // token BEFORE the span is entered) also emits run_id top-level
            // (ADR-0038 canonical). Provider name only — never the token/secret
            // (ADR-0038 redaction).
            tracing::error!(
                event = "worker.access_token_resolution_failed",
                %run_id,
                provider = %workflow.provider,
                error = ?e
            );
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

/// Pre-loop spawn-failure path: the Worker produced no output, so terminate the
/// Run as `worker_disconnected` (ADR-0017) and remove the hub so a subscriber
/// falls through to the persisted snapshot + `done`.
async fn finalize_error(pool: &SqlitePool, hubs: &Hubs, run_id: Uuid) {
    if let Err(e) = db::error_run(pool, run_id, db::now_ms()).await {
        tracing::error!(event = "worker.error_run_failed", %run_id, error = ?e);
    }
    crate::hub::remove(hubs, run_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workflow(tools: &[&str]) -> Workflow {
        Workflow {
            name: "default".to_string(),
            version: "1.0.0".to_string(),
            provider: "faux".to_string(),
            model: Some("m".to_string()),
            system_prompt: "Base prompt.".to_string(),
            thinking_level: Some("off".to_string()),
            tools: tools.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// The manifest builder injects the scanned skills' name+description into the
    /// `system_prompt` AND ships `load_skill` in `tools`, even when the Workflow's
    /// own allowlist omits it — the two ADR-0036 gates, asserted together on the
    /// one struct that reaches the wire.
    #[test]
    fn workflow_manifest_injects_skills_and_ambient_load_skill() {
        let _guard = crate::skills::SKILLS_ENV_GUARD
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let tmp = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(tmp.path().join("weekly-review")).expect("mk skill dir");
        std::fs::write(
            tmp.path().join("weekly-review").join("SKILL.md"),
            "---\nname: weekly-review\ndescription: Guide a GTD weekly review.\n---\n\n# Weekly review\n",
        )
        .expect("write SKILL.md");
        unsafe {
            std::env::set_var("INKSTONE_SKILLS_DIR", tmp.path());
        }

        // A Workflow whose own allowlist has one domain tool and NOT load_skill.
        let wf = workflow(&["search_entities"]);
        let system_prompt = crate::skills::augmented_system_prompt(&wf);
        let manifest = workflow_manifest(&wf, &system_prompt);

        // Disclosure: the base prompt is kept and the skill's name+description are
        // injected under an <available_skills> block.
        assert!(manifest.system_prompt.starts_with("Base prompt."));
        assert!(manifest.system_prompt.contains("<available_skills>"));
        assert!(
            manifest
                .system_prompt
                .contains("- weekly-review: Guide a GTD weekly review."),
            "skill name+description injected — got {:?}",
            manifest.system_prompt
        );

        // Activation: load_skill is shipped (ambient) alongside the domain tool.
        let tool_names: Vec<&str> = manifest.tools.iter().map(|t| t.name.as_str()).collect();
        assert!(tool_names.contains(&"search_entities"), "domain tool kept");
        assert!(
            tool_names.contains(&"load_skill"),
            "ambient load_skill shipped despite the Workflow omitting it — got {tool_names:?}"
        );

        unsafe {
            std::env::remove_var("INKSTONE_SKILLS_DIR");
        }
    }

    /// With no skills dir, the prompt is left untouched (no empty block) but
    /// `load_skill` is still ambiently shipped — disclosure degrades, activation
    /// does not.
    #[test]
    fn workflow_manifest_without_skills_keeps_bare_prompt_but_ships_load_skill() {
        let _guard = crate::skills::SKILLS_ENV_GUARD
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let tmp = tempfile::tempdir().expect("tempdir");
        // Point at an empty (existing) dir: scan finds nothing.
        unsafe {
            std::env::set_var("INKSTONE_SKILLS_DIR", tmp.path());
        }

        let wf = workflow(&["search_entities"]);
        let system_prompt = crate::skills::augmented_system_prompt(&wf);
        let manifest = workflow_manifest(&wf, &system_prompt);

        assert_eq!(
            manifest.system_prompt, "Base prompt.",
            "no skills → no block"
        );
        let tool_names: Vec<&str> = manifest.tools.iter().map(|t| t.name.as_str()).collect();
        assert!(
            tool_names.contains(&"load_skill"),
            "load_skill stays ambient"
        );

        unsafe {
            std::env::remove_var("INKSTONE_SKILLS_DIR");
        }
    }
}
