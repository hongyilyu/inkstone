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
        // Validate each attachment target exists (and, for an Entity with an
        // expected type, is that type) IN THIS TX — the FK existence reads see
        // the just-inserted `media` row and any prior loop inserts via the same
        // `&mut *tx` executor. A miss returns `Err`, rolling the tx back so the
        // already-written file is unlinked by the arm below (no orphan row).
        for target in &input.attachments {
            validate_target(&mut *tx, target).await?;
            let (target_kind, entity_id, message_id, observation_id, proposal_id) =
                target_columns(target);
            queries::insert_media_attachment(
                &mut *tx,
                &Uuid::now_v7().to_string(),
                &id,
                target_kind,
                entity_id,
                message_id,
                observation_id,
                proposal_id,
                now,
            )
            .await?;
        }
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

/// Confirm an attachment target row exists (and, for a typed Entity, is the
/// expected type) using the in-flight transaction's executor — mirrors
/// `insert_observations_in_tx`'s source validation. A miss is
/// `MediaInsertError::InvalidTarget`, naming the kind + id so the rollback
/// surfaces a clear reason.
async fn validate_target<'e, E>(
    executor: E,
    target: &MediaAttachmentTarget,
) -> Result<(), MediaInsertError>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    let ok = match target {
        MediaAttachmentTarget::Entity {
            id,
            expected_type: Some(expected),
        } => queries::entity_is_type(executor, id, expected.as_str()).await?,
        MediaAttachmentTarget::Entity {
            id,
            expected_type: None,
        } => queries::entity_exists(executor, id).await?,
        MediaAttachmentTarget::Message { id } => queries::message_exists(executor, id).await?,
        MediaAttachmentTarget::Observation { id } => {
            queries::observation_exists(executor, id).await?
        }
        MediaAttachmentTarget::Proposal { id } => queries::proposal_exists(executor, id).await?,
    };
    if ok {
        return Ok(());
    }
    Err(MediaInsertError::InvalidTarget(invalid_target_reason(target)))
}

/// A clear miss reason naming the target kind and id (Entity with an expected
/// type also names the type it had to match).
fn invalid_target_reason(target: &MediaAttachmentTarget) -> String {
    match target {
        MediaAttachmentTarget::Entity {
            id,
            expected_type: Some(expected),
        } => format!(
            "media attachment target entity {id} must name an existing {} entity",
            expected.as_str()
        ),
        MediaAttachmentTarget::Entity {
            id,
            expected_type: None,
        } => format!("media attachment target entity {id} must name an existing entity"),
        MediaAttachmentTarget::Message { id } => {
            format!("media attachment target message {id} must name an existing message")
        }
        MediaAttachmentTarget::Observation { id } => {
            format!("media attachment target observation {id} must name an existing observation")
        }
        MediaAttachmentTarget::Proposal { id } => {
            format!("media attachment target proposal {id} must name an existing proposal")
        }
    }
}

/// Map a target to its stored `target_kind` plus the one populated target id
/// column (the other three stay `None` — the table CHECK enforces this).
fn target_columns(
    target: &MediaAttachmentTarget,
) -> (
    &'static str,
    Option<&str>,
    Option<&str>,
    Option<&str>,
    Option<&str>,
) {
    match target {
        MediaAttachmentTarget::Entity { id, .. } => {
            ("entity", Some(id.as_str()), None, None, None)
        }
        MediaAttachmentTarget::Message { id } => {
            ("message", None, Some(id.as_str()), None, None)
        }
        MediaAttachmentTarget::Observation { id } => {
            ("observation", None, None, Some(id.as_str()), None)
        }
        MediaAttachmentTarget::Proposal { id } => {
            ("proposal", None, None, None, Some(id.as_str()))
        }
    }
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

    /// Seed a thread + run + one user message so a `Message` attachment target
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

    /// Seed one entity of the given `entities.type` so an `Entity` attachment
    /// target resolves.
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

    /// Build a `MediaInput` carrying the given attachment targets. `created_by`
    /// is `'user'` so the provenance XOR holds without a proposal id.
    fn media_input(attachments: Vec<MediaAttachmentTarget>) -> MediaInput {
        MediaInput {
            mime: "image/png".to_string(),
            width: None,
            height: None,
            duration_ms: None,
            capture_time: None,
            thumbnail_path: None,
            created_by: "user".to_string(),
            created_via_proposal_id: None,
            attachments,
        }
    }

    #[tokio::test]
    async fn insert_media_links_each_attachment_target() {
        let _guard = MEDIA_ENV_GUARD.lock().unwrap_or_else(|p| p.into_inner());
        let tmp = tempfile::tempdir().expect("tempdir");
        unsafe {
            std::env::set_var("INKSTONE_MEDIA_DIR", tmp.path());
        }

        let result = async {
            let pool = memory_pool().await;
            let message_id = "018f0000-0000-7000-8000-0000000000a1";
            let entity_id = "018f0000-0000-7000-8000-0000000000a2";
            seed_message(&pool, message_id).await;
            seed_entity(&pool, entity_id, EntityType::Person.as_str()).await;

            let media_id = insert_media(
                &pool,
                b"bytes",
                media_input(vec![
                    MediaAttachmentTarget::Message {
                        id: message_id.to_string(),
                    },
                    MediaAttachmentTarget::Entity {
                        id: entity_id.to_string(),
                        expected_type: Some(EntityType::Person),
                    },
                ]),
            )
            .await
            .expect("insert media with attachments");

            // One row per target, each tagged with the right kind and the single
            // populated target column.
            let rows: Vec<(String, Option<String>, Option<String>, Option<String>, Option<String>)> =
                sqlx::query_as(
                    "SELECT target_kind, target_entity_id, target_message_id, \
                     target_observation_id, target_proposal_id \
                     FROM media_attachments WHERE media_id = ?1 \
                     ORDER BY target_kind",
                )
                .bind(&media_id)
                .fetch_all(&pool)
                .await
                .expect("select attachments");
            assert_eq!(rows.len(), 2, "one media_attachments row per target");

            // ORDER BY target_kind: 'entity' before 'message'.
            assert_eq!(rows[0].0, "entity");
            assert_eq!(rows[0].1.as_deref(), Some(entity_id));
            assert_eq!(rows[0].2, None);
            assert_eq!(rows[0].3, None);
            assert_eq!(rows[0].4, None);

            assert_eq!(rows[1].0, "message");
            assert_eq!(rows[1].2.as_deref(), Some(message_id));
            assert_eq!(rows[1].1, None);
            assert_eq!(rows[1].3, None);
            assert_eq!(rows[1].4, None);
        }
        .await;

        unsafe {
            std::env::remove_var("INKSTONE_MEDIA_DIR");
        }
        result
    }

    /// A bad target (missing message / wrong entity type) rolls the whole insert
    /// back: `InvalidTarget`, no `media` row, and no orphan file on disk.
    #[tokio::test]
    async fn insert_media_rejects_invalid_target_without_orphan() {
        let _guard = MEDIA_ENV_GUARD.lock().unwrap_or_else(|p| p.into_inner());
        let tmp = tempfile::tempdir().expect("tempdir");
        unsafe {
            std::env::set_var("INKSTONE_MEDIA_DIR", tmp.path());
        }

        let result = async {
            let pool = memory_pool().await;
            let person_id = "018f0000-0000-7000-8000-0000000000b1";
            seed_entity(&pool, person_id, EntityType::Person.as_str()).await;

            // (1) A message target naming no existing message.
            let err = insert_media(
                &pool,
                b"orphan-a",
                media_input(vec![MediaAttachmentTarget::Message {
                    id: "no-such-message".to_string(),
                }]),
            )
            .await
            .expect_err("missing message target is rejected");
            assert!(matches!(err, MediaInsertError::InvalidTarget(_)), "{err:?}");

            // (2) An entity that exists but is the wrong type.
            let err = insert_media(
                &pool,
                b"orphan-b",
                media_input(vec![MediaAttachmentTarget::Entity {
                    id: person_id.to_string(),
                    expected_type: Some(EntityType::JournalEntry),
                }]),
            )
            .await
            .expect_err("wrong-type entity target is rejected");
            assert!(matches!(err, MediaInsertError::InvalidTarget(_)), "{err:?}");

            // No media row landed for either failed insert, and the media root
            // holds no orphan files (each failed insert unlinked its bytes).
            let media_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM media")
                .fetch_one(&pool)
                .await
                .expect("count media");
            assert_eq!(media_count, 0, "no media row survives a rejected insert");

            let stray = std::fs::read_dir(tmp.path())
                .expect("read media root")
                .count();
            assert_eq!(stray, 0, "no orphan file remains after a rejected insert");
        }
        .await;

        unsafe {
            std::env::remove_var("INKSTONE_MEDIA_DIR");
        }
        result
    }

    /// The table CHECK rejects a forged row with zero targets and one with two
    /// targets (direct SQL, foreign keys + checks on via `memory_pool`).
    #[tokio::test]
    async fn media_attachments_check_rejects_zero_or_two_targets() {
        let _guard = MEDIA_ENV_GUARD.lock().unwrap_or_else(|p| p.into_inner());
        let tmp = tempfile::tempdir().expect("tempdir");
        unsafe {
            std::env::set_var("INKSTONE_MEDIA_DIR", tmp.path());
        }

        let result = async {
            let pool = memory_pool().await;
            let message_id = "018f0000-0000-7000-8000-0000000000c1";
            let entity_id = "018f0000-0000-7000-8000-0000000000c2";
            seed_message(&pool, message_id).await;
            seed_entity(&pool, entity_id, EntityType::Person.as_str()).await;
            let media_id = insert_media(&pool, b"bytes", media_input(Vec::new()))
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
        .await;

        unsafe {
            std::env::remove_var("INKSTONE_MEDIA_DIR");
        }
        result
    }

    /// `delete_media` cascades its attachment rows away and removes the file;
    /// deleting a linked target cascades only that link, leaving the media row
    /// intact (no orphan GC).
    #[tokio::test]
    async fn delete_cascades_links_in_both_directions_without_orphan_gc() {
        let _guard = MEDIA_ENV_GUARD.lock().unwrap_or_else(|p| p.into_inner());
        let tmp = tempfile::tempdir().expect("tempdir");
        unsafe {
            std::env::set_var("INKSTONE_MEDIA_DIR", tmp.path());
        }

        let result = async {
            let pool = memory_pool().await;

            // --- delete_media cascades the link + removes the file ---
            let message_id = "018f0000-0000-7000-8000-0000000000d1";
            seed_message(&pool, message_id).await;
            let media_id = insert_media(
                &pool,
                b"bytes",
                media_input(vec![MediaAttachmentTarget::Message {
                    id: message_id.to_string(),
                }]),
            )
            .await
            .expect("insert media with one attachment");
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
            let media_id2 = insert_media(
                &pool,
                b"bytes2",
                media_input(vec![MediaAttachmentTarget::Message {
                    id: other_message.to_string(),
                }]),
            )
            .await
            .expect("insert second media with attachment");

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
        .await;

        unsafe {
            std::env::remove_var("INKSTONE_MEDIA_DIR");
        }
        result
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
}
