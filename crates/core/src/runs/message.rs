//! `message/search` handler (ADR-0035): full-text substring search over
//! completed Message text, surfaced in the Client's ⌘K palette. Follows the
//! combinator seam (ADR-0029): decode params, run the search, frame the hits.

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;

use super::handler::{self, HandlerError};
use crate::db;
use crate::protocol::{MessageHit, MessageSearchParams, MessageSearchResult};

/// `message/search` handler (ADR-0035): decode the query, run the tier-3
/// substring search ([`db::search_messages`]), and map the rows to wire hits
/// (newest-first, as the query returns them). A DB fault maps to
/// `HandlerError::Internal` (-32603); a non-string query fails at decode as
/// `invalid_params` inside the combinator.
pub(super) async fn handle_search(
    pool: &SqlitePool,
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    handler::handle(id, params, out_tx, |params: MessageSearchParams| async move {
        let hits = db::search_messages(pool, &params.query)
            .await
            .map_err(|e| HandlerError::Internal(e.into()))?
            .into_iter()
            .map(|hit| MessageHit {
                message_id: hit.message_id,
                thread_id: hit.thread_id,
                run_id: hit.run_id,
                role: hit.role,
                snippet: hit.snippet,
                thread_title: hit.thread_title,
                created_at: hit.created_at,
            })
            .collect();
        Ok(MessageSearchResult { hits })
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

    use crate::workflow::Workflow;

    /// A migrated in-memory pool (mirrors the `db` test helpers) so the
    /// `runs`/`messages` CHECKs hold.
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
    /// `persist_thread_with_first_run` path (the user-text indexing seam).
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

    fn recv_json(rx: &mut mpsc::UnboundedReceiver<String>) -> Value {
        let line = rx.try_recv().expect("a frame was queued");
        serde_json::from_str(&line).expect("frame is JSON")
    }

    /// A `message/search` over seeded completed Messages frames a JSON-RPC
    /// RESPONSE whose `result.hits` carry the full field set
    /// {message_id, thread_id, run_id, role, snippet, thread_title, created_at},
    /// newest-first when multiple match.
    #[tokio::test]
    async fn search_frames_full_hit_shape_newest_first() {
        let pool = memory_pool().await;
        let (thread_old, run_old, msg_old) =
            seed_thread_with_user_message(&pool, "Old zebra", "an old zebra appears", 1000).await;
        let (thread_new, run_new, msg_new) =
            seed_thread_with_user_message(&pool, "New zebra", "a new zebra sighting", 3000).await;

        let (tx, mut rx) = mpsc::unbounded_channel();
        super::handle_search(&pool, json!(7), json!({ "query": "zebra" }), &tx).await;

        let v = recv_json(&mut rx);
        assert_eq!(v["id"], json!(7));
        assert!(v.get("error").is_none(), "a normal response, not an error");
        let hits = v["result"]["hits"].as_array().expect("hits array");
        assert_eq!(hits.len(), 2, "both zebra messages match");

        // Newest-first: the 3000-stamped hit leads.
        let first = &hits[0];
        assert_eq!(first["message_id"], json!(msg_new.to_string()));
        assert_eq!(first["thread_id"], json!(thread_new.to_string()));
        assert_eq!(first["run_id"], json!(run_new.to_string()));
        assert_eq!(first["role"], json!("user"));
        assert_eq!(first["thread_title"], json!("New zebra"));
        assert_eq!(first["created_at"], json!(3000));
        assert!(
            first["snippet"]
                .as_str()
                .expect("snippet is a string")
                .to_lowercase()
                .contains("zebra"),
            "snippet excerpts around the match: {first:?}"
        );

        let second = &hits[1];
        assert_eq!(second["message_id"], json!(msg_old.to_string()));
        assert_eq!(second["thread_id"], json!(thread_old.to_string()));
        assert_eq!(second["run_id"], json!(run_old.to_string()));
        assert_eq!(second["thread_title"], json!("Old zebra"));
        assert_eq!(second["created_at"], json!(1000));
    }

    /// A query carrying FTS/SQL-special characters (`"`, `*`, `%`, `_`, and the
    /// word `AND`) returns a normal (non-error) JSON-RPC RESPONSE — no panic, no
    /// error frame. Slice 1 made `%`/`_` literal; this pins the wire path robust.
    #[tokio::test]
    async fn special_character_query_frames_a_normal_response() {
        let pool = memory_pool().await;
        seed_thread_with_user_message(&pool, "Plain", "nothing special here", 1000).await;

        for query in ["\"", "*", "%", "_", "AND", "foo* AND \"bar\" %_"] {
            let (tx, mut rx) = mpsc::unbounded_channel();
            super::handle_search(&pool, json!(1), json!({ "query": query }), &tx).await;
            let v = recv_json(&mut rx);
            assert!(
                v.get("error").is_none(),
                "query {query:?} must frame a normal response, got error: {v:?}"
            );
            assert!(
                v["result"]["hits"].is_array(),
                "query {query:?} frames a result with a hits array: {v:?}"
            );
        }
    }
}
