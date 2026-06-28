//! Media storage facade (ADR-0055). SQL stays in `queries`, matching the DB
//! module's one-statement query convention; this module owns the media storage
//! shapes, the bytes-on-disk write/unlink ordering, and the transaction boundary.
//!
//! The binary lives on disk under [`crate::db::media_root`]; SQLite stores only
//! the relative `storage_path` (a bare random-UUID filename in a flat root, no
//! extension). `insert_media` writes the file first, then the row in a
//! transaction, and unlinks the file if the transaction fails; `delete_media`
//! deletes the row first (committing the future `media_attachments` cascade),
//! then unlinks the file. Both orderings lean toward a recoverable
//! orphan-file-on-disk over a row pointing at missing bytes.
//!
//! The whole surface here is Core-internal and reached only by this module's
//! tests in slice 1 — its production consumer (a media wire verb / the Media
//! entity, #252) lands later, so `dead_code` is allowed module-wide for now.
#![allow(dead_code)]

use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::queries;
use crate::mutation::EntityType;

/// Lower-case sha-256 hex of `bytes`. Hand-rolled to avoid a `hex` crate dep
/// (ADR-0055 keeps `digest` as integrity metadata, not a content address).
fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// A fully-specified media create request. The caller supplies `mime`,
/// dimensions, capture time, and provenance; Core computes only `byte_size` and
/// `digest` from the bytes (ADR-0055 §Scope boundary — no mime sniffing, no
/// dimension extraction). `attachments` is empty on the standalone-media path
/// exercised this slice; slice 2 fills in the per-target validation + link loop
/// without reshaping this struct.
pub(crate) struct MediaInput {
    pub mime: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_ms: Option<i64>,
    pub capture_time: Option<i64>,
    pub thumbnail_path: Option<String>,
    pub created_by: String,
    pub created_via_proposal_id: Option<String>,
    pub attachments: Vec<MediaAttachmentTarget>,
}

/// One polymorphic attachment target — exactly one media row links to exactly one
/// of these (ADR-0055). Defined now; only the empty-`attachments` path runs this
/// slice, so the variants are not yet constructed. Slice 2 consumes them in the
/// in-transaction validation loop.
pub(crate) enum MediaAttachmentTarget {
    Entity {
        id: String,
        expected_type: Option<EntityType>,
    },
    Message {
        id: String,
    },
    Observation {
        id: String,
    },
    Proposal {
        id: String,
    },
}

/// The metadata `get_media` round-trips. Bytes are not carried here — the caller
/// reads them from the resolved `storage_path` when it needs them.
pub(crate) struct MediaRow {
    pub id: String,
    pub mime: String,
    pub byte_size: i64,
    pub digest: String,
    pub storage_path: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_ms: Option<i64>,
    pub capture_time: Option<i64>,
    pub thumbnail_path: Option<String>,
    pub created_by: String,
    pub created_via_proposal_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug)]
pub(crate) enum MediaInsertError {
    /// An attachment target does not exist or is the wrong type. Unused until
    /// slice 2 wires the validation loop.
    InvalidTarget(String),
    Sqlx(sqlx::Error),
}

impl From<sqlx::Error> for MediaInsertError {
    fn from(value: sqlx::Error) -> Self {
        MediaInsertError::Sqlx(value)
    }
}

/// Write the bytes to disk under the media root, then the `media` row in a
/// transaction; returns the new media id. If the transaction fails after the
/// file is written, the file is best-effort unlinked before returning the error.
pub(crate) async fn insert_media(
    pool: &SqlitePool,
    bytes: &[u8],
    input: MediaInput,
) -> Result<String, MediaInsertError> {
    let id = Uuid::now_v7().to_string();
    // Bare random-UUID filename in a flat root, no extension (the `mime` column
    // is the authority); stored as the relative `storage_path`.
    let storage_path = id.clone();
    let digest = sha256_hex(bytes);
    let byte_size = bytes.len() as i64;
    let now = super::now_ms();

    // File first, so a row never points at missing bytes (ADR-0055).
    let abs_path = super::resolve_media_path(&storage_path).map_err(to_sqlx_io)?;
    std::fs::create_dir_all(super::media_root().map_err(to_sqlx_io)?).map_err(to_sqlx_io)?;
    std::fs::write(&abs_path, bytes).map_err(to_sqlx_io)?;

    let write_row = async {
        let mut tx = pool.begin().await?;
        queries::insert_media(
            &mut *tx,
            &id,
            &input.mime,
            byte_size,
            &digest,
            &storage_path,
            input.width,
            input.height,
            input.duration_ms,
            input.capture_time,
            input.thumbnail_path.as_deref(),
            &input.created_by,
            input.created_via_proposal_id.as_deref(),
            now,
        )
        .await?;
        // Slice 2 validates and inserts `input.attachments` here, in this tx.
        tx.commit().await?;
        Ok::<(), MediaInsertError>(())
    }
    .await;

    if let Err(err) = write_row {
        // The row failed to land — best-effort unlink the orphaned file before
        // surfacing the error (a recoverable disk orphan beats a dangling path).
        let _ = std::fs::remove_file(&abs_path);
        return Err(err);
    }

    Ok(id)
}

/// Surface an `io::Error` from the on-disk write/resolve as a `sqlx::Error::Io`,
/// so `insert_media` keeps a single `MediaInsertError` shape (the file and the
/// row failures both flow through `Sqlx`).
fn to_sqlx_io<E: Into<Box<dyn std::error::Error + Send + Sync>>>(err: E) -> MediaInsertError {
    MediaInsertError::Sqlx(sqlx::Error::Io(std::io::Error::other(err)))
}

/// Read a media row's metadata by id. `None` when no such row exists.
pub(crate) async fn get_media(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<MediaRow>> {
    Ok(queries::media_by_id(pool, id).await?.map(|columns| {
        let (
            id,
            mime,
            byte_size,
            digest,
            storage_path,
            width,
            height,
            duration_ms,
            capture_time,
            thumbnail_path,
            created_by,
            created_via_proposal_id,
            created_at,
            updated_at,
        ) = columns;
        MediaRow {
            id,
            mime,
            byte_size,
            digest,
            storage_path,
            width,
            height,
            duration_ms,
            capture_time,
            thumbnail_path,
            created_by,
            created_via_proposal_id,
            created_at,
            updated_at,
        }
    }))
}

/// Delete a media row and unlink its on-disk file. The row is removed (committing
/// the future `media_attachments` cascade) before the file, so a crash leaves an
/// orphan file rather than a row pointing at missing bytes. Unlink is best-effort
/// (a missing file is ignored).
pub(crate) async fn delete_media(pool: &SqlitePool, id: &str) -> sqlx::Result<()> {
    // Resolve the on-disk path before the row is gone.
    let storage_path = queries::media_by_id(pool, id)
        .await?
        .map(|columns| columns.4);
    let Some(storage_path) = storage_path else {
        return Ok(());
    };

    queries::delete_media(pool, id).await?;

    if let Ok(abs_path) = super::resolve_media_path(&storage_path) {
        match std::fs::remove_file(&abs_path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(sqlx::Error::Io(err)),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    async fn memory_pool() -> SqlitePool {
        let options = SqliteConnectOptions::new()
            .filename(":memory:")
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("open in-memory sqlite");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        pool
    }

    /// Serializes every test that mutates the process-global `INKSTONE_MEDIA_DIR`,
    /// mirroring `skills::SKILLS_ENV_GUARD`. Lock with
    /// `unwrap_or_else(|p| p.into_inner())` so a panicking test poisons the mutex
    /// without cascading `PoisonError` into the rest.
    static MEDIA_ENV_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[tokio::test]
    async fn standalone_media_round_trips_bytes_and_deletes_file() {
        let _guard = MEDIA_ENV_GUARD.lock().unwrap_or_else(|p| p.into_inner());
        let tmp = tempfile::tempdir().expect("tempdir");
        unsafe {
            std::env::set_var("INKSTONE_MEDIA_DIR", tmp.path());
        }

        let result = async {
            let pool = memory_pool().await;
            let id = insert_media(
                &pool,
                b"hello",
                MediaInput {
                    mime: "text/plain".to_string(),
                    width: None,
                    height: None,
                    duration_ms: None,
                    capture_time: None,
                    thumbnail_path: None,
                    created_by: "user".to_string(),
                    created_via_proposal_id: None,
                    attachments: Vec::new(),
                },
            )
            .await
            .expect("insert standalone media");

            // The metadata round-trips and points at an on-disk file holding the bytes.
            let row = get_media(&pool, &id)
                .await
                .expect("get_media ok")
                .expect("media row present");
            assert_eq!(row.id, id);
            assert_eq!(row.mime, "text/plain");
            assert_eq!(row.byte_size, 5);
            assert_eq!(row.digest, sha256_hex(b"hello"));
            // Known sha-256 of "hello".
            assert_eq!(
                row.digest,
                "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
            );

            let resolved = crate::db::resolve_media_path(&row.storage_path).expect("resolve path");
            let on_disk = std::fs::read(&resolved).expect("read stored bytes");
            assert_eq!(on_disk, b"hello");

            // Delete removes both the row and the on-disk file.
            delete_media(&pool, &id).await.expect("delete media");
            assert!(
                std::fs::metadata(&resolved).is_err(),
                "stored file is removed after delete_media"
            );
            assert!(
                get_media(&pool, &id).await.expect("get_media ok").is_none(),
                "media row is gone after delete_media"
            );
        }
        .await;

        unsafe {
            std::env::remove_var("INKSTONE_MEDIA_DIR");
        }
        result
    }
}
