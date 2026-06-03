//! Provider credential resolution for a Run (ADR-0023). Core owns the
//! credential bytes; before spawning a Worker it resolves a short-lived
//! access token for the Run's provider and injects ONLY that into the
//! manifest — the refresh token never crosses the process boundary.
//!
//! Refresh is Core-orchestrated and **single-flight**: a process-global
//! async mutex serializes refreshes, and after acquiring the lock the stored
//! expiry is re-checked (double-checked locking) so two concurrent Runs that
//! both observed an expired token trigger exactly one refresh — the second
//! reuses the token the first just persisted. This is the race ADR-0023
//! rejects the Worker-side-refresh design over.
//!
//! Only `openai-codex` is OAuth in this feature. Any other provider (the
//! `faux` test provider, a future env-key provider) has no stored credential
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
/// ADR-0023). One global lock is correct: refreshes are rare (only on expiry)
/// and the rotated refresh token must not be used twice.
fn refresh_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Resolve a fresh access token for `provider`, or `None` if the provider is
/// not OAuth (no stored credential). For `openai-codex`: read the store; if
/// the token is still valid, return it; if expired, refresh once under the
/// global lock (double-checked) and persist the rotated credential first.
pub async fn resolve_access_token(provider: &str, now_ms: i64) -> Result<Option<String>> {
    if provider != OPENAI_CODEX {
        return Ok(None);
    }

    let Some(creds) = credentials::read(OPENAI_CODEX)? else {
        // No credential stored. The Run will proceed with no access token;
        // the provider call will fail with an auth error the user sees as a
        // Run error, prompting them to connect (slice 8).
        return Ok(None);
    };

    if !creds.is_expired(now_ms) {
        return Ok(Some(creds.access));
    }

    // Expired → refresh under the single-flight lock.
    let _guard = refresh_lock().lock().await;

    // Double-check: another Run may have refreshed while we waited for the
    // lock. Re-read and reuse if it's now valid.
    if let Some(fresh) = credentials::read(OPENAI_CODEX)? {
        if !fresh.is_expired(now_ms) {
            return Ok(Some(fresh.access));
        }
    }

    let rotated = refresh_via_helper(&creds.refresh).await?;
    credentials::write(OPENAI_CODEX, &rotated)?;
    Ok(Some(rotated.access))
}

/// One line of the Provider Helper's stdout in `refresh` mode (ADR-0023):
/// the Core-shaped rotated credentials (snake_case `account_id`).
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
/// stdin, and read back the rotated Core-shaped credentials. The command is
/// `INKSTONE_PROVIDER_HELPER_CMD` (whitespace-split) or the default tsx
/// invocation; tests point it at a stub.
async fn refresh_via_helper(refresh_token: &str) -> Result<Credentials> {
    let cmd = std::env::var("INKSTONE_PROVIDER_HELPER_CMD").unwrap_or_else(|_| {
        "packages/worker/node_modules/.bin/tsx packages/worker/src/provider.ts refresh".to_string()
    });
    let mut parts = cmd.split_whitespace();
    let program = parts.next().context("INKSTONE_PROVIDER_HELPER_CMD is empty")?;
    let args: Vec<&str> = parts.collect();

    let mut child = Command::new(program)
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
