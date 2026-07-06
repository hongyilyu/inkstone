//! `media/upload` handler (ADR-0058): decode the client's base64 bytes and
//! persist them through the `db::media` facade (bytes on disk under the media
//! root, row in SQLite). The client supplies `mime` and optional dimensions —
//! Core never sniffs or extracts (the ADR-0058 scope boundary). Invalid base64
//! and decoded payloads over the 10 MB cap are `invalid_params` BEFORE any
//! write; the stored bytes are served back by `GET /media/{id}` (main.rs).

use base64::Engine as _;
use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;

use super::handler::{self, HandlerError};
use crate::db::{self, MediaInput};
use crate::protocol::{MediaUploadParams, MediaUploadResult};

/// Decoded-size cap (10 MB). Its base64 text (~13.4 MB) stays under
/// tungstenite's 16 MiB default frame cap, so the limit needs no transport
/// negotiation. No config surface — a deliberate scope cut.
const MAX_DECODED_BYTES: usize = 10 * 1024 * 1024;

pub(super) async fn handle_upload(
    pool: &SqlitePool,
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    handler::handle(id, params, out_tx, |params: MediaUploadParams| async move {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&params.bytes_base64)
            .map_err(|e| {
                HandlerError::InvalidParams(format!("bytes_base64 is not valid base64: {e}"))
            })?;
        if bytes.len() > MAX_DECODED_BYTES {
            return Err(HandlerError::InvalidParams(format!(
                "decoded payload is {} bytes; the cap is {MAX_DECODED_BYTES} bytes (10 MB)",
                bytes.len()
            )));
        }

        let media_id = db::insert_media(
            pool,
            &bytes,
            MediaInput {
                mime: params.mime,
                width: params.width,
                height: params.height,
                duration_ms: None,
                capture_time: None,
                thumbnail_path: None,
                created_by: "user".to_string(),
                created_via_proposal_id: None,
                // Standalone upload: attachment linking lands with the send path
                // (slice 2), so no targets here — InvalidTarget cannot occur.
                attachments: Vec::new(),
            },
        )
        .await
        .map_err(|e| HandlerError::Internal(anyhow::anyhow!("insert_media failed: {e:?}")))?;

        Ok(MediaUploadResult { media_id })
    })
    .await;
}
