//! `media/upload` handler (ADR-0058): decode the client's base64 bytes and
//! persist them through the `db::media` facade (bytes on disk under the media
//! root, row in SQLite). The client supplies `mime` and optional dimensions —
//! Core never sniffs or extracts (the ADR-0058 scope boundary). Invalid base64
//! and decoded payloads over the 10 MB cap are `invalid_params` BEFORE any
//! write; the stored bytes are served back by `GET /media/{id}` (main.rs).

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;

use super::handler::{self, HandlerError};
use crate::db::{self, AttachmentSeed, MediaInput, MediaRow};
use crate::protocol::{ManifestAttachment, MediaUploadParams, MediaUploadResult};

/// Resolve each `attachment_ids` entry via `db::get_media` (ADR-0058 send
/// path) into BOTH shapes the send needs: an [`AttachmentSeed`] (persisted
/// metadata — the row's `mime` and dimensions) and a [`ManifestAttachment`]
/// (the stored bytes read back and base64-encoded for the fresh spawn
/// manifest). One pass so each media row is fetched and its file read exactly
/// once. Shared by `thread/create` and `run/post_message`, called BEFORE any
/// persistence: an unknown id is `invalid_params`, an unreadable file is
/// `internal` (logged loudly per ADR-0058) — either way ZERO rows written,
/// the unknown-thread precedent.
pub(super) async fn resolve_attachments(
    pool: &SqlitePool,
    attachment_ids: &[String],
) -> Result<(Vec<AttachmentSeed>, Vec<ManifestAttachment>), HandlerError> {
    if attachment_ids.len() > MAX_ATTACHMENTS {
        return Err(HandlerError::InvalidParams(format!(
            "too many attachments: {} (max {MAX_ATTACHMENTS})",
            attachment_ids.len()
        )));
    }
    let mut seeds = Vec::with_capacity(attachment_ids.len());
    let mut manifest = Vec::with_capacity(attachment_ids.len());
    for id in attachment_ids {
        let row: MediaRow = db::get_media(pool, id)
            .await
            .map_err(|e| HandlerError::Internal(e.into()))?
            .ok_or_else(|| HandlerError::InvalidParams(format!("unknown media id: {id}")))?;
        manifest.push(manifest_attachment_for(&row).await?);
        seeds.push(AttachmentSeed {
            media_id: row.id,
            mime: row.mime,
            width: row.width,
            height: row.height,
        });
    }
    Ok((seeds, manifest))
}

/// Read + base64-encode the stored bytes for each media id into fresh-spawn
/// [`ManifestAttachment`]s — the read+encode half of [`resolve_attachments`],
/// for callers whose ids come from the DB rather than request params.
/// Run-retry replays the original turn's attachments through here. A missing
/// row is `internal` (these ids came from `media_attachments` rows, so a miss
/// is DB inconsistency, not client error); a read failure is the same loud
/// `internal` as the send path — no spawn either way.
pub(super) async fn encode_manifest_attachments(
    pool: &SqlitePool,
    media_ids: &[String],
) -> Result<Vec<ManifestAttachment>, HandlerError> {
    let mut manifest = Vec::with_capacity(media_ids.len());
    for id in media_ids {
        let row: MediaRow = db::get_media(pool, id)
            .await
            .map_err(|e| HandlerError::Internal(e.into()))?
            .ok_or_else(|| {
                HandlerError::Internal(anyhow::anyhow!(
                    "media row {id} vanished under a media_attachments link"
                ))
            })?;
        manifest.push(manifest_attachment_for(&row).await?);
    }
    Ok(manifest)
}

/// One media row → one [`ManifestAttachment`]: read the stored bytes and
/// base64-encode them (STANDARD engine — raw, never `data:`-prefixed).
async fn manifest_attachment_for(row: &MediaRow) -> Result<ManifestAttachment, HandlerError> {
    let bytes = read_media_bytes(&row.id, &row.storage_path).await?;
    Ok(ManifestAttachment {
        mime: row.mime.clone(),
        data_base64: BASE64.encode(&bytes),
    })
}

/// Read a media row's stored bytes through `db::resolve_media_path` (the trust
/// boundary turning the stored relative path into a real filesystem path). A
/// row pointing at missing/unreadable bytes is an internal fault — logged as
/// `media.read_failed` (the `GET /media/{id}` sibling in main.rs) per
/// ADR-0058's loud-error rule.
async fn read_media_bytes(id: &str, storage_path: &str) -> Result<Vec<u8>, HandlerError> {
    let path = db::resolve_media_path(storage_path).map_err(|e| {
        tracing::error!(event = "media.read_failed", media_id = %id, error = ?e);
        HandlerError::Internal(e)
    })?;
    tokio::fs::read(&path).await.map_err(|e| {
        tracing::error!(event = "media.read_failed", media_id = %id, error = ?e);
        HandlerError::Internal(anyhow::anyhow!("read media bytes for {id}: {e}"))
    })
}

/// Decoded-size cap (10 MB). Its base64 text (~13.4 MB) stays under
/// tungstenite's 16 MiB default frame cap, so the limit needs no transport
/// negotiation. No config surface — a deliberate scope cut.
const MAX_DECODED_BYTES: usize = 10 * 1024 * 1024;

/// Per-request attachment cap: bounds the DB/disk/manifest work a single
/// `thread/create` or `run/post_message` can demand (8 × 10 MB ≈ 80 MB
/// worst-case manifest — plenty for a chat turn). No config surface —
/// deliberate.
const MAX_ATTACHMENTS: usize = 8;

pub(super) async fn handle_upload(
    pool: &SqlitePool,
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    handler::handle(id, params, out_tx, |params: MediaUploadParams| async move {
        let bytes = BASE64.decode(&params.bytes_base64).map_err(|e| {
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
                created_by: "user".to_string(),
                created_via_proposal_id: None,
            },
        )
        .await
        .map_err(|e| HandlerError::Internal(anyhow::anyhow!("insert_media failed: {e:?}")))?;

        Ok(MediaUploadResult { media_id })
    })
    .await;
}
