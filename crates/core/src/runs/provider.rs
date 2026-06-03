//! `provider/status` + `provider/login_start` handlers (ADR-0023, ADR-0014
//! amendment). Reports which LLM providers have stored credentials, and
//! begins an OAuth login. Named `provider/*`, not `auth/*`, because ADR-0007
//! reserves "auth" for the (absent) human-auth concern; this is LLM-provider
//! connection.

use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc::UnboundedSender;

use super::reply::{send_error, send_invalid_params, send_response};
use crate::credentials::{self, Credentials, OPENAI_CODEX};
use crate::protocol::{
    ProviderLoginStartParams, ProviderLoginStartResult, ProviderStatus, ProviderStatusResult,
};

pub(super) async fn handle(id: serde_json::Value, out_tx: &UnboundedSender<String>) {
    // ChatGPT/Codex is the only provider this feature supports.
    let connected = match credentials::is_connected(OPENAI_CODEX) {
        Ok(c) => c,
        Err(e) => {
            // A corrupt credential file (present but unparseable) surfaces as
            // an internal error rather than a misleading "connected: false".
            eprintln!("provider/status: credential read failed: {e}");
            send_error(out_tx, id, format!("provider/status: {e}"));
            return;
        }
    };

    send_response(
        out_tx,
        id,
        serde_json::to_value(ProviderStatusResult {
            providers: vec![ProviderStatus {
                id: OPENAI_CODEX.to_string(),
                connected,
            }],
        })
        .expect("ProviderStatusResult serializes"),
    );
}

/// At most one login flow runs at a time: the Provider Helper binds a fixed
/// loopback port (`:1455`) for the OAuth callback, so a second concurrent
/// login would fail to bind. Guard it here and reject overlap with a clear
/// error rather than spawning a doomed second helper.
static LOGIN_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// One structured line of the Provider Helper's `login`-mode stdout
/// (ADR-0023): the authorize URL first, then the Core-shaped credentials on
/// success, or an error.
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
    params: ProviderLoginStartParams,
    out_tx: &UnboundedSender<String>,
) {
    if params.provider != OPENAI_CODEX {
        send_invalid_params(out_tx, id, format!("unknown provider {:?}", params.provider));
        return;
    }

    // Single in-flight login (the :1455 loopback binds once).
    if LOGIN_IN_FLIGHT
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        send_error(out_tx, id, "a provider login is already in progress".to_string());
        return;
    }

    let cmd = std::env::var("INKSTONE_PROVIDER_LOGIN_CMD").unwrap_or_else(|_| {
        "packages/worker/node_modules/.bin/tsx packages/worker/src/provider.ts login".to_string()
    });
    let mut parts = cmd.split_whitespace();
    let Some(program) = parts.next() else {
        LOGIN_IN_FLIGHT.store(false, Ordering::SeqCst);
        send_error(out_tx, id, "INKSTONE_PROVIDER_LOGIN_CMD is empty".to_string());
        return;
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
            send_error(out_tx, id, format!("spawn provider login helper: {e}"));
            return;
        }
    };

    let Some(stdout) = child.stdout.take() else {
        LOGIN_IN_FLIGHT.store(false, Ordering::SeqCst);
        let _ = child.kill().await;
        send_error(out_tx, id, "provider login helper has no stdout".to_string());
        return;
    };
    let mut lines = BufReader::new(stdout).lines();

    // Read until the authorize URL (the first structured line) so we can
    // reply to the Client, which opens it in a new tab.
    let authorize_url = loop {
        match lines.next_line().await {
            Ok(Some(line)) => match serde_json::from_str::<LoginLine>(&line) {
                Ok(LoginLine::AuthorizeUrl { url }) => break url,
                Ok(LoginLine::Error { message }) => {
                    LOGIN_IN_FLIGHT.store(false, Ordering::SeqCst);
                    let _ = child.wait().await;
                    send_error(out_tx, id, format!("provider login failed: {message}"));
                    return;
                }
                // A credentials line before a URL is unexpected; ignore and keep reading.
                Ok(_) => continue,
                Err(_) => continue, // skip non-JSON noise
            },
            Ok(None) => {
                LOGIN_IN_FLIGHT.store(false, Ordering::SeqCst);
                let _ = child.wait().await;
                send_error(out_tx, id, "provider login helper exited before authorize URL".to_string());
                return;
            }
            Err(e) => {
                LOGIN_IN_FLIGHT.store(false, Ordering::SeqCst);
                let _ = child.wait().await;
                send_error(out_tx, id, format!("read provider login helper: {e}"));
                return;
            }
        }
    };

    // Reply with the authorize URL now; the callback + credential write
    // continue out-of-band in the spawned task below.
    send_response(
        out_tx,
        id,
        serde_json::to_value(ProviderLoginStartResult { authorize_url })
            .expect("ProviderLoginStartResult serializes"),
    );

    // Continue draining the helper: when it emits the credentials line (after
    // the browser callback hits its :1455 loopback), Core — the single writer
    // — persists them. The Client learns the outcome by re-querying
    // `provider/status` on focus.
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
