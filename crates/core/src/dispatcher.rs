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

pub fn dispatch(_thread_id: uuid::Uuid, _prompt: &str) -> &'static Workflow {
    workflow::default_workflow()
}

/// The default model for a provider when the user has not picked one
/// (ADR-0024). Only `openai-codex` is connectable today; other providers
/// fall through to the Workflow TOML's `model` (test fixtures set it).
fn default_model_for_provider(provider: &str) -> Option<&'static str> {
    match provider {
        "openai-codex" => Some("gpt-5.5"),
        _ => None,
    }
}

/// The global effort default when neither a setting nor the TOML supplies one.
const DEFAULT_EFFORT: &str = "off";

/// The settings key holding the preferred model for `workflow_name`. Mirrors
/// `runs::settings::model_key` — the two are the read and write ends of the
/// same key (ADR-0024).
fn model_setting_key(workflow_name: &str) -> String {
    format!("model:{workflow_name}")
}

/// Build the Workflow a Run actually executes (ADR-0024): clone the dispatched
/// base and override `model` + `thinking_level` from user settings.
///
/// Resolution order:
///   - model:  setting `model:<name>` → per-provider default → TOML `model`
///   - effort: setting `effort`       → TOML `thinking_level` → `off`
///
/// The returned Workflow always carries a concrete `model`/`thinking_level`
/// (the wire manifest requires them). A settings read error is treated as
/// "unset" so a transient DB hiccup falls back to the default rather than
/// failing the Run here.
pub async fn resolve_effective_workflow(pool: &SqlitePool, base: &Workflow) -> Workflow {
    let model_setting = crate::db::get_setting(pool, &model_setting_key(&base.name))
        .await
        .unwrap_or(None);
    let effort_setting = crate::db::get_setting(pool, "effort").await.unwrap_or(None);

    let model = model_setting
        .or_else(|| default_model_for_provider(&base.provider).map(str::to_string))
        .or_else(|| base.model.clone())
        .unwrap_or_default();

    let thinking_level = effort_setting
        .or_else(|| base.thinking_level.clone())
        .unwrap_or_else(|| DEFAULT_EFFORT.to_string());

    Workflow {
        model: Some(model),
        thinking_level: Some(thinking_level),
        ..base.clone()
    }
}
