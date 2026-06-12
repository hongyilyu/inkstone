//! `model/catalog` handler (ADR-0024): the models available per provider.
//! Read-only, no params — the embedded catalog (`crate::models`) is the only
//! input.

use tokio::sync::mpsc::UnboundedSender;

use super::handler::{self, HandlerError};
use crate::models;

pub(super) async fn handle(
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    handler::handle(id, params, out_tx, |_p: serde_json::Value| async move {
        Ok::<_, HandlerError>(models::catalog())
    })
    .await;
}
