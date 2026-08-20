//! `proposal/get` (ADR-0025): fetch a parked Run's pending Proposal — its
//! mutation_kind, payload, rationale, and status. A Client that learns a Run
//! is `parked` (via `run/subscribe`) follows with `proposal/get(run_id)`.
//!
//! `proposal/decide` (ADR-0025, ADR-0016): apply a Decision then resume the
//! parked Run. The decide transaction lives in [`crate::decide`]; this handler
//! is the thin JSON-RPC shell (decode → `decide::apply` → map error → notify).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;

use super::handler::{self, HandlerError};
use super::reply::{send_proposal_changed, send_response};
use crate::db;
use crate::decide::{DecideError, DecideOutcome};
use crate::hub::Hubs;
use crate::protocol::{
    JournalEntryBodyNode, ProposalDecideParams, ProposalDecideResult, ProposalGetParams,
    ProposalGetResult, ProposalReviewContext, ProposalReviewCurrentJournalEntry,
    ProposalReviewCurrentPerson, ProposalReviewCurrentProject, ResolvedNode,
};

pub(super) async fn handle_get(
    pool: &SqlitePool,
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    handler::handle(id, params, out_tx, |params: ProposalGetParams| async move {
        let run_id = params.run_id;
        let p = db::get_pending_proposal_for_run(pool, run_id)
            .await
            .map_err(|e| HandlerError::Internal(e.into()))?
            .ok_or_else(|| {
                HandlerError::ProposalNotPending(format!("no pending proposal for run {run_id}"))
            })?;
        let review_context = review_context_for_proposal(pool, run_id, &p).await?;
        let resolved_plan = resolved_plan_for_proposal(pool, &p).await?;
        // The TickTick write family's pending read (ticktick-writes W-A4):
        // the `proposed` variant with the READ-DERIVED `stale_connection`, so
        // a stale card warns with accept disabled on FIRST render in any tab.
        let ticktick_write = crate::ticktick_write::wire_state_for_proposal(pool, &p.proposal_id)
            .await
            .map_err(|e| HandlerError::Internal(e.into()))?;

        Ok(ProposalGetResult {
            proposal_id: p.proposal_id,
            run_id: run_id.to_string(),
            mutation_kind: p.mutation_kind,
            payload: p.payload,
            rationale: p.rationale,
            review_context,
            resolved_plan,
            ticktick_write,
            status: p.status,
        })
    })
    .await;
}

/// `proposal/decide`: apply via [`crate::decide::apply`] (injecting
/// `worker::resume` as the resume closure), map the typed `DecideError` here,
/// then frame the result + push `proposal/changed`.
///
/// The TickTick write family runs DETACHED (ticktick-writes W-A3): an inline
/// A→C decide would freeze this connection — both directions — for the whole
/// remote call, so a same-socket `run/cancel` could never arrive during it.
pub(super) async fn handle_decide(
    pool: &SqlitePool,
    hubs: &Hubs,
    id: serde_json::Value,
    params: ProposalDecideParams,
    out_tx: &UnboundedSender<String>,
) {
    // Family pre-read (one cheap SELECT). An unknown id stays inline, where
    // `decide::apply` answers it canonically.
    let is_ticktick_write =
        match db::load_proposal_for_decide(pool, &params.proposal_id.to_string()).await {
            Ok(Some(p)) => p.mutation_kind == crate::ticktick_write::MUTATION_KIND,
            Ok(None) => false,
            Err(e) => {
                handler::frame_error(out_tx, id, HandlerError::Internal(e.into()));
                return;
            }
        };
    if is_ticktick_write {
        let pool = pool.clone();
        let hubs = hubs.clone();
        let out_tx = out_tx.clone();
        tokio::spawn(async move {
            // The JoinHandle turns a panic into a JoinError, and `responded`
            // makes the recovery frame conditional — so one request still gets
            // exactly one response, even if the body dies after framing it.
            let responded = Arc::new(AtomicBool::new(false));
            let inner = tokio::spawn(handle_decide_ticktick_write(
                pool,
                hubs,
                id.clone(),
                params,
                out_tx.clone(),
                responded.clone(),
            ));
            if inner.await.is_err() && !responded.load(Ordering::SeqCst) {
                tracing::error!(event = "ticktick_write.decide_task_died");
                handler::frame_error(
                    &out_tx,
                    id,
                    HandlerError::Internal(anyhow::anyhow!("ticktick write decide task died")),
                );
            }
        });
        return;
    }

    match crate::decide::apply(
        pool,
        params.proposal_id,
        &params.decision,
        params.edited_payload,
        params.decisions,
        params.decision_idempotency_key,
        |run_id| crate::worker::resume(run_id, pool, hubs),
    )
    .await
    {
        Ok(DecideOutcome::Accepted { run_id, entity_id }) => {
            send_decide_result(out_tx, id, "accepted", entity_id, None);
            send_proposal_changed(out_tx, run_id, &params.proposal_id.to_string(), "accepted");
        }
        Ok(DecideOutcome::Rejected { run_id }) => {
            send_decide_result(out_tx, id, "rejected", None, None);
            send_proposal_changed(out_tx, run_id, &params.proposal_id.to_string(), "rejected");
        }
        Err(e) => handler::frame_error(out_tx, id, map_decide_error(e)),
    }
}

/// The write family's decide (ticktick-writes W-A3), running detached. Wires
/// the production collaborators into [`crate::ticktick_write::decide`]: the
/// real `client::create_task` POST, `worker::resume`, and the
/// `proposal/changed` push on this connection — then frames the response by
/// the captured request id.
async fn handle_decide_ticktick_write(
    pool: SqlitePool,
    hubs: Hubs,
    id: serde_json::Value,
    params: ProposalDecideParams,
    out_tx: UnboundedSender<String>,
    responded: Arc<AtomicBool>,
) {
    use crate::ticktick_write::{WriteDecide, WriteDecideError, WriteDeps};

    let proposal_id = params.proposal_id.to_string();
    let post: crate::ticktick_write::PostFn = std::sync::Arc::new(|body| {
        Box::pin(async move {
            match crate::ticktick::connection() {
                Some(conn) => {
                    crate::ticktick::client::create_task(&conn.access_token, &body).await
                }
                // Unreachable: phase A verified the boot-static connection
                // moments ago. Refuse without sending rather than panic.
                None => {
                    tracing::error!(event = "ticktick_write.post_without_connection");
                    crate::ticktick::client::WriteOutcome::Failed { http_status: None }
                }
            }
        })
    });
    let resume: crate::ticktick_write::ResumeFn = {
        let pool = pool.clone();
        let hubs = hubs.clone();
        std::sync::Arc::new(move |run_id| {
            let pool = pool.clone();
            let hubs = hubs.clone();
            Box::pin(async move { crate::worker::resume(run_id, &pool, &hubs).await })
        })
    };
    let notify: crate::ticktick_write::NotifyFn = {
        let out_tx = out_tx.clone();
        let proposal_id = proposal_id.clone();
        std::sync::Arc::new(move |run_id, status, write| {
            super::reply::send_proposal_changed_with_write(
                &out_tx,
                run_id,
                &proposal_id,
                status,
                Some(write.clone()),
            );
        })
    };
    let deps = WriteDeps {
        pool,
        post,
        resume,
        notify,
    };

    match crate::ticktick_write::decide(
        &deps,
        params.proposal_id,
        &params.decision,
        params.edited_payload,
        params.decision_idempotency_key,
    )
    .await
    {
        Ok(WriteDecide::Accepted { run_id, write }) => {
            responded.store(true, Ordering::SeqCst);
            send_decide_result(&out_tx, id, "accepted", None, Some(write.clone()));
            super::reply::send_proposal_changed_with_write(
                &out_tx,
                run_id,
                &proposal_id,
                "accepted",
                Some(write),
            );
        }
        Ok(WriteDecide::Rejected { run_id }) => {
            responded.store(true, Ordering::SeqCst);
            send_decide_result(&out_tx, id, "rejected", None, None);
            send_proposal_changed(&out_tx, run_id, &proposal_id, "rejected");
        }
        Err(e) => {
            responded.store(true, Ordering::SeqCst);
            handler::frame_error(
                &out_tx,
                id,
                match e {
                    WriteDecideError::StaleConnection => HandlerError::StaleConnection,
                    WriteDecideError::NotDecidable(m) => HandlerError::ProposalNotPending(m),
                    WriteDecideError::Invalid(m) => HandlerError::InvalidParams(m),
                    WriteDecideError::Internal(e) => HandlerError::Internal(e),
                },
            );
        }
    }
}

/// Map the decide module's typed failure to the wire vocabulary (ADR-0014):
/// lost race and not-decidable both → `proposal_not_pending`; invalid input →
/// `invalid_params`; everything else → internal.
fn map_decide_error(e: DecideError) -> HandlerError {
    match e {
        DecideError::LostRace => {
            HandlerError::ProposalNotPending("proposal is no longer pending".to_string())
        }
        DecideError::NotDecidable(m) => HandlerError::ProposalNotPending(m),
        DecideError::Invalid(m) => HandlerError::InvalidParams(m),
        DecideError::Internal(e) => HandlerError::Internal(e),
    }
}

fn send_decide_result(
    out_tx: &UnboundedSender<String>,
    id: serde_json::Value,
    status: &str,
    entity_id: Option<String>,
    ticktick_write: Option<crate::protocol::TickTickWriteState>,
) {
    send_response(
        out_tx,
        id,
        serde_json::to_value(ProposalDecideResult {
            status: status.to_string(),
            entity_id,
            ticktick_write,
        })
        .expect("ProposalDecideResult serializes"),
    );
}

/// The per-node create/reuse/ambiguous plan for an `apply_intent_graph` proposal
/// (ADR-0042), `None` (omitted on the wire) for every single-entity kind. Computed
/// READ-ONLY from the stored graph payload via [`db::resolved_plan_for`] so the
/// Client renders the badges without re-resolving — advisory display; decide
/// re-resolves authoritatively. Only `apply_intent_graph` carries a graph payload,
/// so other kinds short-circuit to `None` (their card is unchanged).
async fn resolved_plan_for_proposal(
    pool: &SqlitePool,
    proposal: &db::ProposalRow,
) -> Result<Option<Vec<ResolvedNode>>, HandlerError> {
    if crate::mutation::MutationKind::from_wire(&proposal.mutation_kind)
        != Some(crate::mutation::MutationKind::ApplyIntentGraph)
    {
        return Ok(None);
    }
    let plan = db::resolved_plan_for(pool, &proposal.payload)
        .await
        .map_err(|e| HandlerError::Internal(e.into()))?;
    Ok(Some(plan))
}

async fn review_context_for_proposal(
    pool: &SqlitePool,
    run_id: uuid::Uuid,
    proposal: &db::ProposalRow,
) -> Result<Option<ProposalReviewContext>, HandlerError> {
    // Only the agent-proposable kinds that mutate an EXISTING Journal Entry carry
    // review context. Resolve the stored kind to the typed predicate; a kind that
    // is unknown or not agent-proposable simply has no review context (Ok(None)),
    // matching the prior non-journal-kind early return.
    let Some(proposable) = crate::mutation::ProposableMutation::from_wire(&proposal.mutation_kind)
    else {
        return Ok(None);
    };
    if !proposable.carries_review_context() {
        return Ok(None);
    }

    // The Entity under review is the kind's target — `source_entity_id` for the
    // reference weave, `entity_id` for every other update/delete (from the
    // descriptor).
    let Some(kind) = proposable.entity_kind() else {
        return Ok(None);
    };
    let descriptor = kind.describe();
    let entity_id_field = descriptor
        .target_key
        .map(|k| k.as_str())
        .expect("a review-context kind always has a target key");
    let Some(entity_id) = proposal
        .payload
        .get(entity_id_field)
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
    else {
        return Ok(None);
    };

    // Dispatch on the kind's entity type. The Journal Entry path keeps its
    // cross-thread gate (review context is scoped to the Run's own Thread); the
    // Person/Project full-document REPLACE updates (lamplit-desk-alignment) read
    // the stored Entity by id and surface the fields a REPLACE would drop. A
    // missing/deleted Entity or unparseable snapshot degrades to `None` (the card
    // shows Proposed only) — never an error.
    use crate::mutation::EntityType;
    let context = match descriptor.entity_type {
        EntityType::JournalEntry => {
            let allowed = db::journal_entry_target_is_valid(pool, run_id, entity_id)
                .await
                .map_err(|e| HandlerError::Internal(e.into()))?;
            if !allowed {
                return Ok(None);
            }
            let Some(row) =
                db::current_entity_review_data(pool, entity_id, EntityType::JournalEntry)
                    .await
                    .map_err(|e| HandlerError::Internal(e.into()))?
            else {
                return Ok(None);
            };
            let Some(current) = review_current_journal_entry(row.entity_id, &row.data) else {
                return Ok(None);
            };
            ProposalReviewContext {
                current_journal_entry: Some(current),
                current_person: None,
                current_project: None,
            }
        }
        EntityType::Person => {
            let Some(row) = db::current_entity_review_data(pool, entity_id, EntityType::Person)
                .await
                .map_err(|e| HandlerError::Internal(e.into()))?
            else {
                return Ok(None);
            };
            let Some(current) = review_current_person(row.entity_id, &row.data) else {
                return Ok(None);
            };
            ProposalReviewContext {
                current_journal_entry: None,
                current_person: Some(current),
                current_project: None,
            }
        }
        EntityType::Project => {
            let Some(row) = db::current_entity_review_data(pool, entity_id, EntityType::Project)
                .await
                .map_err(|e| HandlerError::Internal(e.into()))?
            else {
                return Ok(None);
            };
            let Some(current) = review_current_project(row.entity_id, &row.data) else {
                return Ok(None);
            };
            ProposalReviewContext {
                current_journal_entry: None,
                current_person: None,
                current_project: Some(current),
            }
        }
        // No proposable Media/Habit kind carries review context (those
        // mutations are user-path-only). These degrade gracefully rather than
        // panic if a future kind reaches here.
        EntityType::Media | EntityType::Habit => return Ok(None),
    };

    Ok(Some(context))
}

/// Build the display-only Current Person from its stored `data` JSON
/// (lamplit-desk-alignment). Carries the fields the renderer displays — `name`
/// plus optional `note`/`aliases`. Returns `None` only when `name` is missing
/// (an unparseable snapshot), so the card degrades to Proposed-only.
fn review_current_person(
    entity_id: String,
    data: &serde_json::Value,
) -> Option<ProposalReviewCurrentPerson> {
    let name = data.get("name")?.as_str()?.to_string();
    let note = optional_string(data, "note");
    let aliases = data.get("aliases").and_then(|v| {
        v.as_array().map(|arr| {
            arr.iter()
                .filter_map(|n| n.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
    });
    Some(ProposalReviewCurrentPerson {
        entity_id,
        name,
        note,
        aliases,
    })
}

/// Build the display-only Current Project from its stored `data` JSON. Carries
/// `name` plus optional `outcome`/`status`/`note`.
fn review_current_project(
    entity_id: String,
    data: &serde_json::Value,
) -> Option<ProposalReviewCurrentProject> {
    let name = data.get("name")?.as_str()?.to_string();
    Some(ProposalReviewCurrentProject {
        entity_id,
        name,
        outcome: optional_string(data, "outcome"),
        status: optional_string(data, "status"),
        note: optional_string(data, "note"),
    })
}

/// Read an optional string field from the stored `data` JSON for review context:
/// a present string is carried; absent/null is `None`. A non-string value is
/// treated as absent (display-only read — corruption is rejected on apply, not
/// here).
fn optional_string(data: &serde_json::Value, key: &str) -> Option<String> {
    data.get(key).and_then(|v| v.as_str()).map(str::to_string)
}

fn review_current_journal_entry(
    entity_id: String,
    data: &serde_json::Value,
) -> Option<ProposalReviewCurrentJournalEntry> {
    let occurred_at = data.get("occurred_at")?.as_str()?.to_string();
    let ended_at = match data.get("ended_at") {
        Some(serde_json::Value::String(value)) => Some(value.clone()),
        Some(serde_json::Value::Null) | None => None,
        Some(_) => return None,
    };
    let body = data
        .get("body")?
        .as_array()?
        .iter()
        .map(|node| {
            let obj = node.as_object()?;
            let node_type = obj.get("type")?.as_str()?;
            match node_type {
                "text" => {
                    let text = obj.get("text")?.as_str()?.to_string();
                    Some(JournalEntryBodyNode::Text { text })
                }
                "entity_ref" => {
                    let ref_id = obj.get("ref_id")?.as_str()?.to_string();
                    Some(JournalEntryBodyNode::EntityRef { ref_id })
                }
                _ => None,
            }
        })
        .collect::<Option<Vec<_>>>()?;

    Some(ProposalReviewCurrentJournalEntry {
        entity_id,
        occurred_at,
        ended_at,
        body,
    })
}
