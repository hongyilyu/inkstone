//! Worker process spawn (ADR-0013) behind the transport seam (ADR-0026). One
//! Worker process per Run, stdio transport with NDJSON framing. `spawn`/`resume`
//! build the manifest line (the only fresh-vs-resume difference) and hand it to
//! [`drive`] — the one shared driver body — which spawns a
//! [`child::ChildWorker`] (the sole `Command::spawn` site) and drives it with
//! the shared generic [`run::run_loop`]. The loop publishes each Run Event into
//! the Run's hub (ADR-0022) — the live stream is owned by Core, observable by
//! any connection, not bound to the issuing socket.

mod child;
mod liveness;
mod oneshot;
mod port;
mod run;
mod title;

pub use title::spawn_title_generation;
// The provider/test handler (`crate::runs::provider`) drives the synchronous
// liveness probe (ADR-0062) — a one-shot non-Run Worker, sibling to the titler.
pub(crate) use liveness::probe as probe_liveness;

use sqlx::SqlitePool;
use tracing::Instrument;
use uuid::Uuid;

use crate::db;
use crate::hub::{self, Hubs, RunHub};
use crate::protocol::{ManifestAttachment, ManifestMessage, WorkerManifest, WorkflowManifest};
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

/// Everything [`spawn`] takes — built by [`crate::start_run::start_run`],
/// consumed by the injected `spawn_fn` (production: [`spawn`]).
pub struct SpawnManifest {
    pub run_id: Uuid,
    pub workflow: Workflow,
    pub prompt: String,
    pub history: Vec<(String, String)>,
    /// The current turn's pre-encoded image attachments
    /// (chat-image-attachments) — resolved by the shell, shipped in the fresh
    /// manifest line.
    pub manifest_attachments: Vec<ManifestAttachment>,
    pub pool: SqlitePool,
    pub assistant_message_id: Uuid,
    pub hubs: Hubs,
    pub run_hub: RunHub,
}

/// Spawn a Worker for `m.run_id` (fresh path). Returns immediately; a Tokio
/// task builds the manifest line and hands it to [`drive`]. A pre-spawn failure
/// (token resolution or process spawn) terminates the Run via
/// [`finalize_error`]. `text_delta`s append to the assistant row pre-inserted
/// at `seq=0`. `m.manifest_attachments` is the CURRENT turn's images, already
/// read + base64-encoded by the handler (so a read failure fails the RPC, not
/// this detached task).
pub fn spawn(m: SpawnManifest) {
    let SpawnManifest {
        run_id,
        workflow,
        prompt,
        history,
        manifest_attachments: attachments,
        pool,
        assistant_message_id,
        hubs,
        run_hub,
    } = m;
    // Correlation span (ADR-0038): every Diagnostic Log event emitted inside this
    // task — including `child.rs`'s stdout-reader sites where `run_id` is not a
    // parameter — inherits `run_id` from this span. `tokio::spawn` does NOT
    // propagate the current span, so the future is explicitly `.instrument`'d.
    let span = tracing::info_span!("worker_run", %run_id);
    tokio::spawn(
        async move {
            pre_spawn_delay_if_configured().await;
            // Manifest-build-specific cancel check: bail before the (async)
            // token resolution the build performs. `drive`'s own entry check
            // re-tests after the build.
            if run_hub.is_cancelled() {
                hub::remove(&hubs, run_id);
                return;
            }
            let Some(line) =
                fresh_manifest_line(run_id, &workflow, &prompt, &history, attachments).await
            else {
                finalize_error(&pool, &hubs, run_id).await;
                return;
            };
            drive(
                line,
                run_id,
                workflow,
                pool,
                assistant_message_id,
                hubs,
                run_hub,
            )
            .await;
        }
        .instrument(span),
    );
}

/// Resume a parked Run after its Proposal is decided (ADR-0025). Reconstructs
/// the transcript, flips `parked → running` (self-guarded — bails if another
/// resume won the race), creates a fresh per-run hub, and hands the pre-built
/// `mode:"resume"` manifest to [`drive`].
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
            drive(
                line,
                run_id,
                workflow,
                pool,
                assistant_message_id,
                hubs,
                run_hub,
            )
            .await;
        }
        .instrument(span),
    );

    Ok(())
}

/// The one Worker driver task body, shared by the fresh ([`spawn`]) and resume
/// ([`resume`]) paths — the manifest `line` is the only caller-supplied
/// difference. Cancel checks sit at fixed structural positions — on entry
/// (before the command resolve) and after the child spawn — so fresh and
/// resume honor cancellation identically BY CONSTRUCTION: the union of the two
/// pre-collapse check sets (the old resume body lacked the post-spawn check
/// for no reason recorded anywhere).
///
/// Layout: `drive` does NOT own the pre-spawn test delay or the manifest
/// build. Each caller's task body runs `pre_spawn_delay_if_configured` first
/// (once — no double delay), the fresh path keeps its manifest sandwich
/// (cancel check → async build) caller-side, and `drive`'s entry check IS the
/// fresh path's pre-collapse post-build check — so both callers' orderings are
/// preserved exactly, with resume's post-spawn check the one union addition.
async fn drive(
    line: String,
    run_id: Uuid,
    workflow: Workflow,
    pool: SqlitePool,
    assistant_message_id: Uuid,
    hubs: Hubs,
    run_hub: RunHub,
) {
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
            // Post-spawn cancel check (the union addition for resume): the
            // cancel won while the child was spawning, so drop it before the
            // loop ever runs — `kill_on_drop` reaps it, no orphan Worker.
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
                run_hub,
            )
            .await;
        }
        // A pre-loop spawn failure finalizes the Run `errored`. For a fresh
        // Run this is the ordinary pre-spawn failure path. For a resume it is
        // the rare residual case — a post-flip spawn failure (the realistic
        // token/manifest failure is handled before the flip): the decide RPC
        // already reported success, so re-parking would leave a decided card
        // over a silently hung turn. Finalizing `errored` keeps the failure
        // visible and the user can re-send.
        Err(()) => finalize_error(&pool, &hubs, run_id).await,
    }
}

/// Build the fresh-spawn manifest line (ADR-0018): Workflow fields, prompt,
/// prior history as typed message blocks, allowlisted tool descriptors, the
/// current turn's pre-encoded image `attachments` (chat-image-attachments),
/// and — for OAuth providers — a short-lived access token (ADR-0023). `None`
/// if token resolution fails (the caller runs `finalize_error`).
async fn fresh_manifest_line(
    run_id: Uuid,
    workflow: &Workflow,
    prompt: &str,
    history: &[(String, String)],
    attachments: Vec<ManifestAttachment>,
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
    // Scan the skills dir once and build the effective system prompt (ADR-0036 +
    // ADR-0063): the <available_skills> block plus — on a trigger match against
    // the current prompt — a Core-authored directive naming the matched skill.
    // ONE scan feeds both, so the advertised set is exactly the matchable set.
    // The augmented String must outlive the borrowing manifest, so it is bound
    // here. Resume uses the plain `augmented_system_prompt` (no fresh prompt to
    // match), so the directive is fresh-dispatch-only.
    let system_prompt = crate::skills::augmented_system_prompt_with_trigger(workflow, prompt);
    let manifest = WorkerManifest {
        run_id,
        workflow: workflow_manifest(workflow, &system_prompt),
        prompt,
        messages,
        mode: None,
        access_token: access_token.as_deref(),
        attachments: (!attachments.is_empty()).then_some(attachments),
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
        // Parked-resume does not replay images — accepted cut (plan §out-of-scope):
        // only the CURRENT turn's attachments ever reach a model, and a resumed
        // Run's turn already started without them.
        attachments: None,
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

pub(super) fn serialize_manifest(manifest: &WorkerManifest<'_>) -> String {
    let mut line = serde_json::to_string(manifest).expect("WorkerManifest serializes");
    line.push('\n');
    line
}

async fn pre_spawn_delay_if_configured() {
    // Test-only hook for forcing the cancel-before-worker-start race.
    if let Some(delay) = crate::config::get().worker_pre_spawn_delay {
        tokio::time::sleep(delay).await;
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
        let tmp = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(tmp.path().join("weekly-review")).expect("mk skill dir");
        std::fs::write(
            tmp.path().join("weekly-review").join("SKILL.md"),
            "---\nname: weekly-review\ndescription: Guide a GTD weekly review.\n---\n\n# Weekly review\n",
        )
        .expect("write SKILL.md");
        let _config = crate::skills::test_skills_dir(tmp.path());

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
    }

    /// The shared driver honors a cancel signalled before the child spawn — for
    /// the RESUME path too (the union of the two pre-collapse check sets: the
    /// old resume task body lacked the fresh path's post-spawn check). The test
    /// pins the check POSITION via the cancelled-before-`drive` path: cancel
    /// first, run `drive`, assert no orphan hub and no run_loop / finalize
    /// side effects (status untouched). Driving a real `ChildWorker` to exercise
    /// the post-spawn check in isolation would need a spawnable worker binary
    /// (env-dependent, non-hermetic) — and its outcome is indistinguishable
    /// from `run_loop`'s own initial-cancel handling from outside — so the
    /// pre-spawn structural position is the one pinned here. RED note: this
    /// behavior was unreachable pre-collapse (the old resume body had no shared
    /// seam to call), so the RED commit compiled this against a `todo!()` stub
    /// of `drive` — the refactor-slice exemption.
    #[tokio::test]
    async fn drive_honors_cancel_signalled_before_child_spawn() {
        use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

        let options = SqliteConnectOptions::new()
            .filename(":memory:")
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("open in-memory sqlite");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");

        // Seed a Thread + Run so `runs.status` exists to assert against.
        let wf = workflow(&[]);
        let thread_id = Uuid::now_v7();
        let run_id = Uuid::now_v7();
        let assistant_message_id = Uuid::now_v7();
        db::persist_thread_with_first_run(
            &pool,
            thread_id,
            run_id,
            Uuid::now_v7(),
            assistant_message_id,
            &wf,
            "prompt",
            &[],
            "t",
            1,
        )
        .await
        .expect("seed run");

        let hubs = hub::new_hubs();
        let run_hub = hub::create(&hubs, run_id);
        // The cancel wins BEFORE the driver reaches the child spawn.
        run_hub.cancel();

        drive(
            "{}\n".to_string(),
            run_id,
            wf,
            pool.clone(),
            assistant_message_id,
            hubs.clone(),
            run_hub,
        )
        .await;

        // Bailed at the pre-spawn check: hub removed (no orphan) ...
        assert!(
            hub::get(&hubs, run_id).is_none(),
            "a cancelled driver removes the hub instead of orphaning it"
        );
        // ... and neither run_loop nor finalize_error ran: status untouched.
        assert_eq!(
            db::run_status(&pool, run_id)
                .await
                .unwrap()
                .map(db::RunStatus::as_str),
            Some("running"),
            "no terminal tx: the driver spawned nothing and finalized nothing"
        );
    }

    /// With no skills dir, the prompt is left untouched (no empty block) but
    /// `load_skill` is still ambiently shipped — disclosure degrades, activation
    /// does not.
    #[test]
    fn workflow_manifest_without_skills_keeps_bare_prompt_but_ships_load_skill() {
        let tmp = tempfile::tempdir().expect("tempdir");
        // Point at an empty (existing) dir: scan finds nothing.
        let _config = crate::skills::test_skills_dir(tmp.path());

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
    }

    /// Seed a `weekly-review` skill with a `triggers` phrase in a temp skills dir
    /// and return the config guard keeping it active for the test.
    fn seed_triggered_skill(tmp: &std::path::Path) -> crate::config::test_override::ConfigGuard {
        std::fs::create_dir_all(tmp.join("weekly-review")).expect("mk skill dir");
        std::fs::write(
            tmp.join("weekly-review").join("SKILL.md"),
            "---\nname: weekly-review\ndescription: Guide a GTD weekly review.\ntriggers:\n  - weekly review\n---\n\n# Weekly review\n",
        )
        .expect("write SKILL.md");
        crate::skills::test_skills_dir(tmp)
    }

    /// ADR-0063: a fresh prompt containing a skill's trigger phrase appends the
    /// Core-authored directive naming that skill AFTER the `<available_skills>`
    /// block. The `<available_skills>` block itself is unchanged (disclosure).
    #[test]
    fn fresh_prompt_matching_a_trigger_appends_the_directive() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let _config = seed_triggered_skill(tmp.path());
        let wf = workflow(&["search_entities"]);

        let sp = crate::skills::augmented_system_prompt_with_trigger(&wf, "let's do my weekly review");

        assert!(sp.contains("<available_skills>"), "disclosure block still present");
        let directive = crate::skills::render_trigger_directive("weekly-review");
        assert!(sp.contains(&directive), "directive appended — got {sp:?}");
        // Directive comes AFTER the closing tag (append order), never inside the block.
        let block_end = sp.find("</available_skills>").expect("block closes");
        let dir_at = sp.find(&directive).expect("directive present");
        assert!(dir_at > block_end, "directive sits after the block");
    }

    /// A fresh prompt that matches no trigger gets the plain `<available_skills>`
    /// block and NO directive — byte-identical to the pre-ADR-0063 fresh prompt.
    #[test]
    fn fresh_prompt_without_a_match_has_no_directive() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let _config = seed_triggered_skill(tmp.path());
        let wf = workflow(&["search_entities"]);

        let sp = crate::skills::augmented_system_prompt_with_trigger(&wf, "something unrelated");

        assert!(sp.contains("<available_skills>"), "block still present");
        assert!(
            !sp.contains("Call load_skill(\"weekly-review\")"),
            "no directive without a match — got {sp:?}"
        );
        // Identical to the plain (resume) augmenter when nothing matches.
        assert_eq!(
            sp,
            crate::skills::augmented_system_prompt(&wf),
            "no-match fresh prompt equals the plain augmented prompt"
        );
    }

    /// The RESUME manifest builder never adds a directive — it uses the plain
    /// augmenter (no fresh prompt to match, ADR-0025/0063), even when a triggering
    /// skill is present and the reconstructed transcript's user turn would match.
    #[tokio::test]
    async fn resume_manifest_never_carries_a_directive() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let _config = seed_triggered_skill(tmp.path());
        let wf = workflow(&[]);
        // A reconstructed transcript whose user turn literally contains the trigger.
        let transcript = vec![crate::resume::Block::User {
            text: "let's do my weekly review".to_string(),
        }];

        let line = resume_manifest_line(Uuid::now_v7(), &wf, &transcript)
            .await
            .expect("resume manifest builds");

        assert!(
            !line.contains("Call load_skill(\"weekly-review\")"),
            "resume must not inject the directive — got {line}"
        );
        // Disclosure still happens on resume (the block is present).
        assert!(line.contains("available_skills"), "resume keeps the block");
    }
}
