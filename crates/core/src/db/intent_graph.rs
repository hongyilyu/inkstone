//! The intent-graph resolve+apply path (ADR-0042), the sibling to
//! [`super::apply_proposal`] for the one mutation kind that is NOT a single
//! entity. Where `apply_proposal` flips the Proposal, runs ONE
//! [`super::apply::apply_entity_mutation`], and resolves the tool call,
//! [`apply_intent_graph_proposal`] keeps the same envelope but its middle is a
//! GRAPH: it LOOPS `apply_entity_mutation` once per resolved node — the Journal
//! Entry node (if present) and every entity node — in one transaction,
//! topologically ordered (JE first, then entities). Each node carries its OWN
//! single-entity kind, so the per-type data normalization, validation, and the
//! seq-1 revision write are exactly the single-entity create path's, reused.
//!
//! Slice 2 is CREATE-ONLY (ADR-0042 "the JE node is create-only"): every node
//! mints a fresh entity, no link is applied, no exact-match reuse runs. The
//! resolver is shaped so later slices plug in:
//!   - slice 3 adds exact-match resolution (`disposition: reuse | ambiguous`)
//!     before the create loop;
//!   - slice 4 applies `links` (todo_project / todo_person) after entities;
//!   - slice 5 reconciles the per-node decision vector into the accepted subset;
//!   - slice 6 weaves `journal_ref` body refs into the JE in one revision.
//!
//! Provenance (ADR-0042 "No provenance writes"): the ONLY `entity_sources` row
//! the graph writes is the JE node's `created_from` user-Message guard row (the
//! cross-thread-guard input, NOT entity provenance). It is passed as the JE
//! node's `EntitySource`; every entity node passes `source: None`, so the
//! extracted Person/Project/Todo get NO source row — an entity view derives its
//! origin from backlinks, not a source row.

use uuid::Uuid;

use super::ApplyError;
use super::apply::{self, EntityMutationSpec, EntitySource};
use super::lifecycle::ProposalStatus;
use super::queries;
use crate::mutation::{MutationKind, SourceRelation};

/// One resolved graph node to create in-tx (slice 2 mints all of them). `kind`
/// is the node's single-entity create kind (selects validator + Entity Type);
/// `payload` is the reconstructed single-entity payload the create path expects
/// (the graph-local `handle`/`type`/`existing_id` removed; a Todo re-wrapped in
/// its `{todo: …}` envelope). `is_journal_anchor` marks the single JE node — the
/// only node that writes the `created_from` guard row, and the anchor reported.
struct ResolvedCreate {
    kind: MutationKind,
    payload: serde_json::Value,
    is_journal_anchor: bool,
}

/// Apply an accepted `apply_intent_graph` Proposal in one atomic transaction
/// (ADR-0042), mirroring [`super::apply_proposal`]'s envelope: begin → guarded
/// accept-flip → resolve+apply the graph → resolve the tool call → commit. Any
/// failure drops the tx (nothing partial lands). Returns the anchor `entity_id`
/// — the Journal Entry node's id, or the first created entity's id for a
/// JE-less direct-capture graph (ADR-0042).
///
/// `decision_result_payload` is rendered AFTER the writes return so the resume
/// transcript can carry the real anchor id (matching `apply_proposal`).
#[allow(clippy::too_many_arguments)]
pub async fn apply_intent_graph_proposal(
    pool: &sqlx::SqlitePool,
    run_id: Uuid,
    proposal_id: &str,
    tool_call_id: &str,
    payload: &serde_json::Value,
    decision_idempotency_key: Option<&str>,
    decision_result_payload: impl FnOnce(&str) -> String,
    now_ms: i64,
) -> Result<String, ApplyError> {
    // Resolve the graph BEFORE opening the tx: pure structural work (extract +
    // per-type validate each node) that needs no DB. A malformed graph fails
    // here as `InvalidMutation` and nothing is touched. Slice 3 moves exact-match
    // resolution INTO the tx (it must see freshly-minted entities), but the
    // create-node extraction + validation stays poolless.
    let creates = resolve_graph_creates(payload)?;

    let mut tx = pool.begin().await?;

    // The guarded accept-flip — the SAME single concurrency choke
    // `apply_proposal` uses. On 0 rows a racing decide won, so the tx drops
    // (rollback) and nothing is written.
    let accepted = ProposalStatus::accept(
        &mut tx,
        run_id,
        proposal_id,
        // The graph is not corrected via the whole-payload `edited_payload`
        // (ADR-0042: per-node `edited_fields`, slice 5). Record no edit here.
        None,
        decision_idempotency_key,
        now_ms,
    )
    .await?;
    if !accepted.won() {
        return Err(ApplyError::NotPending);
    }

    // Topo-order is JE-first (slice 2 has no inter-entity link deps yet, so
    // `creates` already carries the JE first when present). Loop the shared
    // single-entity create core per node; the JE node additionally writes its
    // `created_from` guard source row, every entity node writes none.
    let mut anchor_entity_id: Option<String> = None;
    let mut first_entity_id: Option<String> = None;
    for create in &creates {
        let source = if create.is_journal_anchor {
            // The JE node's `created_from` user-Message guard row (ADR-0042) —
            // resolved INSIDE this tx, exactly as `apply_proposal` resolves a
            // message-sourced create. The JE is always newborn in this Run, so
            // the guard row is correct by construction (this Run's user Message).
            let message_id = queries::user_message_id_for_run(&mut *tx, run_id).await?;
            Some(EntitySource::FromMessage {
                message_id,
                relation: SourceRelation::CreatedFrom.as_str().to_string(),
            })
        } else {
            // ADR-0042 "No provenance writes": extracted entities get NO source row.
            None
        };

        let entity_id = apply::apply_entity_mutation(
            &mut tx,
            EntityMutationSpec {
                kind: create.kind,
                target_entity_id: None,
                payload: &create.payload,
                edited_payload: None,
                created_by: "proposal",
                proposal_id: Some(proposal_id),
                source,
                now_ms,
            },
        )
        .await?;

        first_entity_id.get_or_insert_with(|| entity_id.clone());
        if create.is_journal_anchor {
            anchor_entity_id = Some(entity_id);
        }
    }

    // slice 4: apply `links` (todo_project / todo_person) here, after every
    // entity exists, joining each link endpoint handle → its minted id.

    // The anchor is the JE id; a JE-less direct-capture graph reports the first
    // created entity (ADR-0042). `resolve_graph_creates` guarantees `>= 1` node,
    // so `first_entity_id` is always Some.
    let anchor = anchor_entity_id
        .or(first_entity_id)
        .ok_or_else(|| ApplyError::InvalidMutation("intent graph created no entity".to_string()))?;

    let result_payload = decision_result_payload(&anchor);
    queries::resolve_tool_call(&mut *tx, tool_call_id, "completed", &result_payload, now_ms).await?;

    tx.commit().await?;
    Ok(anchor)
}

/// Resolve the graph payload into the ordered create nodes (JE first, then
/// entities), each reconstructed into the single-entity payload its create kind
/// expects. Slice 2 is create-only: every node is minted. A structurally broken
/// graph (non-object payload, missing/empty `entities`, unknown entity type) is
/// `InvalidMutation` — the whole apply fails, never partial (ADR-0042). Per-node
/// data validation happens in `apply_entity_mutation` itself (the single-entity
/// validator the create path already runs).
fn resolve_graph_creates(payload: &serde_json::Value) -> Result<Vec<ResolvedCreate>, ApplyError> {
    let obj = payload.as_object().ok_or_else(|| {
        ApplyError::InvalidMutation("intent graph payload must be an object".to_string())
    })?;

    let mut creates = Vec::new();

    // JE first (the anchor minted ahead of the entities it could weave). An
    // absent or null `journal_entry` is the direct-capture flavor (ADR-0042).
    if let Some(journal_entry) = obj.get("journal_entry").filter(|v| !v.is_null()) {
        creates.push(resolve_journal_entry_node(journal_entry)?);
    }

    let entities = obj.get("entities").and_then(serde_json::Value::as_array).ok_or_else(|| {
        ApplyError::InvalidMutation("intent graph entities must be an array".to_string())
    })?;
    if entities.is_empty() {
        return Err(ApplyError::InvalidMutation(
            "intent graph must carry at least one entity".to_string(),
        ));
    }
    for node in entities {
        creates.push(resolve_entity_node(node)?);
    }

    // slice 3: re-resolve each entity node's disposition (existing_id hint →
    // reuse; exact name+type match → reuse / ambiguous) BEFORE the create loop,
    // dropping reused nodes from `creates` and surfacing ambiguous ones.

    Ok(creates)
}

/// Reconstruct the `journal_entry` node into a `create_journal_entry` payload:
/// `{occurred_at, ended_at?, body}` — the graph-local `handle` dropped (handles
/// are graph-internal join keys, never entity data).
///
/// Slice 2 is TEXT-ONLY: a body carrying `entity_ref` nodes is the slice-6 WEAVE
/// (mint `entity_refs`, rewrite each `target` handle into a stored `ref_id`), so
/// until that lands we REJECT any non-text body node here. This is load-bearing,
/// not belt-and-suspenders: the graph's decide-time schema permits `entity_ref`
/// body nodes, and `apply_entity_mutation` runs no content validation on the
/// reconstructed `create_journal_entry` payload (validation is the decide gate's
/// job, which validated the GRAPH shape, not the per-node create payload). Absent
/// this guard a graph whose JE body has an `{type:entity_ref, target}` node would
/// be stored VERBATIM — a dangling graph handle with no backing `entity_ref` row.
/// Rejecting here fails the whole tx cleanly (nothing partial, ADR-0042); slice 6
/// replaces this rejection with the actual weave.
fn resolve_journal_entry_node(node: &serde_json::Value) -> Result<ResolvedCreate, ApplyError> {
    let obj = node.as_object().ok_or_else(|| {
        ApplyError::InvalidMutation("journal_entry node must be an object".to_string())
    })?;

    let mut payload = serde_json::Map::new();
    for key in ["occurred_at", "ended_at", "body"] {
        if let Some(value) = obj.get(key) {
            payload.insert(key.to_string(), value.clone());
        }
    }

    // Reject non-text body nodes until slice 6 wires the weave (see doc above).
    if let Some(body) = obj.get("body").and_then(serde_json::Value::as_array) {
        for body_node in body {
            let node_type = body_node.get("type").and_then(serde_json::Value::as_str);
            if node_type != Some("text") {
                return Err(ApplyError::InvalidMutation(
                    "intent graph journal entry body may carry only text nodes until \
                     entity_ref weaving lands (ADR-0042 slice 6)"
                        .to_string(),
                ));
            }
        }
    }

    Ok(ResolvedCreate {
        kind: MutationKind::CreateJournalEntry,
        payload: serde_json::Value::Object(payload),
        is_journal_anchor: true,
    })
}

/// Reconstruct one typed entity node into its single-entity create payload.
/// Strips the graph-local `handle`/`type`/`existing_id` (none are entity data);
/// the `type` discriminant selects the create kind. A Todo's data is wrapped in
/// the `{todo: …}` envelope the `create_todo` path expects (it unwraps + stores
/// the inner TodoData); Person/Project pass their data flat. `apply_entity_mutation`
/// runs the per-type validator + data normalization (e.g. a Project's default
/// status/review seeding) on the reconstructed payload.
fn resolve_entity_node(node: &serde_json::Value) -> Result<ResolvedCreate, ApplyError> {
    let obj = node.as_object().ok_or_else(|| {
        ApplyError::InvalidMutation("intent graph entity must be an object".to_string())
    })?;

    let node_type = obj.get("type").and_then(serde_json::Value::as_str).ok_or_else(|| {
        ApplyError::InvalidMutation("intent graph entity is missing type".to_string())
    })?;

    // The entity data is every field EXCEPT the graph-local join/hint keys.
    let mut data = serde_json::Map::new();
    for (key, value) in obj {
        if matches!(key.as_str(), "handle" | "type" | "existing_id") {
            continue;
        }
        data.insert(key.clone(), value.clone());
    }
    let data = serde_json::Value::Object(data);

    let (kind, payload) = match node_type {
        "person" => (MutationKind::CreatePerson, data),
        "project" => (MutationKind::CreateProject, data),
        // The create_todo path expects (and the data-seam unwraps) a
        // `{todo: TodoData}` envelope, so wrap the node's data.
        "todo" => (MutationKind::CreateTodo, serde_json::json!({ "todo": data })),
        other => {
            return Err(ApplyError::InvalidMutation(format!(
                "unknown intent graph entity type {other:?}"
            )));
        }
    };

    Ok(ResolvedCreate {
        kind,
        payload,
        is_journal_anchor: false,
    })
}
