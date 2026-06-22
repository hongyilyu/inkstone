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

/// The default model id for titling a thread when the provider offers a cheaper
/// title-sized model (ADR-0046). Like [`default_model`], this is product policy
/// authored here rather than in the drift-tested embedded JSON. Only
/// `openai-codex` has one today; other providers return `None`.
pub fn default_title_model(provider: &str) -> Option<&'static str> {
    match provider {
        "openai-codex" => Some("gpt-5.4-mini"),
        _ => None,
    }
}

/// The model the titler should use for `provider`: the title model when it is a
/// known catalog id, otherwise the chat [`default_model`]. An absent or unknown
/// title model falls through to the chat default.
pub fn title_model_for(provider: &str) -> Option<&'static str> {
    default_title_model(provider)
        .filter(|m| is_known_model(m))
        .or_else(|| default_model(provider))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_title_model_is_codex_only() {
        assert_eq!(default_title_model("openai-codex"), Some("gpt-5.4-mini"));
        assert_eq!(default_title_model("anthropic"), None);
    }

    #[test]
    fn title_model_for_prefers_known_title_model() {
        // openai-codex's title model is in the catalog, so it wins outright.
        assert!(is_known_model("gpt-5.4-mini"));
        assert_eq!(title_model_for("openai-codex"), Some("gpt-5.4-mini"));
    }

    #[test]
    fn title_model_for_falls_back_to_chat_default() {
        // A provider with no title model defers to `default_model` (None today).
        assert_eq!(title_model_for("anthropic"), default_model("anthropic"));
    }

    #[test]
    fn title_model_filter_rejects_unknown_id() {
        // The "present but unknown title model" arm has no real provider to
        // exercise it (the sole title model, gpt-5.4-mini, is in the catalog),
        // so assert `title_model_for`'s composition directly: an unknown id is
        // filtered out and `or_else` recovers the chat default.
        let unknown = "no-such-title-model";
        assert!(!is_known_model(unknown));
        let resolved = Some(unknown)
            .filter(|m| is_known_model(m))
            .or_else(|| default_model("openai-codex"));
        assert_eq!(resolved, default_model("openai-codex"));
    }
}
