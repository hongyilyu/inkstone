//! The intent-graph resolve+apply path (ADR-0042), the sibling to
//! [`super::apply_proposal`] for the one mutation kind that is NOT a single
//! entity. Where `apply_proposal` flips the Proposal, runs ONE
//! [`super::apply::apply_entity_mutation`], and resolves the tool call,
//! [`apply_intent_graph_proposal`] keeps the same envelope but its middle is a
//! GRAPH: it LOOPS `apply_entity_mutation` once per CREATE-disposition node — the
//! Journal Entry node (if present) and every entity node that did not resolve to
//! an existing row — in one transaction, topologically ordered (JE first, then
//! entities). Each node carries its OWN single-entity kind, so the per-type data
//! normalization, validation, and the seq-1 revision write are exactly the
//! single-entity create path's, reused.
//!
//! Slice 3 adds EXACT-MATCH RESOLUTION (ADR-0042 "disposition"): each entity node
//! resolves to a `disposition` INSIDE the tx, before the create loop, so it sees
//! this tx's own freshly-minted entities (later slices) and is race-free on the
//! `max_connections(1)` pool:
//!   - `reuse`: the node's `existing_id` hint names an accepted entity of the
//!     matching type (honor the hint), ELSE an exact (case-insensitive, trimmed)
//!     name/title + type match against the accepted set yields exactly ONE row.
//!     A reused node mints NOTHING (no entity, no revision); slice 4 reads its
//!     resolved id to apply links.
//!   - `create`: zero matches → mint fresh (the slice-2 path).
//!   - `ambiguous`: two or more matches → the whole apply FAILS
//!     `InvalidMutation` (ADR-0042 "An ambiguous node has no silent fallback");
//!     the tx rolls back, nothing is written. The disambiguation picker / per-node
//!     `entity_id` override is slice 5 / #181.
//!
//! The JE node stays create-only (ADR-0042 "the JE node is create-only"): it is
//! always newborn and carries no disposition.
//!
//! Provenance (ADR-0042 "No provenance writes"): the ONLY `entity_sources` row
//! the graph writes is the JE node's `created_from` user-Message guard row (the
//! cross-thread-guard input, NOT entity provenance). It is passed as the JE
//! node's `EntitySource`; every created entity node passes `source: None`, so the
//! extracted Person/Project/Todo get NO source row — an entity view derives its
//! origin from backlinks, not a source row.

use uuid::Uuid;

use super::ApplyError;
use super::apply::{self, EntityMutationSpec, EntitySource};
use super::lifecycle::ProposalStatus;
use super::queries;
use crate::mutation::{MutationKind, SourceRelation};

/// One resolved graph node to MINT in-tx (the JE node + every `create`-disposition
/// entity node). `kind` is the node's single-entity create kind (selects validator
/// + Entity Type); `payload` is the reconstructed single-entity payload the create
/// path expects (the graph-local `handle`/`type`/`existing_id` removed; a Todo
/// re-wrapped in its `{todo: …}` envelope). `is_journal_anchor` marks the single
/// JE node — the only node that writes the `created_from` guard row, and the
/// anchor reported.
struct ResolvedCreate {
    kind: MutationKind,
    payload: serde_json::Value,
    is_journal_anchor: bool,
}

/// One extracted entity node, BEFORE its in-tx disposition is resolved. Carries
/// both the create payload (used when the node resolves to `create`) and the
/// exact-match inputs (`type_str` + trimmed `label` + the optional `existing_id`
/// hint) the resolver matches against the accepted set. The JE node is NOT an
/// `EntityNode` — it is create-only and extracted directly into a `ResolvedCreate`.
struct EntityNode {
    /// The node's single-entity create kind (`create_person`/`project`/`todo`).
    kind: MutationKind,
    /// The reconstructed single-entity create payload (handle/type/existing_id
    /// stripped; a Todo wrapped in `{todo: …}`).
    payload: serde_json::Value,
    /// The stored `entities.type` string for this node (`person`/`project`/`todo`).
    type_str: &'static str,
    /// The node's display handle (`@morris`), surfaced in an ambiguous error.
    handle: String,
    /// The trimmed label to exact-match on — `name` for person/project, `title`
    /// for todo. `None` when the node carries no usable label (no exact-match
    /// possible → always `create`).
    label: Option<String>,
    /// The model's optional `existing_id` reuse hint (ADR-0042). Honored when it
    /// names an accepted entity of the matching type; otherwise ignored and the
    /// node falls back to exact-match.
    existing_id: Option<String>,
}

/// The structurally-extracted graph: the create-only JE node (if present) and the
/// entity nodes awaiting in-tx disposition. Pure/poolless — a malformed graph
/// fails here as `InvalidMutation` before any tx opens.
struct ExtractedGraph {
    journal_entry: Option<ResolvedCreate>,
    entities: Vec<EntityNode>,
}

/// Apply an accepted `apply_intent_graph` Proposal in one atomic transaction
/// (ADR-0042), mirroring [`super::apply_proposal`]'s envelope: begin → guarded
/// accept-flip → resolve dispositions + apply the graph → resolve the tool call →
/// commit. Any failure drops the tx (nothing partial lands). Returns the anchor
/// `entity_id` — the Journal Entry node's id, or the first MINTED entity's id for
/// a JE-less direct-capture graph (ADR-0042).
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
    // Extract the graph BEFORE opening the tx: pure structural work (parse +
    // reconstruct each node's create payload, capture each entity node's
    // exact-match inputs) that needs no DB. A malformed graph fails here as
    // `InvalidMutation` and nothing is touched. The EXACT-MATCH disposition step
    // runs INSIDE the tx below (it must see freshly-minted entities and be
    // race-free), but extraction + per-type validation stays poolless.
    let graph = extract_graph(payload)?;

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

    // Resolve each entity node's disposition against the ACCEPTED set, IN-TX (it
    // sees this tx's freshly-minted rows; the serialized pool makes it race-free).
    // An ambiguous node (>= 2 exact matches) fails the WHOLE apply here — no
    // silent fallback (ADR-0042) — dropping the tx so nothing lands. A `create`
    // node carries its `ResolvedCreate` forward to mint; a `reuse` node carries
    // its resolved existing id (read by slice 4 for links) and mints nothing.
    let mut creates: Vec<ResolvedCreate> = Vec::new();
    if let Some(je) = graph.journal_entry {
        creates.push(je);
    }
    for node in &graph.entities {
        match resolve_disposition(&mut tx, node).await? {
            // slice 4 reads each reuse node's resolved id to apply its links.
            Disposition::Reuse(_existing_id) => {}
            Disposition::Create => creates.push(ResolvedCreate {
                kind: node.kind,
                payload: node.payload.clone(),
                is_journal_anchor: false,
            }),
        }
    }

    // Topo-order is JE-first (slice 3 has no inter-entity link deps yet, so the
    // JE precedes the create-disposition entities). Loop the shared single-entity
    // create core per MINT node; the JE node additionally writes its `created_from`
    // guard source row, every entity node writes none.
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
    // entity exists, joining each link endpoint handle → its resolved id (create
    // → minted, reuse → existing).

    // The anchor is the JE id; a JE-less direct-capture graph reports the first
    // MINTED entity (ADR-0042). A graph whose only nodes all resolved to `reuse`
    // (a JE-less graph that mints nothing) has no anchor — that is a degenerate
    // all-reuse graph and surfaces a clean `InvalidMutation` rather than a panic.
    let anchor = anchor_entity_id.or(first_entity_id).ok_or_else(|| {
        ApplyError::InvalidMutation("intent graph created no entity".to_string())
    })?;

    let result_payload = decision_result_payload(&anchor);
    queries::resolve_tool_call(&mut *tx, tool_call_id, "completed", &result_payload, now_ms).await?;

    tx.commit().await?;
    Ok(anchor)
}

/// One entity node's resolved disposition (ADR-0042). `ambiguous` is not a variant
/// — it surfaces as an `Err(InvalidMutation)` from [`resolve_disposition`] so the
/// whole apply fails with no fallback. `Reuse`'s id is read by slice 4 for links.
enum Disposition {
    /// Mint a fresh entity (zero exact matches).
    Create,
    /// Reuse this accepted entity's id (the `existing_id` hint, or the sole exact
    /// match). Mints nothing this slice.
    Reuse(#[allow(dead_code)] String),
}

/// Resolve one entity node's disposition against the ACCEPTED set, IN-TX (ADR-0042
/// "Resolution runs in-tx on the serialized pool"). The order matches the ADR:
///
/// 1. **`existing_id` hint** — if present AND it names an accepted entity of this
///    node's type, honor it → `reuse`. (A hint that does not resolve — stale or
///    wrong type — is ignored, falling through to exact-match.)
/// 2. **Exact match** — case-insensitive equality on the trimmed label
///    (`name`/`title`) AND `type` against the accepted rows: exactly one → `reuse`;
///    zero → `create`; two or more → `ambiguous` (`Err(InvalidMutation)`).
///
/// The accepted set is `queries::list_by_type` (every `entities` row is accepted),
/// run against the open `tx` so it sees this tx's own freshly-minted entities.
/// Matching is filtered in Rust (mirroring `search_entities`, avoiding SQL `LOWER`
/// portability concerns); the serialized pool makes the read race-free.
async fn resolve_disposition(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    node: &EntityNode,
) -> Result<Disposition, ApplyError> {
    // 1. Honor a usable `existing_id` hint (an accepted entity of the right type).
    if let Some(hint) = node.existing_id.as_deref().filter(|id| !id.is_empty())
        && queries::entity_is_type(&mut **tx, hint, node.type_str).await?
    {
        return Ok(Disposition::Reuse(hint.to_string()));
    }

    // 2. Exact (case-insensitive, trimmed) label + type match. Without a label
    //    there is nothing to match on, so the node is a fresh `create`.
    let Some(label) = node.label.as_deref() else {
        return Ok(Disposition::Create);
    };
    let needle = label.trim().to_lowercase();
    let label_key = label_key_for(node.type_str);

    let rows = queries::list_by_type(&mut **tx, node.type_str).await?;
    let mut matches = rows.into_iter().filter(|(_, _, data, _, _)| {
        serde_json::from_str::<serde_json::Value>(data)
            .ok()
            .as_ref()
            .and_then(|v| v.get(label_key))
            .and_then(serde_json::Value::as_str)
            .is_some_and(|stored| stored.trim().to_lowercase() == needle)
    });

    let Some((first_id, ..)) = matches.next() else {
        return Ok(Disposition::Create);
    };
    if matches.next().is_some() {
        // ADR-0042: two or more exact matches → ambiguous, no silent fallback.
        // The whole apply fails; the tx rolls back. The picker / `entity_id`
        // override (slice 5 / #181) is the only way to resolve this.
        return Err(ApplyError::InvalidMutation(format!(
            "intent graph node {} ({:?}) matches more than one existing {} named {:?}; \
             cannot resolve without disambiguation",
            node.handle, node.type_str, node.type_str, label
        )));
    }
    Ok(Disposition::Reuse(first_id))
}

/// The `data` key holding a node's exact-match label, per Entity Type (mirrors
/// `search_entities`'s `label_key`): `name` for person/project, `title` for todo.
fn label_key_for(type_str: &str) -> &'static str {
    match type_str {
        "todo" => "title",
        // person | project (the only other node types `resolve_entity_node` emits).
        _ => "name",
    }
}

/// Extract the graph payload into the create-only JE node (if present) and the
/// entity nodes awaiting in-tx disposition, each reconstructed into the
/// single-entity payload its create kind expects. A structurally broken graph
/// (non-object payload, missing/empty `entities`, unknown entity type) is
/// `InvalidMutation` — the whole apply fails, never partial (ADR-0042). Per-node
/// data validation happens in `apply_entity_mutation` itself (the single-entity
/// validator the create path already runs).
fn extract_graph(payload: &serde_json::Value) -> Result<ExtractedGraph, ApplyError> {
    let obj = payload.as_object().ok_or_else(|| {
        ApplyError::InvalidMutation("intent graph payload must be an object".to_string())
    })?;

    // JE first (the anchor minted ahead of the entities it could weave). An
    // absent or null `journal_entry` is the direct-capture flavor (ADR-0042).
    let journal_entry = match obj.get("journal_entry").filter(|v| !v.is_null()) {
        Some(node) => Some(resolve_journal_entry_node(node)?),
        None => None,
    };

    let entities = obj.get("entities").and_then(serde_json::Value::as_array).ok_or_else(|| {
        ApplyError::InvalidMutation("intent graph entities must be an array".to_string())
    })?;
    if entities.is_empty() {
        return Err(ApplyError::InvalidMutation(
            "intent graph must carry at least one entity".to_string(),
        ));
    }
    let entities = entities
        .iter()
        .map(resolve_entity_node)
        .collect::<Result<Vec<_>, _>>()?;

    Ok(ExtractedGraph {
        journal_entry,
        entities,
    })
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

/// Reconstruct one typed entity node into an [`EntityNode`]: its single-entity
/// create payload plus the exact-match inputs the resolver needs. Strips the
/// graph-local `handle`/`type`/`existing_id` from the create payload (none are
/// entity data); the `type` discriminant selects the create kind. A Todo's data
/// is wrapped in the `{todo: …}` envelope the `create_todo` path expects (it
/// unwraps + stores the inner TodoData); Person/Project pass their data flat.
/// `apply_entity_mutation` runs the per-type validator + data normalization (e.g.
/// a Project's default status/review seeding) on the reconstructed payload.
fn resolve_entity_node(node: &serde_json::Value) -> Result<EntityNode, ApplyError> {
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

    let (kind, type_str, payload) = match node_type {
        "person" => (MutationKind::CreatePerson, "person", data),
        "project" => (MutationKind::CreateProject, "project", data),
        // The create_todo path expects (and the data-seam unwraps) a
        // `{todo: TodoData}` envelope, so wrap the node's data.
        "todo" => (MutationKind::CreateTodo, "todo", serde_json::json!({ "todo": data })),
        other => {
            return Err(ApplyError::InvalidMutation(format!(
                "unknown intent graph entity type {other:?}"
            )));
        }
    };

    // The exact-match label is the node's own `name`/`title` (read off the raw
    // node, not the wrapped Todo payload). A blank/whitespace-only label is not a
    // usable match key → `None` (the node will always `create`).
    let label = obj
        .get(label_key_for(type_str))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let handle = obj
        .get("handle")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("<unnamed>")
        .to_string();

    let existing_id = obj
        .get("existing_id")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);

    Ok(EntityNode {
        kind,
        payload,
        type_str,
        handle,
        label,
        existing_id,
    })
}
