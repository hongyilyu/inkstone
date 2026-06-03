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

use super::reply::{send_error, send_invalid_params, send_response};
use crate::protocol::{SettingsResult, SettingsSetParams};
use crate::{db, models, workflow};

/// The settings key holding the preferred model id for `workflow_name`.
/// Keyed by Workflow so a second Workflow later needs no schema change
/// (ADR-0024).
fn model_key(workflow_name: &str) -> String {
    format!("model:{workflow_name}")
}

/// The global effort (thinking level) key and its default when unset.
const EFFORT_KEY: &str = "effort";
const DEFAULT_EFFORT: &str = "off";

/// Read the effective settings for the default Workflow: its provider, the
/// stored preferred model (`None` until picked), and the global effort.
async fn current(pool: &SqlitePool) -> sqlx::Result<SettingsResult> {
    let wf = workflow::default_workflow();
    let model = db::get_setting(pool, &model_key(&wf.name)).await?;
    let effort = db::get_setting(pool, EFFORT_KEY)
        .await?
        .unwrap_or_else(|| DEFAULT_EFFORT.to_string());
    Ok(SettingsResult {
        provider: wf.provider.clone(),
        model,
        effort,
    })
}

pub(super) async fn handle_get(
    pool: &SqlitePool,
    id: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    match current(pool).await {
        Ok(result) => send_response(
            out_tx,
            id,
            serde_json::to_value(result).expect("SettingsResult serializes"),
        ),
        Err(e) => {
            eprintln!("settings/get failed: {e}");
            send_error(out_tx, id, format!("settings/get: {e}"));
        }
    }
}

pub(super) async fn handle_set(
    pool: &SqlitePool,
    id: serde_json::Value,
    params: SettingsSetParams,
    out_tx: &UnboundedSender<String>,
) {
    // Validate BEFORE any write (ADR-0002: Core is the authority) so a bad
    // value persists nothing.
    if let Some(ref model) = params.model {
        if !models::is_known_model(model) {
            send_invalid_params(out_tx, id, format!("unknown model {model:?}"));
            return;
        }
    }
    if let Some(ref effort) = params.effort {
        if !workflow::is_valid_thinking_level(effort) {
            send_invalid_params(out_tx, id, format!("invalid effort {effort:?}"));
            return;
        }
    }

    let wf = workflow::default_workflow();
    if let Some(ref model) = params.model {
        if let Err(e) = db::set_setting(pool, &model_key(&wf.name), model).await {
            eprintln!("settings/set model failed: {e}");
            send_error(out_tx, id, format!("settings/set: {e}"));
            return;
        }
    }
    if let Some(ref effort) = params.effort {
        if let Err(e) = db::set_setting(pool, EFFORT_KEY, effort).await {
            eprintln!("settings/set effort failed: {e}");
            send_error(out_tx, id, format!("settings/set: {e}"));
            return;
        }
    }

    match current(pool).await {
        Ok(result) => send_response(
            out_tx,
            id,
            serde_json::to_value(result).expect("SettingsResult serializes"),
        ),
        Err(e) => {
            eprintln!("settings/set re-read failed: {e}");
            send_error(out_tx, id, format!("settings/set: {e}"));
        }
    }
}
