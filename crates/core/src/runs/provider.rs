//! `provider/status` handler (ADR-0023, ADR-0014 amendment). Reports which
//! LLM providers have stored credentials. Read-only over the Credential
//! Store; "connected" means a parseable credential file exists (expiry is
//! not considered here — an expired credential is renewed by the refresh
//! path). Named `provider/*`, not `auth/*`, because ADR-0007 reserves "auth"
//! for the (absent) human-auth concern; this is LLM-provider connection.

use tokio::sync::mpsc::UnboundedSender;

use super::reply::{send_error, send_response};
use crate::credentials::{self, OPENAI_CODEX};
use crate::protocol::{ProviderStatus, ProviderStatusResult};

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
