//! `journal_entry/rescan` handler (ADR-0042): re-scan an existing Journal Entry
//! for people/projects/tasks mentioned but not yet captured.
//!
//! Core resolves the JE's ORIGIN Thread (the user Message it was `created_from`)
//! and starts an ordinary agent Run THERE — so the Run sees the JE plus its
//! same-Thread context, and the intent-graph cross-Thread anchor-reuse guard
//! passes by construction. A JE that does not exist, is not a `journal_entry`, or
//! has no resolvable origin Thread is `invalid_params` (-32602) with ZERO rows
//! written — no Run is spawned.
//!
//! The run-creation path is `run/post_message`'s, verbatim
//! (`dispatch_and_resolve` → `persist_initial_run` → `hub::create` →
//! `history_for_run` → `worker::spawn`). The only differences: the Thread is
//! resolved from `je_id` instead of taken from params, and the prompt is a fixed
//! synthesized re-scan instruction instead of user input.

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;
use uuid::Uuid;

use super::handler::{self, HandlerError};
use crate::db;
use crate::dispatcher;
use crate::hub::{self, Hubs};
use crate::protocol::{JournalEntryRescanParams, JournalEntryRescanResult};
use crate::worker;

/// The fixed re-scan instruction. Names the JE and asks the agent to surface
/// only entities mentioned but not yet captured. The re-scan recognition prompt
/// lives in `default.toml`'s system prompt; this is the user turn that triggers
/// the run.
fn rescan_prompt(je_id: &str) -> String {
    format!(
        "Re-scan the journal entry {je_id} for any people, projects, or tasks I \
         mentioned but haven't captured yet. Only surface NEW ones."
    )
}

pub(super) async fn handle(
    pool: &SqlitePool,
    hubs: &Hubs,
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    handler::handle(id, params, out_tx, |params: JournalEntryRescanParams| async move {
        // Resolve the JE's origin Thread. A missing JE, a non-`journal_entry`
        // id, or one with no resolvable origin Thread is rejected BEFORE any
        // persistence — zero rows, no Run spawned (ADR-0042).
        let thread_id = db::journal_entry_origin_thread_id(pool, &params.je_id)
            .await
            .map_err(|e| HandlerError::Internal(e.into()))?
            .ok_or_else(|| {
                HandlerError::InvalidParams(format!(
                    "no re-scannable journal entry for je_id {}",
                    params.je_id
                ))
            })?;
        let thread_uuid =
            Uuid::parse_str(&thread_id).map_err(|e| HandlerError::Internal(e.into()))?;

        let prompt = rescan_prompt(&params.je_id);
        let now = db::now_ms();

        // From here this is `run/post_message`'s spawn sequence verbatim: pick a
        // Workflow + resolve its model/effort, persist the initial Run, create the
        // hub before spawning, gather prior-Run history, spawn the Worker.
        let workflow = dispatcher::dispatch_and_resolve(pool, thread_uuid, &prompt).await;

        // Reject BEFORE persisting/spawning if the resolved model's provider has no
        // credential (ADR-0062) — same fail-loud gate as run/post_message.
        handler::ensure_provider_connected(&workflow.provider)?;

        let run_id = Uuid::now_v7();
        let user_message_id = Uuid::now_v7();
        let assistant_message_id = Uuid::now_v7();

        db::persist_initial_run(
            pool,
            run_id,
            thread_uuid,
            user_message_id,
            assistant_message_id,
            &workflow,
            &prompt,
            // A rescan prompt is synthetic — it never carries attachments.
            &[],
            now,
        )
        .await
        .map_err(|e| HandlerError::Internal(e.into()))?;

        let run_hub = hub::create(hubs, run_id);

        let history = db::history_for_run(pool, thread_uuid, run_id)
            .await
            .unwrap_or_else(|e| {
                eprintln!("history_for_run failed for run {run_id}: {e}");
                Vec::new()
            });

        worker::spawn(
            run_id,
            workflow,
            prompt,
            history,
            pool.clone(),
            assistant_message_id,
            hubs.clone(),
            run_hub,
        );

        Ok(JournalEntryRescanResult {
            run_id: run_id.to_string(),
            thread_id,
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

    use crate::hub;

    /// A migrated in-memory pool (mirrors the `db`/`message` test helpers) so the
    /// `entities`/`runs` schema + CHECKs hold.
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

    async fn run_row_count(pool: &SqlitePool) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM runs")
            .fetch_one(pool)
            .await
            .expect("count runs")
    }

    async fn seed_entity(pool: &SqlitePool, id: &str, entity_type: &str, data: &str) {
        sqlx::query(
            "INSERT INTO entities \
             (id, type, schema_version, data, created_by, created_via_proposal_id, \
              created_at, updated_at) \
             VALUES (?, ?, 1, ?, 'user', NULL, 1, 1)",
        )
        .bind(id)
        .bind(entity_type)
        .bind(data)
        .execute(pool)
        .await
        .expect("insert entity");
    }

    fn recv_json(rx: &mut mpsc::UnboundedReceiver<String>) -> Value {
        let line = rx.try_recv().expect("a frame was queued");
        serde_json::from_str(&line).expect("frame is JSON")
    }

    /// An unresolvable JE — one that does not exist — frames `invalid_params`
    /// (-32602) and spawns NO Run: the origin-Thread resolution gates persistence,
    /// so zero `runs` rows are written. The success path (a real spawn into the
    /// origin Thread) is exercised end-to-end in slice 6, which boots a Worker.
    #[tokio::test]
    async fn unknown_je_id_frames_invalid_params_no_run() {
        let pool = memory_pool().await;
        let hubs = hub::new_hubs();
        let (tx, mut rx) = mpsc::unbounded_channel();

        super::handle(
            &pool,
            &hubs,
            json!(1),
            json!({ "je_id": "0190d3c1-0000-7000-8000-000000000099" }),
            &tx,
        )
        .await;

        let v = recv_json(&mut rx);
        assert_eq!(v["error"]["code"], json!(-32602));
        assert!(v.get("result").is_none());
        assert_eq!(run_row_count(&pool).await, 0, "no Run spawned");
    }

    /// An id naming a NON-`journal_entry` Entity is rejected the same way — the
    /// query's type guard resolves `None`, so the handler errors and spawns no Run.
    #[tokio::test]
    async fn non_journal_entry_id_frames_invalid_params_no_run() {
        let pool = memory_pool().await;
        seed_entity(&pool, "p-1", "person", r#"{"name":"Lev"}"#).await;
        let hubs = hub::new_hubs();
        let (tx, mut rx) = mpsc::unbounded_channel();

        super::handle(&pool, &hubs, json!(2), json!({ "je_id": "p-1" }), &tx).await;

        let v = recv_json(&mut rx);
        assert_eq!(v["error"]["code"], json!(-32602));
        assert_eq!(run_row_count(&pool).await, 0, "no Run spawned");
    }

    /// A `je_id`-less request fails decode at the seam (`invalid_params`) before
    /// the body runs.
    #[tokio::test]
    async fn missing_je_id_frames_invalid_params() {
        let pool = memory_pool().await;
        let hubs = hub::new_hubs();
        let (tx, mut rx) = mpsc::unbounded_channel();

        super::handle(&pool, &hubs, json!(3), json!({}), &tx).await;

        let v = recv_json(&mut rx);
        assert_eq!(v["error"]["code"], json!(-32602));
    }
}
