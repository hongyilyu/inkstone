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
// The media substrate (ADR-0058): consumed by the `media/upload` handler
// (`runs/media.rs`), the `GET /media/{id}` route (`main.rs`), and the send-path
// attachment validation (`runs/post_message.rs` / `runs/thread_create.rs`),
// which names `MediaRow` to copy its `mime`/`width`/`height` into
// `AttachmentSeed`s — hence the re-export.
pub(crate) use media::{MediaInput, MediaRow, get_media, insert_media};
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
    AttachmentSeed, TimelineStep, append_assistant_part, assistant_message_id_for_run,
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
