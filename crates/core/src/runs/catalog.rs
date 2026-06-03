//! `model/catalog` handler (ADR-0024): the models available per provider.
//! Read-only, no params — the embedded catalog (`crate::models`) is the only
//! input. Hand-mirrored from `pi-ai` and drift-tested in the Worker.

use tokio::sync::mpsc::UnboundedSender;

use super::reply::send_response;
use crate::models;

pub(super) fn handle(id: serde_json::Value, out_tx: &UnboundedSender<String>) {
    send_response(
        out_tx,
        id,
        serde_json::to_value(models::catalog()).expect("ModelCatalogResult serializes"),
    );
}
