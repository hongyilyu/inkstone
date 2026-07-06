//! `provider/*`, `model/catalog`, and `settings/*` wire types
//! (ADR-0009 hand-mirror).

use serde::{Deserialize, Serialize};

/// `provider/connected` Notification (ADR-0047 second consumer, ADR-0049): the
/// detached credential-drain task (`provider/login_start`, ADR-0023) persisted
/// the rotated OAuth credentials, so Core pushes `{provider}` to the connection
/// that started the login — the Settings → Models card flips to Connected live,
/// without waiting for the tab to regain focus. Rides the connection's `out_tx`,
/// keyed by `method` — not a Run subscription. Carries only the provider id (a
/// ping, not the connection state); the Client refetches `provider/status`.
#[derive(Debug, Serialize)]
pub struct ProviderConnectedNotification {
    pub provider: String,
}

/// One provider's connection status in `provider/status` (ADR-0023). `connected`
/// is true when a credential file exists for it. `auth_kind` (ADR-0062) is the
/// provider's authentication kind from the [`crate::providers`] registry,
/// serialized as `"oauth"` / `"api_key"` — the Web branches Connect-vs-Configure
/// on it rather than guessing from the id.
#[derive(Debug, Serialize)]
pub struct ProviderStatus {
    pub id: String,
    pub connected: bool,
    pub auth_kind: crate::providers::AuthKind,
}

/// `provider/status` result: the connection state of each known provider.
/// Object-wrapper shape keeps it forward-extensible.
#[derive(Debug, Serialize)]
pub struct ProviderStatusResult {
    pub providers: Vec<ProviderStatus>,
}

/// `provider/configure` params (ADR-0062): store a static API key for a
/// key-configurable provider (OpenRouter). Rust mirror of the TS
/// `ProviderConfigureParams`; the result reuses `ProviderStatusResult` (the
/// refreshed status). A non-key-configurable provider (codex is OAuth-only) or an
/// unknown provider → `invalid_params`, decided in the handler.
#[derive(Debug, Deserialize)]
pub struct ProviderConfigureParams {
    pub provider: String,
    pub api_key: String,
}

/// `provider/test` params (ADR-0062): probe a provider's liveness with the
/// given `model` — Core resolves the credential, spawns a one-shot ephemeral
/// Worker with a fixed ping prompt, and reports whether it answered. Rust mirror
/// of the TS `ProviderTestParams`. Provider-agnostic: works for an openrouter
/// static key AND a codex OAuth credential.
#[derive(Debug, Deserialize)]
pub struct ProviderTestParams {
    pub provider: String,
    pub model: String,
}

/// `provider/test` result (ADR-0062): whether the provider answered (`alive`),
/// with an optional failure `message` when it did not (an error frame's text, a
/// timeout, or a "not configured" note). `message` is omitted (not `null`,
/// matching the TS `S.optional`) on the alive path.
#[derive(Debug, Serialize)]
pub struct ProviderTestResult {
    pub alive: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// `provider/login_start` params: which provider to begin an OAuth login for.
/// Malformed/unknown → `invalid_params`.
#[derive(Debug, Deserialize)]
pub struct ProviderLoginStartParams {
    pub provider: String,
}

/// `provider/login_start` result: the authorize URL the Client opens (ADR-0023).
/// The Provider Helper runs the OAuth loopback; the callback + credential write
/// happen out-of-band, and the Client re-queries `provider/status` on focus to
/// learn the outcome.
#[derive(Debug, Serialize)]
pub struct ProviderLoginStartResult {
    pub authorize_url: String,
}

/// One model in `model/catalog` (ADR-0024). Both directions: Core decodes these
/// from the embedded catalog JSON and re-encodes them onto the wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub reasoning: bool,
    pub input: Vec<String>,
}

/// One provider's model group in `model/catalog`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderModels {
    pub id: String,
    pub label: String,
    pub models: Vec<ModelInfo>,
}

/// `model/catalog` result: the models available per provider (ADR-0024).
/// Object-wrapper shape keeps it forward-extensible.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelCatalogResult {
    pub providers: Vec<ProviderModels>,
}

/// `settings/get` + `settings/set` result (ADR-0024): the effective model
/// selection and global effort for the default Workflow. `model` falls back to
/// the per-provider default when the user has not picked one (`null` only when
/// the provider has no default); `effort` defaults to `off`. `enabled_models`
/// is the user's curated set of available chat models; it is `[]` (the empty
/// "uncurated = all enabled" sentinel) when the user has not curated — Core never
/// materializes today's catalog into the response, so the client expands empty→all
/// and a future catalog growth is not frozen out for an uncurated user.
#[derive(Debug, Serialize)]
pub struct SettingsResult {
    pub provider: String,
    pub model: Option<String>,
    pub effort: String,
    pub enabled_models: Vec<String>,
}

/// `settings/set` params (ADR-0024): a partial update. An absent field is left
/// unchanged; a present `model` must be a known catalog id and a present
/// `effort` a valid thinking level, else `invalid_params`. A present
/// `enabled_models` replaces the curated set; each member must be a known
/// catalog id. An empty `[]` is the "uncurated = all enabled" sentinel (a reset),
/// always accepted; for a NON-EMPTY (curated) set the effective preferred model
/// must remain a member, else `invalid_params`.
#[derive(Debug, Deserialize)]
pub struct SettingsSetParams {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub enabled_models: Option<Vec<String>>,
}

#[cfg(test)]
mod mirror_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn provider_connected_notification_encodes_full_shape() {
        let n = ProviderConnectedNotification {
            provider: "openai-codex".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&n).unwrap(),
            json!({ "provider": "openai-codex" }),
        );
    }

    #[test]
    fn provider_configure_params_decodes_provider_and_api_key() {
        let wire = json!({ "provider": "openrouter", "api_key": "sk-or-secret" });
        let p: ProviderConfigureParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.provider, "openrouter");
        assert_eq!(p.api_key, "sk-or-secret");
    }

    #[test]
    fn provider_test_params_decodes_provider_and_model() {
        let wire = json!({ "provider": "openrouter", "model": "anthropic/claude-opus-4.8" });
        let p: ProviderTestParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.provider, "openrouter");
        assert_eq!(p.model, "anthropic/claude-opus-4.8");
    }

    #[test]
    fn provider_test_result_encodes_alive_and_dead() {
        // Alive: message omitted (skip_serializing_if None), matching S.optional.
        let alive = ProviderTestResult {
            alive: true,
            message: None,
        };
        let v = serde_json::to_value(&alive).unwrap();
        assert_eq!(v, json!({ "alive": true }));
        assert!(v.get("message").is_none());

        // Dead: message present.
        let dead = ProviderTestResult {
            alive: false,
            message: Some("provider rejected the request".to_string()),
        };
        assert_eq!(
            serde_json::to_value(&dead).unwrap(),
            json!({ "alive": false, "message": "provider rejected the request" }),
        );
    }

    #[test]
    fn model_catalog_result_round_trips_snake_case() {
        let wire = json!({
            "providers": [{
                "id": "openai-codex",
                "label": "OpenAI",
                "models": [{
                    "id": "gpt-5.5",
                    "name": "GPT-5.5",
                    "reasoning": true,
                    "input": ["text", "image"]
                }]
            }]
        });
        let decoded: ModelCatalogResult = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(decoded.providers[0].id, "openai-codex");
        assert_eq!(decoded.providers[0].models[0].id, "gpt-5.5");
        assert!(decoded.providers[0].models[0].reasoning);
        assert_eq!(serde_json::to_value(&decoded).unwrap(), wire);
    }

    #[test]
    fn settings_set_params_decodes_partial_updates() {
        let only_effort: SettingsSetParams =
            serde_json::from_value(json!({ "effort": "low" })).unwrap();
        assert_eq!(only_effort.model, None);
        assert_eq!(only_effort.effort.as_deref(), Some("low"));

        let only_model: SettingsSetParams =
            serde_json::from_value(json!({ "model": "gpt-5.5" })).unwrap();
        assert_eq!(only_model.model.as_deref(), Some("gpt-5.5"));
        assert_eq!(only_model.effort, None);

        let empty: SettingsSetParams = serde_json::from_value(json!({})).unwrap();
        assert_eq!(empty.model, None);
        assert_eq!(empty.effort, None);
    }
}
