//! The model catalog (ADR-0024): models available per provider, hand-mirrored
//! from `pi-ai`'s `MODELS` and embedded as JSON. A Worker-side drift test
//! (`packages/worker/src/models-catalog.test.ts`) guards the JSON against
//! `pi-ai` (ADR-0009 hand-mirror discipline).
//!
//! Only `openai-codex` is connectable (ADR-0023). Read by the `model/catalog`
//! handler and the `settings/set` validator.

use std::sync::OnceLock;

use crate::protocol::ModelCatalogResult;

/// The embedded catalog JSON, generated from `pi-ai`'s `MODELS["openai-codex"]`.
const CATALOG_JSON: &str = include_str!("openai-codex.json");

static CATALOG: OnceLock<ModelCatalogResult> = OnceLock::new();

/// The parsed catalog, parsed once on first access. A malformed embedded JSON is
/// a build-time bug, so a parse failure panics rather than surfacing per-request.
pub fn catalog() -> &'static ModelCatalogResult {
    CATALOG.get_or_init(|| {
        serde_json::from_str(CATALOG_JSON).expect("embedded model catalog JSON is valid")
    })
}

/// Whether `model` is a known model id in any provider's catalog. Backs the
/// `settings/set` validator (ADR-0024), rejecting an unknown id with
/// `invalid_params` rather than persisting it.
pub fn is_known_model(model: &str) -> bool {
    catalog()
        .providers
        .iter()
        .any(|p| p.models.iter().any(|m| m.id == model))
}

/// The default model id for `provider` when the user has not picked one
/// (ADR-0024). Product policy, not catalog data, so it is authored here rather
/// than in the drift-tested embedded JSON. Providers other than `openai-codex`
/// return `None`, letting the resolver fall through to the Workflow TOML.
pub fn default_model(provider: &str) -> Option<&'static str> {
    match provider {
        "openai-codex" => Some("gpt-5.5"),
        _ => None,
    }
}
