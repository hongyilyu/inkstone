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

/// Read the effective settings for the default Workflow: provider, stored
/// preferred model (`None` until picked), the per-provider default the composer
/// shows when nothing is picked, and global effort.
async fn current(pool: &SqlitePool) -> sqlx::Result<SettingsResult> {
    let wf = workflow::default_workflow();
    let model = settings::preferred_model(pool, &wf.name).await?;
    let default_model = models::default_model(&wf.provider).map(str::to_string);
    let effort = settings::effort_setting(pool)
        .await?
        .unwrap_or_else(|| settings::DEFAULT_EFFORT.to_string());
    Ok(SettingsResult {
        provider: wf.provider.clone(),
        model,
        default_model,
        effort,
    })
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

        let wf = workflow::default_workflow();
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

        current(pool)
            .await
            .map_err(|e| HandlerError::Internal(e.into()))
    })
    .await;
}
