//! SQLite tier-2 storage (ADR-0017): resolves the DB path, opens a pool, runs
//! migrations. SQL lives in [`queries`]; this module owns the high-level
//! operations and transaction boundaries.

mod apply;
mod entities_read;
mod intent_graph;
mod journal_weave;
mod lifecycle;
mod media;
mod message_fts;
mod observations;
mod proposals;
mod queries;
mod run_log;
mod runs;
mod threads;

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};

// The intent-graph resolve+apply path (ADR-0042), the sibling of `apply_proposal`
// for the one mutation kind that is a GRAPH, not a single entity. `decide` routes
// `apply_intent_graph` here instead of `apply_proposal`.
pub use intent_graph::{IntentGraphOutcome, apply_intent_graph_proposal, resolved_plan_for};
pub(crate) use intent_graph::validate_intent_graph_payload;
pub use lifecycle::Moved;
// `RunStatus` is the read+write Interface for Run status: the write verbs live on
// it (ADR-0028), and the read seam (`run_status`, `RunSnapshot.status`) now returns
// it too, so read sites match compiler-checked variants instead of raw strings
// (ADR-0029 "type at the seam"). The wire stays a string via `.as_str()`.
pub use lifecycle::RunStatus;
use lifecycle::ProposalStatus;
// `TerminalReason` is the typed terminal-state cause. It is `pub use`d (not just
// crate-private) so the Worker run loop can name the variant at the `error_run_*`
// call instead of routing a wire string through a re-parse (ADR-0028/0029 "type
// at the seam"). The CHECK/wire string is produced once, outward, via
// `TerminalReason::as_str()` in `RunStatus::fail`.
pub use lifecycle::TerminalReason;
// `search_messages` is the message-search read surface (ADR-0035), consumed by
// the `message/search` handler (slice 3); it returns `message_fts::MessageHit`,
// which the handler maps field-for-field to the wire `protocol::MessageHit`
// without naming the db type. The search assembles text live from `message_parts`
// at query time — no standing projection to maintain or rebuild.
pub use message_fts::search_messages;
// The media substrate (ADR-0058) has no production consumer yet — its wire verb /
// Media entity caller lands later (#252). The `db::media` facade surface
// (`insert_media`/`get_media`/`delete_media` + `MediaInput`/`MediaRow`/…) is
// reached only by the module's own tests for now, so it is NOT re-exported from
// `db` until a real caller exists; `#252` adds the re-export with its consumer.
pub(crate) use observations::{
    ObservationFilter, ObservationInsert, ObservationInsertError, ObservationRelationInsert,
    ObservationRevisionRow, ObservationRow, ObservationSourceFilter, ObservationSourceInsert,
    ObservationUpdate, ObservationUpdateError, apply_record_observations_proposal,
    insert_observations, observation_revisions, observation_schema_key, query_observations,
    update_observation,
};
// `ProposalRow`/`DecidableProposal` fields are read through these fns'
// returns; `ApplyError` is named by decide/mutate and the db siblings.
pub use proposals::{
    ApplyError, DecidableProposal, ProposalRow, apply_proposal, apply_user_mutation,
    entity_id_for_proposal, get_pending_proposal_for_run, journal_entry_origin_thread_id,
    journal_entry_target_is_valid, load_proposal_for_decide, park_on_proposal,
    reject_proposal, should_auto_approve,
};
// `PartType` rides along from `queries` (the Worker run loop names it at the
// open/append seam); the row/step types stay module-private where unnamed.
pub(crate) use queries::PartType;
// `RunSnapshot` is not re-exported: its one consumer (`run/subscribe`) reads
// fields off `select_run_snapshot`'s return without naming the type.
pub use runs::{
    TimelineStep, append_assistant_part, assistant_message_id_for_run,
    cancel_parked_run, cancel_running_run, complete_run, error_run, error_run_with_message,
    history_for_run, list_run_history, mark_run_running, open_assistant_part,
    persist_initial_run, persist_thread_with_first_run, persist_tool_call, prepare_retry,
    read_run_timeline, recover_interrupted_runs, resolve_tool_call, run_prompt_and_thread,
    run_status, run_workflow_snapshot, select_run_snapshot,
};
// Result/row types no caller names (`Backlinks`, `Current*Row`,
// `ResolvedEntityRef`) and the V0-internal GTD reads (`todos_by_*`, consumed
// only by `backlinks_for_entity`) are NOT re-exported — callers destructure the
// returning fns' fields, and in a binary-only crate an unreachable re-export
// trips `unused_imports`. Re-add a name here when a real caller lands.
pub use entities_read::{
    EntityProvenance, EntityRow, backlinks_for_entity, current_journal_entry_by_id,
    current_person_by_id, current_project_by_id, current_thread_journal_entries,
    entity_is_type, entity_type_by_id, list_by_type,
};
// `MessageRow` is not re-exported: no caller names it (consumers destructure
// `get_thread_with_messages`' tuple and use `.text()`/`.segments`), and in a
// binary-only crate an unreachable re-export trips `unused_imports`.
pub use threads::{
    MessageSegment, archive_thread, get_thread_with_messages, list_archived_threads,
    list_threads, thread_exists, unarchive_thread, update_thread_title,
};

/// Current wall-clock time as ms since UNIX_EPOCH (the `*_at` columns).
pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time before epoch")
        .as_millis() as i64
}

/// Resolve the DB path: the boot-resolved `INKSTONE_DB_PATH` override wins,
/// else `<OS data dir>/inkstone/db.sqlite`.
pub(crate) fn resolve_db_path() -> Result<PathBuf> {
    if let Some(ref path) = crate::config::get().db_path_override {
        return Ok(path.clone());
    }
    Ok(os_data_dir()?.join("inkstone").join("db.sqlite"))
}

/// Resolve the media root: the boot-resolved `INKSTONE_MEDIA_DIR` override wins
/// (empty treated as unset at parse time, like `skills_dir`), else
/// `<OS data dir>/inkstone/media/`. The same override-or-data-dir shape as
/// `resolve_db_path`; binary media bytes live under this root with only the
/// relative path stored in SQLite (ADR-0058).
pub(crate) fn media_root() -> Result<PathBuf> {
    if let Some(ref dir) = crate::config::get().media_dir_override {
        return Ok(dir.clone());
    }
    Ok(os_data_dir()?.join("inkstone").join("media"))
}

/// Resolve a stored relative `storage_path` to its absolute on-disk location
/// under [`media_root`]. Both `insert_media`/`delete_media` and the tests turn the
/// relative stored path into the real file path through here.
///
/// `insert_media` only ever stores a bare UUID, but this is the trust boundary
/// where a stored string becomes a real filesystem path fed to `write`/
/// `remove_file`. `PathBuf::join` silently discards the root for an absolute input
/// and preserves `..`, so a malformed row could otherwise escape `media_root`.
/// Reject any absolute path or traversal component rather than join it blindly.
pub(crate) fn resolve_media_path(storage_path: &str) -> Result<PathBuf> {
    use std::path::Component;
    let path = std::path::Path::new(storage_path);
    let escapes_root = path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    });
    if escapes_root {
        anyhow::bail!("media storage_path must be a relative path under media_root");
    }
    Ok(media_root()?.join(path))
}

/// Per-OS application-data directory (hand-rolled to avoid a crate dep).
/// `pub(crate)` so the Skills subsystem can root its dir in the data dir
/// (`<data dir>/inkstone/skills/`, ADR-0036).
#[cfg(target_os = "macos")]
pub(crate) fn os_data_dir() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").context("$HOME not set")?;
    Ok(PathBuf::from(home)
        .join("Library")
        .join("Application Support"))
}

#[cfg(all(unix, not(target_os = "macos")))]
pub(crate) fn os_data_dir() -> Result<PathBuf> {
    if let Some(xdg) = std::env::var_os("XDG_DATA_HOME").filter(|s| !s.is_empty()) {
        return Ok(PathBuf::from(xdg));
    }
    let home = std::env::var_os("HOME").context("$HOME not set")?;
    Ok(PathBuf::from(home).join(".local").join("share"))
}

#[cfg(target_os = "windows")]
pub(crate) fn os_data_dir() -> Result<PathBuf> {
    let appdata = std::env::var_os("APPDATA").context("%APPDATA% not set")?;
    Ok(PathBuf::from(appdata))
}

/// Open the SQLite pool (creating file + parent dir if missing) and run
/// the bundled migrations.
pub async fn open() -> Result<SqlitePool> {
    let path = resolve_db_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create parent dir {}", parent.display()))?;
    }

    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal);

    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .with_context(|| format!("open SQLite pool at {}", path.display()))?;

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .context("run SQLite migrations")?;

    Ok(pool)
}


/// Read a user setting value by key (ADR-0024), or `None` if unset. Backs
/// `settings/get` and the Run-creation resolver that overrides the Workflow's
/// model/effort from persisted user choices.
pub async fn get_setting(pool: &SqlitePool, key: &str) -> sqlx::Result<Option<String>> {
    queries::get_setting(pool, key).await
}

/// Upsert a user setting (ADR-0024). Single statement; backs `settings/set`.
pub async fn set_setting(pool: &SqlitePool, key: &str, value: &str) -> sqlx::Result<()> {
    queries::set_setting(pool, key, value).await
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::entities_read::{todos_by_person, todos_by_project};
    use super::*;
    use crate::workflow::Workflow;

    /// A migrated in-memory pool so the `runs` CHECK constraints are in force.
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

    /// Insert a Thread + a bare Run row in `status` directly (no Worker), to
    /// hand-craft `running`/`parked` Runs for the tests.
    async fn insert_bare_run(pool: &SqlitePool, run_id: &str, status: &str) {
        let mut tx = pool.begin().await.expect("begin");
        sqlx::query(
            "INSERT INTO threads (id, title, created_at, last_activity_at) VALUES (?, ?, ?, ?)",
        )
        .bind(format!("thr-{run_id}"))
        .bind("t")
        .bind(1_i64)
        .bind(1_i64)
        .execute(&mut *tx)
        .await
        .expect("insert thread");
        // user_message_id FK is DEFERRABLE (resolved at COMMIT), so the run can
        // reference a message inserted later in the same tx.
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, \
              thinking_level, user_message_id, status, started_at) \
             VALUES (?, ?, 'w', '1', 'p', 'm', 'off', ?, ?, ?)",
        )
        .bind(run_id)
        .bind(format!("thr-{run_id}"))
        .bind(format!("msg-{run_id}"))
        .bind(status)
        .bind(1_i64)
        .execute(&mut *tx)
        .await
        .expect("insert run");
        sqlx::query(
            "INSERT INTO messages (id, thread_id, run_id, role, status, created_at, updated_at) \
             VALUES (?, ?, ?, 'assistant', 'streaming', ?, ?)",
        )
        .bind(format!("msg-{run_id}"))
        .bind(format!("thr-{run_id}"))
        .bind(run_id)
        .bind(1_i64)
        .bind(1_i64)
        .execute(&mut *tx)
        .await
        .expect("insert message");
        tx.commit().await.expect("commit bare run");
    }

    async fn run_status_of(pool: &SqlitePool, run_id: &str) -> String {
        sqlx::query_scalar("SELECT status FROM runs WHERE id = ?1")
            .bind(run_id)
            .fetch_one(pool)
            .await
            .expect("run row")
    }

    /// The typed read seam fails loudly on an unknown stored status rather than
    /// degrading to `None` (which means "no such Run"). The `runs.status` CHECK
    /// constraint keeps a live DB from ever producing this, so the row is forged
    /// with `PRAGMA ignore_check_constraints` — exercising the defensive
    /// `from_str` → `Decode` arm in `run_status` and `select_run_snapshot`, and
    /// proving the unknown-string error stays distinct from the absent-row `None`.
    #[tokio::test]
    async fn read_seam_rejects_unknown_stored_status() {
        let pool = memory_pool().await;
        // The seam keys on `run_id.to_string()`, so the forged row needs a real
        // UUID id. Relax the CHECK only to seed an out-of-vocabulary status.
        let run_id = Uuid::now_v7();
        sqlx::query("PRAGMA ignore_check_constraints = ON")
            .execute(&pool)
            .await
            .expect("relax checks");
        insert_bare_run(&pool, &run_id.to_string(), "halfway").await;

        // run_status: unknown stored value → Decode, not Ok(None).
        let err = run_status(&pool, run_id)
            .await
            .expect_err("unknown status must surface as an error, not None");
        assert!(
            matches!(err, sqlx::Error::Decode(_)),
            "unknown stored status is a Decode fault, got {err:?}"
        );

        // select_run_snapshot: same defensive arm. `insert_bare_run` already
        // inserted the assistant Message; a `seq=0` part makes the snapshot row
        // JOIN materialize so the parse (not a missing row) is what's exercised.
        sqlx::query(
            "INSERT INTO message_parts (message_id, seq, type, text) \
             VALUES (?, 0, 'text', 'hi')",
        )
        .bind(format!("msg-{run_id}"))
        .execute(&pool)
        .await
        .expect("seed assistant part");
        let snap_err = select_run_snapshot(&pool, run_id)
            .await
            .expect_err("snapshot of an unknown status must error");
        assert!(
            matches!(snap_err, sqlx::Error::Decode(_)),
            "unknown snapshot status is a Decode fault, got {snap_err:?}"
        );

        // An absent Run stays Ok(None) — the error arm must not swallow that case.
        let absent = run_status(&pool, Uuid::now_v7())
            .await
            .expect("absent read ok");
        assert!(absent.is_none(), "an absent Run reads as None, never Decode");
    }

    /// The boot recovery sweep (ADR-0012) errors a `running` Run but preserves a
    /// `parked` one (ADR-0025), flipping only the swept Run's `streaming` Message
    /// to `incomplete` (ADR-0017).
    #[tokio::test]
    async fn recover_errors_running_preserves_parked() {
        let pool = memory_pool().await;
        insert_bare_run(&pool, "run-running", "running").await;
        insert_bare_run(&pool, "run-parked", "parked").await;

        let swept = recover_interrupted_runs(&pool, 42).await.expect("sweep ok");
        assert_eq!(swept, 1, "swept exactly the running Run");

        assert_eq!(run_status_of(&pool, "run-running").await, "errored");
        assert_eq!(
            run_status_of(&pool, "run-parked").await,
            "parked",
            "parked Run preserved across the sweep"
        );

        // Swept Runs carry the core_restarted terminal_reason + error fields.
        let reason: Option<String> =
            sqlx::query_scalar("SELECT terminal_reason FROM runs WHERE id = 'run-running'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(reason.as_deref(), Some("core_restarted"));
        let ended_at: Option<i64> =
            sqlx::query_scalar("SELECT ended_at FROM runs WHERE id = 'run-running'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(ended_at, Some(42), "ended_at stamped with the boot now");

        // The swept Run's streaming Message is flipped to incomplete; the parked
        // Run's stays streaming (it is not terminal).
        let swept_msg: String =
            sqlx::query_scalar("SELECT status FROM messages WHERE run_id = 'run-running'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            swept_msg, "incomplete",
            "swept Run's streaming message → incomplete"
        );
        let parked_msg: String =
            sqlx::query_scalar("SELECT status FROM messages WHERE run_id = 'run-parked'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(parked_msg, "streaming", "parked Run's message untouched");

        // The sweep appends a terminal `error` Run Log milestone for the swept
        // Run (the raw bulk UPDATE is outside the typed `fail()` verb), so
        // `run/get_history` reads it as errored, not Running. The preserved
        // parked Run gets none.
        assert_eq!(
            run_event_count(&pool, "run-running", "error").await,
            1,
            "swept Run gets one terminal error Run Log row"
        );
        assert_eq!(
            run_event_count(&pool, "run-parked", "error").await,
            0,
            "preserved parked Run gets no error row"
        );
        let recovered_kind: String = sqlx::query_scalar(
            "SELECT kind FROM run_log WHERE run_id = 'run-running' \
             ORDER BY run_seq DESC LIMIT 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            recovered_kind, "error",
            "the recovered Run's latest milestone is error, so the feed shows it errored not running"
        );
    }

    async fn run_event_count(pool: &SqlitePool, run_id: &str, kind: &str) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM run_log WHERE run_id = ?1 AND kind = ?2")
            .bind(run_id)
            .bind(kind)
            .fetch_one(pool)
            .await
            .expect("count run events")
    }

    #[tokio::test]
    async fn complete_loses_on_parked_and_writes_no_done_event() {
        let pool = memory_pool().await;
        let run_id = Uuid::parse_str("33333333-3333-4333-8333-333333333333").unwrap();
        insert_bare_run(&pool, &run_id.to_string(), "parked").await;

        let moved = complete_run(&pool, run_id, 42).await.expect("complete");

        assert_eq!(moved, Moved::Lost);
        assert_eq!(run_status_of(&pool, &run_id.to_string()).await, "parked");
        assert_eq!(run_event_count(&pool, &run_id.to_string(), "done").await, 0);
    }

    #[tokio::test]
    async fn fail_loses_on_parked_and_writes_no_error_event() {
        let pool = memory_pool().await;
        let run_id = Uuid::parse_str("44444444-4444-4444-8444-444444444444").unwrap();
        insert_bare_run(&pool, &run_id.to_string(), "parked").await;

        let moved = error_run(&pool, run_id, 42).await.expect("error");

        assert_eq!(moved, Moved::Lost);
        assert_eq!(run_status_of(&pool, &run_id.to_string()).await, "parked");
        assert_eq!(
            run_event_count(&pool, &run_id.to_string(), "error").await,
            0
        );
    }

    #[tokio::test]
    async fn park_on_proposal_is_atomic_and_records_events() {
        let pool = memory_pool().await;
        let run_id = Uuid::parse_str("55555555-5555-4555-8555-555555555555").unwrap();
        insert_bare_run(&pool, &run_id.to_string(), "running").await;

        let moved = park_on_proposal(
            &pool,
            run_id,
            "proposal-1",
            "tool-1",
            "propose_workspace_mutation",
            r#"{"mutation_kind":"create_journal_entry","payload":{"occurred_at":"2026-06-10T10:30:00","body":[{"type":"text","text":"Bought milk."}]}}"#,
            "create_journal_entry",
            42,
        )
        .await
        .expect("park");

        assert_eq!(moved, Moved::Won);
        assert_eq!(run_status_of(&pool, &run_id.to_string()).await, "parked");
        assert_eq!(
            run_event_count(&pool, &run_id.to_string(), "parked").await,
            1
        );
        assert_eq!(
            run_event_count(&pool, &run_id.to_string(), "proposal_pending").await,
            1
        );

        let second = park_on_proposal(
            &pool,
            run_id,
            "proposal-2",
            "tool-2",
            "propose_workspace_mutation",
            r#"{"mutation_kind":"create_journal_entry","payload":{"occurred_at":"2026-06-10T10:31:00","body":[{"type":"text","text":"Bought eggs."}]}}"#,
            "create_journal_entry",
            43,
        )
        .await
        .expect("second park");
        assert_eq!(second, Moved::Lost);
        let proposal_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM proposals")
            .fetch_one(&pool)
            .await
            .expect("count proposals");
        assert_eq!(proposal_count, 1, "lost park rolled back its proposal row");
    }

    async fn seed_pending_proposal(pool: &SqlitePool, run_id: Uuid, tool_call_id: &str) -> String {
        let proposal_id = Uuid::now_v7().to_string();
        let mut tx = pool.begin().await.expect("begin proposal seed");
        queries::insert_tool_call(
            &mut *tx,
            tool_call_id,
            run_id,
            "propose_workspace_mutation",
            r#"{"mutation_kind":"create_journal_entry","payload":{"occurred_at":"2026-06-10T10:30:00","body":[{"type":"text","text":"Bought milk."}]}}"#,
            2,
        )
        .await
        .expect("insert tool call");
        queries::insert_tool_call_run_step(&mut *tx, run_id, 2, tool_call_id, 2)
            .await
            .expect("insert tool step");
        queries::insert_proposal(&mut *tx, &proposal_id, tool_call_id, "create_journal_entry")
            .await
            .expect("insert proposal");
        tx.commit().await.expect("commit proposal seed");
        proposal_id
    }

    #[tokio::test]
    async fn accept_records_proposal_decided_and_resume_is_guarded() {
        let pool = memory_pool().await;
        let run_id = Uuid::parse_str("66666666-6666-4666-8666-666666666666").unwrap();
        insert_bare_run(&pool, &run_id.to_string(), "parked").await;
        let proposal_id = seed_pending_proposal(&pool, run_id, "tool-accept").await;

        let entity_id = apply_proposal(
            &pool,
            run_id,
            &proposal_id,
            "tool-accept",
            crate::mutation::MutationKind::CreateJournalEntry,
            None,
            &serde_json::json!({
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "text", "text": "Bought milk." }]
            }),
            None,
            Some(crate::mutation::SourceRelation::CreatedFrom),
            Some("idem-accept"),
            |_| r#"{"decision":"accept","content":"Accepted."}"#.to_string(),
            42,
        )
        .await
        .expect("apply");
        assert!(!entity_id.is_empty());
        let source_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM entity_sources es \
             JOIN runs r ON r.user_message_id = es.source_message_id \
             WHERE es.entity_id = ?1 AND es.relation = 'created_from' AND r.id = ?2",
        )
        .bind(&entity_id)
        .bind(run_id.to_string())
        .fetch_one(&pool)
        .await
        .expect("count entity_sources");
        assert_eq!(
            source_count, 1,
            "accepted entity records its source Message"
        );
        // The stored schema_version is the one the Entity Type owns (derived from
        // the kind via the descriptor), so this catches apply_proposal stamping
        // the wrong version for the Journal Entry it created.
        let stored_schema_version: i64 =
            sqlx::query_scalar("SELECT schema_version FROM entities WHERE id = ?1")
                .bind(&entity_id)
                .fetch_one(&pool)
                .await
                .expect("entity schema_version");
        assert_eq!(
            stored_schema_version,
            crate::mutation::JOURNAL_ENTRY_SCHEMA_VERSION
        );
        assert_eq!(
            run_event_count(&pool, &run_id.to_string(), "proposal_decided").await,
            1
        );

        let first_resume = mark_run_running(&pool, run_id).await.expect("resume");
        assert_eq!(first_resume, Moved::Won);
        let second_resume = mark_run_running(&pool, run_id).await.expect("resume again");
        assert_eq!(second_resume, Moved::Lost);

        let duplicate = apply_proposal(
            &pool,
            run_id,
            &proposal_id,
            "tool-accept",
            crate::mutation::MutationKind::CreateJournalEntry,
            None,
            &serde_json::json!({
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "text", "text": "Bought milk." }]
            }),
            None,
            Some(crate::mutation::SourceRelation::CreatedFrom),
            Some("idem-accept-2"),
            |_| r#"{"decision":"accept","content":"Accepted."}"#.to_string(),
            43,
        )
        .await;
        assert!(matches!(duplicate, Err(ApplyError::NotPending)));
        assert_eq!(
            run_event_count(&pool, &run_id.to_string(), "proposal_decided").await,
            1,
            "lost apply wrote no duplicate event"
        );
    }

    /// Defense-in-depth (ADR-0030/0031): `source_journal_entry_id` is honored
    /// only for `created_from` (creates). An `updated_from` apply that somehow
    /// carries the field still sources from the user Message — never from a
    /// Journal Entry. (Update validators already reject the field at decide; this
    /// guards the apply layer directly so a future allowlist relaxation can't
    /// mis-source an update or FK-fail on a stray JE id.)
    #[tokio::test]
    async fn update_ignores_source_journal_entry_id_and_stays_message_sourced() {
        let pool = memory_pool().await;
        let run_id = Uuid::parse_str("99999999-9999-4999-8999-999999999999").unwrap();
        insert_bare_run(&pool, &run_id.to_string(), "parked").await;

        // An existing Person to update (created_by='user', no proposal needed).
        let person_id = Uuid::now_v7().to_string();
        sqlx::query(
            "INSERT INTO entities \
             (id, type, schema_version, data, created_by, created_via_proposal_id, \
              created_at, updated_at) \
             VALUES (?, 'person', ?, ?, 'user', NULL, ?, ?)",
        )
        .bind(&person_id)
        .bind(crate::mutation::PERSON_SCHEMA_VERSION)
        .bind(r#"{"name":"Alice"}"#)
        .bind(1_i64)
        .bind(1_i64)
        .execute(&pool)
        .await
        .expect("seed person");

        let proposal_id = seed_pending_proposal(&pool, run_id, "tool-update-src").await;

        // The update payload smuggles a source_journal_entry_id pointing at a
        // NON-existent entity. The buggy (pre-gate) path would route to
        // insert_entity_source_from_entity and FK-fail; the gate keeps it on the
        // Message path because relation == "updated_from".
        let bogus_journal_entry_id = Uuid::now_v7().to_string();
        let entity_id = apply_proposal(
            &pool,
            run_id,
            &proposal_id,
            "tool-update-src",
            crate::mutation::MutationKind::UpdatePerson,
            Some(&person_id),
            &serde_json::json!({
                "entity_id": person_id,
                "name": "Alice Updated",
                "source_journal_entry_id": bogus_journal_entry_id,
            }),
            None,
            Some(crate::mutation::SourceRelation::UpdatedFrom),
            Some("idem-update-src"),
            |_| r#"{"decision":"accept","content":"Accepted."}"#.to_string(),
            42,
        )
        .await
        .expect("update applies (must not FK-fail on the stray JE id)");
        assert_eq!(entity_id, person_id);

        // The updated_from source points at the user Message, NOT the Journal Entry.
        let (msg_count, ent_count): (i64, i64) = sqlx::query_as(
            "SELECT \
               COUNT(*) FILTER (WHERE source_message_id IS NOT NULL AND source_entity_id IS NULL), \
               COUNT(*) FILTER (WHERE source_entity_id IS NOT NULL) \
             FROM entity_sources WHERE entity_id = ?1 AND relation = 'updated_from'",
        )
        .bind(&person_id)
        .fetch_one(&pool)
        .await
        .expect("count updated_from sources");
        assert_eq!(msg_count, 1, "update is sourced from the user Message");
        assert_eq!(
            ent_count, 0,
            "update is never sourced from a Journal Entry (source_journal_entry_id ignored on update)"
        );
    }

    /// A parked Proposal whose target Entity was deleted out from under it
    /// (ADR-0033's user-delete-vs-parked-agent-proposal race): `apply_proposal`'s
    /// update/delete affected-0-rows path surfaces a distinct
    /// [`ApplyError::TargetMissing`], NOT an opaque [`ApplyError::Sql`], so the
    /// caller can resolve the parked Run cleanly (decide maps it to
    /// `NotDecidable` → `-32002`). Nothing is written and the Proposal's flip
    /// rolls back with the tx.
    #[tokio::test]
    async fn apply_delete_with_vanished_target_is_target_missing() {
        let pool = memory_pool().await;
        let run_id = Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
        insert_bare_run(&pool, &run_id.to_string(), "parked").await;
        let proposal_id = seed_pending_proposal(&pool, run_id, "tool-vanished").await;

        // A delete_journal_entry whose `entity_id` names an Entity that does not
        // exist — modeling the target deleted after the Proposal parked. The
        // delete's affected-0-rows check fires.
        let missing_entity_id = Uuid::now_v7().to_string();
        let result = apply_proposal(
            &pool,
            run_id,
            &proposal_id,
            "tool-vanished",
            crate::mutation::MutationKind::DeleteJournalEntry,
            Some(&missing_entity_id),
            &serde_json::json!({ "entity_id": missing_entity_id }),
            None,
            None,
            Some("idem-vanished"),
            |_| r#"{"decision":"accept","content":"Accepted."}"#.to_string(),
            42,
        )
        .await;

        assert!(
            matches!(result, Err(ApplyError::TargetMissing)),
            "a vanished delete target surfaces TargetMissing, not opaque Sql: {result:?}"
        );
        let entity_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM entities")
            .fetch_one(&pool)
            .await
            .expect("count entities");
        assert_eq!(entity_count, 0, "nothing is written on a vanished target");
        // The guarded Proposal flip rolled back with the tx — still pending.
        let proposal_status: String =
            sqlx::query_scalar("SELECT status FROM proposals WHERE id = ?1")
                .bind(&proposal_id)
                .fetch_one(&pool)
                .await
                .expect("proposal status");
        assert_eq!(
            proposal_status, "pending",
            "the apply tx rolled back, leaving the Proposal pending"
        );
    }

    /// The update affected-0-rows path also surfaces [`ApplyError::TargetMissing`]
    /// (not opaque `Sql`): an `update_person` whose target Entity was deleted out
    /// from under the parked Proposal. Covers the generic update arm alongside the
    /// delete arm above.
    #[tokio::test]
    async fn apply_update_with_vanished_target_is_target_missing() {
        let pool = memory_pool().await;
        let run_id = Uuid::parse_str("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").unwrap();
        insert_bare_run(&pool, &run_id.to_string(), "parked").await;
        let proposal_id = seed_pending_proposal(&pool, run_id, "tool-vanished-upd").await;

        let missing_entity_id = Uuid::now_v7().to_string();
        let result = apply_proposal(
            &pool,
            run_id,
            &proposal_id,
            "tool-vanished-upd",
            crate::mutation::MutationKind::UpdatePerson,
            Some(&missing_entity_id),
            &serde_json::json!({ "entity_id": missing_entity_id, "name": "Ghost" }),
            None,
            Some(crate::mutation::SourceRelation::UpdatedFrom),
            Some("idem-vanished-upd"),
            |_| r#"{"decision":"accept","content":"Accepted."}"#.to_string(),
            42,
        )
        .await;

        assert!(
            matches!(result, Err(ApplyError::TargetMissing)),
            "a vanished update target surfaces TargetMissing: {result:?}"
        );
        let entity_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM entities")
            .fetch_one(&pool)
            .await
            .expect("count entities");
        assert_eq!(entity_count, 0, "nothing is written on a vanished target");
    }

    #[tokio::test]
    async fn reject_records_proposal_decided_and_is_guarded() {
        let pool = memory_pool().await;
        let run_id = Uuid::parse_str("88888888-8888-4888-8888-888888888888").unwrap();
        insert_bare_run(&pool, &run_id.to_string(), "parked").await;
        let proposal_id = seed_pending_proposal(&pool, run_id, "tool-reject").await;

        reject_proposal(
            &pool,
            run_id,
            &proposal_id,
            "tool-reject",
            Some("idem-reject"),
            r#"{"decision":"reject","content":"Rejected."}"#,
            42,
        )
        .await
        .expect("reject");

        let proposal_status: String =
            sqlx::query_scalar("SELECT status FROM proposals WHERE id = ?1")
                .bind(&proposal_id)
                .fetch_one(&pool)
                .await
                .expect("proposal status");
        assert_eq!(proposal_status, "rejected");
        let tool_status: String =
            sqlx::query_scalar("SELECT status FROM tool_calls WHERE id = 'tool-reject'")
                .fetch_one(&pool)
                .await
                .expect("tool status");
        assert_eq!(tool_status, "completed");
        let entity_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM entities")
            .fetch_one(&pool)
            .await
            .expect("count entities");
        assert_eq!(entity_count, 0, "reject applies no entity");
        assert_eq!(
            run_event_count(&pool, &run_id.to_string(), "proposal_decided").await,
            1
        );

        let duplicate = reject_proposal(
            &pool,
            run_id,
            &proposal_id,
            "tool-reject",
            Some("idem-reject-2"),
            r#"{"decision":"reject","content":"Rejected."}"#,
            43,
        )
        .await;
        assert!(matches!(duplicate, Err(ApplyError::NotPending)));
        assert_eq!(
            run_event_count(&pool, &run_id.to_string(), "proposal_decided").await,
            1,
            "lost reject wrote no duplicate event"
        );
    }

    #[tokio::test]
    async fn cancel_parked_run_records_run_and_proposal_cancel_events() {
        let pool = memory_pool().await;
        let run_id = Uuid::parse_str("77777777-7777-4777-8777-777777777777").unwrap();
        insert_bare_run(&pool, &run_id.to_string(), "parked").await;
        seed_pending_proposal(&pool, run_id, "tool-cancel").await;

        let cancelled = cancel_parked_run(&pool, run_id, 42).await.expect("cancel");

        assert!(cancelled);
        assert_eq!(run_status_of(&pool, &run_id.to_string()).await, "cancelled");
        let proposal_status: String = sqlx::query_scalar(
            "SELECT p.status FROM proposals p \
             JOIN tool_calls tc ON tc.id = p.tool_call_id WHERE tc.run_id = ?1",
        )
        .bind(run_id.to_string())
        .fetch_one(&pool)
        .await
        .expect("proposal status");
        assert_eq!(proposal_status, "cancelled");
        assert_eq!(
            run_event_count(&pool, &run_id.to_string(), "cancelled").await,
            2,
            "one cancelled event for the Proposal and one for the Run"
        );

        let second = cancel_parked_run(&pool, run_id, 43)
            .await
            .expect("second cancel");
        assert!(!second);
        assert_eq!(
            run_event_count(&pool, &run_id.to_string(), "cancelled").await,
            2,
            "lost cancel wrote no duplicate event"
        );
    }

    /// `mark_run_running` is self-guarding on `status='parked'` (review M2): the
    /// first flip wins (1 row); a second flip and a never-parked Run are both
    /// 0-row no-ops, so the caller bails and exactly one resume Worker spawns.
    #[tokio::test]
    async fn mark_run_running_guards_on_parked() {
        let pool = memory_pool().await;
        let parked = Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap();
        let running = Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap();
        insert_bare_run(&pool, &parked.to_string(), "parked").await;
        insert_bare_run(&pool, &running.to_string(), "running").await;

        // First flip of the parked Run wins (1 row).
        let first = mark_run_running(&pool, parked).await.expect("first flip");
        assert_eq!(first, Moved::Won, "parked → running flips exactly one row");
        assert_eq!(run_status_of(&pool, &parked.to_string()).await, "running");

        // Second flip is a no-op — the Run already left `parked`.
        let second = mark_run_running(&pool, parked).await.expect("second flip");
        assert_eq!(
            second,
            Moved::Lost,
            "a second flip on an already-running Run is a no-op"
        );

        // A flip of a Run that was never parked is likewise 0 rows.
        let non_parked = mark_run_running(&pool, running)
            .await
            .expect("non-parked flip");
        assert_eq!(
            non_parked,
            Moved::Lost,
            "flipping a non-parked Run affects no rows"
        );
    }

    // ─── relationship read helpers (Slice 11, ADR-0031) ────────────────────

    /// Insert an Entity row directly with the given `type` + `data` JSON, so the
    /// relationship-read tests can seed Todos/Persons/Projects without a Proposal.
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

    /// Insert one `todo_person_refs` row directly.
    async fn seed_ref(pool: &SqlitePool, todo_id: &str, person_id: &str, role: &str) {
        sqlx::query(
            "INSERT INTO todo_person_refs \
             (todo_id, person_id, role, created_at, updated_at) VALUES (?, ?, ?, 1, 1)",
        )
        .bind(todo_id)
        .bind(person_id)
        .bind(role)
        .execute(pool)
        .await
        .expect("insert ref");
    }

    #[tokio::test]
    async fn todos_by_project_returns_only_that_projects_todos() {
        let pool = memory_pool().await;
        seed_entity(&pool, "proj-a", "project", r#"{"name":"A"}"#).await;
        seed_entity(&pool, "proj-b", "project", r#"{"name":"B"}"#).await;
        seed_entity(
            &pool,
            "t1",
            "todo",
            r#"{"title":"t1","project_id":"proj-a"}"#,
        )
        .await;
        seed_entity(
            &pool,
            "t2",
            "todo",
            r#"{"title":"t2","project_id":"proj-a"}"#,
        )
        .await;
        seed_entity(
            &pool,
            "t3",
            "todo",
            r#"{"title":"t3","project_id":"proj-b"}"#,
        )
        .await;
        seed_entity(&pool, "t4", "todo", r#"{"title":"t4"}"#).await;

        let mut ids: Vec<String> = todos_by_project(&pool, "proj-a")
            .await
            .expect("todos_by_project")
            .into_iter()
            .map(|row| row.id)
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["t1".to_string(), "t2".to_string()]);
    }

    #[tokio::test]
    async fn todos_by_person_optionally_filters_by_role() {
        let pool = memory_pool().await;
        seed_entity(&pool, "alice", "person", r#"{"name":"Alice"}"#).await;
        seed_entity(&pool, "t1", "todo", r#"{"title":"t1"}"#).await;
        seed_entity(&pool, "t2", "todo", r#"{"title":"t2"}"#).await;
        seed_ref(&pool, "t1", "alice", "waiting_on").await;
        seed_ref(&pool, "t2", "alice", "related").await;

        let mut all: Vec<String> = todos_by_person(&pool, "alice", None)
            .await
            .expect("all roles")
            .into_iter()
            .map(|row| row.id)
            .collect();
        all.sort();
        assert_eq!(all, vec!["t1".to_string(), "t2".to_string()]);

        let waiting: Vec<String> = todos_by_person(&pool, "alice", Some("waiting_on"))
            .await
            .expect("waiting only")
            .into_iter()
            .map(|row| row.id)
            .collect();
        assert_eq!(
            waiting,
            vec!["t1".to_string()],
            "role filter keeps only waiting_on"
        );
    }

    #[tokio::test]
    async fn list_by_type_todo_attaches_person_refs() {
        let pool = memory_pool().await;
        seed_entity(&pool, "alice", "person", r#"{"name":"Alice"}"#).await;
        seed_entity(&pool, "bob", "person", r#"{"name":"Bob"}"#).await;
        seed_entity(&pool, "t1", "todo", r#"{"title":"t1","status":"active"}"#).await;
        seed_entity(&pool, "t2", "todo", r#"{"title":"t2","status":"active"}"#).await;
        seed_ref(&pool, "t1", "alice", "waiting_on").await;
        seed_ref(&pool, "t1", "bob", "related").await;
        // t2 has no refs.

        let rows = list_by_type(&pool, "todo").await.expect("list todos");
        let t1 = rows.iter().find(|r| r.id == "t1").expect("t1 present");
        let mut t1_refs = t1.person_refs.clone();
        t1_refs.sort();
        assert_eq!(
            t1_refs,
            vec![
                ("alice".to_string(), "waiting_on".to_string()),
                ("bob".to_string(), "related".to_string()),
            ],
            "t1 carries both Person References with roles"
        );

        let t2 = rows.iter().find(|r| r.id == "t2").expect("t2 present");
        assert!(
            t2.person_refs.is_empty(),
            "a Todo with no refs carries none"
        );
    }

    #[tokio::test]
    async fn list_by_type_non_todo_has_no_person_refs() {
        let pool = memory_pool().await;
        seed_entity(&pool, "alice", "person", r#"{"name":"Alice"}"#).await;
        let rows = list_by_type(&pool, "person").await.expect("list people");
        assert!(
            rows.iter().all(|r| r.person_refs.is_empty()),
            "non-Todo rows never carry person_refs"
        );
    }

    /// Seed a Thread + Run + user Message chain so a Message-sourced provenance
    /// row resolves a real `thread_id`/`thread_title`. The `runs.user_message_id`
    /// and `messages.run_id` FKs are circular but DEFERRABLE, so the whole chain
    /// commits in one tx. Returns the seeded user-message id.
    async fn seed_thread_message(
        pool: &SqlitePool,
        thread_id: &str,
        thread_title: &str,
        message_id: &str,
    ) {
        let mut tx = pool.begin().await.expect("begin");
        sqlx::query(
            "INSERT INTO threads (id, title, created_at, last_activity_at) VALUES (?, ?, 1, 1)",
        )
        .bind(thread_id)
        .bind(thread_title)
        .execute(&mut *tx)
        .await
        .expect("insert thread");
        let run_id = format!("run-for-{message_id}");
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, \
              thinking_level, user_message_id, status, started_at) \
             VALUES (?, ?, 'w', '1', 'p', 'm', 'off', ?, 'completed', 1)",
        )
        .bind(&run_id)
        .bind(thread_id)
        .bind(message_id)
        .execute(&mut *tx)
        .await
        .expect("insert run");
        sqlx::query(
            "INSERT INTO messages (id, thread_id, run_id, role, status, created_at, updated_at) \
             VALUES (?, ?, ?, 'user', 'completed', 1, 1)",
        )
        .bind(message_id)
        .bind(thread_id)
        .bind(&run_id)
        .execute(&mut *tx)
        .await
        .expect("insert message");
        tx.commit().await.expect("commit thread+message");
    }

    /// Seed one `entity_sources` row. Exactly one of `source_message_id` /
    /// `source_entity_id` is set (the schema CHECK); pass the other as `None`.
    async fn seed_source(
        pool: &SqlitePool,
        id: &str,
        entity_id: &str,
        source_message_id: Option<&str>,
        source_entity_id: Option<&str>,
        relation: &str,
        created_at: i64,
    ) {
        sqlx::query(
            "INSERT INTO entity_sources \
             (id, entity_id, source_message_id, source_entity_id, relation, created_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(entity_id)
        .bind(source_message_id)
        .bind(source_entity_id)
        .bind(relation)
        .bind(created_at)
        .execute(pool)
        .await
        .expect("insert entity_source");
    }

    /// `list_by_type` attaches each Entity's origin provenance ("Captured from",
    /// ADR-0030): a Message source resolves to its Thread; a Journal-Entry source
    /// resolves to the source Entity id; a user-authored Entity (no `created_from`)
    /// carries no source.
    #[tokio::test]
    async fn list_by_type_attaches_captured_from_provenance() {
        let pool = memory_pool().await;
        seed_thread_message(&pool, "thr-1", "Morning brain dump", "msg-1").await;

        // (a) A Todo extracted from a Journal Entry → JournalEntry provenance.
        seed_entity(&pool, "je-1", "journal_entry", r#"{"occurred_at":"x"}"#).await;
        seed_entity(&pool, "t-from-je", "todo", r#"{"title":"Email Alice"}"#).await;
        seed_source(
            &pool,
            "src-je",
            "t-from-je",
            None,
            Some("je-1"),
            "created_from",
            10,
        )
        .await;

        // (b) A Todo created directly from a user Message → Message provenance.
        seed_entity(&pool, "t-from-msg", "todo", r#"{"title":"Buy milk"}"#).await;
        seed_source(
            &pool,
            "src-msg",
            "t-from-msg",
            Some("msg-1"),
            None,
            "created_from",
            10,
        )
        .await;

        // (c) A user-authored Todo (direct Library write) → no source row.
        seed_entity(&pool, "t-user", "todo", r#"{"title":"Hand-made"}"#).await;

        // A later `updated_from` row on (b) must NOT override its origin.
        seed_source(
            &pool,
            "src-msg-upd",
            "t-from-msg",
            Some("msg-1"),
            None,
            "updated_from",
            20,
        )
        .await;

        let rows = list_by_type(&pool, "todo").await.expect("list todos");
        let from_je = rows.iter().find(|r| r.id == "t-from-je").expect("t-from-je");
        assert!(
            matches!(
                from_je.source.as_ref(),
                Some(EntityProvenance::JournalEntry { journal_entry_id }) if journal_entry_id == "je-1"
            ),
            "JE-sourced Todo reports its source Journal Entry"
        );

        let from_msg = rows
            .iter()
            .find(|r| r.id == "t-from-msg")
            .expect("t-from-msg");
        assert!(
            matches!(
                from_msg.source.as_ref(),
                Some(EntityProvenance::Message { thread_id, thread_title, message_id })
                    if thread_id == "thr-1"
                        && thread_title == "Morning brain dump"
                        && message_id.as_deref() == Some("msg-1")
            ),
            "Message-sourced Todo reports its Thread + capturing message; updated_from does not override created_from"
        );

        let user = rows.iter().find(|r| r.id == "t-user").expect("t-user");
        assert!(
            user.source.is_none(),
            "a user-authored Entity carries no Captured-from provenance"
        );
    }

    /// A canonical `entities.data` row holding malformed JSON makes `list_by_type`
    /// fail the read (logged `db.entity_data_parse_failed` + `sqlx::Error::Decode`)
    /// rather than silently returning an `EntityRow` with `data: Null`. The column
    /// has no `json_valid` CHECK, so `seed_entity` writes the bad row directly.
    #[tokio::test]
    async fn list_by_type_errors_on_malformed_entity_data() {
        let pool = memory_pool().await;
        seed_entity(&pool, "t-bad", "todo", "{not json").await;

        assert!(
            list_by_type(&pool, "todo").await.is_err(),
            "a malformed entities.data row errors the read, no silent Null"
        );

        // A well-formed row in the same type still reads back fine once the bad
        // row is gone — the helper only fails on actual parse errors.
        sqlx::query("DELETE FROM entities WHERE id = 't-bad'")
            .execute(&pool)
            .await
            .expect("delete bad row");
        seed_entity(&pool, "t-ok", "todo", r#"{"title":"ok"}"#).await;
        let rows = list_by_type(&pool, "todo")
            .await
            .expect("well-formed reads ok");
        assert_eq!(rows.len(), 1, "the well-formed row reads back");
        assert_eq!(
            rows[0].data.get("title").and_then(|v| v.as_str()),
            Some("ok")
        );
    }

    /// `journal_entry_origin_thread_id` resolves the Thread a Journal Entry was
    /// `created_from` (the origin user Message's Thread), the destination a re-scan
    /// Run starts in. A non-existent id, or an id naming a non-`journal_entry`
    /// Entity, resolves to `None` — so the rescan handler errors instead of
    /// spawning into the wrong Thread.
    #[tokio::test]
    async fn journal_entry_origin_thread_id_resolves_je_origin_only() {
        let pool = memory_pool().await;
        seed_thread_message(&pool, "thr-origin", "Morning dump", "msg-origin").await;

        // (a) A Journal Entry `created_from` the user Message in thr-origin.
        seed_entity(&pool, "je-1", "journal_entry", r#"{"occurred_at":"x"}"#).await;
        seed_source(
            &pool,
            "src-je",
            "je-1",
            Some("msg-origin"),
            None,
            "created_from",
            10,
        )
        .await;

        // (b) A non-`journal_entry` Entity that ALSO has a created_from message
        // source — the query must reject it on the type guard, not resolve its
        // Thread.
        seed_entity(&pool, "t-1", "todo", r#"{"title":"Buy milk"}"#).await;
        seed_source(
            &pool,
            "src-todo",
            "t-1",
            Some("msg-origin"),
            None,
            "created_from",
            10,
        )
        .await;

        assert_eq!(
            journal_entry_origin_thread_id(&pool, "je-1")
                .await
                .expect("query runs"),
            Some("thr-origin".to_string()),
            "a journal_entry resolves its created_from origin Thread"
        );
        assert_eq!(
            journal_entry_origin_thread_id(&pool, "missing")
                .await
                .expect("query runs"),
            None,
            "an unknown id resolves to None"
        );
        assert_eq!(
            journal_entry_origin_thread_id(&pool, "t-1")
                .await
                .expect("query runs"),
            None,
            "a non-journal_entry Entity resolves to None even with a created_from source"
        );
    }

    /// Seed a Thread (with a distinct `title`) + a bare Run, then append one
    /// Run Log milestone (`kind` at `created_at`) — the minimum to exercise the
    /// `list_run_history` latest-milestone/recency read directly.
    async fn seed_run_with_milestone(
        pool: &SqlitePool,
        run_id: &str,
        title: &str,
        kind: &str,
        created_at: i64,
    ) {
        let mut tx = pool.begin().await.expect("begin");
        sqlx::query(
            "INSERT INTO threads (id, title, created_at, last_activity_at) VALUES (?, ?, ?, ?)",
        )
        .bind(format!("thr-{run_id}"))
        .bind(title)
        .bind(created_at)
        .bind(created_at)
        .execute(&mut *tx)
        .await
        .expect("insert thread");
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, \
              thinking_level, user_message_id, status, started_at) \
             VALUES (?, ?, 'w', '1', 'p', 'm', 'off', ?, 'running', ?)",
        )
        .bind(run_id)
        .bind(format!("thr-{run_id}"))
        .bind(format!("msg-{run_id}"))
        .bind(created_at)
        .execute(&mut *tx)
        .await
        .expect("insert run");
        sqlx::query(
            "INSERT INTO messages (id, thread_id, run_id, role, status, created_at, updated_at) \
             VALUES (?, ?, ?, 'assistant', 'streaming', ?, ?)",
        )
        .bind(format!("msg-{run_id}"))
        .bind(format!("thr-{run_id}"))
        .bind(run_id)
        .bind(created_at)
        .bind(created_at)
        .execute(&mut *tx)
        .await
        .expect("insert message");
        tx.commit().await.expect("commit seeded run");

        // The creation `running` row at seq 0, then the supplied milestone at
        // seq 1 (so the latest-milestone selection has more than one row to pick
        // the max from — exactly the live shape `run_log::append` produces).
        queries::insert_run_log_entry(pool, Uuid::parse_str(run_id).unwrap(), 0, "running", None, created_at)
            .await
            .expect("insert running milestone");
        if kind != "running" {
            queries::insert_run_log_entry(
                pool,
                Uuid::parse_str(run_id).unwrap(),
                1,
                kind,
                None,
                created_at,
            )
            .await
            .expect("insert latest milestone");
        }
    }

    /// `list_run_history` returns one row per Run carrying its *latest* milestone
    /// kind verbatim, newest-first by that milestone's `created_at`, capped at
    /// `limit`; an empty Workspace returns an empty Vec.
    #[tokio::test]
    async fn list_run_history_orders_by_recency_with_verbatim_kind() {
        let pool = memory_pool().await;

        // Empty Workspace → empty feed.
        let empty = list_run_history(&pool, 50).await.expect("empty read ok");
        assert!(empty.is_empty(), "a never-run Workspace returns no history");

        // Three Runs at increasing milestone times; the newest is `error`, then
        // `proposal_decided` (a resumed-still-working Run's latest milestone —
        // NOT folded to `running`), then `done` oldest.
        seed_run_with_milestone(
            &pool,
            "11111111-1111-4111-8111-111111111111",
            "oldest done",
            "done",
            100,
        )
        .await;
        seed_run_with_milestone(
            &pool,
            "22222222-2222-4222-8222-222222222222",
            "middle resumed",
            "proposal_decided",
            200,
        )
        .await;
        seed_run_with_milestone(
            &pool,
            "33333333-3333-4333-8333-333333333333",
            "newest error",
            "error",
            300,
        )
        .await;

        let rows = list_run_history(&pool, 50).await.expect("history read ok");
        assert_eq!(rows.len(), 3, "one row per Run");

        // Newest-first by the latest milestone's created_at.
        assert_eq!(rows[0].2, "newest error");
        assert_eq!(rows[0].3, "error", "latest milestone kind verbatim");
        assert_eq!(rows[0].4, 300, "recency key is the milestone created_at");

        assert_eq!(rows[1].2, "middle resumed");
        assert_eq!(
            rows[1].3, "proposal_decided",
            "resumed Run surfaces its proposal_decided milestone, not a folded running"
        );

        assert_eq!(rows[2].2, "oldest done");
        assert_eq!(rows[2].3, "done");

        // thread_id is the owning Thread; run_id is the Run.
        assert_eq!(rows[0].0, "33333333-3333-4333-8333-333333333333");
        assert_eq!(rows[0].1, "thr-33333333-3333-4333-8333-333333333333");

        // The limit caps the row count, keeping the newest.
        let capped = list_run_history(&pool, 2).await.expect("capped read ok");
        assert_eq!(capped.len(), 2, "limit caps the feed");
        assert_eq!(capped[0].2, "newest error");
        assert_eq!(capped[1].2, "middle resumed");
    }

    /// When two Runs' latest milestones share an identical `created_at` (ms ties
    /// are real at this granularity), the `, rl.run_id DESC` tie-break makes the
    /// order deterministic — the higher run_id sorts first.
    #[tokio::test]
    async fn list_run_history_breaks_created_at_ties_by_run_id() {
        let pool = memory_pool().await;

        // Two Runs, same latest-milestone created_at (500). Without the tie-break
        // their relative order would be undefined; with `run_id DESC` the
        // lexically-greater id ("bbbb…") must precede the lesser ("aaaa…").
        let lo = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let hi = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        seed_run_with_milestone(&pool, lo, "lo id", "done", 500).await;
        seed_run_with_milestone(&pool, hi, "hi id", "done", 500).await;

        let rows = list_run_history(&pool, 50).await.expect("history read ok");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].0, hi, "higher run_id sorts first on a created_at tie");
        assert_eq!(rows[1].0, lo);
    }

    /// ADR-0045: `thread/get` rehydrates the assistant turn's ORDERED `segments[]`
    /// from `run_steps` in seq order — text/tool_call/proposal interleaved as they
    /// happened. Folds in the ADR-0043 rules (a non-Proposal tool call rehydrates as
    /// a `tool_call` segment; the Proposal tool call NEVER does — a pending one is
    /// skipped here, a settled one becomes a `proposal` segment; `errored` maps to
    /// the wire `error`; a `pending` tool call is skipped). The canonical round-trip:
    /// a Run whose run_steps are `[assistant-text, tool_call(completed),
    /// tool_call(errored), tool_call(pending), proposal(pending)]` yields segments
    /// `[text, tool_call(completed), tool_call(error)]` — the in-order survivors.
    #[tokio::test]
    async fn thread_get_assembles_ordered_segments_excluding_proposals() {
        let pool = memory_pool().await;
        let thread_id = Uuid::now_v7();
        let run_id = Uuid::now_v7();
        let assistant_id = Uuid::now_v7();

        // Seed Thread + Run + assistant Message directly (UUID ids throughout).
        let mut tx = pool.begin().await.expect("begin");
        queries::insert_thread(&mut *tx, thread_id, "T", 1)
            .await
            .expect("thread");
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, \
              thinking_level, user_message_id, status, started_at) \
             VALUES (?, ?, 'w', '1', 'p', 'm', 'off', ?, 'parked', 1)",
        )
        .bind(run_id.to_string())
        .bind(thread_id.to_string())
        .bind(assistant_id.to_string())
        .execute(&mut *tx)
        .await
        .expect("run");
        queries::insert_message(
            &mut *tx,
            assistant_id,
            thread_id,
            run_id,
            "assistant",
            "streaming",
            1,
        )
        .await
        .expect("assistant message");
        // An assistant text segment at seq 0: its `message_parts` row AND its
        // `run_steps` message row (ADR-0045 — text is sequenced via run_steps, not a
        // free-floating part), so it appears FIRST in the ordered walk.
        queries::insert_text_part(&mut *tx, assistant_id, 0, "Captured.")
            .await
            .expect("text part");
        queries::insert_message_run_step(&mut *tx, run_id, 0, assistant_id, 0, 1)
            .await
            .expect("assistant text step");
        tx.commit().await.expect("commit seed");

        // A non-Proposal search tool call (completed), then an errored one — the
        // request payloads are FAITHFUL to `search_entities::Input` (`type` +
        // `query`) so `display_arg` derives the query. Then a still-`pending`
        // search call, then a Proposal tool call — interleaved in this order.
        persist_tool_call(
            &pool,
            run_id,
            "tc-1",
            "search_entities",
            r#"{"type":"person","query":"Lev"}"#,
            2,
        )
        .await
        .expect("persist search 1");
        resolve_tool_call(&pool, "tc-1", "completed", "{}", 3)
            .await
            .expect("resolve search 1");
        persist_tool_call(
            &pool,
            run_id,
            "tc-2",
            "search_entities",
            r#"{"type":"project","query":"Acme"}"#,
            4,
        )
        .await
        .expect("persist search 2");
        resolve_tool_call(&pool, "tc-2", "errored", "{}", 5)
            .await
            .expect("resolve search 2");
        // A tool call left `pending` (persisted, never resolved — the in-flight /
        // crash-orphaned case): it must NOT rehydrate as a settled row (ADR-0043).
        persist_tool_call(
            &pool,
            run_id,
            "tc-pending",
            "search_entities",
            r#"{"type":"todo","query":"InFlight"}"#,
            6,
        )
        .await
        .expect("persist pending search");
        // The Proposal tool call parks the Run; persist it the way park does.
        park_on_proposal(
            &pool,
            run_id,
            "proposal-x",
            "tc-3",
            "propose_workspace_mutation",
            r#"{"mutation_kind":"create_journal_entry","payload":{"occurred_at":"2026-06-10T10:30:00","body":[{"type":"text","text":"x"}]}}"#,
            "create_journal_entry",
            7,
        )
        .await
        .expect("park");

        let (_title, rows) = get_thread_with_messages(&pool, thread_id)
            .await
            .expect("read ok")
            .expect("thread exists");

        let assistant = rows
            .iter()
            .find(|m| m.role == "assistant")
            .expect("assistant row");

        // The ordered survivors: the text segment FIRST (seq 0), then the two
        // SETTLED search calls in seq order. The `pending` search call is owned by
        // the live tail (skipped), and the still-`pending` Proposal tool call
        // renders as a ProposalCard, never a tool-activity row (skipped) — so the
        // turn has exactly three segments, in this order.
        assert_eq!(
            assistant.segments.len(),
            3,
            "text + two settled tool calls, in order (no pending tool, no pending proposal)"
        );
        match &assistant.segments[0] {
            MessageSegment::Text { text } => assert_eq!(text, "Captured."),
            other => panic!("segment[0] is the text segment, got {other:?}"),
        }
        match &assistant.segments[1] {
            MessageSegment::ToolCall { name, status, arg } => {
                assert_eq!(name, "search_entities");
                assert_eq!(status, "completed");
                assert_eq!(arg.as_deref(), Some("Lev"));
            }
            other => panic!("segment[1] is the completed search, got {other:?}"),
        }
        match &assistant.segments[2] {
            MessageSegment::ToolCall { name, status, arg } => {
                assert_eq!(name, "search_entities");
                // `errored` maps to the wire `error` spelling.
                assert_eq!(status, "error");
                assert_eq!(arg.as_deref(), Some("Acme"));
            }
            other => panic!("segment[2] is the errored search, got {other:?}"),
        }
        // No Proposal tool call, no pending tool call leaked into the segments.
        assert!(
            !assistant.segments.iter().any(|s| matches!(
                s,
                MessageSegment::ToolCall { arg, .. } if arg.as_deref() == Some("InFlight")
            )),
            "a still-pending tool call must not rehydrate"
        );
        assert!(
            !assistant
                .segments
                .iter()
                .any(|s| matches!(s, MessageSegment::Proposal { .. })),
            "a still-pending Proposal must not rehydrate as a segment"
        );
    }

    /// ADR-0044 + ADR-0045: `thread/get` rehydrates the assistant turn's DECIDED
    /// Proposal as a `proposal` SEGMENT (so the "Applied." indicator survives reload),
    /// but only once it is `accepted`/`rejected` — a `pending` one renders its
    /// interactive card. And it sits in TIMELINE ORDER: the screenshot scenario
    /// (park on a Proposal, then reply after deciding) yields segments
    /// `[proposal(accepted), text]` — the decided pill BEFORE the reply text, the
    /// Core-side proof of the pill-above-reply order the reload must preserve.
    #[tokio::test]
    async fn thread_get_rehydrates_decided_proposal_segment_in_order() {
        let pool = memory_pool().await;
        let thread_id = Uuid::now_v7();
        let run_id = Uuid::now_v7();
        let assistant_id = Uuid::now_v7();

        let mut tx = pool.begin().await.expect("begin");
        queries::insert_thread(&mut *tx, thread_id, "T", 1)
            .await
            .expect("thread");
        // `running` so `park_on_proposal` (which guards on `status='running'`)
        // wins the park, mirroring the real propose→park→decide flow.
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, \
              thinking_level, user_message_id, status, started_at) \
             VALUES (?, ?, 'w', '1', 'p', 'm', 'off', ?, 'running', 1)",
        )
        .bind(run_id.to_string())
        .bind(thread_id.to_string())
        .bind(assistant_id.to_string())
        .execute(&mut *tx)
        .await
        .expect("run");
        queries::insert_message(
            &mut *tx,
            assistant_id,
            thread_id,
            run_id,
            "assistant",
            "completed",
            1,
        )
        .await
        .expect("assistant message");
        tx.commit().await.expect("commit seed");

        // Park on an apply_intent_graph Proposal (the proposal tool step lands at
        // seq 0), then ACCEPT it — the decided outcome the reload must reconstruct.
        park_on_proposal(
            &pool,
            run_id,
            "proposal-graph",
            "tc-graph",
            "propose_workspace_mutation",
            r#"{"mutation_kind":"apply_intent_graph","payload":{"entities":[],"links":[]}}"#,
            "apply_intent_graph",
            2,
        )
        .await
        .expect("park");
        let affected = queries::mark_proposal_accepted(&pool, "proposal-graph", None, None, 3)
            .await
            .expect("mark accepted");
        assert_eq!(affected, 1, "accept flips exactly the pending row");
        // The accept minted an Entity stamped with this Proposal's id (the anchor of
        // the apply_intent_graph commit), so the decided segment names + deep-links
        // it (ADR-0044 entity_id amendment). Pins the `created_via_proposal_id`
        // create-arm of the resolver.
        sqlx::query(
            "INSERT INTO entities \
             (id, type, schema_version, data, created_by, created_via_proposal_id, \
              created_at, updated_at) \
             VALUES ('entity-graph', 'todo', 1, '{\"title\":\"x\"}', 'proposal', 'proposal-graph', 4, 4)",
        )
        .execute(&pool)
        .await
        .expect("seed entity created via the proposal");

        // The resume reply: a text segment opened AFTER the proposal (its
        // `message_parts` row + `run_steps` message row at the next seq, ADR-0045).
        let mut tx = pool.begin().await.expect("begin reply");
        let part_seq = queries::next_message_part_seq(&mut *tx, assistant_id)
            .await
            .expect("part seq");
        let step_seq = queries::next_run_step_seq(&mut *tx, run_id)
            .await
            .expect("step seq");
        queries::insert_text_part(&mut *tx, assistant_id, part_seq, "Done — added it.")
            .await
            .expect("reply part");
        queries::insert_message_run_step(&mut *tx, run_id, step_seq, assistant_id, part_seq, 4)
            .await
            .expect("reply step");
        tx.commit().await.expect("commit reply");

        let (_title, rows) = get_thread_with_messages(&pool, thread_id)
            .await
            .expect("read ok")
            .expect("thread exists");
        let assistant = rows
            .iter()
            .find(|m| m.role == "assistant")
            .expect("assistant row");

        // The decided proposal pill is BEFORE the reply text (timeline order).
        assert_eq!(
            assistant.segments.len(),
            2,
            "the turn is [proposal, text] — pill above reply"
        );
        match &assistant.segments[0] {
            MessageSegment::Proposal {
                proposal_id,
                mutation_kind,
                status,
                entity_id,
            } => {
                assert_eq!(proposal_id, "proposal-graph");
                assert_eq!(mutation_kind, "apply_intent_graph");
                assert_eq!(status, "accepted");
                // The decided card names what changed: the anchor Entity the apply created.
                assert_eq!(entity_id.as_deref(), Some("entity-graph"));
            }
            other => panic!("segment[0] is the decided proposal, got {other:?}"),
        }
        match &assistant.segments[1] {
            MessageSegment::Text { text } => assert_eq!(text, "Done — added it."),
            other => panic!("segment[1] is the reply text, got {other:?}"),
        }
        // The Proposal tool call never rehydrates as a tool-activity row.
        assert!(
            !assistant
                .segments
                .iter()
                .any(|s| matches!(s, MessageSegment::ToolCall { .. })),
            "the decided Proposal surfaces via a proposal segment, never a tool row"
        );
    }

    /// ADR-0044: the REJECTED outcome rehydrates too (the "Dismissed." card), and
    /// its `status` passes through verbatim — pins the `rejected` arm of the
    /// `status IN ('accepted','rejected')` filter, which the accepted test alone
    /// leaves uncovered (a filter narrowed to accepted-only would still be green).
    #[tokio::test]
    async fn thread_get_rehydrates_rejected_proposal() {
        let pool = memory_pool().await;
        let thread_id = Uuid::now_v7();
        let run_id = Uuid::now_v7();
        let assistant_id = Uuid::now_v7();

        let mut tx = pool.begin().await.expect("begin");
        queries::insert_thread(&mut *tx, thread_id, "T", 1)
            .await
            .expect("thread");
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, \
              thinking_level, user_message_id, status, started_at) \
             VALUES (?, ?, 'w', '1', 'p', 'm', 'off', ?, 'running', 1)",
        )
        .bind(run_id.to_string())
        .bind(thread_id.to_string())
        .bind(assistant_id.to_string())
        .execute(&mut *tx)
        .await
        .expect("run");
        queries::insert_message(
            &mut *tx,
            assistant_id,
            thread_id,
            run_id,
            "assistant",
            "completed",
            1,
        )
        .await
        .expect("assistant message");
        queries::insert_text_part(&mut *tx, assistant_id, 0, "Logged.")
            .await
            .expect("text part");
        tx.commit().await.expect("commit seed");

        park_on_proposal(
            &pool,
            run_id,
            "proposal-rej",
            "tc-rej",
            "propose_workspace_mutation",
            r#"{"mutation_kind":"create_journal_entry","payload":{"occurred_at":"2026-06-10T10:30:00","body":[{"type":"text","text":"x"}]}}"#,
            "create_journal_entry",
            2,
        )
        .await
        .expect("park");
        let affected = queries::mark_proposal_rejected(&pool, "proposal-rej", None, 3)
            .await
            .expect("mark rejected");
        assert_eq!(affected, 1, "reject flips exactly the pending row");

        let (_title, rows) = get_thread_with_messages(&pool, thread_id)
            .await
            .expect("read ok")
            .expect("thread exists");
        let assistant = rows
            .iter()
            .find(|m| m.role == "assistant")
            .expect("assistant row");
        let proposal = assistant
            .segments
            .iter()
            .find_map(|s| match s {
                MessageSegment::Proposal {
                    mutation_kind,
                    status,
                    ..
                } => Some((mutation_kind, status)),
                _ => None,
            })
            .expect("rejected Proposal rehydrates as a proposal segment");
        assert_eq!(proposal.1, "rejected");
        assert_eq!(proposal.0, "create_journal_entry");
    }

    /// ADR-0045 reasoning amendment (#202): `thread/get` rehydrates a
    /// `type='reasoning'` part as a `MessageSegment::Reasoning` in `run_steps`
    /// order, carrying the streamed thinking text and a Core-computed
    /// `duration_ms` (the reasoning step's `created_at` to the NEXT step's), and
    /// the surrounding text segments are unaffected. The seeded timeline is
    /// `[text@t=10, reasoning@t=20, text@t=35]` — duration of the middle reasoning
    /// step is `35 - 20 = 15`. Reasoning text never folds into the reply text.
    #[tokio::test]
    async fn thread_get_rehydrates_reasoning_segment_with_duration() {
        let pool = memory_pool().await;
        let thread_id = Uuid::now_v7();
        let run_id = Uuid::now_v7();
        let assistant_id = Uuid::now_v7();

        let mut tx = pool.begin().await.expect("begin");
        queries::insert_thread(&mut *tx, thread_id, "T", 1)
            .await
            .expect("thread");
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, \
              thinking_level, user_message_id, status, started_at) \
             VALUES (?, ?, 'w', '1', 'p', 'm', 'medium', ?, 'completed', 1)",
        )
        .bind(run_id.to_string())
        .bind(thread_id.to_string())
        .bind(assistant_id.to_string())
        .execute(&mut *tx)
        .await
        .expect("run");
        queries::insert_message(
            &mut *tx,
            assistant_id,
            thread_id,
            run_id,
            "assistant",
            "completed",
            1,
        )
        .await
        .expect("assistant message");
        // Three contiguous parts, each its own message_parts + run_steps row, the
        // `created_at` of each step driving the duration window:
        //   seq 0  text       @ created_at=10
        //   seq 1  reasoning   @ created_at=20  → duration = 35 - 20 = 15
        //   seq 2  text        @ created_at=35
        queries::insert_text_part(&mut *tx, assistant_id, 0, "Let me check.")
            .await
            .expect("text part 0");
        queries::insert_message_run_step(&mut *tx, run_id, 0, assistant_id, 0, 10)
            .await
            .expect("text step 0");
        queries::insert_reasoning_part(&mut *tx, assistant_id, 1, "The user wants X.")
            .await
            .expect("reasoning part 1");
        queries::insert_message_run_step(&mut *tx, run_id, 1, assistant_id, 1, 20)
            .await
            .expect("reasoning step 1");
        queries::insert_text_part(&mut *tx, assistant_id, 2, "Done.")
            .await
            .expect("text part 2");
        queries::insert_message_run_step(&mut *tx, run_id, 2, assistant_id, 2, 35)
            .await
            .expect("text step 2");
        tx.commit().await.expect("commit seed");

        let (_title, rows) = get_thread_with_messages(&pool, thread_id)
            .await
            .expect("read ok")
            .expect("thread exists");
        let assistant = rows
            .iter()
            .find(|m| m.role == "assistant")
            .expect("assistant row");

        assert_eq!(
            assistant.segments.len(),
            3,
            "text, reasoning, text — in run_steps order"
        );
        match &assistant.segments[0] {
            MessageSegment::Text { text } => assert_eq!(text, "Let me check."),
            other => panic!("segment[0] is the leading text, got {other:?}"),
        }
        match &assistant.segments[1] {
            MessageSegment::Reasoning { text, duration_ms } => {
                assert_eq!(text, "The user wants X.");
                assert_eq!(
                    *duration_ms,
                    Some(15),
                    "duration = next step created_at (35) - this step's (20)"
                );
            }
            other => panic!("segment[1] is the reasoning segment, got {other:?}"),
        }
        match &assistant.segments[2] {
            MessageSegment::Text { text } => assert_eq!(text, "Done."),
            other => panic!("segment[2] is the trailing text, got {other:?}"),
        }
        // The reasoning text never leaks into the Message's flat reply text.
        assert_eq!(
            assistant.text(),
            "Let me check.Done.",
            "concatenated reply text excludes reasoning"
        );
    }

    /// ADR-0045 reasoning amendment: a reasoning step that is the LAST step of the
    /// Run draws its duration end from `runs.ended_at` (no next step). Seeded as a
    /// lone reasoning step @ created_at=20 with `runs.ended_at=50` → duration 30.
    #[tokio::test]
    async fn thread_get_reasoning_duration_uses_run_ended_at_when_last() {
        let pool = memory_pool().await;
        let thread_id = Uuid::now_v7();
        let run_id = Uuid::now_v7();
        let assistant_id = Uuid::now_v7();

        let mut tx = pool.begin().await.expect("begin");
        queries::insert_thread(&mut *tx, thread_id, "T", 1)
            .await
            .expect("thread");
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, \
              thinking_level, user_message_id, status, started_at, ended_at) \
             VALUES (?, ?, 'w', '1', 'p', 'm', 'medium', ?, 'completed', 1, 50)",
        )
        .bind(run_id.to_string())
        .bind(thread_id.to_string())
        .bind(assistant_id.to_string())
        .execute(&mut *tx)
        .await
        .expect("run");
        queries::insert_message(
            &mut *tx,
            assistant_id,
            thread_id,
            run_id,
            "assistant",
            "completed",
            1,
        )
        .await
        .expect("assistant message");
        queries::insert_reasoning_part(&mut *tx, assistant_id, 0, "Thinking it through.")
            .await
            .expect("reasoning part");
        queries::insert_message_run_step(&mut *tx, run_id, 0, assistant_id, 0, 20)
            .await
            .expect("reasoning step");
        tx.commit().await.expect("commit seed");

        let (_title, rows) = get_thread_with_messages(&pool, thread_id)
            .await
            .expect("read ok")
            .expect("thread exists");
        let assistant = rows
            .iter()
            .find(|m| m.role == "assistant")
            .expect("assistant row");
        match assistant.segments.as_slice() {
            [MessageSegment::Reasoning { text, duration_ms }] => {
                assert_eq!(text, "Thinking it through.");
                assert_eq!(
                    *duration_ms,
                    Some(30),
                    "last reasoning step's duration = run.ended_at (50) - created_at (20)"
                );
            }
            other => panic!("expected a lone reasoning segment, got {other:?}"),
        }
    }

    /// ADR-0045 reasoning amendment: a NEGATIVE reasoning span (the next step's
    /// `created_at` precedes this one's — clock skew / a non-monotonic stamp)
    /// yields `duration_ms = None`, not a negative number on the wire. Pins the
    /// `.filter(|&d| d >= 0)` guard in `segment_timeline`. Seeded as
    /// `[reasoning@t=20, text@t=10]` → raw span `10 - 20 = -10` → None.
    #[tokio::test]
    async fn thread_get_reasoning_negative_span_yields_none_duration() {
        let pool = memory_pool().await;
        let thread_id = Uuid::now_v7();
        let run_id = Uuid::now_v7();
        let assistant_id = Uuid::now_v7();

        let mut tx = pool.begin().await.expect("begin");
        queries::insert_thread(&mut *tx, thread_id, "T", 1)
            .await
            .expect("thread");
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, \
              thinking_level, user_message_id, status, started_at) \
             VALUES (?, ?, 'w', '1', 'p', 'm', 'medium', ?, 'completed', 1)",
        )
        .bind(run_id.to_string())
        .bind(thread_id.to_string())
        .bind(assistant_id.to_string())
        .execute(&mut *tx)
        .await
        .expect("run");
        queries::insert_message(
            &mut *tx,
            assistant_id,
            thread_id,
            run_id,
            "assistant",
            "completed",
            1,
        )
        .await
        .expect("assistant message");
        // Reasoning @ created_at=20, then a later-seq text step stamped EARLIER
        // (@10) — the next-step span is `10 - 20 = -10`, which the guard drops to None.
        queries::insert_reasoning_part(&mut *tx, assistant_id, 0, "Pondering.")
            .await
            .expect("reasoning part");
        queries::insert_message_run_step(&mut *tx, run_id, 0, assistant_id, 0, 20)
            .await
            .expect("reasoning step");
        queries::insert_text_part(&mut *tx, assistant_id, 1, "Reply.")
            .await
            .expect("text part");
        queries::insert_message_run_step(&mut *tx, run_id, 1, assistant_id, 1, 10)
            .await
            .expect("text step");
        tx.commit().await.expect("commit seed");

        let (_title, rows) = get_thread_with_messages(&pool, thread_id)
            .await
            .expect("read ok")
            .expect("thread exists");
        let assistant = rows
            .iter()
            .find(|m| m.role == "assistant")
            .expect("assistant row");
        match &assistant.segments[0] {
            MessageSegment::Reasoning { text, duration_ms } => {
                assert_eq!(text, "Pondering.");
                assert_eq!(
                    *duration_ms, None,
                    "a negative span (clock skew) is dropped to None, not sent negative"
                );
            }
            other => panic!("segment[0] is the reasoning segment, got {other:?}"),
        }
    }

    /// ADR-0045 reasoning amendment: duration is the IMMEDIATE NEXT step by `seq`,
    /// not the later step with the smallest `created_at`. Seeded so a LATER-seq step
    /// carries an EARLIER timestamp than the immediate next: `[reasoning@seq0 t=20,
    /// text@seq1 t=25, text@seq2 t=15]`. The correct duration is `25 - 20 = 5` (the
    /// seq-1 next step); a `MIN(created_at)` subquery would wrongly pick seq-2's t=15
    /// → `-5` → None. This pins the `ORDER BY nxt.seq LIMIT 1` fix.
    #[tokio::test]
    async fn thread_get_reasoning_duration_uses_immediate_next_seq_not_min_time() {
        let pool = memory_pool().await;
        let thread_id = Uuid::now_v7();
        let run_id = Uuid::now_v7();
        let assistant_id = Uuid::now_v7();

        let mut tx = pool.begin().await.expect("begin");
        queries::insert_thread(&mut *tx, thread_id, "T", 1)
            .await
            .expect("thread");
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, \
              thinking_level, user_message_id, status, started_at) \
             VALUES (?, ?, 'w', '1', 'p', 'm', 'medium', ?, 'completed', 1)",
        )
        .bind(run_id.to_string())
        .bind(thread_id.to_string())
        .bind(assistant_id.to_string())
        .execute(&mut *tx)
        .await
        .expect("run");
        queries::insert_message(
            &mut *tx,
            assistant_id,
            thread_id,
            run_id,
            "assistant",
            "completed",
            1,
        )
        .await
        .expect("assistant message");
        // reasoning @ seq 0, t=20 — the immediate next step (seq 1) is t=25, so the
        // correct span is 5. The seq-2 step is stamped EARLIER (t=15): a MIN-over-time
        // subquery would pick it and compute -5 (→ None); ORDER BY seq picks seq 1.
        queries::insert_reasoning_part(&mut *tx, assistant_id, 0, "Weighing.")
            .await
            .expect("reasoning part");
        queries::insert_message_run_step(&mut *tx, run_id, 0, assistant_id, 0, 20)
            .await
            .expect("reasoning step");
        queries::insert_text_part(&mut *tx, assistant_id, 1, "First.")
            .await
            .expect("text part 1");
        queries::insert_message_run_step(&mut *tx, run_id, 1, assistant_id, 1, 25)
            .await
            .expect("text step 1");
        queries::insert_text_part(&mut *tx, assistant_id, 2, "Second.")
            .await
            .expect("text part 2");
        queries::insert_message_run_step(&mut *tx, run_id, 2, assistant_id, 2, 15)
            .await
            .expect("text step 2");
        tx.commit().await.expect("commit seed");

        let (_title, rows) = get_thread_with_messages(&pool, thread_id)
            .await
            .expect("read ok")
            .expect("thread exists");
        let assistant = rows
            .iter()
            .find(|m| m.role == "assistant")
            .expect("assistant row");
        match &assistant.segments[0] {
            MessageSegment::Reasoning { text, duration_ms } => {
                assert_eq!(text, "Weighing.");
                assert_eq!(
                    *duration_ms,
                    Some(5),
                    "duration = immediate-next-seq step's created_at (25) - this (20), \
                     NOT the min-time later step (15)"
                );
            }
            other => panic!("segment[0] is the reasoning segment, got {other:?}"),
        }
    }

    /// ADR-0045 reasoning amendment: an empty-text reasoning part yields NO
    /// segment, mirroring the empty-text-part skip — a provider that opens a
    /// thinking block but emits no content never renders a "Thought" row.
    #[tokio::test]
    async fn thread_get_skips_empty_reasoning_part() {
        let pool = memory_pool().await;
        let thread_id = Uuid::now_v7();
        let run_id = Uuid::now_v7();
        let assistant_id = Uuid::now_v7();

        let mut tx = pool.begin().await.expect("begin");
        queries::insert_thread(&mut *tx, thread_id, "T", 1)
            .await
            .expect("thread");
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, \
              thinking_level, user_message_id, status, started_at, ended_at) \
             VALUES (?, ?, 'w', '1', 'p', 'm', 'medium', ?, 'completed', 1, 50)",
        )
        .bind(run_id.to_string())
        .bind(thread_id.to_string())
        .bind(assistant_id.to_string())
        .execute(&mut *tx)
        .await
        .expect("run");
        queries::insert_message(
            &mut *tx,
            assistant_id,
            thread_id,
            run_id,
            "assistant",
            "completed",
            1,
        )
        .await
        .expect("assistant message");
        // An empty reasoning part (seq 0) then a real reply text (seq 1).
        queries::insert_reasoning_part(&mut *tx, assistant_id, 0, "")
            .await
            .expect("empty reasoning part");
        queries::insert_message_run_step(&mut *tx, run_id, 0, assistant_id, 0, 20)
            .await
            .expect("reasoning step");
        queries::insert_text_part(&mut *tx, assistant_id, 1, "Here you go.")
            .await
            .expect("text part");
        queries::insert_message_run_step(&mut *tx, run_id, 1, assistant_id, 1, 30)
            .await
            .expect("text step");
        tx.commit().await.expect("commit seed");

        let (_title, rows) = get_thread_with_messages(&pool, thread_id)
            .await
            .expect("read ok")
            .expect("thread exists");
        let assistant = rows
            .iter()
            .find(|m| m.role == "assistant")
            .expect("assistant row");
        assert!(
            !assistant
                .segments
                .iter()
                .any(|s| matches!(s, MessageSegment::Reasoning { .. })),
            "an empty reasoning part must not rehydrate as a segment"
        );
        match assistant.segments.as_slice() {
            [MessageSegment::Text { text }] => assert_eq!(text, "Here you go."),
            other => panic!("only the reply text segment survives, got {other:?}"),
        }
    }

    /// ADR-0045 reasoning amendment (correctness-critical): a reasoning part is
    /// DISPLAY-ONLY — `read_run_timeline` (the resume transcript reader) must NEVER
    /// surface it as a `TimelineStep::Message`. Replaying thinking without its
    /// provider signature is a live correctness hazard (#201 defers the signed
    /// round-trip), so the resume transcript carries only the surrounding text.
    #[tokio::test]
    async fn read_run_timeline_excludes_reasoning_parts() {
        let pool = memory_pool().await;
        let thread_id = Uuid::now_v7();
        let run_id = Uuid::now_v7();
        let assistant_id = Uuid::now_v7();

        let mut tx = pool.begin().await.expect("begin");
        queries::insert_thread(&mut *tx, thread_id, "T", 1)
            .await
            .expect("thread");
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, \
              thinking_level, user_message_id, status, started_at) \
             VALUES (?, ?, 'w', '1', 'p', 'm', 'medium', ?, 'parked', 1)",
        )
        .bind(run_id.to_string())
        .bind(thread_id.to_string())
        .bind(assistant_id.to_string())
        .execute(&mut *tx)
        .await
        .expect("run");
        queries::insert_message(
            &mut *tx,
            assistant_id,
            thread_id,
            run_id,
            "assistant",
            "completed",
            1,
        )
        .await
        .expect("assistant message");
        // text @ seq 0, reasoning @ seq 1, text @ seq 2 — the reasoning must drop
        // from the resume transcript while the two text steps replay verbatim.
        queries::insert_text_part(&mut *tx, assistant_id, 0, "Replying now.")
            .await
            .expect("text part 0");
        queries::insert_message_run_step(&mut *tx, run_id, 0, assistant_id, 0, 10)
            .await
            .expect("text step 0");
        queries::insert_reasoning_part(&mut *tx, assistant_id, 1, "SECRET-REASONING")
            .await
            .expect("reasoning part 1");
        queries::insert_message_run_step(&mut *tx, run_id, 1, assistant_id, 1, 20)
            .await
            .expect("reasoning step 1");
        queries::insert_text_part(&mut *tx, assistant_id, 2, "All set.")
            .await
            .expect("text part 2");
        queries::insert_message_run_step(&mut *tx, run_id, 2, assistant_id, 2, 30)
            .await
            .expect("text step 2");
        tx.commit().await.expect("commit seed");

        let steps = read_run_timeline(&pool, run_id).await.expect("timeline");

        // No step's text equals the reasoning text — it never replays.
        assert!(
            !steps.iter().any(|s| matches!(
                s,
                TimelineStep::Message { text, .. } if text == "SECRET-REASONING"
            )),
            "a reasoning part must never become a resume transcript Message step"
        );
        // The surrounding text steps still resolve.
        let texts: Vec<&str> = steps
            .iter()
            .filter_map(|s| match s {
                TimelineStep::Message { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            texts,
            vec!["Replying now.", "All set."],
            "text steps replay verbatim, reasoning is dropped"
        );
    }

    /// ADR-0044 (entity_id amendment, re-landed on the ADR-0045 segment timeline):
    /// an UPDATE-kind decided Proposal (update_person/project/todo) names the Entity
    /// it revised. The revision wrote an `entity_revisions` row stamped with the
    /// Proposal's id — there is NO `created_via_proposal_id` entities row for this
    /// Proposal (the Entity pre-existed, minted by another decision). Pins the
    /// `entity_revisions.proposal_id` UNION arm of the entity_id subquery, which the
    /// create-arm test never exercises. The assertion target moved from the deleted
    /// `MessageProposalView.entity_id` to the proposal SEGMENT's `entity_id`.
    #[tokio::test]
    async fn thread_get_rehydrates_updated_entity_via_revision_arm() {
        let pool = memory_pool().await;
        let thread_id = Uuid::now_v7();
        let run_id = Uuid::now_v7();
        let assistant_id = Uuid::now_v7();

        let mut tx = pool.begin().await.expect("begin");
        queries::insert_thread(&mut *tx, thread_id, "T", 1)
            .await
            .expect("thread");
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, \
              thinking_level, user_message_id, status, started_at) \
             VALUES (?, ?, 'w', '1', 'p', 'm', 'off', ?, 'running', 1)",
        )
        .bind(run_id.to_string())
        .bind(thread_id.to_string())
        .bind(assistant_id.to_string())
        .execute(&mut *tx)
        .await
        .expect("run");
        queries::insert_message(
            &mut *tx,
            assistant_id,
            thread_id,
            run_id,
            "assistant",
            "completed",
            1,
        )
        .await
        .expect("assistant message");
        queries::insert_text_part(&mut *tx, assistant_id, 0, "Updated.")
            .await
            .expect("text part");
        tx.commit().await.expect("commit seed");

        park_on_proposal(
            &pool,
            run_id,
            "proposal-update",
            "tc-update",
            "propose_workspace_mutation",
            r#"{"mutation_kind":"update_todo","payload":{"entity_id":"entity-pre","status":"done"}}"#,
            "update_todo",
            2,
        )
        .await
        .expect("park");
        let affected = queries::mark_proposal_accepted(&pool, "proposal-update", None, None, 3)
            .await
            .expect("mark accepted");
        assert_eq!(affected, 1, "accept flips exactly the pending row");

        // The Entity pre-existed (minted by an earlier user/decision, NOT this
        // Proposal — so `created_via_proposal_id` is NULL here). The update wrote a
        // seq-2 `entity_revisions` row carrying THIS Proposal's id. Only the
        // revision arm of the subquery can resolve it.
        sqlx::query(
            "INSERT INTO entities \
             (id, type, schema_version, data, created_by, created_via_proposal_id, \
              created_at, updated_at) \
             VALUES ('entity-pre', 'todo', 1, '{\"title\":\"x\"}', 'user', NULL, 1, 4)",
        )
        .execute(&pool)
        .await
        .expect("seed pre-existing entity");
        sqlx::query(
            "INSERT INTO entity_revisions (entity_id, seq, data, proposal_id, created_at) \
             VALUES ('entity-pre', 2, '{\"title\":\"x\",\"status\":\"done\"}', 'proposal-update', 4)",
        )
        .execute(&pool)
        .await
        .expect("seed revision stamped with the proposal");

        let (_title, rows) = get_thread_with_messages(&pool, thread_id)
            .await
            .expect("read ok")
            .expect("thread exists");
        let assistant = rows
            .iter()
            .find(|m| m.role == "assistant")
            .expect("assistant row");
        let (mutation_kind, status, entity_id) = assistant
            .segments
            .iter()
            .find_map(|s| match s {
                MessageSegment::Proposal {
                    mutation_kind,
                    status,
                    entity_id,
                    ..
                } => Some((mutation_kind, status, entity_id)),
                _ => None,
            })
            .expect("decided update Proposal rehydrates as a proposal segment");
        assert_eq!(status, "accepted");
        assert_eq!(mutation_kind, "update_todo");
        // The decided update card names the revised Entity, resolved via the
        // `entity_revisions.proposal_id` arm.
        assert_eq!(entity_id.as_deref(), Some("entity-pre"));
    }

    /// ADR-0044 finding 1 (re-landed on the ADR-0045 segment timeline): a
    /// multi-entity `apply_intent_graph` apply mints several entities in ONE tx, ALL
    /// stamped with the same `created_at`. The live decide anchor (and the
    /// decide-result entity_id) is the Journal Entry id when a JE node is present
    /// (`intent_graph.rs` `anchor_entity_id`), else the first minted entity. The
    /// read-path subquery must resolve that SAME anchor deterministically — without
    /// a JE-biased, stable tiebreaker its `ORDER BY created_at DESC` ties and returns
    /// an arbitrary entity that can flip between reloads.
    #[tokio::test]
    async fn thread_get_resolves_journal_entry_anchor_on_tie() {
        let pool = memory_pool().await;
        let thread_id = Uuid::now_v7();
        let run_id = Uuid::now_v7();
        let assistant_id = Uuid::now_v7();

        let mut tx = pool.begin().await.expect("begin");
        queries::insert_thread(&mut *tx, thread_id, "T", 1)
            .await
            .expect("thread");
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, \
              thinking_level, user_message_id, status, started_at) \
             VALUES (?, ?, 'w', '1', 'p', 'm', 'off', ?, 'running', 1)",
        )
        .bind(run_id.to_string())
        .bind(thread_id.to_string())
        .bind(assistant_id.to_string())
        .execute(&mut *tx)
        .await
        .expect("run");
        queries::insert_message(
            &mut *tx,
            assistant_id,
            thread_id,
            run_id,
            "assistant",
            "completed",
            1,
        )
        .await
        .expect("assistant message");
        queries::insert_text_part(&mut *tx, assistant_id, 0, "Logged.")
            .await
            .expect("text part");
        tx.commit().await.expect("commit seed");

        park_on_proposal(
            &pool,
            run_id,
            "proposal-multi",
            "tc-multi",
            "propose_workspace_mutation",
            r#"{"mutation_kind":"apply_intent_graph","payload":{"entities":[],"links":[]}}"#,
            "apply_intent_graph",
            2,
        )
        .await
        .expect("park");
        let affected = queries::mark_proposal_accepted(&pool, "proposal-multi", None, None, 3)
            .await
            .expect("mark accepted");
        assert_eq!(affected, 1, "accept flips exactly the pending row");

        // Three entities minted in one tx, ALL at created_at = 4 (no clock advances
        // within an apply). The JE is the anchor. The non-JE ids sort AFTER the JE
        // id lexicographically, so a tiebreaker-less `created_at DESC` (or one that
        // only adds `entity_id DESC`) would pick a non-JE row — this pins the
        // JE-first bias.
        for (id, ty) in [
            ("entity-person", "person"),
            ("entity-je", "journal_entry"),
            ("entity-todo", "todo"),
        ] {
            sqlx::query(
                "INSERT INTO entities \
                 (id, type, schema_version, data, created_by, created_via_proposal_id, \
                  created_at, updated_at) \
                 VALUES (?, ?, 1, '{}', 'proposal', 'proposal-multi', 4, 4)",
            )
            .bind(id)
            .bind(ty)
            .execute(&pool)
            .await
            .expect("seed entity minted via the proposal");
        }

        let (_title, rows) = get_thread_with_messages(&pool, thread_id)
            .await
            .expect("read ok")
            .expect("thread exists");
        let assistant = rows
            .iter()
            .find(|m| m.role == "assistant")
            .expect("assistant row");
        let (status, entity_id) = assistant
            .segments
            .iter()
            .find_map(|s| match s {
                MessageSegment::Proposal {
                    status, entity_id, ..
                } => Some((status, entity_id)),
                _ => None,
            })
            .expect("decided multi-entity Proposal rehydrates as a proposal segment");
        assert_eq!(status, "accepted");
        // The read resolves the JE anchor — the SAME entity the live decide result
        // named — not an arbitrary tie winner.
        assert_eq!(entity_id.as_deref(), Some("entity-je"));
    }

    /// ADR-0044 (entity_id amendment): a REJECTED Proposal created nothing, so the
    /// proposal segment carries no `entity_id` — pins the `None` arm (the resolver is
    /// only invoked for the decided proposal, and a reject resolves no Entity).
    #[tokio::test]
    async fn thread_get_rejected_proposal_segment_has_no_entity_id() {
        let pool = memory_pool().await;
        let thread_id = Uuid::now_v7();
        let run_id = Uuid::now_v7();
        let assistant_id = Uuid::now_v7();

        let mut tx = pool.begin().await.expect("begin");
        queries::insert_thread(&mut *tx, thread_id, "T", 1)
            .await
            .expect("thread");
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, \
              thinking_level, user_message_id, status, started_at) \
             VALUES (?, ?, 'w', '1', 'p', 'm', 'off', ?, 'running', 1)",
        )
        .bind(run_id.to_string())
        .bind(thread_id.to_string())
        .bind(assistant_id.to_string())
        .execute(&mut *tx)
        .await
        .expect("run");
        queries::insert_message(
            &mut *tx,
            assistant_id,
            thread_id,
            run_id,
            "assistant",
            "completed",
            1,
        )
        .await
        .expect("assistant message");
        queries::insert_text_part(&mut *tx, assistant_id, 0, "Logged.")
            .await
            .expect("text part");
        tx.commit().await.expect("commit seed");

        park_on_proposal(
            &pool,
            run_id,
            "proposal-rej-eid",
            "tc-rej-eid",
            "propose_workspace_mutation",
            r#"{"mutation_kind":"create_journal_entry","payload":{"occurred_at":"2026-06-10T10:30:00","body":[{"type":"text","text":"x"}]}}"#,
            "create_journal_entry",
            2,
        )
        .await
        .expect("park");
        let affected = queries::mark_proposal_rejected(&pool, "proposal-rej-eid", None, 3)
            .await
            .expect("mark rejected");
        assert_eq!(affected, 1, "reject flips exactly the pending row");

        let (_title, rows) = get_thread_with_messages(&pool, thread_id)
            .await
            .expect("read ok")
            .expect("thread exists");
        let assistant = rows
            .iter()
            .find(|m| m.role == "assistant")
            .expect("assistant row");
        let (status, entity_id) = assistant
            .segments
            .iter()
            .find_map(|s| match s {
                MessageSegment::Proposal {
                    status, entity_id, ..
                } => Some((status, entity_id)),
                _ => None,
            })
            .expect("rejected Proposal rehydrates as a proposal segment");
        assert_eq!(status, "rejected");
        // A rejected Proposal created nothing, so there is no entity to name.
        assert_eq!(*entity_id, None);
    }

    /// ADR-0044: a CANCELLED Proposal does NOT rehydrate (its parked Run was
    /// cancelled — nothing to review). Pins the `cancelled` exclusion of the
    /// `status IN ('accepted','rejected')` allowlist; a filter widened to
    /// `status <> 'pending'` would wrongly surface it and stay green otherwise.
    #[tokio::test]
    async fn thread_get_excludes_cancelled_proposal() {
        let pool = memory_pool().await;
        let thread_id = Uuid::now_v7();
        let run_id = Uuid::now_v7();
        let assistant_id = Uuid::now_v7();

        let mut tx = pool.begin().await.expect("begin");
        queries::insert_thread(&mut *tx, thread_id, "T", 1)
            .await
            .expect("thread");
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, \
              thinking_level, user_message_id, status, started_at) \
             VALUES (?, ?, 'w', '1', 'p', 'm', 'off', ?, 'running', 1)",
        )
        .bind(run_id.to_string())
        .bind(thread_id.to_string())
        .bind(assistant_id.to_string())
        .execute(&mut *tx)
        .await
        .expect("run");
        queries::insert_message(
            &mut *tx,
            assistant_id,
            thread_id,
            run_id,
            "assistant",
            "completed",
            1,
        )
        .await
        .expect("assistant message");
        queries::insert_text_part(&mut *tx, assistant_id, 0, "Logged.")
            .await
            .expect("text part");
        tx.commit().await.expect("commit seed");

        park_on_proposal(
            &pool,
            run_id,
            "proposal-cancel",
            "tc-cancel",
            "propose_workspace_mutation",
            r#"{"mutation_kind":"create_journal_entry","payload":{"occurred_at":"2026-06-10T10:30:00","body":[{"type":"text","text":"x"}]}}"#,
            "create_journal_entry",
            2,
        )
        .await
        .expect("park");
        let affected = queries::mark_proposal_cancelled(&pool, "proposal-cancel")
            .await
            .expect("mark cancelled");
        assert_eq!(affected, 1, "cancel flips exactly the pending row");

        let (_title, rows) = get_thread_with_messages(&pool, thread_id)
            .await
            .expect("read ok")
            .expect("thread exists");
        let assistant = rows
            .iter()
            .find(|m| m.role == "assistant")
            .expect("assistant row");
        assert!(
            !assistant
                .segments
                .iter()
                .any(|s| matches!(s, MessageSegment::Proposal { .. })),
            "a cancelled Proposal must not rehydrate as a proposal segment"
        );
    }

    /// ADR-0044/0045: a Run that parks MORE THAN ONCE (decide, resume, park again)
    /// rehydrates exactly ONE proposal segment — its MOST-RECENT decided outcome —
    /// not one per park. The superseded `decided_proposal_for_run` read collapsed to
    /// `decided_at DESC LIMIT 1`; the segment walk must preserve that one-indicator-
    /// per-turn rule, else a double-park turn shows the first outcome twice (both
    /// cards read the single `run_id`-keyed live proposal) and loses the second.
    #[tokio::test]
    async fn thread_get_rehydrates_only_the_most_recent_of_two_decided_proposals() {
        let pool = memory_pool().await;
        let thread_id = Uuid::now_v7();
        let run_id = Uuid::now_v7();
        let assistant_id = Uuid::now_v7();

        let mut tx = pool.begin().await.expect("begin");
        queries::insert_thread(&mut *tx, thread_id, "T", 1)
            .await
            .expect("thread");
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, \
              thinking_level, user_message_id, status, started_at) \
             VALUES (?, ?, 'w', '1', 'p', 'm', 'off', ?, 'running', 1)",
        )
        .bind(run_id.to_string())
        .bind(thread_id.to_string())
        .bind(assistant_id.to_string())
        .execute(&mut *tx)
        .await
        .expect("run");
        queries::insert_message(
            &mut *tx,
            assistant_id,
            thread_id,
            run_id,
            "assistant",
            "completed",
            1,
        )
        .await
        .expect("assistant message");
        tx.commit().await.expect("commit seed");

        // FIRST park + accept (the earlier decision).
        park_on_proposal(
            &pool,
            run_id,
            "proposal-first",
            "tc-first",
            "propose_workspace_mutation",
            r#"{"mutation_kind":"apply_intent_graph","payload":{"entities":[],"links":[]}}"#,
            "apply_intent_graph",
            2,
        )
        .await
        .expect("park 1");
        queries::mark_proposal_accepted(&pool, "proposal-first", None, None, 3)
            .await
            .expect("accept 1");
        // Resume returns the Run to `running` so the second park can win its guard,
        // mirroring `worker::resume` (parked -> running) before a second proposal.
        queries::mark_run_running(&pool, run_id)
            .await
            .expect("resume 1 -> running");

        // SECOND park + accept (the later decision; lands at a higher seq).
        park_on_proposal(
            &pool,
            run_id,
            "proposal-second",
            "tc-second",
            "propose_workspace_mutation",
            r#"{"mutation_kind":"create_journal_entry","payload":{"occurred_at":"2026-06-10T10:30:00","body":[{"type":"text","text":"x"}]}}"#,
            "create_journal_entry",
            4,
        )
        .await
        .expect("park 2");
        queries::mark_proposal_accepted(&pool, "proposal-second", None, None, 5)
            .await
            .expect("accept 2");

        let (_title, rows) = get_thread_with_messages(&pool, thread_id)
            .await
            .expect("read ok")
            .expect("thread exists");
        let assistant = rows
            .iter()
            .find(|m| m.role == "assistant")
            .expect("assistant row");

        let proposals: Vec<&MessageSegment> = assistant
            .segments
            .iter()
            .filter(|s| matches!(s, MessageSegment::Proposal { .. }))
            .collect();
        assert_eq!(
            proposals.len(),
            1,
            "a twice-parked Run rehydrates ONE proposal segment, not one per park"
        );
        match proposals[0] {
            MessageSegment::Proposal { proposal_id, .. } => assert_eq!(
                proposal_id, "proposal-second",
                "the surviving segment is the MOST-RECENT decided Proposal"
            ),
            other => panic!("expected a proposal segment, got {other:?}"),
        }
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

    /// `update_thread_title` overwrites a Thread's title by id WITHOUT bumping
    /// `last_activity_at` (titling is not activity), and is a silent no-op when the
    /// row is absent.
    #[tokio::test]
    async fn update_thread_title_overwrites_and_is_noop_when_absent() {
        let pool = memory_pool().await;
        let thread_id = Uuid::now_v7();
        persist_thread_with_first_run(
            &pool,
            thread_id,
            Uuid::now_v7(),
            Uuid::now_v7(),
            Uuid::now_v7(),
            &fixture_workflow(),
            "hello",
            "old",
            7,
        )
        .await
        .expect("persist thread");

        // Capture the persisted last_activity_at before retitling.
        let before = list_threads(&pool).await.expect("list before");
        let (_, title_before, activity_before) = before
            .iter()
            .find(|(id, _, _)| *id == thread_id.to_string())
            .expect("thread row before");
        assert_eq!(title_before, "old");

        update_thread_title(&pool, thread_id, "New Title")
            .await
            .expect("update title");

        let after = list_threads(&pool).await.expect("list after");
        let (_, title_after, activity_after) = after
            .iter()
            .find(|(id, _, _)| *id == thread_id.to_string())
            .expect("thread row after");
        assert_eq!(title_after, "New Title", "title is overwritten by id");
        assert_eq!(
            activity_after, activity_before,
            "retitling does NOT bump last_activity_at"
        );

        // An absent id is a silent no-op: Ok, nothing changed, no error/panic.
        update_thread_title(&pool, Uuid::now_v7(), "X")
            .await
            .expect("update of an absent thread is a no-op Ok");
    }

    // ─── entity/backlinks read (ADR-0050) ──────────────────────────────────

    /// Seed one `entities` row with an explicit `created_at`/`updated_at`, so a
    /// read's newest-first ordering can be exercised (the bare `seed_entity`
    /// pins both to `1`).
    async fn seed_entity_at(
        pool: &SqlitePool,
        id: &str,
        entity_type: &str,
        data: &str,
        created_at: i64,
    ) {
        sqlx::query(
            "INSERT INTO entities \
             (id, type, schema_version, data, created_by, created_via_proposal_id, \
              created_at, updated_at) \
             VALUES (?, ?, 1, ?, 'user', NULL, ?, ?)",
        )
        .bind(id)
        .bind(entity_type)
        .bind(data)
        .bind(created_at)
        .bind(created_at)
        .execute(pool)
        .await
        .expect("insert entity at");
    }

    /// Insert one `entity_refs` row directly (a Journal Entry → target link).
    async fn seed_entity_ref(pool: &SqlitePool, id: &str, source_je: &str, target: &str) {
        sqlx::query(
            "INSERT INTO entity_refs \
             (id, source_entity_id, target_entity_id, label_snapshot, created_at) \
             VALUES (?, ?, ?, NULL, 1)",
        )
        .bind(id)
        .bind(source_je)
        .bind(target)
        .execute(pool)
        .await
        .expect("insert entity_ref");
    }

    fn je_data(occurred_at: &str, text: &str) -> String {
        serde_json::json!({
            "occurred_at": occurred_at,
            "body": [{ "type": "text", "text": text }],
        })
        .to_string()
    }

    /// `backlinks_for_entity` resolves the two reverse sets for a Person, Project,
    /// or Todo: `mentioned_in` (DISTINCT Journal Entries referencing it, with their
    /// `refs` + `source` attached, newest-occurred first) and `linked_todos` (the
    /// Todos linked via `person_refs` for a Person / `project_id` for a Project,
    /// each carrying its `person_refs`, newest-first; empty for a Todo target).
    #[tokio::test]
    async fn backlinks_resolves_mentioned_in_and_linked_todos() {
        let pool = memory_pool().await;

        // Provenance for the mentioning JEs (so each JE row carries its `source`).
        seed_thread_message(&pool, "thr-1", "Morning dump", "msg-1").await;

        // Targets.
        seed_entity(&pool, "person-a", "person", r#"{"name":"Alice"}"#).await;
        seed_entity(&pool, "proj-a", "project", r#"{"name":"Lead Ads"}"#).await;
        seed_entity(&pool, "todo-standalone", "todo", r#"{"title":"Standalone"}"#).await;
        seed_entity(&pool, "person-zero", "person", r#"{"name":"Nobody"}"#).await;

        // Journal Entries with refs. JE-older and JE-newer both reference Alice;
        // JE-newer occurred later. JE-newer references Alice via TWO ref rows would
        // be blocked by the (source,target) UNIQUE constraint, so dedupe is proven
        // by asserting each distinct JE appears exactly ONCE.
        seed_entity_at(
            &pool,
            "je-older",
            "journal_entry",
            &je_data("2026-06-01T09:00:00", "Met Alice"),
            10,
        )
        .await;
        seed_entity_at(
            &pool,
            "je-newer",
            "journal_entry",
            &je_data("2026-06-05T09:00:00", "Alice again, re Lead Ads"),
            20,
        )
        .await;
        seed_entity_at(
            &pool,
            "je-proj",
            "journal_entry",
            &je_data("2026-06-03T09:00:00", "Lead Ads kickoff"),
            15,
        )
        .await;
        seed_entity_at(
            &pool,
            "je-todo",
            "journal_entry",
            &je_data("2026-06-02T09:00:00", "Mentioned the standalone todo"),
            12,
        )
        .await;

        // Each mentioning JE is `created_from` the user Message (so `source`
        // attaches), exercising the same provenance assembly as `entity/list`.
        for (src_id, je) in [
            ("s-older", "je-older"),
            ("s-newer", "je-newer"),
            ("s-proj", "je-proj"),
            ("s-todo", "je-todo"),
        ] {
            seed_source(&pool, src_id, je, Some("msg-1"), None, "created_from", 5).await;
        }

        // Refs: both JEs → Alice; JE-newer also → the Project (so JE-newer carries
        // multiple refs). JE-proj → Project, JE-todo → the standalone Todo.
        seed_entity_ref(&pool, "ref-1", "je-older", "person-a").await;
        seed_entity_ref(&pool, "ref-2", "je-newer", "person-a").await;
        seed_entity_ref(&pool, "ref-3", "je-newer", "proj-a").await;
        seed_entity_ref(&pool, "ref-4", "je-proj", "proj-a").await;
        seed_entity_ref(&pool, "ref-5", "je-todo", "todo-standalone").await;

        // Linked todos. Alice is on two todos (waiting_on + related → all roles);
        // the Project owns one todo. `t-wait` is newer than `t-rel` so newest-first
        // ordering is observable.
        seed_entity_at(&pool, "t-rel", "todo", r#"{"title":"Older task"}"#, 30).await;
        seed_entity_at(
            &pool,
            "t-wait",
            "todo",
            r#"{"title":"Newer task"}"#,
            40,
        )
        .await;
        seed_ref(&pool, "t-rel", "person-a", "related").await;
        seed_ref(&pool, "t-wait", "person-a", "waiting_on").await;
        seed_entity_at(
            &pool,
            "t-proj",
            "todo",
            r#"{"title":"Project task","project_id":"proj-a"}"#,
            35,
        )
        .await;

        // ── Person target ──────────────────────────────────────────────────
        let person = backlinks_for_entity(&pool, "person-a")
            .await
            .expect("backlinks for person");

        let mentioned_ids: Vec<&str> = person
            .mentioned_in
            .iter()
            .map(|row| row.id.as_str())
            .collect();
        assert_eq!(
            mentioned_ids,
            vec!["je-newer", "je-older"],
            "distinct JEs mentioning the Person, newest-occurred first"
        );
        // Each JE row carries its refs (reuse of the entity/list JE assembly) and
        // its source provenance.
        let je_newer = person
            .mentioned_in
            .iter()
            .find(|r| r.id == "je-newer")
            .expect("je-newer row");
        assert_eq!(
            je_newer.refs.len(),
            2,
            "je-newer carries both of its entity_refs (Alice + Project)"
        );
        assert!(
            matches!(
                je_newer.source.as_ref(),
                Some(EntityProvenance::Message { thread_id, .. }) if thread_id == "thr-1"
            ),
            "mentioned-in JE carries its Captured-from provenance"
        );

        let linked_ids: Vec<&str> = person
            .linked_todos
            .iter()
            .map(|row| row.id.as_str())
            .collect();
        assert_eq!(
            linked_ids,
            vec!["t-wait", "t-rel"],
            "Person's linked todos across all roles, newest-first"
        );
        // person_refs ride along on each linked Todo (the GTD Waiting/Tasks split).
        let wait = person
            .linked_todos
            .iter()
            .find(|r| r.id == "t-wait")
            .expect("t-wait row");
        assert_eq!(
            wait.person_refs,
            vec![("person-a".to_string(), "waiting_on".to_string())],
            "linked Todo carries its person_refs"
        );

        // ── Project target (same result shape) ───────────────────────────────
        let project = backlinks_for_entity(&pool, "proj-a")
            .await
            .expect("backlinks for project");
        let proj_mentioned: Vec<&str> = project
            .mentioned_in
            .iter()
            .map(|row| row.id.as_str())
            .collect();
        assert_eq!(
            proj_mentioned,
            vec!["je-newer", "je-proj"],
            "distinct JEs mentioning the Project, newest-occurred first"
        );
        let proj_linked: Vec<&str> = project
            .linked_todos
            .iter()
            .map(|row| row.id.as_str())
            .collect();
        assert_eq!(
            proj_linked,
            vec!["t-proj"],
            "Project's linked todos via project_id"
        );

        // ── Todo target (Mentioned-in only; no linked todos) ─────────────────
        let todo = backlinks_for_entity(&pool, "todo-standalone")
            .await
            .expect("backlinks for todo");
        let todo_mentioned: Vec<&str> = todo
            .mentioned_in
            .iter()
            .map(|row| row.id.as_str())
            .collect();
        assert_eq!(todo_mentioned, vec!["je-todo"], "the JE mentioning the Todo");
        assert!(
            todo.linked_todos.is_empty(),
            "a Todo has no linked todos (Mentioned-in only)"
        );

        // ── Zero-backlink entity → both sets empty ───────────────────────────
        let empty = backlinks_for_entity(&pool, "person-zero")
            .await
            .expect("backlinks for zero-backlink person");
        assert!(
            empty.mentioned_in.is_empty() && empty.linked_todos.is_empty(),
            "a referenced-by-nothing entity yields empty sets"
        );
    }

    // ─── thread archive lifecycle (ADR-0052) ──────────────────────────────

    /// Seed a Thread carrying a Run, a Message, an Entity, and an
    /// `entity_sources` row pointing at that Message — the minimal provenance
    /// chain an archive must NOT cascade away. Returns the Thread id.
    async fn seed_thread_with_provenance(pool: &SqlitePool, suffix: &str) -> Uuid {
        let thread_id = Uuid::now_v7();
        let run_id = format!("run-{suffix}");
        let msg_id = format!("msg-{suffix}");
        let entity_id = format!("ent-{suffix}");
        let source_id = format!("src-{suffix}");

        let mut tx = pool.begin().await.expect("begin");
        sqlx::query(
            "INSERT INTO threads (id, title, created_at, last_activity_at) VALUES (?, ?, 1, 1)",
        )
        .bind(thread_id.to_string())
        .bind(format!("Thread {suffix}"))
        .execute(&mut *tx)
        .await
        .expect("insert thread");
        // user_message_id FK is DEFERRABLE (resolved at COMMIT).
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, \
              thinking_level, user_message_id, status, started_at) \
             VALUES (?, ?, 'w', '1', 'p', 'm', 'off', ?, 'completed', 1)",
        )
        .bind(&run_id)
        .bind(thread_id.to_string())
        .bind(&msg_id)
        .execute(&mut *tx)
        .await
        .expect("insert run");
        sqlx::query(
            "INSERT INTO messages (id, thread_id, run_id, role, status, created_at, updated_at) \
             VALUES (?, ?, ?, 'user', 'completed', 1, 1)",
        )
        .bind(&msg_id)
        .bind(thread_id.to_string())
        .bind(&run_id)
        .execute(&mut *tx)
        .await
        .expect("insert message");
        sqlx::query(
            "INSERT INTO entities \
             (id, type, schema_version, data, created_by, created_via_proposal_id, \
              created_at, updated_at) \
             VALUES (?, 'todo', 1, '{}', 'user', NULL, 1, 1)",
        )
        .bind(&entity_id)
        .execute(&mut *tx)
        .await
        .expect("insert entity");
        sqlx::query(
            "INSERT INTO entity_sources \
             (id, entity_id, source_message_id, relation, created_at) \
             VALUES (?, ?, ?, 'created_from', 1)",
        )
        .bind(&source_id)
        .bind(&entity_id)
        .bind(&msg_id)
        .execute(&mut *tx)
        .await
        .expect("insert entity_source");
        tx.commit().await.expect("commit seed");
        thread_id
    }

    async fn count_rows(pool: &SqlitePool, sql: &str, bind: &str) -> i64 {
        sqlx::query_scalar(sql)
            .bind(bind)
            .fetch_one(pool)
            .await
            .expect("count")
    }

    /// Archiving drops a Thread from the default `list_threads` and moves it to
    /// `list_archived_threads`, WITHOUT cascading away its messages or
    /// entity_sources (archive-not-delete, ADR-0052); unarchiving restores it.
    #[tokio::test]
    async fn archive_hides_from_default_list_and_preserves_provenance() {
        let pool = memory_pool().await;
        let thread_id = seed_thread_with_provenance(&pool, "a").await;
        let msg_id = "msg-a".to_string();
        let entity_id = "ent-a".to_string();

        // Active: in the default list, absent from the archived list.
        let active = list_threads(&pool).await.expect("list active");
        assert!(
            active.iter().any(|(id, ..)| *id == thread_id.to_string()),
            "a fresh Thread is in the default list"
        );
        let archived = list_archived_threads(&pool).await.expect("list archived");
        assert!(
            archived.is_empty(),
            "no Thread is archived yet, got {archived:?}"
        );

        // Archive → leaves the default list, enters the archived list.
        archive_thread(&pool, thread_id, 1234).await.expect("archive");
        let active = list_threads(&pool).await.expect("list after archive");
        assert!(
            !active.iter().any(|(id, ..)| *id == thread_id.to_string()),
            "an archived Thread is hidden from the default list"
        );
        let archived = list_archived_threads(&pool)
            .await
            .expect("list archived after archive");
        assert_eq!(
            archived.iter().map(|(id, ..)| id.clone()).collect::<Vec<_>>(),
            vec![thread_id.to_string()],
            "the archived Thread is in the archived list"
        );

        // Provenance survives: the Message and its entity_source still exist.
        let msg_count = count_rows(
            &pool,
            "SELECT COUNT(*) FROM messages WHERE id = ?1",
            &msg_id,
        )
        .await;
        assert_eq!(msg_count, 1, "archive did not cascade away the Message");
        let source_count = count_rows(
            &pool,
            "SELECT COUNT(*) FROM entity_sources WHERE entity_id = ?1",
            &entity_id,
        )
        .await;
        assert_eq!(
            source_count, 1,
            "archive did not cascade away the entity_source"
        );

        // Unarchive → back in the default list, gone from the archived list.
        unarchive_thread(&pool, thread_id).await.expect("unarchive");
        let active = list_threads(&pool).await.expect("list after unarchive");
        assert!(
            active.iter().any(|(id, ..)| *id == thread_id.to_string()),
            "an unarchived Thread returns to the default list"
        );
        let archived = list_archived_threads(&pool)
            .await
            .expect("list archived after unarchive");
        assert!(
            archived.is_empty(),
            "an unarchived Thread leaves the archived list, got {archived:?}"
        );
    }

    /// `list_archived_threads` orders newest-archived first (`archived_at DESC`).
    #[tokio::test]
    async fn archive_orders_newest_archived_first() {
        let pool = memory_pool().await;
        let older = seed_thread_with_provenance(&pool, "old").await;
        let newer = seed_thread_with_provenance(&pool, "new").await;

        // Archive `older` first (smaller archived_at), then `newer`.
        archive_thread(&pool, older, 1000).await.expect("archive older");
        archive_thread(&pool, newer, 2000).await.expect("archive newer");

        let archived = list_archived_threads(&pool).await.expect("list archived");
        let ids: Vec<String> = archived.iter().map(|(id, ..)| id.clone()).collect();
        assert_eq!(
            ids,
            vec![newer.to_string(), older.to_string()],
            "archived list is newest-archived first"
        );
    }

    /// Renaming via `update_thread_title` overwrites the title but leaves
    /// `last_activity_at` untouched (titling is not activity, ADR-0046/0052) —
    /// guards the slice-2 rename verb's no-reorder invariant.
    #[tokio::test]
    async fn rename_does_not_bump_last_activity() {
        let pool = memory_pool().await;
        let thread_id = Uuid::now_v7();
        queries::insert_thread(&pool, thread_id, "Original", 7777)
            .await
            .expect("insert thread");

        update_thread_title(&pool, thread_id, "Renamed")
            .await
            .expect("rename");

        let row: (String, i64) =
            sqlx::query_as("SELECT title, last_activity_at FROM threads WHERE id = ?1")
                .bind(thread_id.to_string())
                .fetch_one(&pool)
                .await
                .expect("read renamed thread");
        assert_eq!(row.0, "Renamed", "title is overwritten");
        assert_eq!(
            row.1, 7777,
            "rename does NOT bump last_activity_at (no feed reorder)"
        );
    }

    /// Drive a bare Run to `errored` directly (terminal fields stamped), to seed
    /// the retry verb's `from` state. Mirrors what `RunStatus::fail` leaves behind.
    async fn mark_bare_run_errored(pool: &SqlitePool, run_id: &str) {
        sqlx::query(
            "UPDATE runs SET status = 'errored', terminal_reason = 'errored', \
             error_code = 'agent_error', error_message = 'boom', ended_at = 99 \
             WHERE id = ?1",
        )
        .bind(run_id)
        .execute(pool)
        .await
        .expect("mark errored");
    }

    /// `RunStatus::retry` lock (ADR-0028 retry amendment, #230): the guarded
    /// `errored → running` flip wins only from `errored`, clears the four terminal
    /// fields, and a `running`/`completed`/`parked`/`cancelled` Run loses (0 rows,
    /// no mutation). The single outbound edge `errored` gains.
    #[tokio::test]
    async fn retry_verb_flips_errored_to_running_and_clears_terminal_fields() {
        let pool = memory_pool().await;
        let run_id = Uuid::now_v7();
        let run = run_id.to_string();
        insert_bare_run(&pool, &run, "running").await;
        mark_bare_run_errored(&pool, &run).await;

        // Won: errored → running, terminal fields cleared.
        let mut tx = pool.begin().await.expect("begin");
        let moved = RunStatus::retry(&mut tx, run_id, 100).await.expect("retry");
        tx.commit().await.expect("commit");
        assert_eq!(moved, Moved::Won);

        let (status, tr, ec, em, ended): (String, Option<String>, Option<String>, Option<String>, Option<i64>) =
            sqlx::query_as(
                "SELECT status, terminal_reason, error_code, error_message, ended_at \
                 FROM runs WHERE id = ?1",
            )
            .bind(&run)
            .fetch_one(&pool)
            .await
            .expect("read run");
        assert_eq!(status, "running");
        assert_eq!(tr, None, "terminal_reason cleared");
        assert_eq!(ec, None, "error_code cleared");
        assert_eq!(em, None, "error_message cleared");
        assert_eq!(ended, None, "ended_at cleared");

        // A retry milestone reuses RunLogKind::Running (no new kind).
        let last_kind: String = sqlx::query_scalar(
            "SELECT kind FROM run_log WHERE run_id = ?1 ORDER BY run_seq DESC LIMIT 1",
        )
        .bind(&run)
        .fetch_one(&pool)
        .await
        .expect("read run_log");
        assert_eq!(last_kind, "running");

        // Lost: a non-errored Run matches 0 rows and is untouched.
        for status in ["running", "completed", "parked", "cancelled"] {
            let other = Uuid::now_v7();
            let other_s = other.to_string();
            insert_bare_run(&pool, &other_s, status).await;
            let mut tx = pool.begin().await.expect("begin");
            let moved = RunStatus::retry(&mut tx, other, 100).await.expect("retry lost");
            tx.commit().await.expect("commit");
            assert_eq!(moved, Moved::Lost, "{status} run cannot be retried");
            assert_eq!(run_status_of(&pool, &other_s).await, status, "{status} unchanged");
        }
    }
}
