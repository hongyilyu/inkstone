//! Media storage facade (ADR-0058). SQL stays in `queries`, matching the DB
//! module's one-statement query convention; this module owns the media storage
//! shapes, the bytes-on-disk write/unlink ordering, and the transaction boundary.
//!
//! The binary lives on disk under [`crate::db::media_root`]; SQLite stores only
//! the relative `storage_path` (a bare random-UUID filename in a flat root, no
//! extension). `insert_media` writes the file first, then the row in a
//! transaction, and unlinks the file if the transaction fails; `delete_media`
//! deletes the row first (committing the `media_attachments` cascade), then
//! unlinks the file. Both orderings lean toward a recoverable
//! orphan-file-on-disk over a row pointing at missing bytes.

use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::queries;
use crate::mutation::EntityType;

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

/// A fully-specified media create request. The caller supplies `mime`,
/// dimensions, capture time, and provenance; Core computes only `byte_size` and
/// `digest` from the bytes (ADR-0058 §Scope boundary — no mime sniffing, no
/// dimension extraction). `attachments` may be empty (standalone media) or carry
/// targets, each validated and linked in `insert_media`'s write transaction.
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

/// One polymorphic attachment target — a media row links to exactly one of these
/// (ADR-0058). `insert_media` validates each target's existence (and, for a typed
/// Entity, its type) in the write transaction before inserting the link row.
///
/// The variants have no production constructor yet: `media/upload` passes
/// `attachments: Vec::new()` (the send path links targets in a later slice), so
/// only this module's tests build them — hence the allow.
#[allow(dead_code)]
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
///
/// Production reads `mime` + `storage_path` (the `GET /media/{id}` route) and
/// `id`/`mime`/`width`/`height` (the send-path attachment validation copies them
/// into `AttachmentSeed`s); the remaining metadata columns are read only by this
/// module's tests and await their consumers — the field-level allows name
/// exactly those, so a new production read must drop its allow.
pub(crate) struct MediaRow {
    pub id: String,
    pub mime: String,
    #[allow(dead_code)]
    pub byte_size: i64,
    #[allow(dead_code)]
    pub digest: String,
    pub storage_path: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    #[allow(dead_code)]
    pub duration_ms: Option<i64>,
    #[allow(dead_code)]
    pub capture_time: Option<i64>,
    #[allow(dead_code)]
    pub thumbnail_path: Option<String>,
    #[allow(dead_code)]
    pub created_by: String,
    #[allow(dead_code)]
    pub created_via_proposal_id: Option<String>,
    #[allow(dead_code)]
    pub created_at: i64,
    #[allow(dead_code)]
    pub updated_at: i64,
}

// The variant payloads are read only through `Debug` (the upload handler wraps
// the whole error into `HandlerError::Internal`), which dead-code analysis
// deliberately ignores — hence the allow on the payload-carrying variants.
#[allow(dead_code)]
#[derive(Debug)]
pub(crate) enum MediaInsertError {
    /// An attachment target does not exist or is the wrong type (rejected in the
    /// write transaction, rolling back the insert).
    InvalidTarget(String),
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

    // File first, so a row never points at missing bytes (ADR-0058).
    let abs_path = super::resolve_media_path(&storage_path).map_err(to_io)?;
    std::fs::create_dir_all(super::media_root().map_err(to_io)?).map_err(MediaInsertError::Io)?;
    // `fs::write` creates+truncates before writing, so a mid-write failure can
    // leave a partial file. Unlink it before bailing — symmetric with the
    // tx-failure arm below, so no write failure path leaves an orphan.
    if let Err(err) = std::fs::write(&abs_path, bytes) {
        let _ = std::fs::remove_file(&abs_path);
        return Err(MediaInsertError::Io(err));
    }

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

/// Coerce a media-root resolution failure (an `anyhow::Error` from `media_root`/
/// `resolve_media_path`, e.g. an unresolvable data dir) into the `Io` variant —
/// it is a "the bytes can't be placed on disk" failure, the same class as the
/// `std::fs` errors that flow straight into [`MediaInsertError::Io`].
fn to_io<E: Into<Box<dyn std::error::Error + Send + Sync>>>(err: E) -> MediaInsertError {
    MediaInsertError::Io(std::io::Error::other(err))
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
/// the future `media_attachments` cascade) before the file, so a crash leaves an
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
        .map(|columns| columns.4);
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

    /// Seed a standalone user Observation so an `Observation` attachment target
    /// resolves (`created_by='user'`, so the observations XOR needs no proposal).
    async fn seed_observation(pool: &SqlitePool, observation_id: &str) {
        sqlx::query(
            "INSERT INTO observations \
             (id, schema_key, schema_version, occurred_at, values_json, \
              created_by, created_at, updated_at) \
             VALUES (?1, 'bodyweight', 1, '2026-01-01T00:00:00', '{\"kg\":70}', 'user', 1, 1)",
        )
        .bind(observation_id)
        .execute(pool)
        .await
        .expect("insert observation");
    }

    /// Seed a Proposal so a `Proposal` attachment target resolves. A Proposal is a
    /// sidecar of a `tool_call`, which needs a `run` + `thread`; reuse the
    /// `seed_message` thread/run so the `tool_calls.run_id` FK resolves.
    async fn seed_proposal(pool: &SqlitePool, proposal_id: &str) {
        let mut tx = pool.begin().await.expect("begin proposal seed");
        sqlx::query(
            "INSERT INTO tool_calls (id, run_id, name, request_payload, status, requested_at) \
             VALUES ('tc-media', 'run-media', 'propose_create_entities', '{}', 'pending', 1)",
        )
        .execute(&mut *tx)
        .await
        .expect("insert tool_call");
        sqlx::query(
            "INSERT INTO proposals (id, tool_call_id, mutation_kind, status) \
             VALUES (?1, 'tc-media', 'create_todo', 'pending')",
        )
        .bind(proposal_id)
        .execute(&mut *tx)
        .await
        .expect("insert proposal");
        tx.commit().await.expect("commit proposal seed");
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
        let tmp = tempfile::tempdir().expect("tempdir");
        let _config = test_media_dir(tmp.path());

        let pool = memory_pool().await;
        let message_id = "018f0000-0000-7000-8000-0000000000a1";
        let entity_id = "018f0000-0000-7000-8000-0000000000a2";
        let observation_id = "018f0000-0000-7000-8000-0000000000a3";
        let proposal_id = "018f0000-0000-7000-8000-0000000000a4";
        seed_message(&pool, message_id).await;
        seed_entity(&pool, entity_id, EntityType::Person.as_str()).await;
        seed_observation(&pool, observation_id).await;
        seed_proposal(&pool, proposal_id).await;

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
                MediaAttachmentTarget::Observation {
                    id: observation_id.to_string(),
                },
                MediaAttachmentTarget::Proposal {
                    id: proposal_id.to_string(),
                },
            ]),
        )
        .await
        .expect("insert media with attachments");

        // One row per target, each tagged with the right kind and exactly the
        // single matching target column populated (every discriminator covered).
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
        assert_eq!(rows.len(), 4, "one media_attachments row per target");

        // ORDER BY target_kind: entity, message, observation, proposal. Each row
        // has its own column set and all three others NULL.
        assert_eq!(rows[0].0, "entity");
        assert_eq!(
            (rows[0].1.as_deref(), &rows[0].2, &rows[0].3, &rows[0].4),
            (Some(entity_id), &None, &None, &None)
        );
        assert_eq!(rows[1].0, "message");
        assert_eq!(
            (&rows[1].1, rows[1].2.as_deref(), &rows[1].3, &rows[1].4),
            (&None, Some(message_id), &None, &None)
        );
        assert_eq!(rows[2].0, "observation");
        assert_eq!(
            (&rows[2].1, &rows[2].2, rows[2].3.as_deref(), &rows[2].4),
            (&None, &None, Some(observation_id), &None)
        );
        assert_eq!(rows[3].0, "proposal");
        assert_eq!(
            (&rows[3].1, &rows[3].2, &rows[3].3, rows[3].4.as_deref()),
            (&None, &None, &None, Some(proposal_id))
        );
    }

    /// A bad target (missing message / wrong entity type) rolls the whole insert
    /// back: `InvalidTarget`, no `media` row, and no orphan file on disk.
    #[tokio::test]
    async fn insert_media_rejects_invalid_target_without_orphan() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let _config = test_media_dir(tmp.path());

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
