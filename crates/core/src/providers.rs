//! The single provider registry (ADR-0062): one small table describing every LLM
//! provider Inkstone knows about — its wire `id`, how it authenticates
//! ([`AuthKind`]), and whether it connects via the OAuth `provider/login_start`
//! flow. Everything that used to be a scattered per-file array or `== codex`
//! branch derives from here:
//!
//! - `provider/status` enumerates [`all`] (every id, connected or not).
//! - `provider/configure` accepts only [`AuthKind::ApiKey`] providers ([`is_configurable`]).
//! - `provider/login_start` accepts only `login_allowed` providers ([`login_allowed`]).
//! - `provider/test` validates against [`is_known`] before touching the credential store.
//! - The Web reads `auth_kind` off each `provider/status` row (no client-side guess).
//!
//! `default_model` is intentionally NOT folded in — it lives in
//! [`crate::models::default_model`] as product policy beside the catalog.

use serde::Serialize;

use crate::credentials::{OPENAI_CODEX, OPENROUTER};

/// How a provider authenticates (ADR-0062). Serializes to the wire strings
/// `"oauth"` / `"api_key"` — the values the Web branches Connect-vs-Configure on,
/// carried on each `provider/status` row so the client never guesses from the id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthKind {
    /// Browser OAuth login (`provider/login_start`), refreshable token (codex).
    Oauth,
    /// A pasted static API key (`provider/configure`), never rotates (OpenRouter).
    ApiKey,
}

/// One provider's registry entry: its wire `id`, [`AuthKind`], and whether it
/// connects via the OAuth `provider/login_start` flow.
pub struct ProviderEntry {
    pub id: &'static str,
    pub auth_kind: AuthKind,
    /// Whether `provider/login_start` accepts this provider. An `ApiKey` provider
    /// connects via `provider/configure`, so its login start is rejected.
    pub login_allowed: bool,
}

/// The registry: every provider Inkstone knows about (ADR-0062). The one source
/// for the status enumeration, the configure allowlist, and the login allow-check.
const REGISTRY: &[ProviderEntry] = &[
    ProviderEntry {
        id: OPENAI_CODEX,
        auth_kind: AuthKind::Oauth,
        login_allowed: true,
    },
    ProviderEntry {
        id: OPENROUTER,
        auth_kind: AuthKind::ApiKey,
        login_allowed: false,
    },
];

/// Every registered provider, in registry order — what `provider/status`
/// enumerates.
pub fn all() -> &'static [ProviderEntry] {
    REGISTRY
}

/// The registry entry for `id`, or `None` if unknown.
pub fn get(id: &str) -> Option<&'static ProviderEntry> {
    REGISTRY.iter().find(|e| e.id == id)
}

/// Whether `id` is a registered provider. Gates `provider/test` (and the
/// credential-store path it reaches) against arbitrary values.
pub fn is_known(id: &str) -> bool {
    get(id).is_some()
}

/// Whether `id` is key-configurable ([`AuthKind::ApiKey`]) — the ones
/// `provider/configure` accepts. An OAuth provider (codex) connects via
/// `provider/login_start`, so configuring it is `invalid_params`.
pub fn is_configurable(id: &str) -> bool {
    matches!(
        get(id),
        Some(ProviderEntry {
            auth_kind: AuthKind::ApiKey,
            ..
        })
    )
}

/// Whether `id` connects via the OAuth `provider/login_start` flow.
pub fn login_allowed(id: &str) -> bool {
    get(id).is_some_and(|e| e.login_allowed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_covers_the_two_providers() {
        let ids: Vec<&str> = all().iter().map(|e| e.id).collect();
        assert_eq!(ids, vec![OPENAI_CODEX, OPENROUTER]);
    }

    #[test]
    fn codex_is_oauth_login_only() {
        assert!(is_known(OPENAI_CODEX));
        assert_eq!(get(OPENAI_CODEX).unwrap().auth_kind, AuthKind::Oauth);
        assert!(login_allowed(OPENAI_CODEX), "codex connects via login_start");
        assert!(
            !is_configurable(OPENAI_CODEX),
            "an OAuth provider is not key-configurable"
        );
    }

    #[test]
    fn openrouter_is_api_key_configure_only() {
        assert!(is_known(OPENROUTER));
        assert_eq!(get(OPENROUTER).unwrap().auth_kind, AuthKind::ApiKey);
        assert!(is_configurable(OPENROUTER), "openrouter configures with a key");
        assert!(
            !login_allowed(OPENROUTER),
            "an ApiKey provider does not use login_start"
        );
    }

    #[test]
    fn unknown_provider_is_not_known() {
        assert!(!is_known("acme"));
        assert!(!is_known("../../secret"));
        assert!(get("acme").is_none());
        assert!(!is_configurable("acme"));
        assert!(!login_allowed("acme"));
    }

    #[test]
    fn auth_kind_serializes_to_wire_strings() {
        assert_eq!(
            serde_json::to_value(AuthKind::Oauth).unwrap(),
            serde_json::json!("oauth")
        );
        assert_eq!(
            serde_json::to_value(AuthKind::ApiKey).unwrap(),
            serde_json::json!("api_key")
        );
    }
}
