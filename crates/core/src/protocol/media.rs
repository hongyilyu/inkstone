//! `media/*` wire types (upload) — chat image attachments (ADR-0058 hand-mirror).

use serde::{Deserialize, Serialize};

/// `media/upload` params (ADR-0058): the client supplies the raw bytes (base64)
/// plus the `mime` it determined and optional pixel dimensions — Core never
/// sniffs mime or extracts dimensions (the ADR-0058 scope boundary). Core
/// computes `byte_size` and the content digest itself from the decoded bytes.
/// Invalid base64 or a decoded payload over the 10 MB cap → `invalid_params`
/// (-32602).
#[derive(Debug, Deserialize)]
pub struct MediaUploadParams {
    pub bytes_base64: String,
    pub mime: String,
    #[serde(default)]
    pub width: Option<i64>,
    #[serde(default)]
    pub height: Option<i64>,
}

/// `media/upload` result (ADR-0058): the id of the stored media blob, servable
/// at `GET /media/{media_id}`.
#[derive(Debug, Serialize)]
pub struct MediaUploadResult {
    pub media_id: String,
}
