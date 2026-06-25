//! User-settings registry (ADR-0024): the single source of truth for every key
//! in the `settings` KV table. Every read/write goes through an accessor here;
//! no other module spells a key literal. Validation stays with its domain
//! (`workflow::is_valid_thinking_level`, `models::is_known_model`); this module
//! owns only the keys and their defaults.
//!
//! Registry:
//!   key                               scope    default  values                  → typed column
//!   --------------------------------  -------  -------  ----------------------  --------------------
//!   effort                            global   "off"    off|minimal|low|medium|  settings.effort
//!                                                       high|xhigh
//!   model:<workflow_name>             per-WF   (none)   a model id in the catalog workflow_prefs.model
//!   review_anchor_utc_offset_minutes  global   0        a signed integer         settings.value

use sqlx::SqlitePool;

/// The global effort (thinking level) key.
const EFFORT_KEY: &str = "effort";

/// The minutes east of UTC for the Workspace review anchor (ADR-0031). Seeds the
/// local wall clock used to compute a new active Project's default
/// `next_review_at`; defaults to 0 (local == UTC) when unset or unparseable.
pub(crate) const REVIEW_ANCHOR_UTC_OFFSET_KEY: &str = "review_anchor_utc_offset_minutes";

/// The global effort default when neither a setting nor a Workflow supplies one.
pub const DEFAULT_EFFORT: &str = "off";

/// The setting key holding the preferred model id for `workflow_name` (ADR-0024).
fn model_key(workflow_name: &str) -> String {
    format!("model:{workflow_name}")
}

/// The stored global effort, or `None` when unset. Callers apply their own
/// fallback (the Run resolver via the Workflow TOML before [`DEFAULT_EFFORT`]).
pub async fn effort_setting(pool: &SqlitePool) -> sqlx::Result<Option<String>> {
    crate::db::get_setting(pool, EFFORT_KEY).await
}

/// Persist the global effort. The caller validates the value first (ADR-0002).
pub async fn set_effort(pool: &SqlitePool, effort: &str) -> sqlx::Result<()> {
    crate::db::set_setting(pool, EFFORT_KEY, effort).await
}

/// The stored preferred model id for `workflow_name`, or `None` until picked.
pub async fn preferred_model(
    pool: &SqlitePool,
    workflow_name: &str,
) -> sqlx::Result<Option<String>> {
    crate::db::get_setting(pool, &model_key(workflow_name)).await
}

/// Persist the preferred model for `workflow_name`. The caller validates the
/// model against the catalog first (ADR-0002).
pub async fn set_preferred_model(
    pool: &SqlitePool,
    workflow_name: &str,
    model: &str,
) -> sqlx::Result<()> {
    crate::db::set_setting(pool, &model_key(workflow_name), model).await
}
