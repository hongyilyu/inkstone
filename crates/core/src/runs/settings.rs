//! `settings/get` + `settings/set` handlers (ADR-0024): the user's preferred
//! model (per Workflow) and the global effort level, persisted in tier-2.
//!
//! Reads/writes the `settings` key-value table. `settings/set` is a partial
//! update that validates a present `model` against the embedded catalog and a
//! present `effort` against the thinking levels, rejecting bad input with
//! `invalid_params` (ADR-0014) BEFORE any write — so a rejected request
//! persists nothing. Both handlers return the full effective `SettingsResult`.

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;

use super::handler::{self, HandlerError};
use crate::protocol::{SettingsResult, SettingsSetParams};
use crate::{models, settings, workflow};

/// Read the effective settings for the default Workflow: its provider, the
/// stored preferred model (`None` until picked), and the global effort. Keys
/// and the effort default live in `crate::settings` (the registry).
async fn current(pool: &SqlitePool) -> sqlx::Result<SettingsResult> {
    let wf = workflow::default_workflow();
    let model = settings::preferred_model(pool, &wf.name).await?;
    let effort = settings::effort_setting(pool)
        .await?
        .unwrap_or_else(|| settings::DEFAULT_EFFORT.to_string());
    Ok(SettingsResult {
        provider: wf.provider.clone(),
        model,
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
        // Validate BEFORE any write (ADR-0002: Core is the authority) so a bad
        // value persists nothing.
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
