//! Media storage facade (ADR-0058). SQL stays in `queries`, matching the DB
//! module's one-statement query convention; this module owns the media storage
//! shapes, the bytes-on-disk write/unlink ordering, and the write boundary.
//!
//! The binary lives on disk under [`crate::db::media_root`]; SQLite stores only
//! the relative `storage_path` (a bare random-UUID filename in a flat root, no
//! extension). `insert_media` writes the file first, then the row, and unlinks
//! the file if the row insert fails; `delete_media` deletes the row first
//! (committing the `media_attachments` cascade), then unlinks the file. Both
//! orderings lean toward a recoverable orphan-file-on-disk over a row pointing
//! at missing bytes.
//!
//! Attachment linking is the send path's job: `db::runs` writes the
//! `media_attachments` rows directly (target_kind='message') in the send
//! transaction — this module stores and reads standalone media only.

use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::queries;

/// Lower-case sha-256 hex of `bytes`. Hand-rolled to avoid a `hex` crate dep
/// (ADR-0058 keeps `digest` as integrity metadata, not a content address).
fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// A media create request. The caller supplies `mime` and dimensions; Core
/// computes only `byte_size` and `digest` from the bytes (ADR-0058 §Scope
/// boundary — no mime sniffing, no dimension extraction).
pub(crate) struct MediaInput {
    pub mime: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub created_by: String,
    pub created_via_proposal_id: Option<String>,
}

/// The metadata `get_media` round-trips — the columns production reads. Bytes
/// are not carried here; the caller reads them from the resolved
/// `storage_path` when it needs them. The `GET /media/{id}` route reads
/// `mime` + `storage_path`; the send-path attachment validation copies
/// `id`/`mime`/`width`/`height` into `AttachmentSeed`s.
pub(crate) struct MediaRow {
    pub id: String,
    pub mime: String,
    pub storage_path: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
}

// The variant payloads are read only through `Debug` (the upload handler wraps
// the whole error into `HandlerError::Internal`), which dead-code analysis
// deliberately ignores — hence the allow on the payload-carrying variants.
#[allow(dead_code)]
#[derive(Debug)]
pub(crate) enum MediaInsertError {
    /// A media-root resolution or on-disk write failure — the bytes could not be
    /// persisted. Kept distinct from [`MediaInsertError::Sqlx`] so a disk fault
    /// (e.g. permission denied, disk full) is never mistaken for a SQL fault when
    /// the future wire surface (#252) maps these to error codes.
    Io(std::io::Error),
    Sqlx(sqlx::Error),
}

impl From<sqlx::Error> for MediaInsertError {
    fn from(value: sqlx::Error) -> Self {
        MediaInsertError::Sqlx(value)
    }
}

/// Write the bytes to disk under the media root, then the `media` row; returns
/// the new media id. If the row insert fails after the file is written, the
/// file is best-effort unlinked before returning the error.
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

    // File first, so a row never points at missing bytes (ADR-0058).
    let abs_path = super::resolve_media_path(&storage_path).map_err(to_io)?;
    std::fs::create_dir_all(super::media_root().map_err(to_io)?).map_err(MediaInsertError::Io)?;
    // `fs::write` creates+truncates before writing, so a mid-write failure can
    // leave a partial file. Unlink it before bailing — symmetric with the
    // row-failure arm below, so no write failure path leaves an orphan.
    if let Err(err) = std::fs::write(&abs_path, bytes) {
        let _ = std::fs::remove_file(&abs_path);
        return Err(MediaInsertError::Io(err));
    }

    let write_row = queries::insert_media(
        pool,
        &id,
        &input.mime,
        byte_size,
        &digest,
        &storage_path,
        input.width,
        input.height,
        &input.created_by,
        input.created_via_proposal_id.as_deref(),
        now,
    )
    .await;

    if let Err(err) = write_row {
        // The row failed to land — best-effort unlink the orphaned file before
        // surfacing the error (a recoverable disk orphan beats a dangling path).
        let _ = std::fs::remove_file(&abs_path);
        return Err(err.into());
    }

    Ok(id)
}

/// Coerce a media-root resolution failure (an `anyhow::Error` from `media_root`/
/// `resolve_media_path`, e.g. an unresolvable data dir) into the `Io` variant —
/// it is a "the bytes can't be placed on disk" failure, the same class as the
/// `std::fs` errors that flow straight into [`MediaInsertError::Io`].
fn to_io<E: Into<Box<dyn std::error::Error + Send + Sync>>>(err: E) -> MediaInsertError {
    MediaInsertError::Io(std::io::Error::other(err))
}

/// Read a media row's metadata by id. `None` when no such row exists.
pub(crate) async fn get_media(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<MediaRow>> {
    Ok(queries::media_by_id(pool, id).await?.map(|columns| {
        let (id, mime, storage_path, width, height) = columns;
        MediaRow {
            id,
            mime,
            storage_path,
            width,
            height,
        }
    }))
}

/// The media ids attached to `message_id`, in insertion (send-request) order.
/// Run-retry re-resolves these through the send path's read+encode seam so a
/// retried turn replays its original images (chat-image-attachments).
pub(crate) async fn media_ids_for_message(
    pool: &SqlitePool,
    message_id: &str,
) -> sqlx::Result<Vec<String>> {
    queries::media_ids_for_message(pool, message_id).await
}

/// Delete a media row and unlink its on-disk file. The row is removed (committing
/// the `media_attachments` cascade) before the file, so a crash leaves an
/// orphan file rather than a row pointing at missing bytes. Unlink is best-effort
/// (a missing file is ignored).
///
/// No production consumer yet (no `media/delete` verb; orphan GC is a non-goal,
/// ADR-0058) — reached only by this module's tests, hence the fn-level allow.
#[allow(dead_code)]
pub(crate) async fn delete_media(pool: &SqlitePool, id: &str) -> sqlx::Result<()> {
    // Resolve the on-disk path before the row is gone.
    let storage_path = queries::media_by_id(pool, id)
        .await?
        .map(|columns| columns.2);
    let Some(storage_path) = storage_path else {
        return Ok(());
    };

    queries::delete_media(pool, id).await?;

    // The row is already gone, so the unlink is genuinely best-effort: returning an
    // error here would be falsely retryable (a re-`delete_media` finds no row and
    // no-ops), and ADR-0058 treats an orphan file as an accepted, recoverable state.
    // Swallow any unlink failure (missing file included).
    if let Ok(abs_path) = super::resolve_media_path(&storage_path) {
        let _ = std::fs::remove_file(&abs_path);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::db::test_support::memory_pool;
    use super::*;

    /// Point this thread's Config `media_dir_override` at `dir` for one test —
    /// hermetic and parallel-safe (see `crate::config::test_override`).
    /// `#[tokio::test]` runs its (current-thread) runtime on the installing
    /// thread, so the deep `insert_media` → `media_root` call stack sees the
    /// override.
    fn test_media_dir(dir: &std::path::Path) -> crate::config::test_override::ConfigGuard {
        crate::config::test_override::install(crate::config::Config {
            media_dir_override: Some(dir.to_path_buf()),
            ..Default::default()
        })
    }

    /// Build a user-authored `MediaInput` (`created_by='user'` so the
    /// provenance XOR holds without a proposal id).
    fn media_input() -> MediaInput {
        MediaInput {
            mime: "image/png".to_string(),
            width: None,
            height: None,
            created_by: "user".to_string(),
            created_via_proposal_id: None,
        }
    }

    #[tokio::test]
    async fn standalone_media_round_trips_bytes_and_deletes_file() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let _config = test_media_dir(tmp.path());

        let pool = memory_pool().await;
        let id = insert_media(
            &pool,
            b"hello",
            MediaInput {
                mime: "text/plain".to_string(),
                ..media_input()
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

        // `byte_size`/`digest` are integrity metadata: written, not read back
        // through `MediaRow` — assert the stored columns directly. Known sha-256
        // of "hello".
        let (byte_size, digest): (i64, String) =
            sqlx::query_as("SELECT byte_size, digest FROM media WHERE id = ?1")
                .bind(&id)
                .fetch_one(&pool)
                .await
                .expect("stored integrity columns");
        assert_eq!(byte_size, 5);
        assert_eq!(digest, sha256_hex(b"hello"));
        assert_eq!(
            digest,
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

    /// Seed a thread + run + one user message so a `message` attachment target
    /// resolves (mirrors observations_tests' `seed_message`).
    async fn seed_message(pool: &SqlitePool, message_id: &str) {
        let mut tx = pool.begin().await.expect("begin message seed");
        sqlx::query(
            "INSERT INTO threads (id, title, created_at, last_activity_at) \
             VALUES ('thread-media', 'Media Thread', 1, 1)",
        )
        .execute(&mut *tx)
        .await
        .expect("insert thread");
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, \
              thinking_level, user_message_id, status, started_at) \
             VALUES ('run-media', 'thread-media', 'w', '1', 'p', 'm', 'off', ?1, 'completed', 1)",
        )
        .bind(message_id)
        .execute(&mut *tx)
        .await
        .expect("insert run");
        sqlx::query(
            "INSERT INTO messages (id, thread_id, run_id, role, status, created_at, updated_at) \
             VALUES (?1, 'thread-media', 'run-media', 'user', 'completed', 1, 1)",
        )
        .bind(message_id)
        .execute(&mut *tx)
        .await
        .expect("insert message");
        tx.commit().await.expect("commit message seed");
    }

    /// Seed one entity of the given `entities.type` so an entity target column
    /// resolves.
    async fn seed_entity(pool: &SqlitePool, entity_id: &str, entity_type: &str) {
        sqlx::query(
            "INSERT INTO entities \
             (id, type, schema_version, data, created_by, created_at, updated_at) \
             VALUES (?1, ?2, 1, '{}', 'user', 1, 1)",
        )
        .bind(entity_id)
        .bind(entity_type)
        .execute(pool)
        .await
        .expect("insert entity");
    }

    /// Insert one `media_attachments` row linking `media_id` to a message —
    /// what the send path writes (`db::runs`' target_kind='message' insert).
    async fn link_to_message(pool: &SqlitePool, media_id: &str, message_id: &str) {
        sqlx::query(
            "INSERT INTO media_attachments \
             (id, media_id, target_kind, target_message_id, created_at) \
             VALUES (?1, ?2, 'message', ?3, 1)",
        )
        .bind(Uuid::now_v7().to_string())
        .bind(media_id)
        .bind(message_id)
        .execute(pool)
        .await
        .expect("insert media_attachments link");
    }

    /// The table CHECK rejects a forged row with zero targets and one with two
    /// targets (direct SQL, foreign keys + checks on via `memory_pool`).
    #[tokio::test]
    async fn media_attachments_check_rejects_zero_or_two_targets() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let _config = test_media_dir(tmp.path());

        let pool = memory_pool().await;
        let message_id = "018f0000-0000-7000-8000-0000000000c1";
        let entity_id = "018f0000-0000-7000-8000-0000000000c2";
        seed_message(&pool, message_id).await;
        seed_entity(&pool, entity_id, "person").await;
        let media_id = insert_media(&pool, b"bytes", media_input())
            .await
            .expect("insert standalone media");

        // Zero targets — discriminator says 'message' but no id is set.
        let err = sqlx::query(
            "INSERT INTO media_attachments \
             (id, media_id, target_kind, created_at) VALUES (?1, ?2, 'message', 1)",
        )
        .bind("attach-zero")
        .bind(&media_id)
        .execute(&pool)
        .await
        .expect_err("zero-target row fails the CHECK");
        assert!(err.to_string().contains("CHECK constraint failed"), "{err}");

        // Two targets — both an entity and a message id populated.
        let err = sqlx::query(
            "INSERT INTO media_attachments \
             (id, media_id, target_kind, target_entity_id, target_message_id, created_at) \
             VALUES (?1, ?2, 'message', ?3, ?4, 1)",
        )
        .bind("attach-two")
        .bind(&media_id)
        .bind(entity_id)
        .bind(message_id)
        .execute(&pool)
        .await
        .expect_err("two-target row fails the CHECK");
        assert!(err.to_string().contains("CHECK constraint failed"), "{err}");
    }

    /// `delete_media` cascades its attachment rows away and removes the file;
    /// deleting a linked target cascades only that link, leaving the media row
    /// intact (no orphan GC).
    #[tokio::test]
    async fn delete_cascades_links_in_both_directions_without_orphan_gc() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let _config = test_media_dir(tmp.path());

        let pool = memory_pool().await;

        // --- delete_media cascades the link + removes the file ---
        let message_id = "018f0000-0000-7000-8000-0000000000d1";
        seed_message(&pool, message_id).await;
        let media_id = insert_media(&pool, b"bytes", media_input())
            .await
            .expect("insert media");
        link_to_message(&pool, &media_id, message_id).await;
        let row = get_media(&pool, &media_id)
            .await
            .expect("get_media ok")
            .expect("media row present");
        let resolved =
            crate::db::resolve_media_path(&row.storage_path).expect("resolve path");
        assert!(resolved.exists(), "file written before delete");

        delete_media(&pool, &media_id).await.expect("delete media");
        let link_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM media_attachments WHERE media_id = ?1")
                .bind(&media_id)
                .fetch_one(&pool)
                .await
                .expect("count links");
        assert_eq!(link_count, 0, "delete_media cascades its attachment rows");
        assert!(
            std::fs::metadata(&resolved).is_err(),
            "delete_media removes the file"
        );

        // --- deleting a linked target cascades only the link, media survives ---
        let other_message = "018f0000-0000-7000-8000-0000000000d2";
        seed_message_other(&pool, other_message).await;
        let media_id2 = insert_media(&pool, b"bytes2", media_input())
            .await
            .expect("insert second media");
        link_to_message(&pool, &media_id2, other_message).await;

        // Delete the linked message. `runs.user_message_id` references it
        // (DEFERRABLE INITIALLY DEFERRED, no cascade), so drop the run in the
        // same transaction; the deferred FK is checked only at commit, by
        // which point both are gone. The message deletion is what cascades
        // the `media_attachments` link via `target_message_id ON DELETE CASCADE`.
        let mut tx = pool.begin().await.expect("begin target delete");
        sqlx::query("DELETE FROM runs WHERE id = 'run-media-2'")
            .execute(&mut *tx)
            .await
            .expect("delete linked run");
        sqlx::query("DELETE FROM messages WHERE id = ?1")
            .bind(other_message)
            .execute(&mut *tx)
            .await
            .expect("delete linked message");
        tx.commit().await.expect("commit target delete");

        let link_count2: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM media_attachments WHERE media_id = ?1")
                .bind(&media_id2)
                .fetch_one(&pool)
                .await
                .expect("count links after target delete");
        assert_eq!(link_count2, 0, "deleting the target cascades its link away");
        assert!(
            get_media(&pool, &media_id2)
                .await
                .expect("get_media ok")
                .is_some(),
            "the media row survives its last link being deleted (no orphan GC)"
        );
    }

    /// A second thread + run + message so a test can delete one linked message
    /// without disturbing the first `seed_message` thread.
    async fn seed_message_other(pool: &SqlitePool, message_id: &str) {
        let mut tx = pool.begin().await.expect("begin message seed");
        sqlx::query(
            "INSERT INTO threads (id, title, created_at, last_activity_at) \
             VALUES ('thread-media-2', 'Media Thread 2', 1, 1)",
        )
        .execute(&mut *tx)
        .await
        .expect("insert thread");
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, \
              thinking_level, user_message_id, status, started_at) \
             VALUES ('run-media-2', 'thread-media-2', 'w', '1', 'p', 'm', 'off', ?1, 'completed', 1)",
        )
        .bind(message_id)
        .execute(&mut *tx)
        .await
        .expect("insert run");
        sqlx::query(
            "INSERT INTO messages (id, thread_id, run_id, role, status, created_at, updated_at) \
             VALUES (?1, 'thread-media-2', 'run-media-2', 'user', 'completed', 1, 1)",
        )
        .bind(message_id)
        .execute(&mut *tx)
        .await
        .expect("insert message");
        tx.commit().await.expect("commit message seed");
    }

    /// `resolve_media_path` keeps a stored path under the media root: a bare-UUID
    /// `storage_path` (what `insert_media` writes) resolves inside the root, while
    /// an absolute path or a `..` traversal — only reachable via a corrupted row —
    /// is rejected rather than silently escaping it.
    #[test]
    fn resolve_media_path_rejects_escaping_storage_path() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let _config = test_media_dir(tmp.path());

        // A bare UUID (the only thing insert_media stores) resolves under root.
        let ok = crate::db::resolve_media_path("018f0000-0000-7000-8000-0000000000aa")
            .expect("bare-uuid path resolves");
        assert!(
            ok.starts_with(tmp.path()),
            "resolved path stays under the media root"
        );

        // A traversal or absolute path is rejected, never joined.
        for escaping in ["../escape", "../../etc/passwd", "/etc/passwd", "a/../../b"] {
            assert!(
                crate::db::resolve_media_path(escaping).is_err(),
                "escaping storage_path {escaping:?} must be rejected"
            );
        }
    }
}
