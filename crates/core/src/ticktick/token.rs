//! Boot-read TickTick credential (external-task-views A5). The token file is
//! manually provisioned (0600, `<credentials dir>/ticktick.json`) and read
//! EXACTLY ONCE at boot — never re-read, so a swapped file cannot change
//! accounts under a live connection ID; credential changes require a Core
//! restart.

use std::fs::File;
use std::io::{self, Read};
use std::path::Path;
use std::sync::OnceLock;

use serde::Deserialize;

/// The provider id / on-disk filename stem, mirroring
/// [`crate::credentials::OPENAI_CODEX`].
const TICKTICK: &str = "ticktick";

/// The token file's shape. `access_token` is the credential; `scope` is the
/// optional provisioning-recorded grant — when present and missing
/// `tasks:write`, the connection is read-only and the write family refuses to
/// propose (ticktick-writes W-A2). Absent `scope` = writable (provisioning
/// convention: any token that works for the MCP read lane carries
/// `tasks:write`). Other metadata stays on disk.
#[derive(Deserialize)]
struct TokenFile {
    access_token: String,
    #[serde(default)]
    scope: Option<String>,
}

/// The boot-read TickTick connection: one boot, one credential, one ID.
pub struct Connection {
    /// The `tasks:read tasks:write` bearer token spanning both lanes (S1: one
    /// token authorizes OpenAPI and MCP; MCP rejects read-only scope).
    pub access_token: String,
    /// Opaque, boot-scoped connection identity (A5): random per boot, never
    /// token-derived — nothing about the secret leaks into query keys, and no
    /// cross-boot equality is implied. Served by `ticktick/status`; the Web
    /// uses it as the SOLE task-query key, so a query key can never span two
    /// accounts, and a restart mints a new ID that the A2 reconnect protocol
    /// uses to clear stale task data.
    pub connection_id: String,
    /// Whether the token may WRITE (ticktick-writes W-A2): the parsed `scope`
    /// grants `tasks:write`, or `scope` is absent (provisioning convention).
    /// The pre-park gate refuses proposing on a read-only connection.
    pub writable: bool,
    /// INTERNAL fingerprint of the access token (ticktick-writes W-A3): a
    /// `ticktick_writes` row snapshots it at park and phase A re-checks
    /// equality, so the SAME credential accepts across any number of restarts
    /// while a real credential change refuses with a typed error and no POST.
    /// Never serialized to the wire or logs (A5's never-token-derived rule
    /// protects wire-visible ids; this is a local comparison only).
    pub credential_fp: String,
}

/// Derive the internal credential fingerprint from the access token: a
/// domain-separated SHA-256, hex-encoded. Deterministic across boots (the
/// overnight propose-at-night / accept-in-the-morning flow depends on it).
pub(crate) fn credential_fingerprint(access_token: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"inkstone-ticktick-credential-fp-v1:");
    hasher.update(access_token.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

/// Whether a parsed `scope` string grants `tasks:write`. Absent scope =
/// writable (provisioning convention, stated in the plan).
fn scope_grants_write(scope: Option<&str>) -> bool {
    match scope {
        None => true,
        Some(scope) => scope.split_whitespace().any(|s| s == "tasks:write"),
    }
}

static CONNECTION: OnceLock<Option<Connection>> = OnceLock::new();

/// Read the credential once at Core boot. Missing file = not connected; a
/// present-but-unreadable file is logged and treated as not connected (Core
/// must still boot so the Web can render the disconnected state).
pub fn init() {
    let _ = CONNECTION.set(load());
}

/// The boot-read connection, or `None` when no credential loaded (including
/// before `init` in unit tests — a test installs one via [`test_override`]).
pub fn connection() -> Option<&'static Connection> {
    #[cfg(test)]
    if let Some(over) = test_override::current() {
        return over;
    }
    CONNECTION.get().and_then(Option::as_ref)
}

enum CredentialOpenError {
    Io(io::Error),
    Custody(&'static str),
    Mode(u32),
}

#[cfg(unix)]
fn open_credential(path: &Path) -> Result<File, CredentialOpenError> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|error| {
            if error.raw_os_error() == Some(libc::ELOOP) {
                CredentialOpenError::Custody("symlink")
            } else {
                CredentialOpenError::Io(error)
            }
        })?;
    let metadata = file.metadata().map_err(CredentialOpenError::Io)?;
    if !metadata.is_file() {
        return Err(CredentialOpenError::Custody("not a regular file"));
    }
    let mode = metadata.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        return Err(CredentialOpenError::Mode(mode));
    }
    Ok(file)
}

#[cfg(not(unix))]
fn open_credential(path: &Path) -> Result<File, CredentialOpenError> {
    // There is no portable O_NOFOLLOW equivalent. Preserve the pre-open link
    // rejection on non-Unix platforms, then validate the opened descriptor too.
    let metadata = std::fs::symlink_metadata(path).map_err(CredentialOpenError::Io)?;
    if !metadata.is_file() {
        return Err(CredentialOpenError::Custody("not a regular file"));
    }
    let file = File::open(path).map_err(CredentialOpenError::Io)?;
    if !file.metadata().map_err(CredentialOpenError::Io)?.is_file() {
        return Err(CredentialOpenError::Custody("not a regular file"));
    }
    Ok(file)
}

fn load() -> Option<Connection> {
    let path = match crate::credentials::credential_path(TICKTICK) {
        Ok(path) => path,
        Err(e) => {
            tracing::warn!(event = "ticktick.credential_path_failed", error = ?e);
            return None;
        }
    };
    let mut file = match open_credential(&path) {
        Err(CredentialOpenError::Io(error)) if error.kind() == io::ErrorKind::NotFound => {
            return None;
        }
        Err(CredentialOpenError::Io(error)) => {
            tracing::warn!(event = "ticktick.credential_unreadable", error = ?error);
            return None;
        }
        Err(CredentialOpenError::Custody(reason)) => {
            tracing::warn!(event = "ticktick.credential_custody_rejected", reason);
            return None;
        }
        Err(CredentialOpenError::Mode(mode)) => {
            tracing::warn!(
                event = "ticktick.credential_custody_rejected",
                reason = "group/world-accessible mode",
                mode = format!("{mode:o}")
            );
            return None;
        }
        Ok(file) => file,
    };
    let mut body = String::new();
    if let Err(error) = file.read_to_string(&mut body) {
        tracing::warn!(event = "ticktick.credential_unreadable", error = ?error);
        return None;
    }
    match serde_json::from_str::<TokenFile>(&body) {
        Ok(token) if token.access_token.trim().is_empty() => {
            tracing::warn!(
                event = "ticktick.credential_custody_rejected",
                reason = "empty access_token"
            );
            None
        }
        Ok(token) => Some(Connection {
            writable: scope_grants_write(token.scope.as_deref()),
            credential_fp: credential_fingerprint(&token.access_token),
            access_token: token.access_token,
            connection_id: uuid::Uuid::now_v7().to_string(),
        }),
        Err(e) => {
            tracing::warn!(event = "ticktick.credential_unparsable", error = ?e);
            None
        }
    }
}

/// Thread-local test override, mirroring [`crate::config::test_override`]: a
/// unit test installs a leaked `Connection` (or an explicit disconnected
/// `None`) for its own thread only, restored on guard drop.
#[cfg(test)]
pub(crate) mod test_override {
    use std::cell::Cell;

    use super::Connection;

    thread_local! {
        static OVERRIDE: Cell<Option<Option<&'static Connection>>> = const { Cell::new(None) };
    }

    pub(crate) fn current() -> Option<Option<&'static Connection>> {
        OVERRIDE.with(|o| o.get())
    }

    #[must_use = "the override is removed when the guard drops"]
    pub(crate) struct ConnectionGuard {
        prev: Option<Option<&'static Connection>>,
    }

    impl Drop for ConnectionGuard {
        fn drop(&mut self) {
            let prev = self.prev;
            OVERRIDE.with(|o| o.set(prev));
        }
    }

    /// A test [`Connection`] with a fixed id (helper for the verb tests):
    /// writable, fingerprint derived from the token like the boot read.
    pub(crate) fn test_connection(token: &str, id: &str) -> Connection {
        Connection {
            access_token: token.to_string(),
            connection_id: id.to_string(),
            writable: true,
            credential_fp: super::credential_fingerprint(token),
        }
    }

    /// A read-only test [`Connection`] (scope lacking `tasks:write`).
    pub(crate) fn test_connection_read_only(token: &str, id: &str) -> Connection {
        Connection {
            writable: false,
            ..test_connection(token, id)
        }
    }

    /// Install `connection` for this thread. `Some(conn)` leaks the boxed
    /// Connection (test-scoped, negligible); `None` pins a disconnected state.
    pub(crate) fn install(connection: Option<Connection>) -> ConnectionGuard {
        let leaked: Option<&'static Connection> =
            connection.map(|conn| &*Box::leak(Box::new(conn)));
        let prev = OVERRIDE.with(|o| o.replace(Some(leaked)));
        ConnectionGuard { prev }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A missing file is a clean `None`; an unparseable file degrades to `None`
    /// (Core still boots so the Web can render the disconnected state).
    #[test]
    fn load_reads_token_file_and_degrades_cleanly() {
        let guard = crate::credentials::test_credentials_dir();
        std::fs::create_dir_all(guard.dir()).expect("mk credentials dir");

        // Missing file: not connected.
        assert!(load().is_none(), "no file → None");

        // The real provisioned shape (extra fields ignored). Provisioning is
        // 0600 (A5); mirror it — the custody gate rejects looser modes.
        let write_0600 = |body: &str| {
            let path = guard.dir().join("ticktick.json");
            std::fs::write(&path, body).expect("write token file");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                    .expect("chmod 0600");
            }
        };
        write_0600(
            r#"{"access_token":"tok_ticktick","token_type":"bearer","scope":"tasks:read tasks:write","obtained_at":"2026-08-14T19:17:10.894Z"}"#,
        );
        let conn = load().expect("token file loads");
        assert_eq!(conn.access_token, "tok_ticktick");
        assert!(
            !conn.connection_id.contains("tok_ticktick") && conn.connection_id.len() == 36,
            "the connection id is an opaque uuid, never token-derived"
        );
        // Two loads mint DIFFERENT ids (boot-scoped, no cross-boot equality).
        assert_ne!(conn.connection_id, load().expect("reload").connection_id);
        // The write-scope parse (ticktick-writes W-A2) and the internal
        // fingerprint (W-A3): full scope → writable; the fingerprint is
        // deterministic across loads (restart-stable — the overnight accept)
        // and never contains the raw token.
        assert!(conn.writable, "tasks:write scope → writable");
        assert_eq!(
            conn.credential_fp,
            load().expect("reload").credential_fp,
            "the fingerprint is stable across restarts for the SAME credential"
        );
        assert!(
            !conn.credential_fp.contains("tok_ticktick"),
            "the fingerprint never embeds the raw token"
        );

        // A scope WITHOUT tasks:write → connected but read-only; a DIFFERENT
        // token fingerprints differently (the phase-A guard's signal).
        write_0600(r#"{"access_token":"tok_other","scope":"tasks:read"}"#);
        let read_only = load().expect("read-only token loads");
        assert!(!read_only.writable, "scope lacking tasks:write → read-only");
        assert_ne!(
            read_only.credential_fp, conn.credential_fp,
            "a different credential fingerprints differently"
        );

        // An ABSENT scope field = writable (provisioning convention).
        write_0600(r#"{"access_token":"tok_ticktick"}"#);
        assert!(
            load().expect("scopeless token loads").writable,
            "absent scope → writable"
        );

        // An unparseable file degrades to None rather than failing boot.
        write_0600("not json");
        assert!(load().is_none(), "corrupt file → None (Core still boots)");

        // Custody (review R12 #5): a group/world-readable token file is REJECTED
        // — the tasks:write secret follows the repo's 0600 policy at read time.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = guard.dir().join("ticktick.json");
            write_0600(r#"{"access_token":"tok_ticktick"}"#);
            assert!(load().is_some(), "0600 loads");
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
                .expect("loosen");
            assert!(load().is_none(), "world-readable → not connected");
        }

        // A symlinked credential is rejected (custody must not follow links).
        #[cfg(unix)]
        {
            let real = guard.dir().join("elsewhere.json");
            std::fs::write(&real, r#"{"access_token":"tok_ticktick"}"#).expect("write target");
            let link = guard.dir().join("ticktick.json");
            std::fs::remove_file(&link).expect("clear");
            std::os::unix::fs::symlink(&real, &link).expect("symlink");
            assert!(load().is_none(), "symlink → not connected");
            std::fs::remove_file(&link).expect("clear link");
        }

        // An empty token is rejected — never a connected state with no secret.
        write_0600(r#"{"access_token":"  "}"#);
        assert!(load().is_none(), "empty access_token → not connected");
    }
}
