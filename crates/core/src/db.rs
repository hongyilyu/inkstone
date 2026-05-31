//! SQLite tier-2 storage (ADR-0017). Resolves the DB path, opens a pool,
//! and runs the embedded migration. The pool is the durable home for
//! Threads, Runs, Messages, Run Events, Tool Calls, Proposals, and
//! Entities.

use std::path::PathBuf;

use anyhow::{Context, Result};
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use uuid::Uuid;

/// Resolve the DB path: `INKSTONE_DB_PATH` env override wins; otherwise
/// land on `<OS data dir>/inkstone/db.sqlite` (e.g. macOS:
/// `~/Library/Application Support/inkstone/db.sqlite`).
fn resolve_db_path() -> Result<PathBuf> {
    if let Some(env) = std::env::var_os("INKSTONE_DB_PATH") {
        return Ok(PathBuf::from(env));
    }
    let dirs = directories::ProjectDirs::from("", "", "inkstone")
        .context("could not resolve OS data directory for inkstone")?;
    Ok(dirs.data_dir().join("db.sqlite"))
}

/// Open the SQLite pool, creating the file (and parent dir) if missing,
/// and run the bundled migration. Returns a pool ready for queries.
pub async fn open() -> Result<SqlitePool> {
    let path = resolve_db_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create parent dir {}", parent.display()))?;
    }

    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await
        .with_context(|| format!("open SQLite pool at {}", path.display()))?;

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .context("run SQLite migrations")?;

    Ok(pool)
}

/// Return the default Thread's id, lazy-minting one row in `threads` the
/// first time we're called against a fresh DB. The skeleton has a single
/// implicit Thread; real Thread CRUD lands in a future feature.
///
/// Note: the SELECT and INSERT run on the pool directly, not inside the
/// caller's transaction. Two concurrent first-time `run/post_message`
/// callers could each miss the other's INSERT and both insert. For the
/// MVP single-user single-process model this race is theoretical (one
/// WS frame at a time per connection); the eventual fix is an
/// `is_default` flag with `INSERT … ON CONFLICT DO NOTHING`.
pub async fn ensure_default_thread(pool: &SqlitePool, now_ms: i64) -> sqlx::Result<Uuid> {
    if let Some((id_str,)) = sqlx::query_as::<_, (String,)>(
        "SELECT id FROM threads ORDER BY created_at ASC LIMIT 1",
    )
    .fetch_optional(pool)
    .await?
    {
        return Ok(Uuid::parse_str(&id_str).expect("threads.id is a valid UUID"));
    }
    let id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO threads (id, title, created_at, last_activity_at) \
         VALUES (?, 'Untitled', ?, ?)",
    )
    .bind(id.to_string())
    .bind(now_ms)
    .bind(now_ms)
    .execute(pool)
    .await?;
    Ok(id)
}
