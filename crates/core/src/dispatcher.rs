//! Dispatcher seam (per ADR-0011) + effective-Workflow resolution (ADR-0024).
//!
//! [`dispatch`] picks the base Workflow for a Run (a one-liner today — the
//! single default Workflow). [`resolve_effective_workflow`] is the new
//! post-dispatch step: it overrides the base Workflow's `model` and
//! `thinking_level` from the user's persisted settings, producing the owned
//! Workflow the Run actually executes. The Dispatcher stays the seam that
//! answers "which Workflow?"; resolution answers "with which model/effort?".

use sqlx::SqlitePool;

use crate::workflow::{self, Workflow};
use crate::{models, settings};

pub fn dispatch(_thread_id: uuid::Uuid, _prompt: &str) -> &'static Workflow {
    workflow::default_workflow()
}

/// Build the Workflow a Run actually executes (ADR-0024): clone the dispatched
/// base and override `model` + `thinking_level` from user settings.
///
/// Resolution order:
///   - model:  user setting → `models::default_model(provider)` → TOML `model`
///   - effort: user setting → TOML `thinking_level` → `settings::DEFAULT_EFFORT`
///
/// The setting keys/defaults live in `crate::settings` (the registry) and the
/// per-provider default model in `crate::models` (the catalog domain); this
/// function owns only the fallback ordering. The returned Workflow always
/// carries a concrete `model`/`thinking_level` (the wire manifest requires
/// them). A settings read error is treated as "unset" so a transient DB hiccup
/// falls back to the default rather than failing the Run here.
pub async fn resolve_effective_workflow(pool: &SqlitePool, base: &Workflow) -> Workflow {
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

    Workflow {
        model: Some(model),
        thinking_level: Some(thinking_level),
        ..base.clone()
    }
}
