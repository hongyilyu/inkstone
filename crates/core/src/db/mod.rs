//! SQLite tier-2 storage (ADR-0017): resolves the DB path, opens a pool, runs
//! migrations. SQL lives in [`queries`]; this module owns the high-level
//! operations and transaction boundaries.

mod apply;
mod intent_graph;
mod lifecycle;
mod message_fts;
mod queries;
mod run_log;

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use uuid::Uuid;

use crate::workflow::Workflow;

// The intent-graph resolve+apply path (ADR-0042), the sibling of `apply_proposal`
// for the one mutation kind that is a GRAPH, not a single entity. `decide` routes
// `apply_intent_graph` here instead of `apply_proposal`.
pub use intent_graph::{IntentGraphOutcome, apply_intent_graph_proposal, resolved_plan_for};
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
// without naming the db type. `rebuild_message_fts` runs on open.
pub use message_fts::{rebuild_message_fts, search_messages};

/// Current wall-clock time as ms since UNIX_EPOCH (the `*_at` columns).
pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time before epoch")
        .as_millis() as i64
}

/// Resolve the DB path: `INKSTONE_DB_PATH` env override wins, else
/// `<OS data dir>/inkstone/db.sqlite`.
pub(crate) fn resolve_db_path() -> Result<PathBuf> {
    if let Some(env) = std::env::var_os("INKSTONE_DB_PATH") {
        return Ok(PathBuf::from(env));
    }
    Ok(os_data_dir()?.join("inkstone").join("db.sqlite"))
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

/// Whether a Thread row exists. `run/post_message` is existing-thread-only
/// (ADR-0022); an unknown `thread_id` is rejected with `unknown_thread`.
pub async fn thread_exists(pool: &SqlitePool, thread_id: Uuid) -> sqlx::Result<bool> {
    queries::thread_exists(pool, thread_id).await
}

/// Read all Threads for `thread/list` (ADR-0022), most-recent-activity-first,
/// as `(id, title, last_activity_at)` rows.
pub async fn list_threads(pool: &SqlitePool) -> sqlx::Result<Vec<(String, String, i64)>> {
    queries::list_threads(pool).await
}

/// Read the recent-Runs feed for `run/get_history` (ADR-0028 as-built): one row
/// per Run carrying its latest Run Log milestone, newest-first, capped at
/// `limit`. Returns `(run_id, thread_id, title, kind, at)` rows; `kind` is the
/// milestone kind verbatim (the client maps it to a label). An empty Workspace
/// returns an empty Vec.
pub async fn list_run_history(
    pool: &SqlitePool,
    limit: i64,
) -> sqlx::Result<Vec<(String, String, String, String, i64)>> {
    queries::list_run_history(pool, limit).await
}

/// Parse a stored Canonical Entity's `data` JSON (tier-2 `entities.data` /
/// `entity_revisions.data`). A malformed value is a corrupt tier-2 row, not a
/// blank entity: log a `db.entity_data_parse_failed` Diagnostic Log event
/// (ADR-0038) and surface a loud `sqlx::Error::Decode` rather than degrading to
/// `Value::Null`. Mirrors `entity_type_by_id`'s loud-decode precedent.
fn parse_entity_data(entity_id: &str, raw: &str) -> sqlx::Result<serde_json::Value> {
    serde_json::from_str(raw).map_err(|e| {
        tracing::error!(event = "db.entity_data_parse_failed", entity_id, error = ?e);
        sqlx::Error::Decode(format!("entity {entity_id} data is malformed JSON: {e}").into())
    })
}

/// One accepted Entity for `entity/list`. `data` is parsed from the stored
/// JSON; a malformed row now fails the read with a logged `sqlx::Error`
/// (`db.entity_data_parse_failed`, ADR-0038) rather than silently degrading to
/// `null`.
pub struct EntityRow {
    pub id: String,
    pub r#type: String,
    pub data: serde_json::Value,
    pub created_at: i64,
    pub updated_at: i64,
    pub refs: Vec<ResolvedEntityRef>,
    /// `(person_id, role)` pairs for a Todo row's Person References (ADR-0032).
    /// Empty for non-Todo rows and Todos with no references.
    pub person_refs: Vec<(String, String)>,
    /// The Entity's origin provenance (`created_from`, ADR-0030), or `None` for a
    /// user-authored Entity (a direct Library write records no source row). Backs
    /// the Inspector's "Captured from" footer.
    pub source: Option<EntityProvenance>,
}

/// The resolved origin of an Entity for the "Captured from" read (ADR-0030). One
/// of two shapes, mirroring the `entity_sources` CHECK (exactly one source kind):
/// a user Message (carrying the Thread to link back to) or a source Journal Entry.
pub enum EntityProvenance {
    /// `created_from` a user Message: link back to its Thread.
    Message { thread_id: String, thread_title: String },
    /// `created_from` a source Entity (a Journal Entry): link to it in the Library.
    JournalEntry { journal_entry_id: String },
}

pub struct ResolvedEntityRef {
    pub id: String,
    pub source_entity_id: String,
    pub target_entity_id: String,
    pub target_entity_type: String,
    pub target_title: Option<String>,
    pub label_snapshot: Option<String>,
}

/// Read every accepted Entity of `entity_type` for `entity/list`, newest-first.
pub async fn list_by_type(pool: &SqlitePool, entity_type: &str) -> sqlx::Result<Vec<EntityRow>> {
    let rows = queries::list_by_type(pool, entity_type).await?;
    let mut rows = rows
        .into_iter()
        .map(|(id, r#type, data, created_at, updated_at)| {
            let data = parse_entity_data(&id, &data)?;
            Ok(EntityRow {
                id,
                r#type,
                data,
                created_at,
                updated_at,
                refs: Vec::new(),
                person_refs: Vec::new(),
                source: None,
            })
        })
        .collect::<sqlx::Result<Vec<_>>>()?;

    // Attach each row's origin provenance ("Captured from", ADR-0030), batched
    // like the journal refs below to avoid an N+1 over the listed Entities. The
    // query returns oldest-first per Entity, so the FIRST row per id is the true
    // origin `created_from` (later cross-Thread sources, if any, are ignored).
    let entity_ids = rows.iter().map(|row| row.id.clone()).collect::<Vec<_>>();
    let provenance = queries::provenance_for_entities(pool, &entity_ids).await?;
    let mut provenance_by_entity = HashMap::<String, EntityProvenance>::new();
    for (entity_id, source_entity_id, thread_id, thread_title) in provenance {
        provenance_by_entity
            .entry(entity_id)
            .or_insert_with(|| match source_entity_id {
                Some(journal_entry_id) => EntityProvenance::JournalEntry { journal_entry_id },
                // Exactly one source kind is non-NULL (schema CHECK); a Message
                // source carries its Thread id, and the Thread title is present
                // for every real Thread. Default the title defensively rather
                // than dropping the whole provenance if the join is somehow thin.
                None => EntityProvenance::Message {
                    thread_id: thread_id.unwrap_or_default(),
                    thread_title: thread_title.unwrap_or_default(),
                },
            });
    }
    for row in &mut rows {
        row.source = provenance_by_entity.remove(&row.id);
    }

    if entity_type == "journal_entry" {
        let source_entity_ids = rows.iter().map(|row| row.id.clone()).collect::<Vec<_>>();
        let refs = resolved_entity_refs_for_sources(pool, &source_entity_ids).await?;
        let mut refs_by_source = HashMap::<String, Vec<ResolvedEntityRef>>::new();
        for entity_ref in refs {
            refs_by_source
                .entry(entity_ref.source_entity_id.clone())
                .or_default()
                .push(entity_ref);
        }
        for row in &mut rows {
            row.refs = refs_by_source.remove(&row.id).unwrap_or_default();
        }
    }

    // Attach each Todo's Person References (ADR-0032), batched like journal refs
    // above to avoid an N+1 over the listed Todos.
    if entity_type == "todo" {
        let todo_ids = rows.iter().map(|row| row.id.clone()).collect::<Vec<_>>();
        let refs = queries::person_refs_for_todos(pool, &todo_ids).await?;
        let mut refs_by_todo = HashMap::<String, Vec<(String, String)>>::new();
        for (todo_id, person_id, role) in refs {
            refs_by_todo
                .entry(todo_id)
                .or_default()
                .push((person_id, role));
        }
        for row in &mut rows {
            row.person_refs = refs_by_todo.remove(&row.id).unwrap_or_default();
        }
    }

    Ok(rows)
}

async fn resolved_entity_refs_for_sources(
    pool: &SqlitePool,
    source_entity_ids: &[String],
) -> sqlx::Result<Vec<ResolvedEntityRef>> {
    let rows = queries::entity_refs_for_sources(pool, source_entity_ids).await?;
    rows.into_iter()
        .map(
            |(
                id,
                source_entity_id,
                target_entity_id,
                target_entity_type,
                target_data,
                label_snapshot,
            )| {
                let data = parse_entity_data(&target_entity_id, &target_data)?;
                Ok(ResolvedEntityRef {
                    id,
                    source_entity_id,
                    target_entity_id,
                    target_title: entity_title(&target_entity_type, &data),
                    target_entity_type,
                    label_snapshot,
                })
            },
        )
        .collect()
}

fn entity_title(entity_type: &str, data: &serde_json::Value) -> Option<String> {
    let field = match entity_type {
        "person" | "project" => "name",
        "todo" => "title",
        // Bookmark is deliberately absent: it is not journal-referenceable in V1
        // (ADR-0036), so it never reaches this reference-target title lookup.
        _ => return None,
    };
    data.get(field)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// One Journal Entry returned to the Worker for same-Thread correction context.
/// `data` is the latest accepted revision snapshot.
pub struct CurrentThreadJournalEntryRow {
    pub entity_id: String,
    pub data: serde_json::Value,
}

/// One accepted Journal Entry for `proposal/get` review context. `data` is the
/// current `entities.data` snapshot. Unlike the canonical [`EntityRow`] reads,
/// this is a display-only review-context snapshot: a malformed `data` degrades to
/// `Value::Null` rather than failing the read (see [`current_journal_entry_by_id`]).
pub struct CurrentJournalEntryRow {
    pub entity_id: String,
    pub data: serde_json::Value,
}

/// Read one accepted Journal Entry by id. `None` when it does not exist or is
/// not a journal entry.
///
/// Display-only review read: its sole caller is `proposal/get`'s
/// `review_context_for_proposal` preview, which is designed to degrade gracefully
/// when the current-entry snapshot is unparseable. So a malformed `data` falls
/// back to `Value::Null` here rather than routing through [`parse_entity_data`] —
/// deliberately NOT a canonical authoritative read. The loud parse-failure
/// guarantee for this Journal Entry's data lives on the decide/apply path
/// (`db::apply`, which parses the same snapshot and returns
/// `ApplyError::InvalidMutation` → `-32602`), so corruption is rejected where it
/// matters without breaking the optional review preview.
pub async fn current_journal_entry_by_id(
    pool: &SqlitePool,
    entity_id: &str,
) -> sqlx::Result<Option<CurrentJournalEntryRow>> {
    let Some((entity_id, data)) = queries::current_journal_entry_by_id(pool, entity_id).await?
    else {
        return Ok(None);
    };
    Ok(Some(CurrentJournalEntryRow {
        entity_id,
        data: serde_json::from_str(&data).unwrap_or(serde_json::Value::Null),
    }))
}

/// One accepted GTD Entity (Person/Project/Todo) for `proposal/get` review
/// context (lamplit-desk-alignment). `data` is the current `entities.data`
/// snapshot. Like [`CurrentJournalEntryRow`], this is a display-only review read:
/// a malformed `data` degrades to `Value::Null` rather than failing the read. The
/// loud parse-failure guarantee for an accepted update lives on the decide/apply
/// path, so corruption is rejected where it matters without breaking the optional
/// review preview.
pub struct CurrentEntityRow {
    pub entity_id: String,
    pub data: serde_json::Value,
}

/// Read one accepted Person by id. `None` when it does not exist or is not a
/// person. Display-only review read (see [`current_journal_entry_by_id`]).
pub async fn current_person_by_id(
    pool: &SqlitePool,
    entity_id: &str,
) -> sqlx::Result<Option<CurrentEntityRow>> {
    let Some(data) = queries::current_person_data(pool, entity_id).await? else {
        return Ok(None);
    };
    Ok(Some(CurrentEntityRow {
        entity_id: entity_id.to_string(),
        data: serde_json::from_str(&data).unwrap_or(serde_json::Value::Null),
    }))
}

/// Read one accepted Project by id. `None` when it does not exist or is not a
/// project. Display-only review read (see [`current_journal_entry_by_id`]).
pub async fn current_project_by_id(
    pool: &SqlitePool,
    entity_id: &str,
) -> sqlx::Result<Option<CurrentEntityRow>> {
    let Some(data) = queries::current_project_data(pool, entity_id).await? else {
        return Ok(None);
    };
    Ok(Some(CurrentEntityRow {
        entity_id: entity_id.to_string(),
        data: serde_json::from_str(&data).unwrap_or(serde_json::Value::Null),
    }))
}

/// Read one accepted Todo by id. `None` when it does not exist or is not a todo.
/// Display-only review read (see [`current_journal_entry_by_id`]).
pub async fn current_todo_by_id(
    pool: &SqlitePool,
    entity_id: &str,
) -> sqlx::Result<Option<CurrentEntityRow>> {
    let Some(data) = queries::current_todo_data(pool, entity_id).await? else {
        return Ok(None);
    };
    Ok(Some(CurrentEntityRow {
        entity_id: entity_id.to_string(),
        data: serde_json::from_str(&data).unwrap_or(serde_json::Value::Null),
    }))
}

/// Read accepted Journal Entries originally created from `run_id`'s Thread,
/// ordered newest-first by each Entity's latest revision time.
pub async fn current_thread_journal_entries(
    pool: &SqlitePool,
    run_id: Uuid,
) -> sqlx::Result<Vec<CurrentThreadJournalEntryRow>> {
    let rows = queries::current_thread_journal_entries(pool, run_id).await?;
    rows.into_iter()
        .map(|(entity_id, data)| {
            let data = parse_entity_data(&entity_id, &data)?;
            Ok(CurrentThreadJournalEntryRow { entity_id, data })
        })
        .collect()
}

/// One tool call rehydrated for a `thread/get` Message (ADR-0043): the
/// non-Proposal calls of the Message's Run, in timeline order, with the
/// persisted status mapped to the wire spelling (`errored` → `error`) and the
/// display `arg` derived from the request payload (the same extractor the live
/// `tool_call` Run Event uses).
pub struct ToolCallRow {
    pub name: String,
    pub status: String,
    pub arg: Option<String>,
}

/// The decided Proposal an assistant turn parked on, for `thread/get`
/// rehydration (ADR-0044): `(proposal_id, mutation_kind, status)` where `status`
/// is `accepted` or `rejected`. `None` for a turn with no Proposal, or one still
/// `pending` (renders its full interactive card — deferred) or `cancelled`.
pub struct MessageProposalRow {
    pub proposal_id: String,
    pub mutation_kind: String,
    pub status: String,
}

/// One Message in a `thread/get` read, with `text` already assembled (text
/// parts concatenated in `seq` order). Flat-text-no-parts per ADR-0017.
/// `tool_calls` rehydrates the assistant turn's tool-activity rows (ADR-0043);
/// empty for user Messages and turns with no non-Proposal tool call. `proposal`
/// rehydrates the assistant turn's decided Proposal outcome (ADR-0044); `None`
/// for user Messages and turns with no decided Proposal.
pub struct MessageRow {
    pub id: String,
    pub role: String,
    pub status: String,
    pub run_id: String,
    pub text: String,
    pub tool_calls: Vec<ToolCallRow>,
    pub proposal: Option<MessageProposalRow>,
}

/// Read a Thread plus its Messages for `thread/get` (ADR-0022). `None` when the
/// Thread does not exist (handler maps to `unknown_thread`). Messages are
/// chronological by `(created_at, rowid)` — the rowid tiebreaker keeps the user
/// Message ahead of the assistant Message on a same-ms insert.
pub async fn get_thread_with_messages(
    pool: &SqlitePool,
    thread_id: Uuid,
) -> sqlx::Result<Option<(String, Vec<MessageRow>)>> {
    let Some(title) = queries::thread_title(pool, thread_id).await? else {
        return Ok(None);
    };

    let rows = queries::messages_by_thread(pool, thread_id).await?;
    let mut messages = Vec::with_capacity(rows.len());
    for (id, role, status, run_id) in rows {
        let text = queries::text_parts_by_message(pool, &id).await?.concat();
        // Rehydrate tool-activity rows AND the decided Proposal outcome only on
        // the assistant Message (ADR-0043, ADR-0044). A Run's user and assistant
        // Messages share its `run_id`, but tool calls and the Proposal belong to
        // the assistant turn; attaching them to the user Message would duplicate.
        // Proposal tool calls are excluded from `tool_calls` (they render as a
        // `ProposalCard`, not a tool-activity row — ADR-0025); the decided outcome
        // is surfaced separately via `proposal`.
        let (tool_calls, proposal) = if role == "assistant" {
            (
                tool_call_rows_for_run(pool, &run_id).await?,
                decided_proposal_for_run(pool, &run_id).await?,
            )
        } else {
            (Vec::new(), None)
        };
        messages.push(MessageRow {
            id,
            role,
            status,
            run_id,
            text,
            tool_calls,
            proposal,
        });
    }

    Ok(Some((title, messages)))
}

/// Read the SETTLED non-Proposal tool calls of `run_id` for `thread/get`
/// rehydration (ADR-0043), in timeline order. Filters Proposal tools via the
/// registry ([`crate::tools::is_proposal`]) — they render as a `ProposalCard`,
/// never a tool-activity row — and maps the persisted status to the wire
/// spelling (`errored` → `error`, `completed` → `completed`), matching the live
/// `ToolCallStatus`. `pending` rows are already excluded by the query, so the
/// rehydrated set is always settled; an unexpected status falls back to `error`
/// rather than leaking a non-vocabulary string to the wire. A `run_id` that does
/// not parse as a UUID yields no rows rather than an error (the read is
/// best-effort; a malformed id simply has no rehydratable calls).
async fn tool_call_rows_for_run(pool: &SqlitePool, run_id: &str) -> sqlx::Result<Vec<ToolCallRow>> {
    let Ok(run_uuid) = Uuid::parse_str(run_id) else {
        return Ok(Vec::new());
    };
    let rows = queries::tool_calls_by_run(pool, run_uuid).await?;
    Ok(rows
        .into_iter()
        .filter(|(name, _, _)| !crate::tools::is_proposal(name))
        .map(|(name, status, request_payload)| {
            // Derive the display arg from the stored request payload via the same
            // per-tool extractor the live `tool_call` Run Event uses (ADR-0043),
            // so the reloaded row matches the live one. A malformed payload yields
            // no arg rather than an error (the read is best-effort).
            let arg = serde_json::from_str::<serde_json::Value>(&request_payload)
                .ok()
                .and_then(|params| crate::tools::display_arg(&name, &params));
            ToolCallRow {
                name,
                status: match status.as_str() {
                    "completed" => "completed".to_string(),
                    // `errored`, or any unexpected value, maps to the wire `error`
                    // spelling — never leak a non-vocabulary status to the client.
                    _ => "error".to_string(),
                },
                arg,
            }
        })
        .collect())
}

/// Read the DECIDED Proposal a Run parked on, for `thread/get` rehydration
/// (ADR-0044). `None` when the Run has no Proposal, or its Proposal is still
/// `pending` (renders its full interactive card, which needs the payload —
/// deferred) or `cancelled` (cleared live, nothing to review). A `run_id` that
/// does not parse as a UUID yields `None` (the read is best-effort — a malformed
/// id simply has no rehydratable Proposal), mirroring [`tool_call_rows_for_run`].
async fn decided_proposal_for_run(
    pool: &SqlitePool,
    run_id: &str,
) -> sqlx::Result<Option<MessageProposalRow>> {
    let Ok(run_uuid) = Uuid::parse_str(run_id) else {
        return Ok(None);
    };
    Ok(queries::decided_proposal_for_run(pool, run_uuid)
        .await?
        .map(|(proposal_id, mutation_kind, status)| MessageProposalRow {
            proposal_id,
            mutation_kind,
            status,
        }))
}

/// Assemble prior-Run conversation history for a Run's manifest (ADR-0018).
/// `(role, text)` pairs for every `completed` Message in `thread_id` belonging
/// to a Run other than `exclude_run_id`, oldest-first. Excluding the current
/// Run keeps history to the prior exchange; `completed`-only drops
/// partial/errored assistant text.
pub async fn history_for_run(
    pool: &SqlitePool,
    thread_id: Uuid,
    exclude_run_id: Uuid,
) -> sqlx::Result<Vec<(String, String)>> {
    let rows = queries::history_messages_for_run(pool, thread_id, exclude_run_id).await?;
    let mut history = Vec::with_capacity(rows.len());
    for (id, role) in rows {
        let text = queries::text_parts_by_message(pool, &id).await?.concat();
        history.push((role, text));
    }
    Ok(history)
}

/// Persist a Run's initial rows in one deferred-FK transaction: the FK cycle
/// between `runs.user_message_id` and `messages.run_id` resolves only at COMMIT.
/// Pre-inserts the assistant `messages` row (`streaming`) + an empty `seq=0`
/// text part for [`append_assistant_text`] to append into.
pub async fn persist_initial_run(
    pool: &SqlitePool,
    run_id: Uuid,
    thread_id: Uuid,
    user_message_id: Uuid,
    assistant_message_id: Uuid,
    workflow: &Workflow,
    prompt: &str,
    now_ms: i64,
) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;

    insert_initial_run_rows(
        &mut tx,
        run_id,
        thread_id,
        user_message_id,
        assistant_message_id,
        workflow,
        prompt,
        now_ms,
    )
    .await?;

    tx.commit().await
}

/// Message-first thread creation (ADR-0022): mint a new Thread row then the
/// same initial-run rows as [`persist_initial_run`], all in one transaction, so
/// `thread/create` births the Thread and its first message atomically.
#[allow(clippy::too_many_arguments)]
pub async fn persist_thread_with_first_run(
    pool: &SqlitePool,
    thread_id: Uuid,
    run_id: Uuid,
    user_message_id: Uuid,
    assistant_message_id: Uuid,
    workflow: &Workflow,
    prompt: &str,
    title: &str,
    now_ms: i64,
) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;

    queries::insert_thread(&mut *tx, thread_id, title, now_ms).await?;

    insert_initial_run_rows(
        &mut tx,
        run_id,
        thread_id,
        user_message_id,
        assistant_message_id,
        workflow,
        prompt,
        now_ms,
    )
    .await?;

    tx.commit().await
}

/// Shared initial-run inserts inside the caller's open transaction (caller owns
/// begin/commit): the Run row, user Message + `seq=0` text part, assistant
/// Message (`streaming`) + empty `seq=0` text part, the two run steps, the
/// `running` run-log row, and the Thread activity touch.
#[allow(clippy::too_many_arguments)]
async fn insert_initial_run_rows(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    run_id: Uuid,
    thread_id: Uuid,
    user_message_id: Uuid,
    assistant_message_id: Uuid,
    workflow: &Workflow,
    prompt: &str,
    now_ms: i64,
) -> sqlx::Result<()> {
    queries::insert_run(
        &mut **tx,
        run_id,
        thread_id,
        &workflow.name,
        &workflow.version,
        &workflow.provider,
        workflow.model.as_deref().unwrap_or_default(),
        workflow.thinking_level.as_deref().unwrap_or_default(),
        user_message_id,
        now_ms,
    )
    .await?;

    queries::insert_message(
        &mut **tx,
        user_message_id,
        thread_id,
        run_id,
        "user",
        "completed",
        now_ms,
    )
    .await?;
    queries::insert_text_part(&mut **tx, user_message_id, 0, prompt).await?;
    // Index the completed user Message into the tier-3 search projection
    // (ADR-0035), atomic with the Message in this tx. The assistant Message is
    // `streaming`/empty here — it is indexed at Run completion (slice 2).
    message_fts::index_message(
        &mut **tx,
        &user_message_id.to_string(),
        &thread_id.to_string(),
        &run_id.to_string(),
        "user",
        prompt,
    )
    .await?;

    queries::insert_message(
        &mut **tx,
        assistant_message_id,
        thread_id,
        run_id,
        "assistant",
        "streaming",
        now_ms,
    )
    .await?;
    queries::insert_text_part(&mut **tx, assistant_message_id, 0, "").await?;

    queries::insert_message_run_step(&mut **tx, run_id, 0, user_message_id, now_ms).await?;
    queries::insert_message_run_step(&mut **tx, run_id, 1, assistant_message_id, now_ms).await?;

    run_log::append(
        &mut **tx,
        run_id,
        run_log::RunLogKind::Running,
        None,
        now_ms,
    )
    .await?;

    queries::touch_thread_activity(&mut **tx, thread_id, now_ms).await
}

/// Append a streaming `text_delta` to the assistant's pre-inserted `seq=0`
/// text part. Single statement; SQLite serializes writes.
pub async fn append_assistant_text(
    pool: &SqlitePool,
    assistant_message_id: Uuid,
    delta: &str,
) -> sqlx::Result<bool> {
    queries::append_text_part(pool, assistant_message_id, 0, delta)
        .await
        .map(|rows| rows == 1)
}

/// Persist an incoming Tool Request (ADR-0017/0018): a `pending` `tool_calls`
/// row plus its `run_steps` timeline entry in one transaction, so the timeline
/// never holds a tool call unaddressable via `run_steps`. `tool_call_id` is the
/// Worker-assigned wire correlation key; `request_payload` is the serialized args.
pub async fn persist_tool_call(
    pool: &SqlitePool,
    run_id: Uuid,
    tool_call_id: &str,
    name: &str,
    request_payload: &str,
    now_ms: i64,
) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;
    persist_tool_call_rows(&mut tx, run_id, tool_call_id, name, request_payload, now_ms).await?;
    tx.commit().await
}

async fn persist_tool_call_rows(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    run_id: Uuid,
    tool_call_id: &str,
    name: &str,
    request_payload: &str,
    now_ms: i64,
) -> sqlx::Result<()> {
    let seq = queries::next_run_step_seq(&mut **tx, run_id).await?;
    queries::insert_tool_call(
        &mut **tx,
        tool_call_id,
        run_id,
        name,
        request_payload,
        now_ms,
    )
    .await?;
    queries::insert_tool_call_run_step(&mut **tx, run_id, seq, tool_call_id, now_ms).await
}

/// Resolve a persisted Tool Request with its outcome (ADR-0017): flip the
/// `tool_calls` row to `status` (`completed`/`errored`) and store the
/// serialized `result_payload`.
pub async fn resolve_tool_call(
    pool: &SqlitePool,
    tool_call_id: &str,
    status: &str,
    result_payload: &str,
    now_ms: i64,
) -> sqlx::Result<()> {
    queries::resolve_tool_call(pool, tool_call_id, status, result_payload, now_ms).await
}

/// Park a Run on a Proposal tool request (ADR-0025): persist the tool call +
/// timeline step + pending Proposal, then move the Run `running -> parked` with
/// the waitpoint and lifecycle events (`parked`, `proposal_pending`), all in one
/// transaction. If the Run is no longer `running` the guarded park loses and the
/// transaction rolls back.
#[allow(clippy::too_many_arguments)]
pub async fn park_on_proposal(
    pool: &SqlitePool,
    run_id: Uuid,
    proposal_id: &str,
    tool_call_id: &str,
    name: &str,
    request_payload: &str,
    mutation_kind: &str,
    now_ms: i64,
) -> sqlx::Result<Moved> {
    let mut tx = pool.begin().await?;

    persist_tool_call_rows(&mut tx, run_id, tool_call_id, name, request_payload, now_ms).await?;
    queries::insert_proposal(&mut *tx, proposal_id, tool_call_id, mutation_kind).await?;

    let moved = RunStatus::park(&mut *tx, run_id, tool_call_id, now_ms).await?;
    if !moved.won() {
        return Ok(moved);
    }

    let payload = serde_json::json!({
        "proposal_id": proposal_id,
        "tool_call_id": tool_call_id,
        "mutation_kind": mutation_kind,
    })
    .to_string();
    run_log::append(
        &mut *tx,
        run_id,
        run_log::RunLogKind::ProposalPending,
        Some(&payload),
        now_ms,
    )
    .await?;

    tx.commit().await?;
    Ok(moved)
}

/// Read a Run's [`RunStatus`] (ADR-0025); `None` when the Run does not exist.
/// Backs `run/subscribe`'s parked branch and the forwarder's no-false-done check.
///
/// The stored string is parsed into the enum at this seam (ADR-0029): read sites
/// match typed variants, not raw strings. A row whose stored `status` fails to
/// parse surfaces as a loud `sqlx::Error::Decode` rather than collapsing to `None`
/// (which means "no such Run"), mirroring [`entity_type_by_id`]. The `runs.status`
/// CHECK constraint means a live DB never produces an unknown value, so this arm
/// is defensive.
pub async fn run_status(pool: &SqlitePool, run_id: Uuid) -> sqlx::Result<Option<RunStatus>> {
    match queries::run_status(pool, run_id).await? {
        None => Ok(None),
        Some(raw) => RunStatus::from_str(&raw)
            .map(Some)
            .ok_or_else(|| sqlx::Error::Decode(format!("unknown stored run status {raw:?}").into())),
    }
}

/// A Run's pending Proposal for `proposal/get` (ADR-0025). `payload` and
/// `rationale` come from the tool call's stored `request_payload`;
/// `mutation_kind` and `status` from the `proposals` row.
pub struct ProposalRow {
    pub proposal_id: String,
    pub mutation_kind: String,
    pub status: String,
    pub payload: serde_json::Value,
    pub rationale: Option<String>,
}

/// Read the Run's pending Proposal, or `None`. A malformed `request_payload`
/// degrades to `payload: null` / `rationale: None` rather than failing the read.
pub async fn get_pending_proposal_for_run(
    pool: &SqlitePool,
    run_id: Uuid,
) -> sqlx::Result<Option<ProposalRow>> {
    let Some((proposal_id, mutation_kind, status, request_payload)) =
        queries::pending_proposal_for_run(pool, run_id).await?
    else {
        return Ok(None);
    };
    let payload: serde_json::Value =
        serde_json::from_str(&request_payload).unwrap_or(serde_json::Value::Null);
    let proposal_payload = payload
        .get("payload")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let rationale = payload
        .get("rationale")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    Ok(Some(ProposalRow {
        proposal_id,
        mutation_kind,
        status,
        payload: proposal_payload,
        rationale,
    }))
}

/// Auto-approve seam (ADR-0025, ADR-0016). Always `false` for now — every
/// Proposal is manual, so every `propose_workspace_mutation` parks the Run.
pub fn should_auto_approve() -> bool {
    false
}

/// A Proposal loaded by id for `proposal/decide` (ADR-0025): owning Run, awaited
/// `tool_call_id`, lifecycle columns, the proposed `payload` (from the tool
/// call's `request_payload`), and any recorded `decision_idempotency_key`.
pub struct DecidableProposal {
    pub run_id: Uuid,
    pub tool_call_id: String,
    pub mutation_kind: String,
    pub status: String,
    pub payload: serde_json::Value,
    pub decision_idempotency_key: Option<String>,
}

/// Load a Proposal by id for `proposal/decide`; `None` when it does not exist.
/// A malformed `request_payload` degrades the proposed `payload` to `null`.
pub async fn load_proposal_for_decide(
    pool: &SqlitePool,
    proposal_id: &str,
) -> sqlx::Result<Option<DecidableProposal>> {
    let Some((run_id, tool_call_id, mutation_kind, status, request_payload, idem)) =
        queries::proposal_by_id(pool, proposal_id).await?
    else {
        return Ok(None);
    };
    let Ok(run_id) = Uuid::parse_str(&run_id) else {
        return Ok(None);
    };
    let payload: serde_json::Value =
        serde_json::from_str(&request_payload).unwrap_or(serde_json::Value::Null);
    let proposal_payload = payload
        .get("payload")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    Ok(Some(DecidableProposal {
        run_id,
        tool_call_id,
        mutation_kind,
        status,
        payload: proposal_payload,
        decision_idempotency_key: idem,
    }))
}

/// The `entities.id` already created via `proposal_id`, or `None`. Backs the
/// idempotent-decide check: a repeated accept returns the prior `entity_id`
/// instead of re-applying.
pub async fn entity_id_for_proposal(
    pool: &SqlitePool,
    proposal_id: &str,
) -> sqlx::Result<Option<String>> {
    queries::entity_id_for_proposal(pool, proposal_id).await
}

pub async fn journal_entry_target_is_valid(
    pool: &SqlitePool,
    run_id: Uuid,
    entity_id: &str,
) -> sqlx::Result<bool> {
    queries::journal_entry_target_is_valid(pool, run_id, entity_id).await
}

/// The Entity Type of an accepted Entity, parsed into [`crate::mutation::EntityType`].
/// `None` means the row is genuinely absent (→ a target-gone `TargetMissing` on the
/// agent path, ADR-0033). A row whose stored `type` string fails to parse — the
/// column has no CHECK constraint — surfaces as a loud `sqlx::Error::Decode`
/// (every caller routes it to `Internal`), never silently collapsing to `None`.
pub async fn entity_type_by_id(
    pool: &SqlitePool,
    entity_id: &str,
) -> sqlx::Result<Option<crate::mutation::EntityType>> {
    match queries::entity_type_by_id(pool, entity_id).await? {
        None => Ok(None),
        Some(raw) => crate::mutation::EntityType::from_str(&raw)
            .map(Some)
            .ok_or_else(|| {
                sqlx::Error::Decode(format!("unknown stored entity type {raw:?}").into())
            }),
    }
}

/// Whether an accepted Entity with `entity_id` exists and is of `entity_type`.
/// Backs decide-time target-type checks (e.g. a Todo's `project_id` must point at
/// a `project`).
pub async fn entity_is_type(
    pool: &SqlitePool,
    entity_id: &str,
    entity_type: &str,
) -> sqlx::Result<bool> {
    queries::entity_is_type(pool, entity_id, entity_type).await
}

/// Failure modes of [`apply_proposal`] the caller must distinguish (review M1).
#[derive(Debug)]
pub enum ApplyError {
    /// An impossible mutation contract, e.g. an update without a target id.
    InvalidMutation(String),
    /// The guarded `proposals` flip found the row non-`pending` (a concurrent
    /// decide won); the tx rolled back, nothing applied. Maps to
    /// `proposal_not_pending`.
    NotPending,
    /// An update/delete found its target Entity row already gone (the
    /// affected-0-rows case): a user deleted the Entity out from under a parked
    /// Proposal (ADR-0033). Distinct from a genuine DB fault so the caller can
    /// resolve the parked Run cleanly (decide maps it to `NotDecidable`).
    TargetMissing,
    /// Any other SQL error inside the apply transaction.
    Sql(sqlx::Error),
}

impl From<sqlx::Error> for ApplyError {
    fn from(e: sqlx::Error) -> Self {
        ApplyError::Sql(e)
    }
}

impl std::fmt::Display for ApplyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApplyError::InvalidMutation(reason) => write!(f, "{reason}"),
            ApplyError::NotPending => write!(f, "proposal is not pending (lost the apply race)"),
            ApplyError::TargetMissing => write!(f, "proposal target entity no longer exists"),
            ApplyError::Sql(e) => write!(f, "{e}"),
        }
    }
}

/// Apply an accepted Proposal in one atomic transaction (ADR-0016, ADR-0025):
/// flip the `proposals` row to `accepted` under the `status='pending'` guard,
/// run the shared [`apply::apply_entity_mutation`] core, and resolve the awaited
/// `tool_calls` row to `completed` with the Decision the model reads on resume.
/// Returns the new `entity_id`. `entity_type`/`schema_version` are
/// caller-resolved, so this layer names no specific Entity Type.
///
/// This function owns the run-coupled work the shared core deliberately does not:
/// the guarded accept flip, resolving the Entity Source (the JE anchor from the
/// payload for a `created_from` create, else the user Message from `run_id`), the
/// trailing tool-call resolve, and the commit. Everything else — the per-kind
/// entity data/revision/ref/source writes — lives in `apply_entity_mutation`,
/// shared with the user path (ADR-0033).
///
/// EDIT (ADR-0025): when `edited_payload` is `Some`, the entity `data` is the
/// edited payload (Core-validated by the caller) and `proposals.edited_payload`
/// records the edit; an unedited accept passes `None` and writes the proposed
/// `data`.
///
/// `decision_result_payload` is rendered after the entity write returns so the
/// resume transcript can carry the real affected Entity id. This matters for
/// follow-up agent proposals that must target or source from the accepted Entity.
///
/// Self-guarding (review M1): the `proposals` flip is guarded on
/// `status='pending'`. On 0 rows a racing decide already won, so the tx rolls
/// back and [`ApplyError::NotPending`] is returned — exactly one concurrent
/// decide applies.
#[allow(clippy::too_many_arguments)]
pub async fn apply_proposal(
    pool: &SqlitePool,
    run_id: Uuid,
    proposal_id: &str,
    tool_call_id: &str,
    kind: crate::mutation::MutationKind,
    target_entity_id: Option<&str>,
    payload: &serde_json::Value,
    edited_payload: Option<&serde_json::Value>,
    source_relation_from_user_message: Option<crate::mutation::SourceRelation>,
    decision_idempotency_key: Option<&str>,
    decision_result_payload: impl FnOnce(&str) -> String,
    now_ms: i64,
) -> Result<String, ApplyError> {
    use crate::mutation::SourceRelation;
    let edited_str = edited_payload.map(|v| v.to_string());
    let effective_payload = edited_payload.unwrap_or(payload);

    let mut tx = pool.begin().await?;

    // Flip the Proposal first under the `status='pending'` guard (the single
    // concurrency choke); on 0 rows a racing decide won, so bail before applying.
    let accepted = ProposalStatus::accept(
        &mut *tx,
        run_id,
        proposal_id,
        edited_str.as_deref(),
        decision_idempotency_key,
        now_ms,
    )
    .await?;
    if !accepted.won() {
        // tx drops without commit → rollback; no entity inserted.
        return Err(ApplyError::NotPending);
    }

    // Resolve the run-coupled Entity Source descriptor for the shared core. A
    // create carrying `source_journal_entry_id` is sourced `created_from` that
    // Journal Entry (source_entity_id), not the user Message. Absent the field,
    // the Message-sourcing path is unchanged: read the Run's immutable
    // `user_message_id` here (inside this tx). JournalEntry provenance is
    // `created_from` only (ADR-0030/0031): an `updated_from` source always points
    // at the user Message, so the field is honored solely for creates.
    let source = match source_relation_from_user_message {
        Some(relation) => {
            let je_id = (relation == SourceRelation::CreatedFrom)
                .then(|| crate::entities::source_journal_entry_id(effective_payload))
                .flatten();
            Some(match je_id {
                Some(journal_entry_id) => apply::EntitySource::FromJournalEntry {
                    journal_entry_id: journal_entry_id.to_string(),
                    relation: relation.as_str().to_string(),
                },
                None => apply::EntitySource::FromMessage {
                    message_id: queries::user_message_id_for_run(&mut *tx, run_id).await?,
                    relation: relation.as_str().to_string(),
                },
            })
        }
        None => None,
    };

    let entity_id = apply::apply_entity_mutation(
        &mut tx,
        apply::EntityMutationSpec {
            kind,
            target_entity_id,
            payload,
            edited_payload,
            created_by: "proposal",
            proposal_id: Some(proposal_id),
            source,
            now_ms,
        },
    )
    .await?;

    let decision_result_payload = decision_result_payload(&entity_id);
    queries::resolve_tool_call(
        &mut *tx,
        tool_call_id,
        "completed",
        &decision_result_payload,
        now_ms,
    )
    .await?;

    tx.commit().await?;
    Ok(entity_id)
}

/// Apply a user-initiated Entity mutation in one atomic transaction (ADR-0033):
/// the user write-path's `begin → apply_entity_mutation → commit`, with no
/// Proposal flip and no tool-call resolve (there is no Run). The shared core is
/// driven with `created_by='user'`, `proposal_id=None`, and `source=None` — a
/// plain Library write has no Run, user Message, or Journal-Entry anchor, so it
/// writes no Entity Source row (ADR-0033 "source row iff a real source").
/// The `kind` carries the Entity Type / schema version / target-key, and the
/// `target_entity_id` is caller-resolved, so this layer names no specific Entity
/// Type, mirroring [`apply_proposal`].
pub async fn apply_user_mutation(
    pool: &SqlitePool,
    kind: crate::mutation::MutationKind,
    target_entity_id: Option<&str>,
    payload: &serde_json::Value,
    now_ms: i64,
) -> Result<String, ApplyError> {
    let mut tx = pool.begin().await?;
    let entity_id = apply::apply_entity_mutation(
        &mut tx,
        apply::EntityMutationSpec {
            kind,
            target_entity_id,
            payload,
            edited_payload: None,
            created_by: "user",
            proposal_id: None,
            source: None,
            now_ms,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(entity_id)
}

/// Reject a Proposal in one atomic transaction (ADR-0025), touching no entity
/// store: flip the `proposals` row to `rejected` and resolve the awaited
/// `tool_calls` row to `completed` with the Decision the model reads on resume —
/// a normal (non-error) decline so it continues conversationally. Self-guarding
/// on `status='pending'` like [`apply_proposal`]: 0 rows → rollback +
/// [`ApplyError::NotPending`].
pub async fn reject_proposal(
    pool: &SqlitePool,
    run_id: Uuid,
    proposal_id: &str,
    tool_call_id: &str,
    decision_idempotency_key: Option<&str>,
    decision_result_payload: &str,
    now_ms: i64,
) -> Result<(), ApplyError> {
    let mut tx = pool.begin().await?;

    // Flip the Proposal first under the `status='pending'` guard; on 0 rows a
    // racing decide won, so bail before resolving the tool call.
    let rejected = ProposalStatus::reject(
        &mut *tx,
        run_id,
        proposal_id,
        decision_idempotency_key,
        now_ms,
    )
    .await?;
    if !rejected.won() {
        // tx drops without commit → rollback; nothing changed.
        return Err(ApplyError::NotPending);
    }

    queries::resolve_tool_call(
        &mut *tx,
        tool_call_id,
        "completed",
        decision_result_payload,
        now_ms,
    )
    .await?;

    tx.commit().await?;
    Ok(())
}

/// Flip a parked Run back to `running` on resume (ADR-0025), clearing the
/// waitpoint, between `apply_proposal`'s commit and the resume Worker spawn.
/// Guarded (review M2): on a lost race the caller bails rather than spawning a
/// duplicate resume Worker.
pub async fn mark_run_running(pool: &SqlitePool, run_id: Uuid) -> sqlx::Result<Moved> {
    let mut tx = pool.begin().await?;
    let moved = RunStatus::resume(&mut *tx, run_id).await?;
    tx.commit().await?;
    Ok(moved)
}

/// Cancel a parked Run and its pending Proposal in one transaction (ADR-0014,
/// ADR-0028), funneling both status changes through guarded verbs
/// (`ProposalStatus::cancel` on `status='pending'`, `RunStatus::cancel` on
/// `status='parked'`), each appending its own `cancelled` `run_log` row.
/// Returns whether the Run was cancelled — `false` (rollback) when there is no
/// pending Proposal or a concurrent decide/cancel already won; the caller maps
/// that to `already_terminal`.
pub async fn cancel_parked_run(pool: &SqlitePool, run_id: Uuid, now_ms: i64) -> sqlx::Result<bool> {
    let mut tx = pool.begin().await?;

    let Some((proposal_id, _, _, _)) = queries::pending_proposal_for_run(&mut *tx, run_id).await?
    else {
        // No pending Proposal → a concurrent decide/cancel likely won. Rollback.
        return Ok(false);
    };

    let proposal_cancelled = ProposalStatus::cancel(&mut *tx, run_id, &proposal_id, now_ms).await?;
    if !proposal_cancelled.won() {
        // Proposal no longer pending. Rollback.
        return Ok(false);
    }

    let run_cancelled = RunStatus::cancel(&mut *tx, run_id, now_ms).await?;
    if !run_cancelled.won() {
        // Run no longer parked. Rollback.
        return Ok(false);
    }

    tx.commit().await?;
    Ok(true)
}

/// Cancel a running Run in one guarded transition. Returns `Won` only if the
/// Run was still `running`; a lost race means a Worker terminal transition got
/// there first and the caller maps the cancel request to `already_terminal`.
pub async fn cancel_running_run(
    pool: &SqlitePool,
    run_id: Uuid,
    now_ms: i64,
) -> sqlx::Result<Moved> {
    let mut tx = pool.begin().await?;
    let moved = RunStatus::cancel_running(&mut *tx, run_id, now_ms).await?;
    tx.commit().await?;
    Ok(moved)
}

/// The run's assistant Message id (the seq-0 streaming row resume continues
/// appending into). `None` when the Run has no assistant message.
pub async fn assistant_message_id_for_run(
    pool: &SqlitePool,
    run_id: Uuid,
) -> sqlx::Result<Option<Uuid>> {
    let id = queries::assistant_message_id_for_run(pool, run_id).await?;
    Ok(id.and_then(|s| Uuid::parse_str(&s).ok()))
}

/// One element of a Run's timeline for resume reconstruction (ADR-0025).
/// `ToolCall.result` is the persisted `result_payload`, `None` while pending
/// (reconstruction synthesizes a "not executed" result).
pub enum TimelineStep {
    Message {
        role: String,
        text: String,
    },
    ToolCall {
        id: String,
        name: String,
        request: serde_json::Value,
        result: Option<String>,
    },
}

/// Read a Run's ordered timeline for resume transcript reconstruction
/// (ADR-0025): each `run_steps` row, resolving message text from parts and
/// the tool call's name/request/result. Ordered by `run_steps.seq`.
pub async fn read_run_timeline(pool: &SqlitePool, run_id: Uuid) -> sqlx::Result<Vec<TimelineStep>> {
    let rows = queries::run_timeline(pool, run_id).await?;
    let mut steps = Vec::with_capacity(rows.len());
    for (kind, message_id, role, tool_call_id, tc_name, request_payload, result_payload) in rows {
        match kind.as_str() {
            "message" => {
                let Some(mid) = message_id else { continue };
                let text = queries::text_parts_by_message(pool, &mid).await?.concat();
                steps.push(TimelineStep::Message {
                    role: role.unwrap_or_default(),
                    text,
                });
            }
            "tool_call" => {
                let Some(id) = tool_call_id else { continue };
                let request = request_payload
                    .as_deref()
                    .and_then(|p| serde_json::from_str(p).ok())
                    .unwrap_or(serde_json::Value::Null);
                steps.push(TimelineStep::ToolCall {
                    id,
                    name: tc_name.unwrap_or_default(),
                    request,
                    result: result_payload,
                });
            }
            _ => {}
        }
    }
    Ok(steps)
}

/// A Run's snapshot for `run/subscribe` (ADR-0022): the assistant message's
/// cumulative text at the subscribe instant plus the Run's status. `text` is
/// empty for a Run that has streamed no delta yet.
#[derive(Debug)]
pub struct RunSnapshot {
    pub text: String,
    /// The Run's [`RunStatus`]. Part of the ADR-0022 snapshot shape; the
    /// subscribe handler reads it to tell terminal from live under the gate, and
    /// the `thread/get` rehydration read consumes it in a later slice.
    pub status: RunStatus,
}

/// Read the snapshot-then-tail starting point: the assistant message's
/// cumulative `seq=0` text and the Run status. `None` when the Run does not
/// exist (subscribe handler stays defensible against unknown run ids).
///
/// The stored status is parsed into [`RunStatus`] at this seam; an unknown value
/// surfaces as a loud `sqlx::Error::Decode` (see [`run_status`]).
pub async fn select_run_snapshot(
    pool: &SqlitePool,
    run_id: Uuid,
) -> sqlx::Result<Option<RunSnapshot>> {
    let Some((text, status)) = queries::select_run_snapshot(pool, run_id).await? else {
        return Ok(None);
    };
    let status = RunStatus::from_str(&status)
        .ok_or_else(|| sqlx::Error::Decode(format!("unknown stored run status {status:?}").into()))?;
    Ok(Some(RunSnapshot {
        text: text.unwrap_or_default(),
        status,
    }))
}

/// Rebuild the effective Workflow a Run executes from its persisted snapshot
/// (ADR-0024). The `runs` row snapshots the post-dispatch resolved
/// `name`/`version`/`provider`/`model`/`thinking_level` at Run start; the
/// un-tunable, un-snapshotted fields (`system_prompt`, `tools`) come from the
/// static base Workflow of the same name. `None` when the Run does not exist.
///
/// This is how resume honors ADR-0024 ("a setting changed mid-Run affects the
/// next Run, not the running one"): it reads the snapshot, never re-resolving
/// live settings, so a model/effort change between park and decide cannot leak
/// into the resumed Run.
pub async fn run_workflow_snapshot(
    pool: &SqlitePool,
    run_id: Uuid,
    base: &Workflow,
) -> sqlx::Result<Option<Workflow>> {
    Ok(queries::select_run_workflow_snapshot(pool, run_id)
        .await?
        .map(
            |(name, version, provider, model, thinking_level)| Workflow {
                name,
                version,
                provider,
                model: Some(model),
                thinking_level: Some(thinking_level),
                system_prompt: base.system_prompt.clone(),
                tools: base.tools.clone(),
            },
        ))
}

/// Clean termination on the Worker's `done`: flip `runs` and the assistant
/// `messages` row to `completed` and append a `done` `run_log` row, in one
/// transaction so a reader never sees an in-between mix.
pub async fn complete_run(pool: &SqlitePool, run_id: Uuid, now_ms: i64) -> sqlx::Result<Moved> {
    let mut tx = pool.begin().await?;
    let moved = RunStatus::complete(&mut *tx, run_id, now_ms).await?;
    tx.commit().await?;
    Ok(moved)
}

/// Worker stdout EOF without a `done` event (worker died/killed/hung up). Flip
/// `runs` to `errored` (`terminal_reason='worker_disconnected'`), every
/// `streaming` Message to `incomplete` (ADR-0017 invariant), and append an
/// `error` `run_log` row. One transaction.
pub async fn error_run(pool: &SqlitePool, run_id: Uuid, now_ms: i64) -> sqlx::Result<Moved> {
    error_run_with_message(
        pool,
        run_id,
        TerminalReason::WorkerDisconnected,
        "worker_disconnected",
        "worker exited without emitting done event",
        now_ms,
    )
    .await
}

/// Worker emitted an explicit `error` Run Event (ADR-0006). Same terminal shape
/// as [`error_run`] but with caller-supplied `terminal_reason`, `error_code`,
/// and `error_message` carried into the `runs` row and `run_log` payload. The
/// `runs` CHECK string is produced from `terminal_reason` via `as_str()` inside
/// [`RunStatus::fail`]. One transaction.
pub async fn error_run_with_message(
    pool: &SqlitePool,
    run_id: Uuid,
    terminal_reason: TerminalReason,
    error_code: &str,
    error_message: &str,
    now_ms: i64,
) -> sqlx::Result<Moved> {
    let mut tx = pool.begin().await?;
    let moved =
        RunStatus::fail(&mut *tx, run_id, terminal_reason, error_code, error_message, now_ms)
            .await?;
    tx.commit().await?;
    Ok(moved)
}

/// Boot recovery sweep (ADR-0012): on Core start, force-error every `running`
/// Run (no live Worker survives a restart) to `errored` with
/// `terminal_reason='core_restarted'`, flipping its `streaming` Message to
/// `incomplete` (ADR-0017) in the same transaction. Preserves `parked` Runs
/// (ADR-0025) — they stay durable and decidable across a restart. Returns the
/// swept count for boot logging.
pub async fn recover_interrupted_runs(pool: &SqlitePool, now_ms: i64) -> sqlx::Result<u64> {
    let mut tx = pool.begin().await?;
    let error_message = "core restarted while run in flight";
    let swept = queries::recover_interrupted_runs(&mut *tx, error_message, now_ms).await?;
    queries::mark_recovered_streaming_messages_incomplete(&mut *tx, now_ms).await?;
    // Append the terminal `error` Run Log row the typed `fail()` verb would have
    // written, so a crash-recovered Run reads as errored (not Running) in
    // `run/get_history`. Same tx as the status flip.
    queries::append_recovered_error_events(&mut *tx, error_message, now_ms).await?;
    tx.commit().await?;
    Ok(swept)
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

// ─── GTD relationship read layer (Slice 11, ADR-0031) ──────────────────────
//
// Core-internal in V0 — exposed to client APIs in V1, so currently uncalled
// (`#[allow(dead_code)]`). Entity-returning helpers map raw rows into
// [`EntityRow`] like [`list_by_type`]: a malformed `data` JSON now fails the read
// with a logged `sqlx::Error` (`db.entity_data_parse_failed`, ADR-0038) rather
// than degrading to `null`.

/// Map a raw `(id, type, data, created_at, updated_at)` row to an [`EntityRow`].
fn entity_row(row: (String, String, String, i64, i64)) -> sqlx::Result<EntityRow> {
    let (id, r#type, data, created_at, updated_at) = row;
    let data = parse_entity_data(&id, &data)?;
    Ok(EntityRow {
        id,
        r#type,
        data,
        created_at,
        updated_at,
        refs: Vec::new(),
        person_refs: Vec::new(),
        source: None,
    })
}

/// Read every Todo owning `project_id` (its `data.project_id` matches), reusing
/// the `json_extract` project match. Returns full [`EntityRow`]s with real
/// `created_at`/`updated_at`, newest-first.
#[allow(dead_code)]
pub async fn todos_by_project(pool: &SqlitePool, project_id: &str) -> sqlx::Result<Vec<EntityRow>> {
    let rows = queries::todos_by_project(pool, project_id).await?;
    rows.into_iter()
        .map(|(id, data, created_at, updated_at)| {
            entity_row((id, "todo".to_string(), data, created_at, updated_at))
        })
        .collect::<sqlx::Result<Vec<_>>>()
}

/// Read every Todo linked to `person_id` via `todo_person_refs`, optionally
/// filtered to `role` (ADR-0031). Returns full [`EntityRow`]s, newest-first.
#[allow(dead_code)]
pub async fn todos_by_person(
    pool: &SqlitePool,
    person_id: &str,
    role: Option<&str>,
) -> sqlx::Result<Vec<EntityRow>> {
    let rows = queries::todos_by_person(pool, person_id, role).await?;
    rows.into_iter()
        .map(entity_row)
        .collect::<sqlx::Result<Vec<_>>>()
}

/// Read every Todo Person Reference on `todo_id` as `(person_id, role)` pairs
/// (ADR-0031).
#[allow(dead_code)]
pub async fn person_refs_by_todo(
    pool: &SqlitePool,
    todo_id: &str,
) -> sqlx::Result<Vec<(String, String)>> {
    queries::person_refs_by_todo(pool, todo_id).await
}

/// Distinct People linked to `project_id` through that Project's Todos (ADR-0031).
#[allow(dead_code)]
pub async fn project_people(pool: &SqlitePool, project_id: &str) -> sqlx::Result<Vec<String>> {
    queries::project_people(pool, project_id).await
}

/// Distinct Projects linked to `person_id` through their Todos (ADR-0031).
#[allow(dead_code)]
pub async fn person_projects(pool: &SqlitePool, person_id: &str) -> sqlx::Result<Vec<String>> {
    queries::person_projects(pool, person_id).await
}

/// Read reviewable Projects due for review: active/on_hold with a non-null
/// `next_review_at` at-or-before `now` (ADR-0031). Returns full [`EntityRow`]s.
#[allow(dead_code)]
pub async fn projects_due_for_review(pool: &SqlitePool, now: &str) -> sqlx::Result<Vec<EntityRow>> {
    let rows = queries::projects_due_for_review(pool, now).await?;
    rows.into_iter()
        .map(entity_row)
        .collect::<sqlx::Result<Vec<_>>>()
}

#[cfg(test)]
mod tests {
    use super::*;

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
    async fn person_refs_by_todo_returns_person_role_pairs() {
        let pool = memory_pool().await;
        seed_entity(&pool, "alice", "person", r#"{"name":"Alice"}"#).await;
        seed_entity(&pool, "bob", "person", r#"{"name":"Bob"}"#).await;
        seed_entity(&pool, "t1", "todo", r#"{"title":"t1"}"#).await;
        seed_ref(&pool, "t1", "alice", "waiting_on").await;
        seed_ref(&pool, "t1", "bob", "related").await;

        let mut refs = person_refs_by_todo(&pool, "t1").await.expect("refs");
        refs.sort();
        assert_eq!(
            refs,
            vec![
                ("alice".to_string(), "waiting_on".to_string()),
                ("bob".to_string(), "related".to_string()),
            ]
        );
    }

    #[tokio::test]
    async fn project_people_derive_only_through_that_projects_todos() {
        let pool = memory_pool().await;
        seed_entity(&pool, "alice", "person", r#"{"name":"Alice"}"#).await;
        seed_entity(&pool, "bob", "person", r#"{"name":"Bob"}"#).await;
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
            r#"{"title":"t2","project_id":"proj-b"}"#,
        )
        .await;
        seed_ref(&pool, "t1", "alice", "waiting_on").await;
        // bob is on a DIFFERENT project's todo — must NOT appear under proj-a.
        seed_ref(&pool, "t2", "bob", "related").await;

        let people = project_people(&pool, "proj-a")
            .await
            .expect("project_people");
        assert_eq!(
            people,
            vec!["alice".to_string()],
            "only people linked through proj-a's todos"
        );
    }

    #[tokio::test]
    async fn person_projects_returns_distinct_project_ids() {
        let pool = memory_pool().await;
        seed_entity(&pool, "alice", "person", r#"{"name":"Alice"}"#).await;
        // Two todos in proj-a (DISTINCT collapses), one in proj-b, one with no project.
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
        seed_ref(&pool, "t1", "alice", "related").await;
        seed_ref(&pool, "t2", "alice", "related").await;
        seed_ref(&pool, "t3", "alice", "waiting_on").await;
        seed_ref(&pool, "t4", "alice", "related").await;

        let mut projects = person_projects(&pool, "alice")
            .await
            .expect("person_projects");
        projects.sort();
        assert_eq!(
            projects,
            vec!["proj-a".to_string(), "proj-b".to_string()],
            "distinct project ids, null project excluded"
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

    #[tokio::test]
    async fn projects_due_for_review_includes_reviewable_excludes_terminal_and_future() {
        let pool = memory_pool().await;
        let now = "2026-06-12T00:00:00";
        seed_entity(
            &pool,
            "p-active-due",
            "project",
            r#"{"name":"active due","status":"active","next_review_at":"2026-06-11T20:00:00"}"#,
        )
        .await;
        seed_entity(
            &pool,
            "p-onhold-due",
            "project",
            r#"{"name":"on_hold due","status":"on_hold","next_review_at":"2026-06-12T00:00:00"}"#,
        )
        .await;
        seed_entity(
            &pool,
            "p-active-future",
            "project",
            r#"{"name":"active future","status":"active","next_review_at":"2026-06-30T20:00:00"}"#,
        )
        .await;
        seed_entity(
            &pool,
            "p-completed",
            "project",
            r#"{"name":"done","status":"completed","completed_at":"2026-06-01T00:00:00","next_review_at":"2026-06-11T20:00:00"}"#,
        )
        .await;
        seed_entity(
            &pool,
            "p-dropped",
            "project",
            r#"{"name":"dropped","status":"dropped","dropped_at":"2026-06-01T00:00:00","next_review_at":"2026-06-11T20:00:00"}"#,
        )
        .await;
        seed_entity(
            &pool,
            "p-active-noreview",
            "project",
            r#"{"name":"active no review","status":"active"}"#,
        )
        .await;

        let mut ids: Vec<String> = projects_due_for_review(&pool, now)
            .await
            .expect("projects_due_for_review")
            .into_iter()
            .map(|row| row.id)
            .collect();
        ids.sort();
        assert_eq!(
            ids,
            vec!["p-active-due".to_string(), "p-onhold-due".to_string()],
            "active/on_hold with next_review_at <= now; terminal and future excluded"
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
                Some(EntityProvenance::Message { thread_id, thread_title })
                    if thread_id == "thr-1" && thread_title == "Morning brain dump"
            ),
            "Message-sourced Todo reports its Thread; updated_from does not override created_from"
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

    /// ADR-0043: `thread/get` rehydrates a Run's non-Proposal tool calls onto the
    /// assistant Message, in timeline order, but NEVER the Proposal tool call (it
    /// renders as a `ProposalCard`). Errored status maps to the wire `error`.
    #[tokio::test]
    async fn thread_get_rehydrates_tool_calls_excluding_proposals() {
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
        queries::insert_text_part(&mut *tx, assistant_id, 0, "Captured.")
            .await
            .expect("text part");
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

        // Only the two SETTLED search calls survive: the Proposal tool call renders
        // as a ProposalCard (excluded) and the `pending` call is owned by the live
        // tail, not rehydrated.
        assert_eq!(
            assistant.tool_calls.len(),
            2,
            "only settled non-Proposal tool calls rehydrate (no Proposal, no pending)"
        );
        // First call: completed, with its display arg derived from the payload.
        assert_eq!(assistant.tool_calls[0].name, "search_entities");
        assert_eq!(assistant.tool_calls[0].status, "completed");
        assert_eq!(assistant.tool_calls[0].arg.as_deref(), Some("Lev"));
        // Second call: `errored` maps to the wire `error` spelling, arg derived.
        assert_eq!(assistant.tool_calls[1].name, "search_entities");
        assert_eq!(assistant.tool_calls[1].status, "error");
        assert_eq!(assistant.tool_calls[1].arg.as_deref(), Some("Acme"));
        assert!(
            assistant
                .tool_calls
                .iter()
                .all(|tc| tc.name != "propose_workspace_mutation"),
            "no Proposal tool call in rehydrated rows"
        );
        assert!(
            assistant
                .tool_calls
                .iter()
                .all(|tc| tc.arg.as_deref() != Some("InFlight")),
            "a still-pending tool call must not rehydrate"
        );
        // The Run parked on a still-`pending` Proposal: its decided outcome is
        // absent (the live interactive card owns a pending Proposal — ADR-0044).
        assert!(
            assistant.proposal.is_none(),
            "a still-pending Proposal must not rehydrate as a decided outcome"
        );
    }

    /// ADR-0044: `thread/get` rehydrates the assistant turn's DECIDED Proposal
    /// outcome (so the "Applied." indicator survives reload), but only once it is
    /// `accepted`/`rejected` — a `pending` one renders its interactive card.
    #[tokio::test]
    async fn thread_get_rehydrates_decided_proposal() {
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
        queries::insert_text_part(&mut *tx, assistant_id, 0, "Logged.")
            .await
            .expect("text part");
        tx.commit().await.expect("commit seed");

        // Park on an apply_intent_graph Proposal, then ACCEPT it (the decided
        // outcome the reload must reconstruct).
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

        let (_title, rows) = get_thread_with_messages(&pool, thread_id)
            .await
            .expect("read ok")
            .expect("thread exists");
        let assistant = rows
            .iter()
            .find(|m| m.role == "assistant")
            .expect("assistant row");

        let proposal = assistant
            .proposal
            .as_ref()
            .expect("decided Proposal rehydrates onto the assistant turn");
        assert_eq!(proposal.proposal_id, "proposal-graph");
        assert_eq!(proposal.mutation_kind, "apply_intent_graph");
        assert_eq!(proposal.status, "accepted");
        // The Proposal tool call still never rehydrates as a tool-activity row.
        assert!(
            assistant
                .tool_calls
                .iter()
                .all(|tc| tc.name != "propose_workspace_mutation"),
            "the decided Proposal surfaces via `proposal`, never as a tool row"
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
            .proposal
            .as_ref()
            .expect("rejected Proposal rehydrates onto the assistant turn");
        assert_eq!(proposal.status, "rejected");
        assert_eq!(proposal.mutation_kind, "create_journal_entry");
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
            assistant.proposal.is_none(),
            "a cancelled Proposal must not rehydrate as a decided outcome"
        );
    }
}
