//! Credential Store (ADR-0023): Core owns provider OAuth credential bytes on
//! disk as a `0600` JSON file per provider beside the SQLite database. Core is
//! the single writer, so no file-locking is needed. Sits outside the three-tier
//! storage model by design (ADR-0007).

use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// The only provider this feature supports (ChatGPT/Codex). One source for both
/// the wire `id` and the on-disk filename.
pub const OPENAI_CODEX: &str = "openai-codex";

/// Stored OAuth credentials for a provider (ADR-0023), mirroring the shape
/// `pi-ai`'s pure OAuth functions use. `Debug` is hand-implemented to redact the
/// token fields — they must never reach a log line.
#[derive(Clone, Serialize, Deserialize)]
pub struct Credentials {
    pub access: String,
    pub refresh: String,
    /// Absolute expiry, ms since epoch (`Date.now() + expires_in*1000`).
    pub expires: i64,
    pub account_id: String,
}

impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials")
            .field("access", &"<redacted>")
            .field("refresh", &"<redacted>")
            .field("expires", &self.expires)
            .field("account_id", &self.account_id)
            .finish()
    }
}

impl Credentials {
    /// Whether the access token is at or past its expiry at `now_ms`. Consulted
    /// by the refresh path; status treats an expired credential as "connected".
    pub fn is_expired(&self, now_ms: i64) -> bool {
        now_ms >= self.expires
    }
}

/// The directory credential files live in: `INKSTONE_CREDENTIALS_DIR` if set
/// (tests), else `<dir of resolved DB path>/credentials`.
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

/// Read the stored credentials for `provider`, or `None` if no file exists. A
/// present-but-unparseable file is an error (corrupt store), not a silent `None`.
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
/// considered — an expired credential is still "connected" (refresh renews it).
pub fn is_connected(provider: &str) -> Result<bool> {
    Ok(read(provider)?.is_some())
}

/// Persist `creds` for `provider` as a `0600` JSON file in a `0700` dir
/// (ADR-0023). The file is created at mode 0600 from the start, so the secret
/// never sits at the umask default.
pub fn write(provider: &str, creds: &Credentials) -> Result<()> {
    let dir = credentials_dir()?;
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("create credentials dir {}", dir.display()))?;
    set_dir_mode_0700(&dir)?;

    let path = credential_path(provider)?;
    let body = serde_json::to_string_pretty(creds).expect("Credentials serializes");
    write_file_0600(&path, body.as_bytes())
        .with_context(|| format!("write credentials {}", path.display()))?;
    Ok(())
}

/// Write `bytes` to `path`, creating/truncating at mode 0600 on unix so the
/// secret never exists at a broader mode.
#[cfg(unix)]
fn write_file_0600(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::fs::PermissionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    // If the file pre-existed with a broader mode, tighten it.
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    f.write_all(bytes)
}

#[cfg(not(unix))]
fn write_file_0600(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `write()` round-trips through `read()` and lands the file at mode 0600
    /// in a 0700 dir (ADR-0023). Serialized via a process-global lock because
    /// the `INKSTONE_CREDENTIALS_DIR` env var is global.
    #[test]
    fn write_then_read_round_trips_at_0600() {
        use std::sync::Mutex;
        static ENV_LOCK: Mutex<()> = Mutex::new(());
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());

        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("credentials");
        // SAFETY: single-threaded test guarded by ENV_LOCK.
        unsafe {
            std::env::set_var("INKSTONE_CREDENTIALS_DIR", &dir);
        }

        let creds = Credentials {
            access: "tok_access".to_string(),
            refresh: "tok_refresh".to_string(),
            expires: 9_999_999_999_999,
            account_id: "acct_1".to_string(),
        };
        write(OPENAI_CODEX, &creds).expect("write credentials");

        let read_back = read(OPENAI_CODEX).expect("read credentials").expect("present");
        assert_eq!(read_back.access, "tok_access");
        assert_eq!(read_back.refresh, "tok_refresh");
        assert_eq!(read_back.expires, 9_999_999_999_999);
        assert_eq!(read_back.account_id, "acct_1");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let file_mode = std::fs::metadata(dir.join("openai-codex.json"))
                .expect("stat credential file")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(file_mode, 0o600, "credential file is 0600");
            let dir_mode = std::fs::metadata(&dir)
                .expect("stat credential dir")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(dir_mode, 0o700, "credential dir is 0700");
        }

        unsafe {
            std::env::remove_var("INKSTONE_CREDENTIALS_DIR");
        }
    }

    /// A redacting `Debug` keeps the token bytes out of any log line.
    #[test]
    fn debug_redacts_tokens() {
        let creds = Credentials {
            access: "SECRET_ACCESS".to_string(),
            refresh: "SECRET_REFRESH".to_string(),
            expires: 42,
            account_id: "acct_9".to_string(),
        };
        let rendered = format!("{creds:?}");
        assert!(!rendered.contains("SECRET_ACCESS"), "access token must be redacted");
        assert!(!rendered.contains("SECRET_REFRESH"), "refresh token must be redacted");
        assert!(rendered.contains("acct_9"), "non-secret account_id may show");
        assert!(rendered.contains("42"), "non-secret expiry may show");
    }
}

#[cfg(unix)]
fn set_dir_mode_0700(dir: &std::path::Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
        .with_context(|| format!("chmod 0700 {}", dir.display()))
}

#[cfg(not(unix))]
fn set_dir_mode_0700(_dir: &std::path::Path) -> Result<()> {
    Ok(())
}
