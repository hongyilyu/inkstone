//! Dispatcher seam (ADR-0011) + effective-Workflow resolution (ADR-0024).
//!
//! [`dispatch_and_resolve`] is the single entry every fresh Run-creation site
//! shares (ADR-0011: "asked once, in one place"): it picks the Workflow, then
//! resolves its model/effort from settings into an owned, executable Workflow.
//! [`dispatch`] answers "which Workflow?" (the single default today);
//! [`resolve_effective_workflow`] answers "with which model/effort?", overriding
//! the base Workflow's `model`/`thinking_level` from the user's settings.
//!
//! Resume does NOT call this — a resumed Run rebuilds its Workflow from the
//! `runs` snapshot (`db::run_workflow_snapshot`), never re-resolving live
//! settings, so a mid-Run setting change cannot leak into the running Run
//! (ADR-0024).

use sqlx::SqlitePool;

use crate::workflow::{self, Workflow};
use crate::{models, settings};

/// Pick the Workflow for a fresh Run (ADR-0011) and resolve its effective
/// model/effort from user settings (ADR-0024) in one step — the single seam the
/// Run-creation sites share. Returns an owned, executable Workflow.
pub async fn dispatch_and_resolve(
    pool: &SqlitePool,
    thread_id: uuid::Uuid,
    prompt: &str,
) -> Workflow {
    let base = dispatch(thread_id, prompt);
    resolve_effective_workflow(pool, base).await
}

fn dispatch(_thread_id: uuid::Uuid, _prompt: &str) -> &'static Workflow {
    workflow::default_workflow()
}

/// Build the Workflow a Run actually executes (ADR-0024): clone the dispatched
/// base and override `model` + `thinking_level` from user settings, then derive
/// `provider` from the resolved model (ADR-0062).
///
/// Resolution order:
///   - model:    user setting → `models::default_model(provider)` → TOML `model`
///   - effort:   user setting → TOML `thinking_level` → `settings::DEFAULT_EFFORT`
///   - provider: `models::provider_for(resolved model)` → TOML `provider`
///
/// The returned Workflow always carries a concrete `model`/`thinking_level` (the
/// wire manifest requires them). A settings read error is treated as "unset" so
/// a transient DB hiccup falls back to the default rather than failing the Run.
async fn resolve_effective_workflow(pool: &SqlitePool, base: &Workflow) -> Workflow {
    let model_setting = settings::preferred_model(pool, &base.name)
        .await
        .unwrap_or(None);
    let effort_setting = settings::effort_setting(pool).await.unwrap_or(None);

    let model = model_setting
        .or_else(|| models::default_model(&base.provider).map(str::to_string))
        .or_else(|| base.model.clone())
        .unwrap_or_default();

    let thinking_level = effort_setting
        .or_else(|| base.thinking_level.clone())
        .unwrap_or_else(|| settings::DEFAULT_EFFORT.to_string());

    // The provider follows the resolved model: an OpenRouter model routes to the
    // `openrouter` provider (and its ApiKey), not the base's default `openai-codex`
    // (ADR-0062). A model in no catalog group falls back to the base provider.
    let provider = models::provider_for(&model)
        .map(str::to_string)
        .unwrap_or_else(|| base.provider.clone());

    Workflow {
        model: Some(model),
        thinking_level: Some(thinking_level),
        provider,
        ..base.clone()
    }
}
