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
