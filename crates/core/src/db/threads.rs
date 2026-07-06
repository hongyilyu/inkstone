//! Thread storage facade. SQL stays in [`queries`], matching the DB module's
//! one-statement query convention; this module owns the Thread read/mutate
//! operations and the `thread/get` Message-timeline assembly shapes.

use sqlx::SqlitePool;
use uuid::Uuid;

use super::queries;

/// Whether a Thread row exists. `run/post_message` is existing-thread-only
/// (ADR-0022); an unknown `thread_id` is rejected with `unknown_thread`.
pub async fn thread_exists(pool: &SqlitePool, thread_id: Uuid) -> sqlx::Result<bool> {
    queries::thread_exists(pool, thread_id).await
}

/// Read all ACTIVE Threads for `thread/list` (ADR-0022), most-recent-activity-
/// first, as `(id, title, last_activity_at)` rows. Archived Threads (ADR-0052)
/// are excluded.
pub async fn list_threads(pool: &SqlitePool) -> sqlx::Result<Vec<(String, String, i64)>> {
    queries::list_threads(pool).await
}

/// Read the ARCHIVED Threads for `thread/list_archived` (ADR-0052),
/// newest-archived first, as `(id, title, last_activity_at)` rows — the same
/// tuple shape `list_threads` returns, so the Archived view reuses it.
pub async fn list_archived_threads(
    pool: &SqlitePool,
) -> sqlx::Result<Vec<(String, String, i64)>> {
    queries::list_archived_threads(pool).await
}

/// Archive a Thread by stamping `archived_at` (ms-epoch), hiding it from the
/// default `list_threads` (ADR-0052). Does NOT cascade — the Thread's messages,
/// runs, and "Captured from" provenance survive (archive-not-delete; a hard
/// delete would cascade away the Message an Entity's provenance points at). Does
/// NOT bump `last_activity_at`.
pub async fn archive_thread(
    pool: &SqlitePool,
    thread_id: Uuid,
    now_ms: i64,
) -> sqlx::Result<()> {
    queries::archive_thread(pool, thread_id, now_ms).await
}

/// Un-archive a Thread by clearing `archived_at`, returning it to the default
/// `list_threads` (ADR-0052). The inverse of [`archive_thread`].
pub async fn unarchive_thread(pool: &SqlitePool, thread_id: Uuid) -> sqlx::Result<()> {
    queries::unarchive_thread(pool, thread_id).await
}

/// Overwrite a Thread's title by id (the generated-title write). A silent no-op
/// when the row is absent, and deliberately does NOT bump `last_activity_at` —
/// titling is not activity, so it must not reorder the `thread/list` feed.
pub async fn update_thread_title(
    pool: &SqlitePool,
    thread_id: Uuid,
    title: &str,
) -> sqlx::Result<()> {
    queries::update_thread_title(pool, thread_id, title).await
}

/// One item of an assistant turn's ordered `segments[]` timeline for `thread/get`
/// rehydration (ADR-0045), in `run_steps` `seq` order. The db-side mirror of the
/// wire `protocol::Segment`; [`crate::runs::thread_get`] maps each variant to the
/// wire union. Supersedes the read-path shapes of ADR-0043 (`tool_calls`) and
/// ADR-0044 (`proposal`): both fold into this ordered list.
#[derive(Debug)]
pub enum MessageSegment {
    /// A contiguous run of assistant text (one `message_parts` row).
    Text { text: String },
    /// A settled tool-activity row (ADR-0043): the persisted status mapped to the
    /// wire spelling (`errored`/anything-unexpected → `error`, `completed` →
    /// `completed`) and the display `arg` derived from the request payload via the
    /// same per-tool extractor the live `tool_call` Run Event uses.
    ToolCall {
        name: String,
        status: String,
        arg: Option<String>,
    },
    /// The decided Proposal the turn parked on (ADR-0044): `accepted`/`rejected`
    /// only — pending/cancelled are skipped at assembly. `entity_id` (ADR-0044
    /// entity_id amendment) is the durable Entity the accepted change
    /// created/updated — the anchor for `apply_intent_graph` — so the decided card
    /// can name + deep-link it. `None` for a `rejected` Proposal (nothing created)
    /// or when no Entity resolves.
    Proposal {
        proposal_id: String,
        mutation_kind: String,
        status: String,
        entity_id: Option<String>,
    },
    /// A reasoning/thinking segment (ADR-0045 reasoning amendment, #202): the
    /// streamed thinking text plus Core-computed think duration (next-step
    /// created_at − this step's, or run.ended_at when last; None when unknown).
    /// Display-only — never replayed into the worker transcript (resume excludes it).
    Reasoning { text: String, duration_ms: Option<i64> },
}

/// One Message in a `thread/get` read. `segments` is the assistant turn's ordered
/// timeline (ADR-0045) — text/tool_call/proposal items in `run_steps` order; a user
/// Message carries a single `text` segment. Replaces the prior assembled flat
/// `text` + separate `tool_calls` (ADR-0043) + `proposal` (ADR-0044) fields, which
/// all fold into the ordered list.
pub struct MessageRow {
    pub id: String,
    pub role: String,
    pub status: String,
    pub run_id: String,
    pub segments: Vec<MessageSegment>,
}

impl MessageRow {
    /// The Message's flat reply text — its `text` segments concatenated in order
    /// (ADR-0045: there is no denormalized flat field; text derives from segments,
    /// the Rust analogue of the Client's `concatText`). Backs the `read_thread`
    /// tool, which surfaces each prior Message's text to the model.
    pub fn text(&self) -> String {
        self.segments
            .iter()
            .filter_map(|segment| match segment {
                MessageSegment::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }
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
        // The assistant turn replays its ORDERED segment timeline from `run_steps`
        // (text/tool_call/proposal interleaved in seq order, ADR-0045). A user
        // Message has no run-step timeline of its own — it is a single text
        // segment from its concatenated text parts. Both forms drop an empty text
        // segment so a blank part never renders.
        let segments = if role == "assistant" {
            segment_rows_for_run(pool, &run_id, &id).await?
        } else {
            let text = queries::text_parts_by_message(pool, &id).await?.concat();
            if text.is_empty() {
                Vec::new()
            } else {
                vec![MessageSegment::Text { text }]
            }
        };
        messages.push(MessageRow {
            id,
            role,
            status,
            run_id,
            segments,
        });
    }

    Ok(Some((title, messages)))
}

/// Assemble an assistant Run's ordered `segments[]` for `thread/get` rehydration
/// (ADR-0045): walk [`queries::segment_timeline`] in `run_steps` `seq` order and
/// turn each step into a `text` / `tool_call` / `proposal` segment, applying the
/// settled-history filters ADR-0043/0044 specify (all over the parsed status
/// strings here, so the one ordered SQL walk is never broken by a per-kind
/// sub-read):
///
/// - `message` step → a `Text` segment, skipping an empty-text part.
/// - `tool_call` step carrying a `proposals` row → a `Proposal` segment, but only
///   for a DECIDED (`accepted`/`rejected`) Proposal — a `pending` one renders its
///   interactive card (deferred) and a `cancelled` one is cleared live (ADR-0044).
///   A Run that parks more than once (decide, resume, park again) holds several
///   decided Proposals; only the MOST-RECENT rehydrates, as a single indicator per
///   turn — the live store shows one card per `run_id`, and the superseded ADR-0044
///   read collapsed to `decided_at DESC LIMIT 1`. Proposal steps appear in `seq`
///   order, which is `decided_at` order (a Run must decide its first Proposal before
///   resuming to park on a second), so the LAST decided step in the walk is the
///   most-recent; earlier decided Proposals emit nothing.
/// - `tool_call` step without a `proposals` row → a `ToolCall` segment, skipping a
///   `pending` call (an in-flight call at reload time is owned by the live tail,
///   ADR-0043) and any Proposal-named tool that somehow lacks its `proposals` row
///   (defensive: a Proposal renders as a card, never a tool-activity row).
///
/// `message` steps are scoped to `assistant_message_id` (the Run's user-Message
/// text step belongs to the user `MessageRow`, not this turn — see
/// [`queries::segment_timeline`]). A `run_id` that does not parse as a UUID yields
/// no segments (best-effort read; a malformed id has no rehydratable timeline).
async fn segment_rows_for_run(
    pool: &SqlitePool,
    run_id: &str,
    assistant_message_id: &str,
) -> sqlx::Result<Vec<MessageSegment>> {
    let Ok(run_uuid) = Uuid::parse_str(run_id) else {
        return Ok(Vec::new());
    };
    let rows = queries::segment_timeline(pool, run_uuid, assistant_message_id).await?;
    // The row index of the LAST decided Proposal step — the only Proposal that
    // rehydrates, so a multi-park Run surfaces one indicator (its most-recent
    // decision), matching the live store and the superseded ADR-0044 read.
    let last_decided_proposal = rows.iter().rposition(|row| {
        row.kind == "tool_call"
            && row.proposal_id.is_some()
            && matches!(row.proposal_status.as_deref(), Some("accepted" | "rejected"))
    });
    let mut segments = Vec::with_capacity(rows.len());
    for (idx, row) in rows.into_iter().enumerate() {
        let queries::SegmentTimelineRow {
            kind,
            part_text,
            part_type,
            tc_name,
            tc_status,
            request_payload,
            proposal_id,
            mutation_kind,
            proposal_status,
            duration_ms,
        } = row;
        match kind.as_str() {
            "message" => {
                let text = part_text.unwrap_or_default();
                if text.is_empty() {
                    // An empty part renders nothing — for either text or
                    // reasoning (a thinking block that streamed no content).
                    continue;
                }
                // The part TYPE distinguishes a reasoning segment from text
                // (ADR-0045 reasoning amendment): both are `kind='message'` steps;
                // only `message_parts.type` tells them apart. `duration_ms` is the
                // Core-computed think span (None for text rows or when unknown).
                if part_type.as_deref() == Some("reasoning") {
                    segments.push(MessageSegment::Reasoning { text, duration_ms });
                } else {
                    segments.push(MessageSegment::Text { text });
                }
            }
            "tool_call" => {
                let name = tc_name.unwrap_or_default();
                if let Some(proposal_id) = proposal_id {
                    // A Proposal step: rehydrate only the DECIDED outcome (ADR-0044),
                    // and only the MOST-RECENT decided Proposal of a multi-park Run
                    // (`last_decided_proposal`). Earlier decided Proposals, and any
                    // pending/cancelled one, emit nothing.
                    let status = proposal_status.unwrap_or_default();
                    if (status == "accepted" || status == "rejected")
                        && Some(idx) == last_decided_proposal
                    {
                        // Resolve the durable Entity the decided change created/updated
                        // (ADR-0044 entity_id amendment) so the decided card can name +
                        // deep-link it. `entity_id_for_proposal` is JE-anchor
                        // deterministic, matching the live decide result. Only the
                        // single decided proposal is resolved (one round-trip). A reject
                        // created nothing, so this resolves `None`.
                        let entity_id =
                            queries::entity_id_for_proposal(pool, &proposal_id).await?;
                        segments.push(MessageSegment::Proposal {
                            proposal_id,
                            mutation_kind: mutation_kind.unwrap_or_default(),
                            status,
                            entity_id,
                        });
                    }
                } else if !crate::tools::is_proposal(&name) {
                    // A non-Proposal tool call → a settled tool-activity row
                    // (ADR-0043). Skip a `pending` call; map the persisted status to
                    // the wire spelling, never leaking a non-vocabulary value.
                    let status = tc_status.unwrap_or_default();
                    if status != "pending" {
                        // Derive the display arg from the stored request payload via
                        // the same per-tool extractor the live `tool_call` Run Event
                        // uses, so the reloaded row matches the live one. A malformed
                        // payload yields no arg (best-effort read).
                        let arg = request_payload
                            .as_deref()
                            .and_then(|p| serde_json::from_str::<serde_json::Value>(p).ok())
                            .and_then(|params| crate::tools::display_arg(&name, &params));
                        segments.push(MessageSegment::ToolCall {
                            name,
                            status: if status == "completed" {
                                "completed".to_string()
                            } else {
                                "error".to_string()
                            },
                            arg,
                        });
                    }
                }
            }
            _ => {}
        }
    }
    Ok(segments)
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;
    use crate::db::{
        park_on_proposal, persist_thread_with_first_run, persist_tool_call, resolve_tool_call,
    };
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
}
