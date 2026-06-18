//! Provider credential resolution for a Run (ADR-0023). Before spawning a
//! Worker, Core resolves a short-lived access token and injects only that into
//! the manifest — the refresh token never crosses the process boundary.
//!
//! Refresh is Core-orchestrated and single-flight: a process-global async mutex
//! serializes refreshes, with double-checked expiry after acquiring the lock so
//! concurrent Runs trigger exactly one refresh.
//!
//! Only `openai-codex` is OAuth; any other provider has no stored credential
//! and resolves to `None`, so the manifest omits `access_token`.

use std::process::Stdio;
use std::sync::OnceLock;

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::credentials::{self, Credentials, OPENAI_CODEX};

/// Serializes credential refreshes across all in-flight Runs (single-flight,
/// ADR-0023), so the rotated refresh token is never used twice.
fn refresh_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Resolve a fresh access token for `provider`, or `None` if it is not OAuth.
/// For `openai-codex`: return the stored token if valid, else refresh once under
/// the single-flight lock (double-checked) and persist the rotated credential.
pub async fn resolve_access_token(provider: &str, now_ms: i64) -> Result<Option<String>> {
    if provider != OPENAI_CODEX {
        return Ok(None);
    }

    let Some(creds) = credentials::read(OPENAI_CODEX)? else {
        // No credential stored: the Run proceeds tokenless and the provider
        // call fails with an auth error, prompting the user to connect.
        return Ok(None);
    };

    if !creds.is_expired(now_ms) {
        return Ok(Some(creds.access));
    }

    // Expired → refresh under the single-flight lock.
    let _guard = refresh_lock().lock().await;

    // Double-check: another Run may have refreshed while we waited.
    if let Some(fresh) = credentials::read(OPENAI_CODEX)? {
        if !fresh.is_expired(now_ms) {
            return Ok(Some(fresh.access));
        }
    }

    let rotated = refresh_via_helper(&creds.refresh).await?;
    credentials::write(OPENAI_CODEX, &rotated)?;
    Ok(Some(rotated.access))
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
