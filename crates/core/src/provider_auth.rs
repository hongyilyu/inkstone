//! Provider credential resolution for a Run (ADR-0023). Before spawning a
//! Worker, Core resolves a short-lived access token and injects only that into
//! the manifest — the refresh token never crosses the process boundary.
//!
//! Resolution dispatches by auth kind (ADR-0062): an `Oauth` credential takes
//! the refresh path below; a static `ApiKey` returns its stored key as-is and
//! never touches the refresh machinery. A provider with no stored credential
//! resolves to `None`, so the manifest omits `access_token`.
//!
//! Refresh (OAuth only) is Core-orchestrated and single-flight: a process-global
//! async mutex serializes refreshes, with double-checked expiry after acquiring
//! the lock so concurrent Runs trigger exactly one refresh.

use std::process::Stdio;
use std::sync::OnceLock;

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::credentials::{self, Credentials, StoredCredential};

/// Serializes credential refreshes across all in-flight Runs (single-flight,
/// ADR-0023), so the rotated refresh token is never used twice.
fn refresh_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Resolve a fresh access token for `provider`, dispatching by auth kind
/// (ADR-0062). A static `ApiKey` returns its stored key as-is — no refresh, no
/// lock, no helper spawn. An `Oauth` credential returns the stored token if
/// valid, else refreshes once under the single-flight lock (double-checked) and
/// persists the rotated credential. No stored credential → `None`.
pub async fn resolve_access_token(provider: &str, now_ms: i64) -> Result<Option<String>> {
    match credentials::read(provider)? {
        // Static key: never rotates; the refresh machinery is OAuth-only.
        Some(StoredCredential::ApiKey { key }) => Ok(Some(key)),
        Some(StoredCredential::Oauth(creds)) => resolve_oauth(provider, creds, now_ms).await,
        // No credential stored: the Run proceeds tokenless and the provider
        // call fails with an auth error, prompting the user to connect.
        None => Ok(None),
    }
}

/// The OAuth valid-or-refresh path (ADR-0023), unchanged: return the stored
/// access token if valid, else refresh once under the single-flight lock
/// (double-checked) and persist the rotated credential.
async fn resolve_oauth(
    provider: &str,
    creds: Credentials,
    now_ms: i64,
) -> Result<Option<String>> {
    if !creds.is_expired(now_ms) {
        return Ok(Some(creds.access));
    }

    // Expired → refresh under the single-flight lock.
    let _guard = refresh_lock().lock().await;

    // Double-check: another Run may have refreshed while we waited.
    if let Some(StoredCredential::Oauth(fresh)) = credentials::read(provider)? {
        if !fresh.is_expired(now_ms) {
            return Ok(Some(fresh.access));
        }
    }

    let rotated = refresh_via_helper(&creds.refresh).await?;
    let access = rotated.access.clone();
    credentials::write(provider, &StoredCredential::Oauth(rotated))?;
    Ok(Some(access))
}

/// One line of the Provider Helper's stdout in `refresh` mode (ADR-0023).
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum HelperLine {
    Credentials {
        access: String,
        refresh: String,
        expires: i64,
        account_id: String,
    },
    Error {
        message: String,
    },
}

/// Spawn the Provider Helper in `refresh` mode, feed it the refresh token on
/// stdin, and read back the rotated credentials. The command is resolved by
/// `crate::launch` (ADR-0041): the `INKSTONE_PROVIDER_HELPER_CMD` override
/// (shlex-parsed) or the default tsx invocation; tests point it at a stub.
async fn refresh_via_helper(refresh_token: &str) -> Result<Credentials> {
    let crate::launch::ResolvedCommand { program, args } =
        crate::launch::resolve(crate::launch::Role::ProviderRefresh)?;

    let mut child = Command::new(&program)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .with_context(|| format!("spawn provider helper {program:?}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        let line = serde_json::json!({ "refresh": refresh_token }).to_string();
        stdin
            .write_all(format!("{line}\n").as_bytes())
            .await
            .context("write refresh token to provider helper stdin")?;
        drop(stdin);
    }

    let stdout = child.stdout.take().context("provider helper has no stdout")?;
    let mut lines = BufReader::new(stdout).lines();

    // The first structured line is the result (credentials or error).
    while let Some(line) = lines.next_line().await.context("read provider helper stdout")? {
        let parsed: HelperLine = match serde_json::from_str(&line) {
            Ok(p) => p,
            // Non-JSON noise (e.g. a stray log) — skip and keep reading.
            Err(_) => continue,
        };
        let _ = child.wait().await;
        return match parsed {
            HelperLine::Credentials {
                access,
                refresh,
                expires,
                account_id,
            } => Ok(Credentials {
                access,
                refresh,
                expires,
                account_id,
            }),
            HelperLine::Error { message } => bail!("provider helper refresh failed: {message}"),
        };
    }

    let _ = child.wait().await;
    bail!("provider helper produced no result line")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::{OPENAI_CODEX, test_credentials_env};

    /// A static API-key credential resolves to its stored key directly — no
    /// refresh, no helper spawn (the helper command is unset; if the ApiKey arm
    /// touched it, this would error). The codex OAuth path stays untouched.
    #[test]
    fn api_key_resolves_to_stored_key_without_refresh() {
        let _env = test_credentials_env();

        credentials::write(
            "openrouter",
            &StoredCredential::ApiKey { key: "sk-or-static".to_string() },
        )
        .expect("write api key");

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let resolved = rt
            .block_on(resolve_access_token("openrouter", 0))
            .expect("resolve");
        assert_eq!(resolved.as_deref(), Some("sk-or-static"), "static key returned as-is");
    }

    /// A valid (non-expired) OAuth credential for codex resolves to its access
    /// token with no refresh — the existing OAuth fast path, behavior-identical.
    #[test]
    fn valid_oauth_resolves_to_access_token() {
        let _env = test_credentials_env();

        credentials::write(
            OPENAI_CODEX,
            &StoredCredential::Oauth(Credentials {
                access: "fresh_access".to_string(),
                refresh: "refresh_v1".to_string(),
                expires: 9_999_999_999_999,
                account_id: "acct_1".to_string(),
            }),
        )
        .expect("write oauth");

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let resolved = rt
            .block_on(resolve_access_token(OPENAI_CODEX, 0))
            .expect("resolve");
        assert_eq!(resolved.as_deref(), Some("fresh_access"), "valid oauth access token");
    }

    /// An unconfigured provider (no stored credential) resolves to `None`.
    #[test]
    fn unconfigured_provider_resolves_to_none() {
        let _env = test_credentials_env();

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let resolved = rt
            .block_on(resolve_access_token("openrouter", 0))
            .expect("resolve");
        assert_eq!(resolved, None, "no stored credential resolves to None");
    }
}
