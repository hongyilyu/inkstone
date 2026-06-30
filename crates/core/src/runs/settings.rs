//! `settings/get` + `settings/set` handlers (ADR-0024): the user's preferred
//! model (per Workflow) and global effort level, persisted in tier-2.
//!
//! `settings/set` is a partial update; a present `model`/`effort` is validated
//! against the catalog/thinking levels and rejected with `invalid_params`
//! BEFORE any write (ADR-0014). Both handlers return the full `SettingsResult`.

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;

use super::handler::{self, HandlerError};
use crate::protocol::{SettingsResult, SettingsSetParams};
use crate::{models, settings, workflow};

/// Read the effective settings for the default Workflow: provider, preferred
/// model (falling back to the per-provider default the resolver uses, mirroring
/// effort), global effort, and the enabled-model set (the stored curation, else
/// the full catalog).
async fn current(pool: &SqlitePool) -> sqlx::Result<SettingsResult> {
    let wf = workflow::default_workflow();
    let model = settings::preferred_model(pool, &wf.name)
        .await?
        .or_else(|| models::default_model(&wf.provider).map(str::to_string));
    let effort = settings::effort_setting(pool)
        .await?
        .unwrap_or_else(|| settings::DEFAULT_EFFORT.to_string());
    let enabled_models = settings::enabled_models(pool)
        .await?
        .unwrap_or_else(all_catalog_model_ids);
    Ok(SettingsResult {
        provider: wf.provider.clone(),
        model,
        effort,
        enabled_models,
    })
}

/// Every model id in the catalog, flattened across providers — the default
/// enabled set when the user has not curated one (ADR-0024).
fn all_catalog_model_ids() -> Vec<String> {
    models::catalog()
        .providers
        .iter()
        .flat_map(|p| p.models.iter().map(|m| m.id.clone()))
        .collect()
}

pub(super) async fn handle_get(
    pool: &SqlitePool,
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    handler::handle(id, params, out_tx, |_p: serde_json::Value| async move {
        current(pool)
            .await
            .map_err(|e| HandlerError::Internal(e.into()))
    })
    .await;
}

pub(super) async fn handle_set(
    pool: &SqlitePool,
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    handler::handle(id, params, out_tx, |params: SettingsSetParams| async move {
        // Validate BEFORE any write so a bad value persists nothing (ADR-0002).
        if let Some(ref model) = params.model {
            if !models::is_known_model(model) {
                return Err(HandlerError::InvalidParams(format!("unknown model {model:?}")));
            }
        }
        if let Some(ref effort) = params.effort {
            if !workflow::is_valid_thinking_level(effort) {
                return Err(HandlerError::InvalidParams(format!("invalid effort {effort:?}")));
            }
        }
        if let Some(ref enabled) = params.enabled_models {
            if let Some(unknown) = enabled.iter().find(|m| !models::is_known_model(m)) {
                return Err(HandlerError::InvalidParams(format!(
                    "unknown enabled model {unknown:?}"
                )));
            }
        }

        let wf = workflow::default_workflow();

        // The effective post-merge enabled set: a submitted set replaces the stored
        // curation, else the stored-or-full-catalog default holds.
        let effective_enabled = match params.enabled_models.clone() {
            Some(enabled) => enabled,
            None => settings::enabled_models(pool)
                .await
                .map_err(|e| HandlerError::Internal(e.into()))?
                .unwrap_or_else(all_catalog_model_ids),
        };

        // The effective preferred model: a submitted model wins, else the stored
        // preference, else the per-provider default the resolver falls back to.
        let effective_model = match params.model.clone() {
            Some(model) => Some(model),
            None => settings::preferred_model(pool, &wf.name)
                .await
                .map_err(|e| HandlerError::Internal(e.into()))?
                .or_else(|| models::default_model(&wf.provider).map(str::to_string)),
        };

        // The default must stay a member of the enabled set (ADR-0024). A provider
        // with no effective default has nothing to enforce.
        if let Some(ref model) = effective_model {
            if !effective_enabled.iter().any(|m| m == model) {
                return Err(HandlerError::InvalidParams(format!(
                    "effective model {model:?} is not in the enabled set"
                )));
            }
        }

        if let Some(ref model) = params.model {
            settings::set_preferred_model(pool, &wf.name, model)
                .await
                .map_err(|e| HandlerError::Internal(e.into()))?;
        }
        if let Some(ref effort) = params.effort {
            settings::set_effort(pool, effort)
                .await
                .map_err(|e| HandlerError::Internal(e.into()))?;
        }
        if let Some(ref enabled) = params.enabled_models {
            settings::set_enabled_models(pool, enabled)
                .await
                .map_err(|e| HandlerError::Internal(e.into()))?;
        }

        current(pool)
            .await
            .map_err(|e| HandlerError::Internal(e.into()))
    })
    .await;
}
