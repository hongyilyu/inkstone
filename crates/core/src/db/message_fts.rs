//! Message full-text search: the tier-3 `message_fts` projection (ADR-0035).
//!
//! `message_fts` indexes the text of every `completed` Message. User text is
//! complete at Run creation, so it is indexed at the `persist_initial_run` seam
//! (see [`super::insert_initial_run_rows`]); assistant text is indexed at Run
//! completion (slice 2). The projection is tier-3 (ADR-0004) — re-derivable from
//! `message_parts` via [`rebuild_message_fts`], which Core runs on every open.

use sqlx::{Executor, Sqlite, SqlitePool};

use super::queries;

/// One message search hit (ADR-0035): enough to render a result and navigate to
/// the source Thread. Core-internal this slice; the `message/search` handler that
/// consumes it (and the mirrored wire types) lands in slice 3 — uncalled until
/// then, like the GTD read layer in [`super`].
#[allow(dead_code)]
pub struct MessageHit {
    pub message_id: String,
    pub thread_id: String,
    pub run_id: String,
    pub role: String,
    pub snippet: String,
    pub thread_title: String,
    pub created_at: i64,
}

/// Index one Message's text into `message_fts` within the caller's executor
/// (a transaction at the user-create seam, the pool during a rebuild). Empty
/// text is skipped — an empty row would match no substring query and only add
/// noise. Used by [`super::insert_initial_run_rows`] and [`rebuild_message_fts`].
pub(super) async fn index_message<'e, E>(
    executor: E,
    message_id: &str,
    thread_id: &str,
    run_id: &str,
    role: &str,
    text: &str,
) -> sqlx::Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    if text.is_empty() {
        return Ok(());
    }
    queries::insert_message_fts_row(executor, message_id, thread_id, run_id, role, text).await
}

/// Substring-search the message index (ADR-0035): a case-insensitive
/// `LIKE '%query%'` over `message_fts.text`, newest-first, with the snippet
/// rendered in SQL (`instr`/`substr`) around the first match. Wired to the
/// `message/search` handler in slice 3; uncalled until then.
#[allow(dead_code)]
pub async fn search_messages(pool: &SqlitePool, query: &str) -> sqlx::Result<Vec<MessageHit>> {
    let rows = queries::search_messages(pool, query).await?;
    Ok(rows
        .into_iter()
        .map(
            |(message_id, thread_id, run_id, role, snippet, thread_title, created_at)| MessageHit {
                message_id,
                thread_id,
                run_id,
                role,
                snippet,
                thread_title,
                created_at,
            },
        )
        .collect())
}

/// Rebuild `message_fts` from tier-2 `message_parts` (ADR-0035): wipe the table
/// and re-index every `completed` Message's assembled text via the canonical
/// `text_parts_by_message` concat (the path `history_for_run` uses). Run on every
/// Core open so an existing DB backfills and any drift self-heals — the
/// projection is honestly tier-3 (ADR-0004): delete it and it comes back.
pub async fn rebuild_message_fts(pool: &SqlitePool) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;
    queries::clear_message_fts(&mut *tx).await?;
    let messages = queries::completed_messages_for_fts(&mut *tx).await?;
    for (message_id, thread_id, run_id, role) in messages {
        let text = queries::text_parts_by_message(&mut *tx, &message_id)
            .await?
            .concat();
        index_message(&mut *tx, &message_id, &thread_id, &run_id, &role, &text).await?;
    }
    tx.commit().await
}

#[cfg(test)]
mod tests {
    use sqlx::SqlitePool;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use uuid::Uuid;

    use crate::db::{rebuild_message_fts, search_messages};
    use crate::workflow::Workflow;

    /// A migrated in-memory pool (mirrors the `db::tests` helper) so the
    /// `message_fts` virtual table and the `runs`/`messages` CHECKs are in force.
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

    fn fixture_workflow() -> Workflow {
        Workflow {
            name: "w".to_string(),
            version: "1".to_string(),
            provider: "p".to_string(),
            model: Some("m".to_string()),
            system_prompt: String::new(),
            thinking_level: None,
            tools: Vec::new(),
        }
    }

    /// Seed one Thread + a completed user Message carrying `prompt`, via the real
    /// `persist_thread_with_first_run` path (which routes through
    /// `insert_initial_run_rows` — the user-text indexing seam under test).
    /// Returns `(thread_id, run_id, user_message_id)`.
    async fn seed_thread_with_user_message(
        pool: &SqlitePool,
        title: &str,
        prompt: &str,
        now_ms: i64,
    ) -> (Uuid, Uuid, Uuid) {
        let thread_id = Uuid::now_v7();
        let run_id = Uuid::now_v7();
        let user_message_id = Uuid::now_v7();
        let assistant_message_id = Uuid::now_v7();
        crate::db::persist_thread_with_first_run(
            pool,
            thread_id,
            run_id,
            user_message_id,
            assistant_message_id,
            &fixture_workflow(),
            prompt,
            title,
            now_ms,
        )
        .await
        .expect("persist thread with first run");
        (thread_id, run_id, user_message_id)
    }

    /// A case-insensitive substring query finds only the matching completed user
    /// Message, with the correct ids/role/thread_title and a snippet containing
    /// the match, ordered newest-first when multiple match.
    #[tokio::test]
    async fn search_finds_user_message_by_substring_newest_first() {
        let pool = memory_pool().await;

        // Thread A (older): mentions "daycare". Thread B (newer): mentions "invoice".
        let (thread_a, run_a, msg_a) = seed_thread_with_user_message(
            &pool,
            "Daycare planning",
            "Sort out the DAYCARE schedule",
            1000,
        )
        .await;
        let (_thread_b, _run_b, _msg_b) =
            seed_thread_with_user_message(&pool, "Invoices", "Send the invoice to Acme", 2000)
                .await;

        // Case-insensitive substring of a fragment INSIDE a word ("care" in
        // "daycare") returns only Thread A's user Message.
        let hits = search_messages(&pool, "CARE").await.expect("search");
        assert_eq!(hits.len(), 1, "only the daycare message matches 'CARE'");
        let hit = &hits[0];
        assert_eq!(hit.message_id, msg_a.to_string());
        assert_eq!(hit.thread_id, thread_a.to_string());
        assert_eq!(hit.run_id, run_a.to_string());
        assert_eq!(hit.role, "user");
        assert_eq!(hit.thread_title, "Daycare planning");
        assert_eq!(hit.created_at, 1000);
        assert!(
            hit.snippet.to_lowercase().contains("care"),
            "snippet excerpts around the match: {:?}",
            hit.snippet
        );

        // A query that matches BOTH messages comes back newest-first.
        let (_t_old, _r_old, _m_old) =
            seed_thread_with_user_message(&pool, "Old note", "the keyword zebra appears here", 500)
                .await;
        let (_t_new, _r_new, _m_new) =
            seed_thread_with_user_message(&pool, "New note", "another zebra sighting", 3000).await;
        let zebra = search_messages(&pool, "zebra").await.expect("search zebra");
        assert_eq!(zebra.len(), 2, "both zebra messages match");
        assert!(
            zebra[0].created_at >= zebra[1].created_at,
            "newest-first: {} then {}",
            zebra[0].created_at,
            zebra[1].created_at
        );
        assert_eq!(zebra[0].created_at, 3000, "newest zebra hit leads");
    }

    /// A match surrounded by multi-byte text returns a correct, non-empty snippet
    /// and never panics. The snippet must be byte-safe: `to_lowercase()` is not
    /// length-preserving (`İ` U+0130 folds to two chars, ligatures expand), so a
    /// char index taken against the folded text and applied to the original text
    /// overshoots and slices mid-codepoint. Emoji and accented letters near the
    /// match exercise that boundary.
    #[tokio::test]
    async fn search_snippet_survives_multibyte_text() {
        let pool = memory_pool().await;
        // A run of İ (each folds to TWO chars) before the match inflates the
        // folded-text char index well past the original string's length, so a
        // char index taken on the folded text slices out of bounds on the
        // original. Emoji and accents around the match add multi-byte chars too.
        let prompt =
            "🎉 İİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİ café please find the needle here naïve 🚀";
        let (_thread, _run, msg) =
            seed_thread_with_user_message(&pool, "Unicode thread", prompt, 1000).await;

        let hits = search_messages(&pool, "needle").await.expect("search");
        assert_eq!(hits.len(), 1, "the unicode message matches 'needle'");
        assert!(
            hits[0].snippet.to_lowercase().contains("needle"),
            "snippet excerpts around the match: {:?}",
            hits[0].snippet
        );
        assert_eq!(hits[0].message_id, msg.to_string());
    }

    /// `%` and `_` in the query are LIKE metacharacters; they must be treated as
    /// literal text (ADR-0035: user input is literal). A query of `"%"` matches
    /// only messages literally containing `%`, not every message; same for `_`.
    #[tokio::test]
    async fn search_treats_like_wildcards_as_literal() {
        let pool = memory_pool().await;
        seed_thread_with_user_message(&pool, "Has percent", "discount is 50% off today", 1000)
            .await;
        seed_thread_with_user_message(&pool, "Has underscore", "file is named my_report", 2000)
            .await;
        seed_thread_with_user_message(&pool, "Plain", "nothing special in this message", 3000)
            .await;

        let percent = search_messages(&pool, "%").await.expect("search %");
        assert_eq!(
            percent.len(),
            1,
            "'%' matches only the literal-percent message, not all: {:?}",
            percent.iter().map(|h| &h.thread_title).collect::<Vec<_>>()
        );
        assert_eq!(percent[0].thread_title, "Has percent");

        let underscore = search_messages(&pool, "_").await.expect("search _");
        assert_eq!(
            underscore.len(),
            1,
            "'_' matches only the literal-underscore message, not all: {:?}",
            underscore
                .iter()
                .map(|h| &h.thread_title)
                .collect::<Vec<_>>()
        );
        assert_eq!(underscore[0].thread_title, "Has underscore");
    }

    /// `rebuild_message_fts` reconstructs the index from `message_parts` after the
    /// table is wiped — proving the projection is honestly tier-3 (ADR-0004).
    #[tokio::test]
    async fn rebuild_reconstructs_index_from_message_parts() {
        let pool = memory_pool().await;
        let (_thread, _run, msg) = seed_thread_with_user_message(
            &pool,
            "Daycare planning",
            "Sort out the daycare schedule",
            1000,
        )
        .await;

        // Sanity: present before the wipe.
        assert_eq!(
            search_messages(&pool, "daycare")
                .await
                .expect("search")
                .len(),
            1
        );

        // Wipe the projection — the canonical message_parts are untouched.
        sqlx::query("DELETE FROM message_fts")
            .execute(&pool)
            .await
            .expect("wipe message_fts");
        assert_eq!(
            search_messages(&pool, "daycare")
                .await
                .expect("search after wipe")
                .len(),
            0,
            "wiped index returns no hits"
        );

        // Rebuild from message_parts restores the hit.
        rebuild_message_fts(&pool).await.expect("rebuild");
        let hits = search_messages(&pool, "daycare")
            .await
            .expect("search after rebuild");
        assert_eq!(hits.len(), 1, "rebuild reconstructs the user message hit");
        assert_eq!(hits[0].message_id, msg.to_string());
    }
}
