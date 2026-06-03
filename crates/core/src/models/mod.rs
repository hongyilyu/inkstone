//! The model catalog (ADR-0024): the set of models available per provider,
//! hand-mirrored from `pi-ai`'s `MODELS` and embedded as JSON. A Worker-side
//! drift test (`packages/worker/src/models-catalog.test.ts`) guards the JSON
//! against `pi-ai`, so a version bump that changes the model set fails CI
//! rather than silently diverging (the ADR-0009 hand-mirror discipline).
//!
//! Only `openai-codex` is connectable (ADR-0023), so the catalog ships that
//! one provider's models. Read by the `model/catalog` handler and (from the
//! settings slice) the `settings/set` validator that rejects an unknown model.

use std::sync::OnceLock;

use crate::protocol::ModelCatalogResult;

/// The embedded catalog JSON, generated from `pi-ai`'s `MODELS["openai-codex"]`.
const CATALOG_JSON: &str = include_str!("openai-codex.json");

static CATALOG: OnceLock<ModelCatalogResult> = OnceLock::new();

/// The parsed catalog. Parsed once on first access; a malformed embedded JSON
/// is an authored-at-build-time bug (never a runtime input), so a parse
/// failure panics rather than surfacing as a request error.
pub fn catalog() -> &'static ModelCatalogResult {
    CATALOG.get_or_init(|| {
        serde_json::from_str(CATALOG_JSON).expect("embedded model catalog JSON is valid")
    })
}

/// Whether `model` is a known model id in any provider's catalog. Backs the
/// `settings/set` validator (ADR-0024) — an unknown model id is rejected with
/// `invalid_params` rather than persisted and later failing a Run.
pub fn is_known_model(model: &str) -> bool {
    catalog()
        .providers
        .iter()
        .any(|p| p.models.iter().any(|m| m.id == model))
}

/// The default model id for `provider` when the user has not picked one
/// (ADR-0024). This is product policy, NOT catalog data, so it is authored
/// here rather than read from the embedded JSON — that JSON is drift-tested
/// against `pi-ai` and must not grow a non-`pi-ai` `default` field. Only
/// `openai-codex` is connectable today (ADR-0023); other providers return
/// `None`, leaving the resolver to fall through to the Workflow TOML's `model`.
pub fn default_model(provider: &str) -> Option<&'static str> {
    match provider {
        "openai-codex" => Some("gpt-5.5"),
        _ => None,
    }
}
