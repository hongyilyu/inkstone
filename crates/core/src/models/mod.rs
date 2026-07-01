//! The model catalog (ADR-0024): models available per provider, hand-mirrored
//! from `pi-ai`'s `MODELS` and embedded as JSON. A Worker-side drift test
//! (`packages/worker/src/models-catalog.test.ts`) guards the JSON against
//! `pi-ai` (ADR-0009 hand-mirror discipline).
//!
//! Only `openai-codex` is connectable (ADR-0023). Read by the `model/catalog`
//! handler and the `settings/set` validator.

use std::sync::OnceLock;

use crate::protocol::{ModelCatalogResult, ProviderModels};

/// The embedded catalog JSON, generated from `pi-ai`'s `MODELS["openai-codex"]`.
const CATALOG_JSON: &str = include_str!("openai-codex.json");

/// The embedded openrouter provider group, generated from `pi-ai`'s
/// `MODELS["openrouter"]` (ADR-0062). One `ProviderModels` group, merged into
/// [`catalog`] after the openai-codex group.
const OPENROUTER_JSON: &str = include_str!("openrouter.json");

static CATALOG: OnceLock<ModelCatalogResult> = OnceLock::new();

/// The parsed catalog, parsed once on first access. A malformed embedded JSON is
/// a build-time bug, so a parse failure panics rather than surfacing per-request.
pub fn catalog() -> &'static ModelCatalogResult {
    CATALOG.get_or_init(|| {
        let mut catalog: ModelCatalogResult =
            serde_json::from_str(CATALOG_JSON).expect("embedded model catalog JSON is valid");
        let openrouter: ProviderModels =
            serde_json::from_str(OPENROUTER_JSON).expect("embedded openrouter catalog JSON is valid");
        catalog.providers.push(openrouter);
        catalog
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
        "openrouter" => Some("anthropic/claude-opus-4.8"),
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

/// The model the titler should use for `provider`: its dedicated title model,
/// else the chat [`default_model`].
///
/// The title model is product policy (authored here, ADR-0046), NOT a
/// user-selectable catalog entry — so it is deliberately NOT gated through
/// [`is_known_model`]. The user-facing catalog ([`catalog`]) can be trimmed to a
/// single chat model (e.g. `gpt-5.5`) while titling keeps using a cheaper model
/// (`gpt-5.4-mini`) that the provider still serves. Validity of the title model
/// is enforced downstream by `pi-ai` at request time, not by this catalog.
pub fn title_model_for(provider: &str) -> Option<&'static str> {
    default_title_model(provider).or_else(|| default_model(provider))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_includes_openrouter_group() {
        let openrouter = catalog()
            .providers
            .iter()
            .find(|p| p.id == "openrouter")
            .expect("openrouter provider present in catalog");
        assert_eq!(openrouter.label, "OpenRouter");
        let ids: Vec<&str> = openrouter.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "anthropic/claude-opus-4.8",
                "anthropic/claude-haiku-4.5",
                "moonshotai/kimi-k2.5",
            ]
        );
    }

    #[test]
    fn default_model_for_openrouter_is_opus() {
        assert_eq!(
            default_model("openrouter"),
            Some("anthropic/claude-opus-4.8")
        );
    }

    #[test]
    fn default_title_model_is_codex_only() {
        assert_eq!(default_title_model("openai-codex"), Some("gpt-5.4-mini"));
        assert_eq!(default_title_model("anthropic"), None);
    }

    #[test]
    fn title_model_for_uses_title_model_not_gated_by_catalog() {
        // The title model is product policy, NOT a user-facing catalog entry: the
        // catalog is trimmed to gpt-5.5 only, yet titling still resolves the cheaper
        // gpt-5.4-mini. The resolution must NOT be gated by `is_known_model`.
        assert!(!is_known_model("gpt-5.4-mini"));
        assert_eq!(title_model_for("openai-codex"), Some("gpt-5.4-mini"));
    }

    #[test]
    fn title_model_for_falls_back_to_chat_default() {
        // A provider with no title model defers to `default_model` (None today).
        assert_eq!(title_model_for("anthropic"), default_model("anthropic"));
    }
}
