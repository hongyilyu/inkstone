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
use super::reply;
use crate::credentials::{self, Credentials, OPENAI_CODEX, StoredCredential};
use crate::protocol::{
    ProviderConfigureParams, ProviderLoginStartParams, ProviderLoginStartResult, ProviderStatus,
    ProviderStatusResult, ProviderTestParams,
};

pub(super) async fn handle(
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    handler::handle(id, params, out_tx, |_p: serde_json::Value| async move {
        provider_status()
    })
    .await;
}

/// The connection state of every registered provider ([`crate::providers::all`],
/// ADR-0062). Each row carries the registry's `auth_kind` so the Client branches
/// Connect-vs-Configure off the wire. A corrupt credential file surfaces as an
/// internal error, not a misleading "connected: false". Shared by
/// `provider/status` and the `provider/configure` reply.
fn provider_status() -> Result<ProviderStatusResult, HandlerError> {
    let providers = crate::providers::all()
        .iter()
        .map(|entry| {
            Ok(ProviderStatus {
                id: entry.id.to_string(),
                connected: credentials::is_connected(entry.id)
                    .map_err(|e| HandlerError::Internal(e.into()))?,
                auth_kind: entry.auth_kind,
            })
        })
        .collect::<Result<Vec<_>, HandlerError>>()?;
    Ok(ProviderStatusResult { providers })
}

pub(super) async fn handle_configure(
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    // The closure moves a clone to push `provider/connected`; `handler::handle`
    // keeps the borrow for its own framing (both target the same connection).
    let notify_tx = out_tx.clone();
    handler::handle(id, params, out_tx, |params: ProviderConfigureParams| async move {
        // Only key-configurable providers accept a pasted key (registry-derived,
        // ADR-0062). An unknown provider AND an OAuth-only one (codex → use
        // login_start) both reject as invalid_params — configure is for
        // static-key providers.
        if !crate::providers::is_configurable(&params.provider) {
            return Err(HandlerError::InvalidParams(format!(
                "provider {:?} is not key-configurable",
                params.provider
            )));
        }

        // Reject-before-write (ADR-0014): an empty/whitespace key would persist a
        // credential that reports connected:true yet fails at request time. Guard
        // AFTER the provider check so provider-validity still reports first.
        let key = params.api_key.trim();
        if key.is_empty() {
            return Err(HandlerError::InvalidParams(
                "api_key must not be empty".to_string(),
            ));
        }

        // Persist the TRIMMED key: surrounding whitespace/newlines (e.g. a pasted
        // "  sk-or-…\n") would otherwise be stored verbatim and sent as invalid
        // auth bytes at request time, reporting connected but failing every call.
        credentials::write(
            &params.provider,
            &StoredCredential::ApiKey {
                key: key.to_string(),
            },
        )
        .map_err(|e| HandlerError::Internal(e.into()))?;

        // The key is durable — push the live signal (ADR-0049) so the Settings
        // card flips to Connected without a focus refetch, exactly like login.
        reply::send_provider_connected(&notify_tx, &params.provider);

        provider_status()
    })
    .await;
}

pub(super) async fn handle_test(
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    // The liveness probe (ADR-0062) resolves the credential and spawns a one-shot
    // ephemeral Worker; it NEVER touches the pool (no Thread, no Run row). A dead
    // result (unconfigured / no reply) is a normal response, not a JSON-RPC error,
    // so the body is `Ok`.
    handler::handle(id, params, out_tx, |params: ProviderTestParams| async move {
        // Reject an unknown provider BEFORE probing. `provider` reaches
        // `credentials::credential_path` as `credentials/{provider}.json`, so an
        // unvalidated value like "../../secret" would path-traverse to probe an
        // arbitrary `.json` file. Gate against the registry (invalid_params) so
        // only real providers ever reach the credential store.
        if !crate::providers::is_known(&params.provider) {
            return Err(HandlerError::InvalidParams(format!(
                "unknown provider {:?}",
                params.provider
            )));
        }
        Ok::<_, HandlerError>(crate::worker::probe_liveness(&params.provider, &params.model).await)
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
        // Only OAuth (login_allowed) providers begin a browser login (ADR-0062);
        // an unknown OR key-configurable provider (use provider/configure) is
        // invalid_params. Registry-derived, not a codex-only branch.
        if !crate::providers::login_allowed(&params.provider) {
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

        // The launch command (ADR-0041): the INKSTONE_PROVIDER_LOGIN_CMD
        // override (shlex-parsed) or the tsx default. An empty override is an
        // error; release the single-flight latch before surfacing it.
        let crate::launch::ResolvedCommand { program, args } =
            match crate::launch::resolve(crate::launch::Role::ProviderLogin) {
                Ok(cmd) => cmd,
                Err(e) => {
                    LOGIN_IN_FLIGHT.store(false, Ordering::SeqCst);
                    return Err(HandlerError::Internal(e));
                }
            };

        let mut child = match Command::new(&program)
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
        // (after the browser callback), Core persists them. On success it pushes
        // `provider/connected` to THIS connection (ADR-0047 channel, ADR-0049) so
        // the waiting Settings → Models card flips live; the focus-refetch
        // (ADR-0023) remains the fallback if the push is missed (dead `out_tx`).
        let out_tx = out_tx.clone();
        tokio::spawn(async move {
            let result = read_login_credentials(&mut lines).await;
            match result {
                Ok(Some(creds)) => {
                    if let Err(e) =
                        credentials::write(OPENAI_CODEX, &StoredCredential::Oauth(creds))
                    {
                        eprintln!("provider login: persisting credentials failed: {e}");
                    } else {
                        // Persist succeeded — credentials are durable. Push the
                        // live signal; a dead `out_tx` makes it a silent no-op.
                        reply::send_provider_connected(&out_tx, OPENAI_CODEX);
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
