//! Credential Store (ADR-0023): Core owns provider OAuth credential bytes
//! on disk. A `0600` JSON file per provider beside the SQLite database
//! (`<data-dir>/inkstone/credentials/<provider>.json`). Core is the single
//! writer — the login helper and the refresh path (slice 7) hand Core the
//! rotated bytes and Core persists them; no other process writes here, so no
//! file-locking is needed.
//!
//! This sits OUTSIDE the three-tier storage model by design (ADR-0007 carves
//! provider credentials out as "a separate concern"): neither tier-2
//! canonical state nor a tier-3 projection.

use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// The only provider this feature supports (ChatGPT/Codex). Kept as a const
/// so the wire `id` and the on-disk filename share one source.
pub const OPENAI_CODEX: &str = "openai-codex";

/// Stored OAuth credentials for a provider (ADR-0023). Mirrors the shape
/// `pi-ai`'s pure OAuth functions produce/consume: a long-lived refresh
/// token, the current short-lived access token, an absolute expiry
/// (ms-epoch), and the codex `account_id` decoded from the access-token JWT.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Credentials {
    pub access: String,
    pub refresh: String,
    /// Absolute expiry, ms since epoch (`Date.now() + expires_in*1000`).
    pub expires: i64,
    pub account_id: String,
}

impl Credentials {
    /// Whether the access token is at or past its expiry at `now_ms`. The
    /// refresh path (slice 7) consults this; status (this slice) does not —
    /// an expired-but-present credential still counts as "connected".
    #[allow(dead_code)] // consumed by the refresh path in slice 7
    pub fn is_expired(&self, now_ms: i64) -> bool {
        now_ms >= self.expires
    }
}

/// The directory credential files live in: `INKSTONE_CREDENTIALS_DIR` if set
/// (tests), else `<dir of resolved DB path>/credentials`. Deriving from the
/// DB path keeps credentials beside the rest of Core-managed state and makes
/// per-test isolation a single env var.
fn credentials_dir() -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("INKSTONE_CREDENTIALS_DIR") {
        return Ok(PathBuf::from(dir));
    }
    let db_path = crate::db::resolve_db_path()?;
    let parent = db_path
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    Ok(parent.join("credentials"))
}

fn credential_path(provider: &str) -> Result<PathBuf> {
    Ok(credentials_dir()?.join(format!("{provider}.json")))
}

/// Read the stored credentials for `provider`, or `None` if no file exists.
/// A present-but-unparseable file is an error (corrupt store) rather than a
/// silent `None`, so it surfaces instead of masquerading as "not connected".
pub fn read(provider: &str) -> Result<Option<Credentials>> {
    let path = credential_path(provider)?;
    match std::fs::read_to_string(&path) {
        Ok(body) => {
            let creds: Credentials = serde_json::from_str(&body)
                .with_context(|| format!("parsing credentials {}", path.display()))?;
            Ok(Some(creds))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("reading credentials {}", path.display())),
    }
}

/// Whether a (parseable) credential file exists for `provider`. Expiry is not
/// considered — an expired credential is still "connected" (the refresh path
/// renews it). A corrupt file surfaces as an error.
pub fn is_connected(provider: &str) -> Result<bool> {
    Ok(read(provider)?.is_some())
}

/// Persist `creds` for `provider` as a `0600` JSON file in a `0700` dir.
/// Core is the single writer (ADR-0023). Used by the login helper result
/// path and the refresh path (slice 7).
#[allow(dead_code)] // first writer lands in slice 7 (login/refresh)
pub fn write(provider: &str, creds: &Credentials) -> Result<()> {
    let dir = credentials_dir()?;
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("create credentials dir {}", dir.display()))?;
    set_dir_mode_0700(&dir)?;

    let path = credential_path(provider)?;
    let body = serde_json::to_string_pretty(creds).expect("Credentials serializes");
    std::fs::write(&path, body)
        .with_context(|| format!("write credentials {}", path.display()))?;
    set_file_mode_0600(&path)?;
    Ok(())
}

#[cfg(unix)]
fn set_dir_mode_0700(dir: &std::path::Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
        .with_context(|| format!("chmod 0700 {}", dir.display()))
}

#[cfg(unix)]
fn set_file_mode_0600(path: &std::path::Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .with_context(|| format!("chmod 0600 {}", path.display()))
}

#[cfg(not(unix))]
fn set_dir_mode_0700(_dir: &std::path::Path) -> Result<()> {
    Ok(())
}

#[cfg(not(unix))]
fn set_file_mode_0600(_path: &std::path::Path) -> Result<()> {
    Ok(())
}
