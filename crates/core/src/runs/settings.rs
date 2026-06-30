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
/// the empty "uncurated = all enabled" sentinel — never the materialized catalog).
async fn current(pool: &SqlitePool) -> sqlx::Result<SettingsResult> {
    let wf = workflow::default_workflow();
    let model = settings::preferred_model(pool, &wf.name)
        .await?
        .or_else(|| models::default_model(&wf.provider).map(str::to_string));
    let effort = settings::effort_setting(pool)
        .await?
        .unwrap_or_else(|| settings::DEFAULT_EFFORT.to_string());
    // The stored curation verbatim, or the empty "uncurated" sentinel when the
    // user has not curated (ADR-0024). Empty means "all models enabled" — the
    // client materializes the full catalog itself (composer ModelPicker), and we
    // do NOT bake today's catalog into the response, so a future catalog growth
    // is not frozen out for an uncurated user.
    let enabled_models = settings::enabled_models(pool).await?.unwrap_or_default();
    Ok(SettingsResult {
        provider: wf.provider.clone(),
        model,
        effort,
        enabled_models,
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
        // A submitted set is normalized to a true SET: every member must be a known
        // catalog id, and duplicates are dropped (order-preserving) so the stored
        // and echoed value honors the curated-set contract rather than persisting a
        // bag with repeats.
        let submitted_enabled = match params.enabled_models {
            Some(ref enabled) => {
                if let Some(unknown) = enabled.iter().find(|m| !models::is_known_model(m)) {
                    return Err(HandlerError::InvalidParams(format!(
                        "unknown enabled model {unknown:?}"
                    )));
                }
                let mut seen = std::collections::HashSet::new();
                Some(
                    enabled
                        .iter()
                        .filter(|m| seen.insert((*m).clone()))
                        .cloned()
                        .collect::<Vec<_>>(),
                )
            }
            None => None,
        };

        let wf = workflow::default_workflow();

        // The effective post-merge enabled set: a submitted (deduped) set replaces
        // the stored curation, else the stored set holds. An EMPTY set is the
        // "uncurated" sentinel meaning "all models enabled" (ADR-0024) — never
        // "enable nothing" — so it imposes no membership constraint below.
        let effective_enabled = match submitted_enabled.clone() {
            Some(enabled) => enabled,
            None => settings::enabled_models(pool)
                .await
                .map_err(|e| HandlerError::Internal(e.into()))?
                .unwrap_or_default(),
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

        // The default must stay a member of a CURATED (non-empty) enabled set
        // (ADR-0024). An empty effective set is uncurated (= all enabled), so the
        // default is trivially available and nothing is enforced. A provider with
        // no effective default likewise has nothing to enforce.
        if let (Some(model), false) = (&effective_model, effective_enabled.is_empty()) {
            if !effective_enabled.iter().any(|m| m == model) {
                return Err(HandlerError::InvalidParams(format!(
                    "effective model {model:?} is not in the enabled set"
                )));
            }
        }

        // Write order matters for the default∈enabled invariant: persist the
        // enabled set BEFORE the preferred model. The writes are separate
        // statements (not one transaction), so a later write can fail after an
        // earlier one committed. Writing enabled-first means any surviving partial
        // state is (new enabled set, old model) — and the old model was validated
        // against its own enabled set at its write time, and shrinking the set
        // below the old model is already rejected up-front above — so a partial
        // write can never strand the stored default outside the stored enabled set.
        // (Effort binds no cross-key invariant, so its position is immaterial.)
        if let Some(ref enabled) = submitted_enabled {
            settings::set_enabled_models(pool, enabled)
                .await
                .map_err(|e| HandlerError::Internal(e.into()))?;
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

        current(pool)
            .await
            .map_err(|e| HandlerError::Internal(e.into()))
    })
    .await;
}
