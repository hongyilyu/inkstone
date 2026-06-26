//! The three mutating Thread verbs (ADR-0052): `thread/rename`,
//! `thread/archive`, `thread/unarchive`. Each routes through the request-handler
//! combinator (ADR-0029): decode params → verify the Thread exists
//! (`db::thread_exists`) → reject an unknown Thread with `UnknownThread`
//! (`-32001`) writing ZERO rows → else perform the slice-1 DB op and frame a
//! shared `ThreadMutateResult { thread_id }` ack.
//!
//! `thread/rename` additionally trims the new title and rejects an empty/
//! whitespace one with `InvalidParams` (`-32602`) BEFORE the existence check —
//! the cheaper guard first, and an empty title is malformed regardless of which
//! Thread it targets. Rename does NOT bump `last_activity_at` (titling is not
//! activity, ADR-0046/0052) — the `db::update_thread_title` helper it wraps
//! already holds that invariant.
//!
//! These verbs deliberately diverge from `db::update_thread_title`'s silent
//! no-op-on-missing-row behaviour: a user-initiated RPC on a just-listed Thread
//! that finds no row is a genuine desync, so the verb wraps the helper with a
//! check-then-act guard (ADR-0052).

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;
use uuid::Uuid;

use super::handler::{self, HandlerError};
use crate::db;
use crate::protocol::{
    ThreadArchiveParams, ThreadMutateResult, ThreadRenameParams, ThreadUnarchiveParams,
};

/// Reject an unknown Thread with `UnknownThread` (-32001) BEFORE any write — the
/// shared check-then-act guard the three verbs use (ADR-0052). On a real Thread
/// this is a no-op.
async fn ensure_thread(pool: &SqlitePool, thread_id: Uuid) -> Result<(), HandlerError> {
    let exists = db::thread_exists(pool, thread_id)
        .await
        .map_err(|e| HandlerError::Internal(e.into()))?;
    if exists {
        Ok(())
    } else {
        Err(HandlerError::UnknownThread(thread_id))
    }
}

pub(super) async fn handle_rename(
    pool: &SqlitePool,
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    handler::handle(id, params, out_tx, |p: ThreadRenameParams| async move {
        // Title guard first — cheaper, and an empty title is malformed regardless
        // of which Thread it targets (ADR-0052).
        let title = p.title.trim();
        if title.is_empty() {
            return Err(HandlerError::InvalidParams(
                "title must not be empty".to_string(),
            ));
        }
        ensure_thread(pool, p.thread_id).await?;
        db::update_thread_title(pool, p.thread_id, title)
            .await
            .map_err(|e| HandlerError::Internal(e.into()))?;
        Ok(ThreadMutateResult {
            thread_id: p.thread_id.to_string(),
        })
    })
    .await;
}

pub(super) async fn handle_archive(
    pool: &SqlitePool,
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    handler::handle(id, params, out_tx, |p: ThreadArchiveParams| async move {
        ensure_thread(pool, p.thread_id).await?;
        db::archive_thread(pool, p.thread_id, db::now_ms())
            .await
            .map_err(|e| HandlerError::Internal(e.into()))?;
        Ok(ThreadMutateResult {
            thread_id: p.thread_id.to_string(),
        })
    })
    .await;
}

pub(super) async fn handle_unarchive(
    pool: &SqlitePool,
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    handler::handle(id, params, out_tx, |p: ThreadUnarchiveParams| async move {
        ensure_thread(pool, p.thread_id).await?;
        db::unarchive_thread(pool, p.thread_id)
            .await
            .map_err(|e| HandlerError::Internal(e.into()))?;
        Ok(ThreadMutateResult {
            thread_id: p.thread_id.to_string(),
        })
    })
    .await;
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};
    use sqlx::SqlitePool;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use tokio::sync::mpsc;
    use uuid::Uuid;

    /// A migrated in-memory pool (mirrors the `journal_entry` test helper) so the
    /// `threads` schema + `archived_at` column hold.
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

    /// Seed an ACTIVE Thread row (raw SQL — `db::insert_thread` is db-internal).
    async fn seed_thread(pool: &SqlitePool, id: Uuid, title: &str) {
        sqlx::query(
            "INSERT INTO threads (id, title, created_at, last_activity_at) \
             VALUES (?, ?, 1, 1)",
        )
        .bind(id.to_string())
        .bind(title)
        .execute(pool)
        .await
        .expect("insert thread");
    }

    async fn thread_count(pool: &SqlitePool) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM threads")
            .fetch_one(pool)
            .await
            .expect("count threads")
    }

    async fn archived_count(pool: &SqlitePool) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM threads WHERE archived_at IS NOT NULL")
            .fetch_one(pool)
            .await
            .expect("count archived threads")
    }

    async fn title_of(pool: &SqlitePool, id: Uuid) -> String {
        sqlx::query_scalar("SELECT title FROM threads WHERE id = ?")
            .bind(id.to_string())
            .fetch_one(pool)
            .await
            .expect("read title")
    }

    fn recv_json(rx: &mut mpsc::UnboundedReceiver<String>) -> Value {
        let line = rx.try_recv().expect("a frame was queued");
        serde_json::from_str(&line).expect("frame is JSON")
    }

    /// Archiving an unknown Thread frames `unknown_thread` (-32001) and writes
    /// nothing — the existence guard rejects before the DB op (ADR-0052).
    #[tokio::test]
    async fn archive_unknown_thread_frames_invalid_thread() {
        let pool = memory_pool().await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let unknown = "0190d3c1-0000-7000-8000-000000000099";

        super::handle_archive(&pool, json!(1), json!({ "thread_id": unknown }), &tx).await;

        let v = recv_json(&mut rx);
        assert_eq!(v["error"]["code"], json!(-32001));
        assert!(v.get("result").is_none());
        assert_eq!(archived_count(&pool).await, 0, "no Thread archived");
    }

    /// Archiving a real Thread acks its id (no -32001), and the archived Thread
    /// then appears in `thread/list_archived`'s `ThreadListResult`.
    #[tokio::test]
    async fn archive_then_list_archived() {
        let pool = memory_pool().await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let id = Uuid::now_v7();
        seed_thread(&pool, id, "Plans").await;

        super::handle_archive(&pool, json!(1), json!({ "thread_id": id.to_string() }), &tx).await;

        let v = recv_json(&mut rx);
        assert!(v.get("error").is_none(), "archive of a real Thread succeeds");
        assert_eq!(v["result"]["thread_id"], json!(id.to_string()));
        assert_eq!(archived_count(&pool).await, 1, "the Thread is archived");

        // The archived list now carries it.
        let (tx2, mut rx2) = mpsc::unbounded_channel();
        super::super::thread_list_archived::handle(&pool, json!(2), json!(null), &tx2).await;
        let listed = recv_json(&mut rx2);
        let threads = listed["result"]["threads"]
            .as_array()
            .expect("threads array");
        assert_eq!(threads.len(), 1, "one archived Thread listed");
        assert_eq!(threads[0]["id"], json!(id.to_string()));
    }

    /// Renaming with a whitespace-only title frames `invalid_params` (-32602)
    /// BEFORE any write — the title is unchanged.
    #[tokio::test]
    async fn rename_empty_title_frames_invalid_params() {
        let pool = memory_pool().await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let id = Uuid::now_v7();
        seed_thread(&pool, id, "Original").await;

        super::handle_rename(
            &pool,
            json!(1),
            json!({ "thread_id": id.to_string(), "title": "   " }),
            &tx,
        )
        .await;

        let v = recv_json(&mut rx);
        assert_eq!(v["error"]["code"], json!(-32602));
        assert_eq!(title_of(&pool, id).await, "Original", "title unchanged");
    }

    /// Renaming a real Thread overwrites its title and acks the id.
    #[tokio::test]
    async fn rename_overwrites_title_and_acks() {
        let pool = memory_pool().await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let id = Uuid::now_v7();
        seed_thread(&pool, id, "Original").await;

        super::handle_rename(
            &pool,
            json!(1),
            json!({ "thread_id": id.to_string(), "title": "  Renamed thread  " }),
            &tx,
        )
        .await;

        let v = recv_json(&mut rx);
        assert!(v.get("error").is_none(), "rename of a real Thread succeeds");
        assert_eq!(v["result"]["thread_id"], json!(id.to_string()));
        // The title is trimmed before the write.
        assert_eq!(title_of(&pool, id).await, "Renamed thread");
    }

    /// Renaming an unknown Thread frames `unknown_thread` (-32001) — a non-blank
    /// title gets past the title guard, so the existence check is what rejects.
    #[tokio::test]
    async fn rename_unknown_thread_frames_invalid_thread() {
        let pool = memory_pool().await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let unknown = "0190d3c1-0000-7000-8000-000000000099";

        super::handle_rename(
            &pool,
            json!(1),
            json!({ "thread_id": unknown, "title": "New name" }),
            &tx,
        )
        .await;

        let v = recv_json(&mut rx);
        assert_eq!(v["error"]["code"], json!(-32001));
        assert_eq!(thread_count(&pool).await, 0, "no Thread row created");
    }

    /// Unarchiving an unknown Thread frames `unknown_thread` (-32001).
    #[tokio::test]
    async fn unarchive_unknown_thread_frames_invalid_thread() {
        let pool = memory_pool().await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let unknown = "0190d3c1-0000-7000-8000-000000000099";

        super::handle_unarchive(&pool, json!(1), json!({ "thread_id": unknown }), &tx).await;

        let v = recv_json(&mut rx);
        assert_eq!(v["error"]["code"], json!(-32001));
    }
}
