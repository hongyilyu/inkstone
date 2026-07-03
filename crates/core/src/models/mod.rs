//! The model catalog (ADR-0024): models available per provider, hand-mirrored
//! from `pi-ai`'s `MODELS` and embedded as JSON. A Worker-side drift test
//! (`packages/worker/test/models-catalog.test.ts`) guards the JSON against
//! `pi-ai` (ADR-0009 hand-mirror discipline).
//!
//! **The VENDOR owns its model list — defined ONCE.** `catalog.json` has a
//! `vendors` array (OpenAI, Anthropic, …), each owning its models by bare `key`
//! (`gpt-5.5`), plus a `providers` array where each provider only declares which
//! vendors it *reaches*. There is no per-provider model copy to keep in sync: a
//! model added to a vendor appears under every provider that reaches it.
//!
//! [`catalog`] derives the per-provider [`ModelCatalogResult`] the rest of the
//! app sees by expanding each provider's `reaches` against the vendor lists:
//!   - a provider's `id_style` decides the model id — `bare` → `gpt-5.5`
//!     (openai-codex OAuth, ADR-0023), `prefixed` → `openai/gpt-5.5` (openrouter
//!     API key, ADR-0062);
//!   - a `prefixed` provider also prepends the vendor label to the display name
//!     (`"OpenAI: GPT-5.5"`), so the vendor prefix is DERIVED, never hand-typed;
//!   - `reaches` may name a subset of a vendor's models, else it takes them all.
//! Read by the `model/catalog` handler and the `settings/set` validator.

use std::sync::OnceLock;

use serde::Deserialize;

use crate::protocol::{ModelCatalogResult, ModelInfo, ProviderModels};

/// The embedded catalog SOURCE JSON, hand-mirrored from `pi-ai`'s `MODELS`.
/// Vendor-owned (`{ "vendors": [...], "providers": [...] }`); [`catalog`] derives
/// the per-provider [`ModelCatalogResult`] from it.
const CATALOG_JSON: &str = include_str!("catalog.json");

/// A model as authored under its vendor: identified by a bare `key` (the id form
/// a provider then decides), with the display name sans any vendor prefix.
#[derive(Deserialize)]
struct VendorModel {
    key: String,
    name: String,
    reasoning: bool,
    input: Vec<String>,
}

/// A vendor (the model MAKER) and the models it owns — the single source of truth.
#[derive(Deserialize)]
struct Vendor {
    id: String,
    label: String,
    models: Vec<VendorModel>,
}

/// One vendor a provider reaches; `models` optionally narrows to a subset of that
/// vendor's `key`s (absent ⇒ all of them).
#[derive(Deserialize)]
struct Reach {
    vendor: String,
    #[serde(default)]
    models: Option<Vec<String>>,
}

/// How a provider forms a reached model's id (and whether it prefixes the name).
#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum IdStyle {
    /// The vendor `key` verbatim: `gpt-5.5` (openai-codex OAuth).
    Bare,
    /// `vendor/key`: `openai/gpt-5.5`, and the display name gets the vendor prefix.
    Prefixed,
}

/// A provider and the vendors it reaches — no model list of its own.
#[derive(Deserialize)]
struct Provider {
    id: String,
    label: String,
    id_style: IdStyle,
    reaches: Vec<Reach>,
}

/// The parsed source catalog.
#[derive(Deserialize)]
struct SourceCatalog {
    vendors: Vec<Vendor>,
    providers: Vec<Provider>,
}

static CATALOG: OnceLock<ModelCatalogResult> = OnceLock::new();

/// The per-provider catalog, derived once on first access from the vendor-owned
/// source. A malformed embedded JSON — or a provider reaching an unknown vendor /
/// model key — is a build-time bug, so it panics rather than surfacing per-request.
pub fn catalog() -> &'static ModelCatalogResult {
    CATALOG.get_or_init(|| {
        let source: SourceCatalog =
            serde_json::from_str(CATALOG_JSON).expect("embedded model catalog JSON is valid");
        derive_catalog(&source)
    })
}

/// Expand each provider's `reaches` against the vendor lists into the flat
/// per-provider [`ModelCatalogResult`] the app consumes.
fn derive_catalog(source: &SourceCatalog) -> ModelCatalogResult {
    let vendors: std::collections::HashMap<&str, &Vendor> =
        source.vendors.iter().map(|v| (v.id.as_str(), v)).collect();

    let providers = source
        .providers
        .iter()
        .map(|provider| {
            let models = provider
                .reaches
                .iter()
                .flat_map(|reach| {
                    let vendor = vendors.get(reach.vendor.as_str()).unwrap_or_else(|| {
                        panic!("provider {} reaches unknown vendor {}", provider.id, reach.vendor)
                    });
                    // A subset narrows to the named keys (in listed order); absent
                    // ⇒ every model the vendor owns, in authored order.
                    let selected: Vec<&VendorModel> = match &reach.models {
                        Some(keys) => keys
                            .iter()
                            .map(|key| {
                                vendor.models.iter().find(|m| &m.key == key).unwrap_or_else(|| {
                                    panic!(
                                        "provider {} reaches {}/{}, not a model of that vendor",
                                        provider.id, reach.vendor, key
                                    )
                                })
                            })
                            .collect(),
                        None => vendor.models.iter().collect(),
                    };
                    selected.into_iter().map(move |m| ModelInfo {
                        id: match provider.id_style {
                            IdStyle::Bare => m.key.clone(),
                            IdStyle::Prefixed => format!("{}/{}", vendor.id, m.key),
                        },
                        name: match provider.id_style {
                            IdStyle::Bare => m.name.clone(),
                            IdStyle::Prefixed => format!("{}: {}", vendor.label, m.name),
                        },
                        reasoning: m.reasoning,
                        input: m.input.clone(),
                    })
                })
                .collect();
            ProviderModels {
                id: provider.id.clone(),
                label: provider.label.clone(),
                models,
            }
        })
        .collect();

    ModelCatalogResult { providers }
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

/// The provider id whose catalog group contains `model` (ADR-0062). Backs the
/// dispatcher's provider derivation: a Run's provider follows the user's selected
/// model, so an OpenRouter model routes to `openrouter` (and its ApiKey), not the
/// default `openai-codex`. `None` if no group lists the model.
pub fn provider_for(model: &str) -> Option<&'static str> {
    catalog()
        .providers
        .iter()
        .find(|p| p.models.iter().any(|m| m.id == model))
        .map(|p| p.id.as_str())
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
/// The title model is product policy (authored here, ADR-0046), resolved
/// WITHOUT consulting [`is_known_model`]. So titling works regardless of how the
/// user-facing catalog ([`catalog`]) is curated — even for a provider whose
/// title model the catalog doesn't list. Validity of the title model is enforced
/// downstream by `pi-ai` at request time, not by this catalog.
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
        // Each shipped model is drift-tested field-for-field against pi-ai in
        // `packages/worker/test/models-catalog.test.ts` (membership itself — the
        // curated subset — is intentionally not enforced); here we pin only that
        // the group loaded with the default and an expanded multi-vendor set.
        assert!(
            ids.contains(&"anthropic/claude-opus-4.8"),
            "openrouter ships its default model"
        );
        let vendors: std::collections::HashSet<&str> =
            ids.iter().filter_map(|id| id.split('/').next()).collect();
        assert!(
            ids.len() > 3 && vendors.len() >= 2,
            "openrouter ships an expanded multi-vendor catalog, not just the original three"
        );
    }

    #[test]
    fn vendor_list_is_defined_once_and_reaches_every_provider() {
        // The point of the vendor-owned source: OpenAI's models are authored ONCE
        // (under the `openai` vendor), and every provider that reaches OpenAI
        // exposes that SAME set — codex serves them bare, openrouter prefixed.
        // Derived-catalog keys (id minus any `vendor/` prefix) must be identical.
        let cat = catalog();
        let openai_keys = |provider_id: &str| -> Vec<String> {
            let mut keys: Vec<String> = cat
                .providers
                .iter()
                .find(|p| p.id == provider_id)
                .expect("provider present")
                .models
                .iter()
                .filter(|m| {
                    // codex OpenAI models are bare; openrouter's are `openai/…`.
                    m.id.starts_with("openai/") || !m.id.contains('/')
                })
                .map(|m| m.id.rsplit('/').next().unwrap().to_string())
                .collect();
            keys.sort();
            keys
        };
        assert_eq!(
            openai_keys("openai-codex"),
            openai_keys("openrouter"),
            "the OpenAI vendor list must be identical under every provider that reaches it"
        );
        assert!(
            openai_keys("openai-codex").contains(&"gpt-5.5".to_string()),
            "sanity: the shared OpenAI set is non-empty"
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
        // The title model is product policy, resolved WITHOUT consulting the
        // user-facing catalog gate — so titling works even for a model the catalog
        // doesn't list. `default_title_model` returns a fixed id here and
        // `is_known_model` is never called on that path.
        assert!(!is_known_model("a-model-the-catalog-does-not-list"));
        assert_eq!(title_model_for("openai-codex"), default_title_model("openai-codex"));
        assert_eq!(title_model_for("openai-codex"), Some("gpt-5.4-mini"));
    }

    #[test]
    fn title_model_for_falls_back_to_chat_default() {
        // A provider with no title model defers to `default_model` (None today).
        assert_eq!(title_model_for("anthropic"), default_model("anthropic"));
    }
}
