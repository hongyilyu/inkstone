//! `provider/status` + `provider/login_start` handlers (ADR-0023): report
//! which LLM providers have stored credentials, and begin an OAuth login.
//! Named `provider/*`, not `auth/*` — "auth" is reserved for human-auth
//! (ADR-0007); this is LLM-provider connection.

use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc::UnboundedSender;

use super::handler::{self, HandlerError};
use crate::credentials::{self, Credentials, OPENAI_CODEX};
use crate::protocol::{
    ProviderLoginStartParams, ProviderLoginStartResult, ProviderStatus, ProviderStatusResult,
};

pub(super) async fn handle(
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    handler::handle(id, params, out_tx, |_p: serde_json::Value| async move {
        // ChatGPT/Codex is the only supported provider. A corrupt credential
        // file surfaces as an internal error, not a misleading "connected: false".
        let connected =
            credentials::is_connected(OPENAI_CODEX).map_err(|e| HandlerError::Internal(e.into()))?;

        Ok(ProviderStatusResult {
            providers: vec![ProviderStatus {
                id: OPENAI_CODEX.to_string(),
                connected,
            }],
        })
    })
    .await;
}

/// At most one login flow at a time: the Provider Helper binds a fixed
/// loopback port (`:1455`) for the OAuth callback, so a concurrent login would
/// fail to bind. Reject overlap rather than spawn a doomed second helper.
static LOGIN_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// One structured line of the Provider Helper's `login`-mode stdout
/// (ADR-0023): the authorize URL, then credentials on success, or an error.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum LoginLine {
    AuthorizeUrl {
        url: String,
    },
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

pub(super) async fn handle_login_start(
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    handler::handle(id, params, out_tx, |params: ProviderLoginStartParams| async move {
        if params.provider != OPENAI_CODEX {
            return Err(HandlerError::InvalidParams(format!(
                "unknown provider {:?}",
                params.provider
            )));
        }

        // Single in-flight login (the :1455 loopback binds once). User-facing
        // condition, not an internal fault.
        if LOGIN_IN_FLIGHT
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(HandlerError::ProviderLoginFailed(
                "a provider login is already in progress".to_string(),
            ));
        }

        let cmd = std::env::var("INKSTONE_PROVIDER_LOGIN_CMD").unwrap_or_else(|_| {
            "packages/provider-helper/node_modules/.bin/tsx packages/provider-helper/src/provider.ts login"
                .to_string()
        });
        let mut parts = cmd.split_whitespace();
        let Some(program) = parts.next() else {
            LOGIN_IN_FLIGHT.store(false, Ordering::SeqCst);
            return Err(HandlerError::Internal(anyhow::anyhow!(
                "INKSTONE_PROVIDER_LOGIN_CMD is empty"
            )));
        };
        let args: Vec<String> = parts.map(str::to_string).collect();

        let mut child = match Command::new(program)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                LOGIN_IN_FLIGHT.store(false, Ordering::SeqCst);
                return Err(HandlerError::Internal(
                    anyhow::Error::from(e).context("spawn provider login helper"),
                ));
            }
        };

        let Some(stdout) = child.stdout.take() else {
            LOGIN_IN_FLIGHT.store(false, Ordering::SeqCst);
            let _ = child.kill().await;
            return Err(HandlerError::Internal(anyhow::anyhow!(
                "provider login helper has no stdout"
            )));
        };
        let mut lines = BufReader::new(stdout).lines();

        // Read until the authorize URL (first structured line) so we can reply
        // to the Client, which opens it in a new tab.
        let authorize_url = loop {
            match lines.next_line().await {
                Ok(Some(line)) => match serde_json::from_str::<LoginLine>(&line) {
                    Ok(LoginLine::AuthorizeUrl { url }) => break url,
                    Ok(LoginLine::Error { message }) => {
                        LOGIN_IN_FLIGHT.store(false, Ordering::SeqCst);
                        let _ = child.wait().await;
                        // The helper sanitizes this message for display.
                        return Err(HandlerError::ProviderLoginFailed(format!(
                            "provider login failed: {message}"
                        )));
                    }
                    // A credentials line before a URL is unexpected; ignore.
                    Ok(_) => continue,
                    Err(_) => continue, // skip non-JSON noise
                },
                Ok(None) => {
                    LOGIN_IN_FLIGHT.store(false, Ordering::SeqCst);
                    let _ = child.wait().await;
                    return Err(HandlerError::ProviderLoginFailed(
                        "provider login helper exited before authorize URL".to_string(),
                    ));
                }
                Err(e) => {
                    LOGIN_IN_FLIGHT.store(false, Ordering::SeqCst);
                    let _ = child.wait().await;
                    return Err(HandlerError::Internal(
                        anyhow::Error::from(e).context("read provider login helper"),
                    ));
                }
            }
        };

        // Drain the helper out-of-band: when it emits the credentials line
        // (after the browser callback), Core persists them. The Client learns
        // the outcome by re-querying `provider/status` on focus.
        tokio::spawn(async move {
            let result = read_login_credentials(&mut lines).await;
            match result {
                Ok(Some(creds)) => {
                    if let Err(e) = credentials::write(OPENAI_CODEX, &creds) {
                        eprintln!("provider login: persisting credentials failed: {e}");
                    }
                }
                Ok(None) => {
                    eprintln!("provider login: helper finished without credentials");
                }
                Err(e) => {
                    eprintln!("provider login: {e}");
                }
            }
            let _ = child.wait().await;
            LOGIN_IN_FLIGHT.store(false, Ordering::SeqCst);
        });

        Ok(ProviderLoginStartResult { authorize_url })
    })
    .await;
}

/// Drain the remaining helper lines after the authorize URL, returning the
/// rotated credentials on success.
async fn read_login_credentials<R>(
    lines: &mut tokio::io::Lines<R>,
) -> anyhow::Result<Option<Credentials>>
where
    R: tokio::io::AsyncBufRead + Unpin,
{
    while let Some(line) = lines.next_line().await? {
        match serde_json::from_str::<LoginLine>(&line) {
            Ok(LoginLine::Credentials {
                access,
                refresh,
                expires,
                account_id,
            }) => {
                return Ok(Some(Credentials {
                    access,
                    refresh,
                    expires,
                    account_id,
                }));
            }
            Ok(LoginLine::Error { message }) => {
                anyhow::bail!("provider login helper error: {message}");
            }
            // Another authorize_url or noise — keep reading.
            _ => continue,
        }
    }
    Ok(None)
}
