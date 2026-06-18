//! The intent-graph resolve+apply path (ADR-0042), the sibling to
//! [`super::apply_proposal`] for the one mutation kind that is NOT a single
//! entity. Where `apply_proposal` flips the Proposal, runs ONE
//! [`super::apply::apply_entity_mutation`], and resolves the tool call,
//! [`apply_intent_graph_proposal`] keeps the same envelope but its middle is a
//! GRAPH: it LOOPS `apply_entity_mutation` once per CREATE-disposition node — every
//! entity node that did not resolve to an existing row, then the Journal Entry node
//! (if present) — in one transaction. Each node carries its OWN single-entity kind,
//! so the per-type data normalization, validation, and the seq-1 revision write are
//! exactly the single-entity create path's, reused. The JE *entity row* is minted
//! LAST (after people/projects/todos) because its body weaves `journal_ref` mentions
//! into stored `entity_ref` nodes, which need the referenced entities' ids — see
//! [`weave_and_mint_journal_entry`] (ADR-0042 "Multi-ref Journal Entry weave is one
//! write"). The topo INTENT (a parent resolved before its dependent) still holds: a
//! Todo's `project_id`/person refs resolve before it mints, and the JE references
//! resolve before it mints.
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
//! always newborn and carries no disposition. Its body may carry
//! `{type:entity_ref, target:@handle}` placeholders, woven into stored
//! `{type:entity_ref, ref_id}` nodes at mint (one `entity_ref` row per surviving
//! `journal_ref` link); a placeholder whose target node was rejected collapses to
//! text (the reject-cascade).
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
use crate::protocol::{NodeDecision, ResolvedNode, ResolvedNodeCandidate};

/// The result of resolving+applying an `apply_intent_graph` Proposal under a
/// decision vector (ADR-0042). The graph reconciles its stored nodes against the
/// vector inside the one tx:
///   - `Applied(anchor)` — at least one node was accepted and minted/reused; the
///     anchor is the Journal Entry id (or the first created entity for a JE-less
///     direct-capture graph).
///   - `RejectedAll` — the vector rejected EVERY node, so nothing was written;
///     the Proposal is flipped *rejected* and the tool call resolved as a
///     decline (a vector that rejects all nodes is effectively a `reject`).
pub enum IntentGraphOutcome {
    Applied(String),
    RejectedAll,
}

/// One resolved graph node to MINT in-tx (the JE node + every `create`-disposition
/// entity node). `kind` is the node's single-entity create kind (selects validator
/// + Entity Type); `payload` is the reconstructed single-entity payload the create
/// path expects (the graph-local `handle`/`type`/`existing_id` removed; a Todo
/// re-wrapped in its `{todo: …}` envelope). `handle` is the node's graph-local
/// label (`@je`/`@rodeo`) — recorded into the handle→id map as the node mints, so a
/// later todo's links + the JE body weave can join on it. The JE node's
/// `created_from` guard row + anchor reporting are handled by
/// [`weave_and_mint_journal_entry`], so this struct carries no anchor flag.
struct ResolvedCreate {
    kind: MutationKind,
    payload: serde_json::Value,
    handle: String,
}

/// One intended link between two graph handles (ADR-0042). `from`/`to` are
/// graph-local handles the resolver joins on the handle→id map; `role` is set only
/// for `todo_person`. `todo_project` + `todo_person` fold into the linked Todo's
/// create payload; a `journal_ref` (JE → entity) weaves into the JE body as an
/// `entity_ref` (mint a row, rewrite the placeholder), in `weave_and_mint_journal_entry`.
struct Link {
    kind: LinkKind,
    from: String,
    to: String,
    /// The `todo_person` role (`waiting_on`/`related`); `None` for the other kinds.
    role: Option<String>,
}

/// The three link kinds (ADR-0042). `JournalRef` (JE → entity) is woven into the JE
/// body: each surviving link mints an `entity_ref` row and rewrites the body's
/// `{entity_ref, target}` placeholder to `{entity_ref, ref_id}`.
enum LinkKind {
    TodoProject,
    TodoPerson,
    JournalRef,
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

/// The structurally-extracted graph: the create-only JE node (if present), the
/// entity nodes awaiting in-tx disposition, and the intended links. Pure/poolless —
/// a malformed graph fails here as `InvalidMutation` before any tx opens.
struct ExtractedGraph {
    journal_entry: Option<ResolvedCreate>,
    entities: Vec<EntityNode>,
    links: Vec<Link>,
}

/// Compute the READ-ONLY resolved plan for an `apply_intent_graph` proposal's
/// stored graph payload (ADR-0042), so `proposal/get` can ship create/reuse/
/// ambiguous badges to the Client WITHOUT re-resolving. One [`ResolvedNode`] per
/// entity node (the JE node is create-only, carries no disposition, and is NOT a
/// plan node). Each node's disposition mirrors [`resolve_disposition`]'s natural
/// path EXACTLY — honor an `existing_id` hint, else exact (case-insensitive,
/// trimmed) label+type match against the accepted set: zero → `create`, one →
/// `reuse`, two-or-more → `ambiguous` (with the competing candidates). The model's
/// per-node `edited_fields`/`entity_id` decisions are NOT applied here (this is the
/// pre-decision display); the Client stages those locally.
///
/// This is a plain pool READ (no tx, no write) against the serialized
/// `max_connections(1)` pool — advisory display only. Resolution is authoritative
/// at decide, which RE-resolves in-tx; a node that reads `reuse` here but races to
/// deleted by decide-time is fine (decide handles it). A structurally malformed
/// graph (which decide would reject anyway) yields an EMPTY plan rather than
/// failing the read, so the Client still renders the card (degraded) instead of a
/// blank `proposal/get`.
pub async fn resolved_plan_for(
    pool: &sqlx::SqlitePool,
    payload: &serde_json::Value,
) -> sqlx::Result<Vec<ResolvedNode>> {
    let Ok(graph) = extract_graph(payload) else {
        // A malformed graph has no meaningful plan; the Client degrades to the
        // raw card. (Decide is the authoritative gate that rejects it.)
        return Ok(Vec::new());
    };

    let mut plan = Vec::with_capacity(graph.entities.len());
    for node in &graph.entities {
        let label = node.label.clone().unwrap_or_default();
        let disposition = resolve_plan_disposition(pool, node).await?;
        plan.push(match disposition {
            PlanDisposition::Create => ResolvedNode {
                handle: node.handle.clone(),
                r#type: node.type_str.to_string(),
                disposition: "create".to_string(),
                label,
                entity_id: None,
                candidates: None,
            },
            PlanDisposition::Reuse(entity_id) => ResolvedNode {
                handle: node.handle.clone(),
                r#type: node.type_str.to_string(),
                disposition: "reuse".to_string(),
                label,
                entity_id: Some(entity_id),
                candidates: None,
            },
            PlanDisposition::Ambiguous(candidates) => ResolvedNode {
                handle: node.handle.clone(),
                r#type: node.type_str.to_string(),
                disposition: "ambiguous".to_string(),
                label,
                entity_id: None,
                candidates: Some(candidates),
            },
        });
    }
    Ok(plan)
}

/// One entity node's resolved disposition for the READ-ONLY plan (ADR-0042). The
/// display analogue of the resolver's [`Disposition`]: `Ambiguous` is a VARIANT
/// here (the plan surfaces the competing candidates so the Client can show the
/// "needs disambiguation" hint), where the resolver fails the whole apply.
enum PlanDisposition {
    Create,
    Reuse(String),
    Ambiguous(Vec<ResolvedNodeCandidate>),
}

/// Resolve one entity node's disposition for the READ-ONLY plan, mirroring
/// [`resolve_disposition`]'s NATURAL path (no per-node override/edit — those are
/// staged in the Client). Reads the accepted set via `queries::list_by_type`
/// against the POOL (not a tx): there is no in-tx state at `proposal/get`. Returns
/// every competing match for an `ambiguous` node so the Client renders the
/// candidates.
async fn resolve_plan_disposition(
    pool: &sqlx::SqlitePool,
    node: &EntityNode,
) -> sqlx::Result<PlanDisposition> {
    // 1. Honor a usable `existing_id` hint (an accepted entity of the right type),
    //    exactly as `resolve_disposition` does.
    if let Some(hint) = node.existing_id.as_deref().filter(|id| !id.is_empty())
        && queries::entity_is_type(pool, hint, node.type_str).await?
    {
        return Ok(PlanDisposition::Reuse(hint.to_string()));
    }

    // 2. Exact (case-insensitive, trimmed) label + type match. Without a label
    //    there is nothing to match on → `create`.
    let Some(label) = node.label.as_deref() else {
        return Ok(PlanDisposition::Create);
    };
    let needle = label.trim().to_lowercase();
    let label_key = label_key_for(node.type_str);

    let rows = queries::list_by_type(pool, node.type_str).await?;
    let matches: Vec<ResolvedNodeCandidate> = rows
        .into_iter()
        .filter_map(|(id, _, data, _, _)| {
            let stored = serde_json::from_str::<serde_json::Value>(&data)
                .ok()?
                .get(label_key)?
                .as_str()?
                .to_string();
            (stored.trim().to_lowercase() == needle).then_some(ResolvedNodeCandidate {
                entity_id: id,
                label: stored,
            })
        })
        .collect();

    Ok(match matches.len() {
        0 => PlanDisposition::Create,
        1 => PlanDisposition::Reuse(matches.into_iter().next().expect("len == 1").entity_id),
        _ => PlanDisposition::Ambiguous(matches),
    })
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
    decisions: Option<&[NodeDecision]>,
    decision_idempotency_key: Option<&str>,
    decision_result_payload: impl FnOnce(&str) -> String,
    now_ms: i64,
) -> Result<IntentGraphOutcome, ApplyError> {
    // The per-node decision vector keyed by handle (ADR-0042). A missing entry =
    // accept (the common accept-all path; a plain `accept` with no vector accepts
    // everything). Built before the tx so reconciliation is pure structural work.
    let decisions = NodeDecisions::from_vector(decisions);
    // Extract the graph BEFORE opening the tx: pure structural work (parse +
    // reconstruct each node's create payload, capture each entity node's
    // exact-match inputs) that needs no DB. A malformed graph fails here as
    // `InvalidMutation` and nothing is touched. The EXACT-MATCH disposition step
    // runs INSIDE the tx below (it must see freshly-minted entities and be
    // race-free), but extraction + per-type validation stays poolless.
    let graph = extract_graph(payload)?;

    // ADR-0042 reject-all: if the decision vector rejects EVERY node (the JE node
    // too), nothing can be written — the accepted subset is empty. A vector that
    // rejects all nodes is effectively a plain `reject` (the primary reject-all
    // path is the scalar `reject` decision; this is the all-rejected *vector*).
    // Resolve it as a decline BEFORE the accept-flip so the Proposal lands
    // `rejected`, not `accepted`-then-empty.
    if accepted_subset_is_empty(&graph, &decisions) {
        return reject_whole_graph(
            pool,
            run_id,
            proposal_id,
            tool_call_id,
            decision_idempotency_key,
            now_ms,
        )
        .await;
    }

    let mut tx = pool.begin().await?;

    // The guarded accept-flip — the SAME single concurrency choke
    // `apply_proposal` uses. On 0 rows a racing decide won, so the tx drops
    // (rollback) and nothing is written.
    let accepted = ProposalStatus::accept(
        &mut tx,
        run_id,
        proposal_id,
        // The graph is not corrected via the whole-payload `edited_payload`
        // (ADR-0042: per-node `edited_fields`, applied below). Record no edit here.
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
    // silent fallback (ADR-0042) — dropping the tx so nothing lands.
    //
    // A `reuse` node mints nothing but records its handle → existing id into the
    // handle→id map, so a todo's link can join on it (the #179 existing-project
    // case). A `create` node is carried forward to mint, SPLIT into TODO vs
    // NON-TODO: the non-todos (person/project) mint FIRST so a todo's linked ids
    // are all known before the todo is minted, then the todos mint LAST with their
    // links folded into the create payload (ADR-0042 topo-order: JE → people/
    // projects → todos).
    let mut handle_to_id: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    // The model-recognized label per resolved handle (`name`/`title`), used as the
    // `entity_ref.label_snapshot` for fallback rendering when the JE body weaves a
    // `journal_ref` to this entity (ADR-0042). For an exact-match reuse this equals
    // the stored label; for a create it is the minted entity's label.
    let mut handle_to_label: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    let mut non_todo_creates: Vec<ResolvedCreate> = Vec::new();
    let mut todo_creates: Vec<ResolvedCreate> = Vec::new();
    // Reject the @je node (ADR-0042 "Reject the @je node"): the journal-anchored
    // capture collapses — nothing is woven, there is no anchor — but the non-JE
    // nodes still apply as a JE-less graph (their journal_ref links are dropped by
    // the cascade). A rejected JE is simply not minted; `je_create` stays `None`.
    let je_create = graph
        .journal_entry
        .filter(|je| !decisions.is_rejected(&je.handle));
    for node in &graph.entities {
        // A node the decision vector REJECTS is not created/reused (ADR-0042). It
        // is skipped here; its handle never enters `handle_to_id`, so the cascade
        // in `fold_links_into_todo` (and the JE body weave) drops every link/
        // placeholder to it (the reject-cascade: a rejected ref collapses to text).
        if decisions.is_rejected(&node.handle) {
            continue;
        }
        if let Some(label) = node.label.clone() {
            handle_to_label.insert(node.handle.clone(), label);
        }
        match resolve_node(&mut tx, node, decisions.for_handle(&node.handle)).await? {
            Disposition::Reuse(existing_id) => {
                // A reused node mints nothing; its handle resolves to the existing
                // id so a todo's link can target it (the #179 existing-project case,
                // and the `entity_id` override / picker path).
                //
                // A reused node is linked-TO, never rewritten (ADR-0042
                // create-and-link-only; a reuse "owns its current structured
                // state", ADR-0030). Outgoing `todo_project`/`todo_person` links are
                // folded only into a CREATED todo's payload (the loop below); a
                // REUSED todo never reaches it, so its surviving outgoing links
                // would be silently dropped. ADR-0042 forbids a silent drop ("a
                // link whose endpoint did not resolve is dropped AND reported, never
                // dangling-written"), and we cannot edit an existing Todo here, so
                // FAIL LOUD: a reused todo with surviving outgoing relationship
                // links is Invalid (editing an existing Todo's links is the picker /
                // direct-edit path, #181 — not the graph apply).
                if node.type_str == "todo"
                    && graph.links.iter().any(|link| {
                        link.from == node.handle
                            && matches!(link.kind, LinkKind::TodoProject | LinkKind::TodoPerson)
                            && !decisions.is_rejected(&link.to)
                    })
                {
                    return Err(ApplyError::InvalidMutation(format!(
                        "intent graph todo {} resolves to an existing Todo but carries outgoing \
                         relationship links; the graph does not edit an existing Todo's links",
                        node.handle
                    )));
                }
                handle_to_id.insert(node.handle.clone(), existing_id);
            }
            Disposition::Create(payload) => {
                let create = ResolvedCreate {
                    kind: node.kind,
                    // The payload may carry an `edited_fields` correction merged
                    // over the node's create payload (ADR-0042); else it is the
                    // node's own payload.
                    payload,
                    handle: node.handle.clone(),
                };
                if node.type_str == "todo" {
                    todo_creates.push(create);
                } else {
                    non_todo_creates.push(create);
                }
            }
        }
    }

    // Mint the non-todo entity creates FIRST, recording each minted handle → id so
    // the todos minted next can resolve their link endpoints. These entities carry
    // NO source row (ADR-0042 "No provenance writes").
    let mut first_entity_id: Option<String> = None;
    for create in &non_todo_creates {
        let entity_id =
            mint_create(&mut tx, create, proposal_id, /* source */ None, now_ms).await?;
        handle_to_id.insert(create.handle.clone(), entity_id.clone());
        first_entity_id.get_or_insert(entity_id);
    }

    // Mint the todos NEXT, folding their `todo_project`/`todo_person` links into
    // the create payload so the SAME `apply_entity_mutation(CreateTodo, …)` writes
    // `project_id` (with its in-tx `recheck_todo_project_link`) and the
    // `todo_person_refs` rows — link application reuses the create-todo path.
    for create in &mut todo_creates {
        fold_links_into_todo(
            &graph.links,
            &create.handle,
            &mut create.payload,
            &handle_to_id,
            &decisions,
        )?;
        let entity_id =
            mint_create(&mut tx, create, proposal_id, /* source */ None, now_ms).await?;
        handle_to_id.insert(create.handle.clone(), entity_id.clone());
        first_entity_id.get_or_insert(entity_id);
    }

    // Mint the JE LAST (ADR-0042 "Multi-ref Journal Entry weave is one write"):
    // every entity the JE could reference is now resolved (in `handle_to_id`), so
    // the JE body's `{entity_ref, target:@handle}` placeholders weave into stored
    // `{entity_ref, ref_id}` nodes in the JE's SINGLE seq-1 revision — never a
    // text-only insert followed by an update. The topo-order is JE → people/
    // projects → todos for FK/link purposes, but the JE *entity row* is minted last
    // because its body needs the referenced ids; its `entity_ref` rows (source = JE)
    // are inserted after the JE row exists.
    let mut anchor_entity_id: Option<String> = None;
    if let Some(je) = &je_create {
        let je_id = weave_and_mint_journal_entry(
            &mut tx,
            run_id,
            je,
            &graph.links,
            &handle_to_id,
            &handle_to_label,
            &decisions,
            proposal_id,
            now_ms,
        )
        .await?;
        first_entity_id.get_or_insert_with(|| je_id.clone());
        anchor_entity_id = Some(je_id);
    }

    // The anchor is the JE id; a JE-less direct-capture graph (or a graph whose JE
    // node was rejected) reports the first MINTED entity (ADR-0042). A graph whose
    // only nodes all resolved to `reuse` (mints nothing) has no anchor — a
    // degenerate all-reuse graph that surfaces a clean `InvalidMutation`, not a
    // panic.
    let anchor = anchor_entity_id.or(first_entity_id).ok_or_else(|| {
        ApplyError::InvalidMutation("intent graph created no entity".to_string())
    })?;

    let result_payload = decision_result_payload(&anchor);
    queries::resolve_tool_call(&mut *tx, tool_call_id, "completed", &result_payload, now_ms).await?;

    tx.commit().await?;
    Ok(IntentGraphOutcome::Applied(anchor))
}

/// Whether the decision vector rejects EVERY node in the graph — the JE node (if
/// present) AND every entity node (ADR-0042 reject-all). A node with no entry
/// defaults to accept, so this is true only when an EXPLICIT `reject` covers every
/// node and none is missing/accepted. An empty graph cannot occur (`extract_graph`
/// requires `>= 1` entity), so `all()` over a non-empty entity set is well-defined.
fn accepted_subset_is_empty(graph: &ExtractedGraph, decisions: &NodeDecisions) -> bool {
    let je_rejected = graph
        .journal_entry
        .as_ref()
        .is_none_or(|je| decisions.is_rejected(&je.handle));
    let all_entities_rejected = graph
        .entities
        .iter()
        .all(|node| decisions.is_rejected(&node.handle));
    je_rejected && all_entities_rejected
}

/// Resolve a reject-all decision vector (ADR-0042): the accepted subset is empty,
/// so the graph is declined wholesale — the Proposal flips `rejected` and the
/// awaited tool call resolves as a NON-error decline (so the resumed model
/// continues conversationally), exactly like a scalar `reject`. Returns
/// [`IntentGraphOutcome::RejectedAll`]; nothing is minted. The guarded reject-flip
/// is the SAME concurrency choke `reject_proposal` uses — on 0 rows a racing decide
/// won (`NotPending`).
async fn reject_whole_graph(
    pool: &sqlx::SqlitePool,
    run_id: Uuid,
    proposal_id: &str,
    tool_call_id: &str,
    decision_idempotency_key: Option<&str>,
    now_ms: i64,
) -> Result<IntentGraphOutcome, ApplyError> {
    let mut tx = pool.begin().await?;

    let rejected =
        ProposalStatus::reject(&mut tx, run_id, proposal_id, decision_idempotency_key, now_ms)
            .await?;
    if !rejected.won() {
        return Err(ApplyError::NotPending);
    }

    // A decline renders as a NORMAL (non-error) tool result — mirrors
    // `reject_proposal`'s decision payload so the resumed model continues
    // conversationally rather than treating the decline as a tool failure.
    let decision_payload = serde_json::json!({
        "decision": "reject",
        "content": "User declined every node of this proposal.",
        "is_error": false,
    })
    .to_string();
    queries::resolve_tool_call(&mut *tx, tool_call_id, "completed", &decision_payload, now_ms)
        .await?;

    tx.commit().await?;
    Ok(IntentGraphOutcome::RejectedAll)
}

/// The per-node decision vector keyed by handle (ADR-0042). A node with NO entry
/// defaults to **accept** — the common accept-all path sends a vector of accepts,
/// but a missing entry (or no vector at all) accepts everything, so a plain
/// `accept` with no vector applies the whole stored graph (the regression path).
struct NodeDecisions {
    by_handle: std::collections::HashMap<String, NodeDecision>,
}

impl NodeDecisions {
    fn from_vector(decisions: Option<&[NodeDecision]>) -> Self {
        let by_handle = decisions
            .unwrap_or(&[])
            .iter()
            .map(|d| (d.handle.trim().to_string(), d.clone()))
            .collect();
        Self { by_handle }
    }

    /// The decision for `handle`. `None` (no entry) means **accept** with no
    /// override — the resolver treats absence as a plain accept.
    fn for_handle(&self, handle: &str) -> Option<&NodeDecision> {
        self.by_handle.get(handle)
    }

    /// Whether `handle` is rejected by the vector (its `decision == "reject"`).
    /// A missing entry is an accept, so it is NOT rejected.
    fn is_rejected(&self, handle: &str) -> bool {
        self.for_handle(handle)
            .is_some_and(|d| d.decision == "reject")
    }
}

/// Mint one resolved create node via the shared single-entity create path
/// (`apply_entity_mutation`), inside the caller's tx. The graph applies a
/// `todo_project`/`todo_person` link FOR FREE by folding it into the Todo's create
/// payload before this call: the create-todo path then writes `project_id` (with
/// its in-tx `recheck_todo_project_link`) and the `todo_person_refs` rows itself.
/// Returns the minted entity id.
async fn mint_create(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    create: &ResolvedCreate,
    proposal_id: &str,
    source: Option<EntitySource>,
    now_ms: i64,
) -> Result<String, ApplyError> {
    apply::apply_entity_mutation(
        tx,
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
    .await
}

/// Weave the JE node's `journal_ref` body mentions and mint the Journal Entry in
/// ONE revision (ADR-0042 "Multi-ref Journal Entry weave is one write"). Called
/// AFTER every referenced entity is resolved, so the placeholder rewrite + the
/// `entity_ref` rows can use real ids:
///
/// 1. For each SURVIVING `journal_ref` link (`from == @je`, `to` not rejected and
///    resolved in `handle_to_id`), generate a fresh `entity_ref` id. This builds a
///    `target_handle → ref_id` map. A `journal_ref` whose target was rejected has
///    no resolved id, so it is dropped — its body placeholder collapses to text.
/// 2. Rewrite the JE body: each `{type:entity_ref, target:@handle}` placeholder
///    becomes `{type:entity_ref, ref_id:<generated>}` when `@handle` has a ref id,
///    else collapses to a `{type:text, text:""}` node (the rejected-ref cascade).
/// 3. Mint the JE entity + its seq-1 revision with the WOVEN body (the JE's only
///    write), carrying the `created_from` user-Message guard row.
/// 4. Insert the `entity_ref` rows: source = the JE id (now exists), target = the
///    referenced entity id, label_snapshot = the entity's recognized label. The
///    pre-generated id matches the body's `ref_id`, so the FK direction holds (the
///    JE row exists before its refs).
///
/// Returns the minted JE id (the graph anchor).
#[allow(clippy::too_many_arguments)]
async fn weave_and_mint_journal_entry(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    run_id: Uuid,
    je: &ResolvedCreate,
    links: &[Link],
    handle_to_id: &std::collections::HashMap<String, String>,
    handle_to_label: &std::collections::HashMap<String, String>,
    decisions: &NodeDecisions,
    proposal_id: &str,
    now_ms: i64,
) -> Result<String, ApplyError> {
    // 1. Surviving journal_ref targets → an entity_ref id. A link whose target node
    //    was rejected (or otherwise unresolved) is dropped here, so its body
    //    placeholder collapses to text in step 2.
    //
    // The `entity_refs` table is UNIQUE(source_entity_id, target_entity_id): there
    // is AT MOST ONE EntityRef per (JE, target entity). So the ref_id is keyed by
    // the resolved TARGET ENTITY ID, not the handle — two distinct handles that
    // resolve to the SAME entity (two same-named nodes reusing one accepted entity,
    // or two `existing_id` hints to one id) share ONE entity_ref row and ONE ref_id.
    // Keying by handle would mint two ref_ids whose second `insert_entity_ref` hits
    // `ON CONFLICT DO NOTHING` → a dangling body ref_id with no backing row. The
    // body map (`handle → ref_id`) still rewrites BOTH placeholders to that shared
    // ref_id.
    let mut entity_ref_id: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    let mut target_ref_id: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    // The ordered weave plan: (ref_id, target_entity_id, label_snapshot), one entry
    // per DISTINCT target entity. Kept ordered so the inserted rows are deterministic.
    let mut weave_plan: Vec<(String, String, Option<String>)> = Vec::new();
    for link in links
        .iter()
        .filter(|l| matches!(l.kind, LinkKind::JournalRef) && l.from == je.handle)
    {
        if decisions.is_rejected(&link.to) {
            continue;
        }
        let Some(entity_id) = handle_to_id.get(&link.to) else {
            // The target resolved to no id (rejected, or a degenerate handle): drop
            // the ref. Its body placeholder collapses to text.
            continue;
        };
        // Reuse the entity's ref_id if a prior link already targeted it (same entity
        // via another handle, or a duplicate journal_ref); else mint one + plan the
        // single row. Either way this handle's placeholder maps to that ref_id.
        let ref_id = match entity_ref_id.get(entity_id) {
            Some(existing) => existing.clone(),
            None => {
                let ref_id = Uuid::now_v7().to_string();
                entity_ref_id.insert(entity_id.clone(), ref_id.clone());
                let label = handle_to_label.get(&link.to).cloned();
                weave_plan.push((ref_id.clone(), entity_id.clone(), label));
                ref_id
            }
        };
        target_ref_id.insert(link.to.clone(), ref_id);
    }

    // 2. Weave the JE body: rewrite each entity_ref placeholder to its ref_id, or
    //    collapse to text when its target was rejected/dropped.
    let mut payload = je.payload.clone();
    weave_journal_body(&mut payload, &target_ref_id)?;

    // 3. Mint the JE entity (its only write) with the woven body + the guard row.
    let woven_je = ResolvedCreate {
        kind: je.kind,
        payload,
        handle: je.handle.clone(),
    };
    // The JE node's `created_from` user-Message guard row (ADR-0042) — resolved
    // INSIDE this tx, exactly as `apply_proposal` resolves a message-sourced
    // create. The JE is always newborn in this Run, so the guard row is correct by
    // construction (this Run's user Message).
    let message_id = queries::user_message_id_for_run(&mut **tx, run_id).await?;
    let source = Some(EntitySource::FromMessage {
        message_id,
        relation: SourceRelation::CreatedFrom.as_str().to_string(),
    });
    let je_id = mint_create(tx, &woven_je, proposal_id, source, now_ms).await?;

    // 4. Insert the entity_ref rows now that the JE (their source) exists. The id
    //    matches the body's ref_id minted in step 1.
    for (ref_id, target_entity_id, label) in &weave_plan {
        queries::insert_entity_ref(
            &mut **tx,
            ref_id,
            &je_id,
            target_entity_id,
            label.as_deref(),
            now_ms,
        )
        .await?;
    }

    Ok(je_id)
}

/// Rewrite a JE body's `entity_ref` placeholders in place (ADR-0042 slice 6): a
/// `{type:entity_ref, target:@handle}` node whose handle has a minted ref id
/// becomes `{type:entity_ref, ref_id:<id>}` (the STORED shape — entity_ref body
/// nodes carry `ref_id`, never `target`); a node whose target was rejected/dropped
/// (no ref id) collapses to a `{type:text, text:""}` node so the body stays valid
/// (no dangling `target`, no dangling `ref_id`). A non-`entity_ref` node (text) is
/// left untouched. Body-target handles were validated at extraction
/// (`validate_links`), so a surviving placeholder names a declared handle.
fn weave_journal_body(
    payload: &mut serde_json::Value,
    target_ref_id: &std::collections::HashMap<String, String>,
) -> Result<(), ApplyError> {
    let Some(body) = payload
        .as_object_mut()
        .and_then(|o| o.get_mut("body"))
        .and_then(serde_json::Value::as_array_mut)
    else {
        // No body array — the JE carries no weavable placeholders (the
        // create_journal_entry validator at mint enforces the body shape).
        return Ok(());
    };
    for node in body.iter_mut() {
        if node.get("type").and_then(serde_json::Value::as_str) != Some("entity_ref") {
            continue;
        }
        let target = node
            .get("target")
            .and_then(serde_json::Value::as_str)
            .map(str::trim);
        *node = match target.and_then(|t| target_ref_id.get(t)) {
            Some(ref_id) => serde_json::json!({ "type": "entity_ref", "ref_id": ref_id }),
            // A placeholder whose target was rejected/dropped collapses to text
            // (ADR-0042 "its body entity_ref placeholder collapses to text").
            None => serde_json::json!({ "type": "text", "text": "" }),
        };
    }
    Ok(())
}

/// Fold the `todo_project` + `todo_person` links whose `from` is `todo_handle`
/// into the Todo's create payload (ADR-0042), so the SAME create-todo path applies
/// them. The payload is the `{todo: TodoData}` envelope `apply_entity_mutation`
/// expects:
///   - `todo_project` → set `todo.project_id` to the resolved Project id. A Todo
///     belongs to AT MOST ONE Project (ADR-0031), so two `todo_project` links from
///     one Todo is a graph error → `InvalidMutation`.
///   - `todo_person` → append `{person_id, role}` to the envelope's `person_refs`
///     array (the create-todo path writes the `todo_person_refs` rows from it).
///
/// The reject-CASCADE (ADR-0042 "Core owns the cascade"): a link whose `to` names
/// a node the decision vector REJECTED is **dropped** — not applied, not an error.
/// A `todo_project` link to a rejected Project drops, so the Todo lands standalone
/// (ADR-0031 "keep the Todo valid on its own"); a `todo_person` link to a rejected
/// Person drops. A link to an UNKNOWN handle (one naming no node at all) was
/// already rejected as a malformed graph at extraction (`validate_links`), so by
/// here every surviving endpoint is either resolved (in `handle_to_id`) or
/// dropped-because-rejected — `resolve_endpoint`'s "no node" arm stays unreachable.
fn fold_links_into_todo(
    links: &[Link],
    todo_handle: &str,
    payload: &mut serde_json::Value,
    handle_to_id: &std::collections::HashMap<String, String>,
    decisions: &NodeDecisions,
) -> Result<(), ApplyError> {
    let obj = payload.as_object_mut().ok_or_else(|| {
        ApplyError::InvalidMutation("intent graph todo payload must be an object".to_string())
    })?;

    let mut project_linked = false;
    let mut person_refs: Vec<serde_json::Value> = Vec::new();

    for link in links.iter().filter(|l| l.from == todo_handle) {
        // Reject-cascade: drop a link whose target node was rejected. The Todo
        // survives the dropped link (standalone, ADR-0031); only the relationship
        // is severed.
        if decisions.is_rejected(&link.to) {
            continue;
        }
        match link.kind {
            LinkKind::TodoProject => {
                if project_linked {
                    // ADR-0031: a Todo belongs to one Project. Two todo_project
                    // links from one Todo is a graph error.
                    return Err(ApplyError::InvalidMutation(format!(
                        "intent graph todo {todo_handle} has more than one todo_project link"
                    )));
                }
                project_linked = true;
                let project_id = resolve_endpoint(handle_to_id, &link.to, "todo_project")?;
                let todo = obj
                    .get_mut("todo")
                    .and_then(serde_json::Value::as_object_mut)
                    .ok_or_else(|| {
                        ApplyError::InvalidMutation(
                            "intent graph todo payload is missing its todo envelope".to_string(),
                        )
                    })?;
                todo.insert("project_id".to_string(), serde_json::json!(project_id));
            }
            LinkKind::TodoPerson => {
                let person_id = resolve_endpoint(handle_to_id, &link.to, "todo_person")?;
                // The schema requires a role on todo_person; default to `related`
                // defensively (the create-todo dedup also defaults a missing role).
                let role = link.role.as_deref().unwrap_or("related");
                person_refs.push(serde_json::json!({ "person_id": person_id, "role": role }));
            }
            // A todo is never a journal_ref `from` (journal_ref is JE → entity, woven
            // into the JE body, not the Todo), so this arm is unreachable for a
            // well-formed graph; ignore it regardless.
            LinkKind::JournalRef => {}
        }
    }

    if !person_refs.is_empty() {
        obj.insert("person_refs".to_string(), serde_json::Value::Array(person_refs));
    }
    Ok(())
}

/// Resolve a link endpoint handle to its entity id via the handle→id map. An
/// unknown handle is a malformed graph in slice 4 → `InvalidMutation` (the whole
/// tx fails). `link_kind` names the offending link in the error.
fn resolve_endpoint(
    handle_to_id: &std::collections::HashMap<String, String>,
    handle: &str,
    link_kind: &str,
) -> Result<String, ApplyError> {
    handle_to_id.get(handle).cloned().ok_or_else(|| {
        ApplyError::InvalidMutation(format!(
            "intent graph {link_kind} link endpoint {handle:?} does not resolve to any node"
        ))
    })
}

/// One entity node's resolved disposition (ADR-0042). `ambiguous` is not a variant
/// — it surfaces as an `Err(InvalidMutation)` from [`resolve_node`] so the whole
/// apply fails with no fallback. `Reuse`'s id is recorded into the handle→id map so
/// a todo's link can target a reused Project/Person (the #179 case). `Create`
/// carries the create payload — usually the node's own, but a per-node
/// `edited_fields` correction is merged into it first (ADR-0042).
enum Disposition {
    /// Mint a fresh entity (zero exact matches). The payload is the node's create
    /// payload, possibly with `edited_fields` merged over it.
    Create(serde_json::Value),
    /// Reuse this accepted entity's id (an `entity_id` override, the `existing_id`
    /// hint, or the sole exact match). Mints nothing; its handle resolves to this
    /// id for links.
    Reuse(String),
}

/// Resolve one entity node's disposition against the ACCEPTED set, IN-TX (ADR-0042
/// "Resolution runs in-tx on the serialized pool"), applying the node's per-node
/// `decision` (already known to be `accept` — a rejected node is filtered out by
/// the caller). The `entity_id` override and `edited_fields` correction are
/// mutually exclusive (ADR-0042 "you edit what you create; you override what you
/// reuse"):
///
/// - **`entity_id` override** (accept + `entity_id`): resolve straight to
///   `reuse(that id)`, validated as an accepted entity of this node's type
///   (`entity_is_type`, in-tx), else `Invalid`. This collapses an ambiguous node →
///   reuse-that-id (the picker path) without running the exact-match step.
/// - **`edited_fields` correction** (accept + `edited_fields`): merge the fields
///   over the node's CREATE payload, then resolve naturally — but a node that
///   resolves to `reuse` cannot be edited (a reuse is linked-to, never rewritten,
///   ADR-0030), so `edited_fields` on a reuse-disposition node is `Invalid`.
/// - **no override/edit**: the natural resolution (the slice-3 path):
///   1. `existing_id` hint → `reuse` if it names an accepted entity of the type;
///   2. exact (case-insensitive, trimmed) label + type match: one → `reuse`,
///      zero → `create`, two or more → `ambiguous` (`Err(InvalidMutation)`).
async fn resolve_node(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    node: &EntityNode,
    decision: Option<&NodeDecision>,
) -> Result<Disposition, ApplyError> {
    // Mutual exclusion: a per-node decision may carry an `entity_id` override OR an
    // `edited_fields` correction, never both (ADR-0042).
    let override_id = decision
        .and_then(|d| d.entity_id.as_deref())
        .filter(|id| !id.trim().is_empty());
    let edited_fields = decision.and_then(|d| d.edited_fields.as_ref());
    if override_id.is_some() && edited_fields.is_some() {
        return Err(ApplyError::InvalidMutation(format!(
            "intent graph node {} carries both entity_id override and edited_fields \
             (mutually exclusive)",
            node.handle
        )));
    }

    // `entity_id` override → reuse-that-id (the picker / disambiguation path). It
    // bypasses exact-match entirely, collapsing an ambiguous node to a definite
    // reuse. Validated as an accepted entity of the node's type, else Invalid.
    if let Some(id) = override_id {
        if !queries::entity_is_type(&mut **tx, id, node.type_str).await? {
            return Err(ApplyError::InvalidMutation(format!(
                "intent graph node {} entity_id override {id:?} is not an accepted {}",
                node.handle, node.type_str
            )));
        }
        return Ok(Disposition::Reuse(id.to_string()));
    }

    let disposition = resolve_disposition(tx, node).await?;

    // `edited_fields` corrects a CREATE node's content before minting. A node that
    // resolves to `reuse` cannot be edited (ADR-0030: a reuse is linked-to, never
    // rewritten) — that is a contradictory decision, so Invalid.
    if let Some(edits) = edited_fields {
        return match disposition {
            Disposition::Create(payload) => {
                let merged = merge_edited_fields(node.type_str, payload, edits)?;
                // Re-validate the CORRECTED payload through the per-type create
                // validator before minting — parity with the single-entity edit
                // path (`decide.rs` validates the edited payload). A correction
                // that violates a per-type invariant (an empty title, a bad enum)
                // fails the whole tx as Invalid, never minting a malformed entity.
                crate::entities::validate(node.kind, &merged)
                    .map_err(ApplyError::InvalidMutation)?;
                Ok(Disposition::Create(merged))
            }
            Disposition::Reuse(_) => Err(ApplyError::InvalidMutation(format!(
                "intent graph node {} carries edited_fields but resolves to reuse \
                 (a reused entity is linked-to, not edited)",
                node.handle
            ))),
        };
    }

    Ok(disposition)
}

/// Merge a per-node `edited_fields` correction over a CREATE node's payload
/// (ADR-0042): the edited fields override the model's proposed fields, then the
/// per-type validator re-runs in `resolve_node` on the merged result. The graph
/// wraps a Todo's data in a `{todo: TodoData}` envelope, so a Todo's edits merge
/// into the INNER `todo` object; Person/Project edit the flat payload.
/// `edited_fields` must be a JSON object.
///
/// A `null` edit value is a CLEAR directive (ADR-0033): it REMOVES the key rather
/// than inserting a JSON null, so blanking a model-proposed optional yields an
/// absent field — valid uniformly for person/project/todo (a Todo's `note` is not
/// clearable in create mode, so an inserted `null` would be rejected at validation;
/// removal sidesteps that). A `null` for a required field (a blanked title/name)
/// drops it to absent and the re-validation in `resolve_node` rejects it.
fn merge_edited_fields(
    type_str: &str,
    mut payload: serde_json::Value,
    edited_fields: &serde_json::Value,
) -> Result<serde_json::Value, ApplyError> {
    let edits = edited_fields.as_object().ok_or_else(|| {
        ApplyError::InvalidMutation("intent graph edited_fields must be an object".to_string())
    })?;

    // A Todo's create payload is `{todo: TodoData}`; edits target the inner object.
    // Person/Project payloads are flat.
    let target = if type_str == "todo" {
        payload
            .as_object_mut()
            .and_then(|o| o.get_mut("todo"))
            .and_then(serde_json::Value::as_object_mut)
            .ok_or_else(|| {
                ApplyError::InvalidMutation(
                    "intent graph todo payload is missing its todo envelope".to_string(),
                )
            })?
    } else {
        payload.as_object_mut().ok_or_else(|| {
            ApplyError::InvalidMutation("intent graph entity payload must be an object".to_string())
        })?
    };
    for (key, value) in edits {
        if value.is_null() {
            target.remove(key);
        } else {
            target.insert(key.clone(), value.clone());
        }
    }
    Ok(payload)
}

/// Resolve one entity node's NATURAL disposition (no override/edit) against the
/// ACCEPTED set, IN-TX. The order matches ADR-0042:
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
        return Ok(Disposition::Create(node.payload.clone()));
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
        return Ok(Disposition::Create(node.payload.clone()));
    };
    if matches.next().is_some() {
        // ADR-0042: two or more exact matches → ambiguous, no silent fallback.
        // The whole apply fails; the tx rolls back. The picker / `entity_id`
        // override resolves this (handled in `resolve_node` before this step).
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

    // `links` is optional and may be absent/null (a graph with no relationships).
    let links = match obj.get("links").filter(|v| !v.is_null()) {
        Some(value) => {
            let arr = value.as_array().ok_or_else(|| {
                ApplyError::InvalidMutation("intent graph links must be an array".to_string())
            })?;
            arr.iter().map(parse_link).collect::<Result<Vec<_>, _>>()?
        }
        None => Vec::new(),
    };

    // Reject DUPLICATE handles before any tx opens (ADR-0042 "Validation": a
    // structural graph error). Handles are the join keys for links, body refs, and
    // the handle→id map; a repeat would silently last-write-win (two nodes mint but
    // `handle_to_id`/`handle_declared_types` keep only the last, so a link/body-ref
    // to that handle resolves to an arbitrary entity — the exact silent mis-link
    // #179 set out to eliminate). The JE node shares the handle namespace.
    validate_unique_handles(&journal_entry, &entities)?;

    // Validate every link's endpoints against the DECLARED handle types before any
    // tx opens (poolless): both `from` and `to` must name a known handle, and the
    // endpoint types must match the link kind. This is type-correct because
    // disposition guarantees a resolved id matches its node's declared type (an
    // `existing_id` hint is `entity_is_type`-checked; exact-match is type-scoped).
    // Without this, a `todo_person` link whose `to` is a Project handle would fold
    // a Project id into `todo_person_refs` (which has no type check) and corrupt
    // tier-2 silently, and a link whose `from` is the wrong type / unknown handle
    // would be silently dropped rather than failing the apply.
    validate_links(&journal_entry, &entities, &links)?;

    Ok(ExtractedGraph {
        journal_entry,
        entities,
        links,
    })
}

/// Reject a graph that declares the same handle on more than one node (ADR-0042).
/// Handles (the JE node + every entity node) are the join keys for links, body
/// refs, and the in-tx handle→id map; a duplicate would silently last-write-win,
/// mis-resolving a link/body-ref to an arbitrary entity. Fails the whole apply as
/// `InvalidMutation` before any tx opens (and degrades `resolved_plan_for` to an
/// empty plan rather than a misleading one).
fn validate_unique_handles(
    journal_entry: &Option<ResolvedCreate>,
    entities: &[EntityNode],
) -> Result<(), ApplyError> {
    let mut seen = std::collections::HashSet::new();
    let handles = journal_entry
        .iter()
        .map(|je| je.handle.as_str())
        .chain(entities.iter().map(|n| n.handle.as_str()));
    for handle in handles {
        if !seen.insert(handle) {
            return Err(ApplyError::InvalidMutation(format!(
                "intent graph handle {handle:?} is declared by more than one node"
            )));
        }
    }
    Ok(())
}

/// The Entity Type a graph handle declares, for link-endpoint type checking.
/// Built from the JE node (`journal_entry`) + each entity node's `type_str`.
fn handle_declared_types(
    journal_entry: &Option<ResolvedCreate>,
    entities: &[EntityNode],
) -> std::collections::HashMap<String, &'static str> {
    let mut types: std::collections::HashMap<String, &'static str> =
        std::collections::HashMap::new();
    if let Some(je) = journal_entry {
        types.insert(je.handle.clone(), "journal_entry");
    }
    for node in entities {
        types.insert(node.handle.clone(), node.type_str);
    }
    types
}

/// Validate every link's endpoints against the declared handle types (ADR-0042):
/// both endpoints must resolve to a known handle, and each kind constrains its
/// endpoint types — `todo_project`: todo → project; `todo_person`: todo → person;
/// `journal_ref`: journal_entry → person|project|todo. A violation fails the whole
/// apply as `InvalidMutation` before any tx opens (all-or-nothing). The softer
/// drop+report on a node a later decision REJECTS is the cascade (in the resolver).
///
/// Slice 6 also pins the JE body ↔ `journal_ref` consistency: every JE body
/// `{type:entity_ref, target:@handle}` placeholder MUST name a declared
/// referenceable handle AND have a matching `journal_ref` link (`@je → @handle`).
/// This makes the weave well-defined — a surviving placeholder always maps to a
/// minted `entity_ref`, and a body placeholder cannot reference an entity the graph
/// never declared a link to (which would be stored dangling).
fn validate_links(
    journal_entry: &Option<ResolvedCreate>,
    entities: &[EntityNode],
    links: &[Link],
) -> Result<(), ApplyError> {
    let types = handle_declared_types(journal_entry, entities);
    let declared = |handle: &str| -> Result<&'static str, ApplyError> {
        types.get(handle).copied().ok_or_else(|| {
            ApplyError::InvalidMutation(format!(
                "intent graph link endpoint {handle:?} does not name any node"
            ))
        })
    };
    let expect = |handle: &str, want: &str, side: &str, kind: &str| -> Result<(), ApplyError> {
        let got = declared(handle)?;
        if got != want {
            return Err(ApplyError::InvalidMutation(format!(
                "intent graph {kind} link {side} {handle:?} must be a {want}, but it is a {got}"
            )));
        }
        Ok(())
    };
    for link in links {
        match link.kind {
            LinkKind::TodoProject => {
                expect(&link.from, "todo", "from", "todo_project")?;
                expect(&link.to, "project", "to", "todo_project")?;
            }
            LinkKind::TodoPerson => {
                expect(&link.from, "todo", "from", "todo_person")?;
                expect(&link.to, "person", "to", "todo_person")?;
            }
            LinkKind::JournalRef => {
                // JE → a referenceable entity, woven into the JE body at mint.
                expect(&link.from, "journal_entry", "from", "journal_ref")?;
                let to = declared(&link.to)?;
                if !matches!(to, "person" | "project" | "todo") {
                    return Err(ApplyError::InvalidMutation(format!(
                        "intent graph journal_ref link to {:?} must be a person, project, or todo, but it is a {to}",
                        link.to
                    )));
                }
            }
        }
    }

    validate_body_targets(journal_entry, &types, links)?;
    Ok(())
}

/// Validate the JE body's `entity_ref` placeholder targets against the declared
/// handles + the `journal_ref` links (ADR-0042 slice 6). Each
/// `{type:entity_ref, target:@handle}` body node MUST name a declared handle AND
/// have a matching `journal_ref` link from the JE — so the weave maps every
/// surviving placeholder to a minted `entity_ref`. A body placeholder with no
/// `target` string, naming no declared handle, or with no backing `journal_ref`
/// link, is a malformed graph → `InvalidMutation` before any tx opens. (A
/// `journal_ref` link WITHOUT a body placeholder is allowed — it simply mints an
/// `entity_ref` not inlined in the body; ADR-0042 v1 keeps JE refs inline, but the
/// reverse requirement is not enforced.)
fn validate_body_targets(
    journal_entry: &Option<ResolvedCreate>,
    types: &std::collections::HashMap<String, &'static str>,
    links: &[Link],
) -> Result<(), ApplyError> {
    let Some(je) = journal_entry else {
        return Ok(());
    };
    let Some(body) = je.payload.get("body").and_then(serde_json::Value::as_array) else {
        return Ok(());
    };
    // The set of handles the JE links to via a `journal_ref` (the inline-ref
    // declarations a body placeholder must match).
    let journal_ref_targets: std::collections::HashSet<&str> = links
        .iter()
        .filter(|l| matches!(l.kind, LinkKind::JournalRef) && l.from == je.handle)
        .map(|l| l.to.as_str())
        .collect();

    for node in body {
        if node.get("type").and_then(serde_json::Value::as_str) != Some("entity_ref") {
            continue;
        }
        let target = node
            .get("target")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                ApplyError::InvalidMutation(
                    "intent graph journal entry body entity_ref node must carry a non-empty target handle"
                        .to_string(),
                )
            })?;
        // The target must name a declared referenceable handle.
        match types.get(target).copied() {
            Some("person" | "project" | "todo") => {}
            Some(other) => {
                return Err(ApplyError::InvalidMutation(format!(
                    "intent graph journal entry body entity_ref target {target:?} must be a person, project, or todo, but it is a {other}"
                )));
            }
            None => {
                return Err(ApplyError::InvalidMutation(format!(
                    "intent graph journal entry body entity_ref target {target:?} does not name any node"
                )));
            }
        }
        // And it must have a matching journal_ref link (the inline-ref declaration).
        if !journal_ref_targets.contains(target) {
            return Err(ApplyError::InvalidMutation(format!(
                "intent graph journal entry body references {target:?} but no journal_ref link declares it"
            )));
        }
    }
    Ok(())
}

/// Parse one `links[]` element into a [`Link`] (ADR-0042). A `todo_project`/
/// `journal_ref` carries `{kind, from, to}`; a `todo_person` additionally carries
/// `role`. A malformed link (non-object, missing/blank `from`/`to`, unknown kind)
/// is `InvalidMutation` — the whole apply fails before any tx opens.
fn parse_link(value: &serde_json::Value) -> Result<Link, ApplyError> {
    let obj = value.as_object().ok_or_else(|| {
        ApplyError::InvalidMutation("intent graph link must be an object".to_string())
    })?;
    let kind = match obj.get("kind").and_then(serde_json::Value::as_str) {
        Some("todo_project") => LinkKind::TodoProject,
        Some("todo_person") => LinkKind::TodoPerson,
        Some("journal_ref") => LinkKind::JournalRef,
        other => {
            return Err(ApplyError::InvalidMutation(format!(
                "unknown intent graph link kind {other:?}"
            )));
        }
    };
    let endpoint = |key: &str| -> Result<String, ApplyError> {
        obj.get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .ok_or_else(|| {
                ApplyError::InvalidMutation(format!("intent graph link is missing {key}"))
            })
    };
    let from = endpoint("from")?;
    let to = endpoint("to")?;
    let role = obj
        .get("role")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    Ok(Link {
        kind,
        from,
        to,
        role,
    })
}

/// Reconstruct the `journal_entry` node into a `create_journal_entry` payload:
/// `{occurred_at, ended_at?, body}` — the graph-local `handle` dropped from the
/// payload (handles are graph-internal join keys, never entity data) but RETAINED
/// on the `ResolvedCreate` so the `journal_ref` body weave and the handle→id map
/// can join on it.
///
/// The body is kept VERBATIM here (including any `{type:entity_ref, target:@handle}`
/// placeholders): the weave runs at mint time in [`weave_and_mint_journal_entry`]
/// (ADR-0042 slice 6), once every referenced entity is resolved. Each placeholder's
/// `target` handle is type-validated against the declared nodes in
/// [`validate_links`] before any tx opens, so a placeholder naming no declared
/// handle fails the whole apply loud rather than being stored dangling.
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

    // Trim the handle to match `parse_link`'s trimmed link endpoints, so a handle
    // with stray surrounding whitespace still joins the handle→type / handle→id maps.
    let handle = obj
        .get("handle")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("<je>")
        .to_string();

    Ok(ResolvedCreate {
        kind: MutationKind::CreateJournalEntry,
        payload: serde_json::Value::Object(payload),
        handle,
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

    // Trim the handle to match `parse_link`'s trimmed link endpoints (see
    // `resolve_journal_entry_node`).
    let handle = obj
        .get("handle")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
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

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    /// A migrated in-memory pool with `max_connections(1)` (matches the resolver's
    /// race-free read assumption).
    async fn memory_pool() -> sqlx::SqlitePool {
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

    /// Insert one accepted Entity (created_by='user', no Proposal anchor) of
    /// `entity_type` with label `label` — the accepted set the plan reads.
    async fn insert_named(pool: &sqlx::SqlitePool, entity_type: &str, label: &str) -> String {
        let id = Uuid::now_v7().to_string();
        let now = crate::db::now_ms();
        let label_key = if entity_type == "todo" { "title" } else { "name" };
        let data = serde_json::json!({ label_key: label }).to_string();
        sqlx::query(
            "INSERT INTO entities (id, type, schema_version, data, created_by, created_at, updated_at) \
             VALUES (?, ?, 1, ?, 'user', ?, ?)",
        )
        .bind(&id)
        .bind(entity_type)
        .bind(&data)
        .bind(now)
        .bind(now)
        .execute(pool)
        .await
        .expect("insert named entity");
        id
    }

    fn node(plan: &[ResolvedNode], handle: &str) -> usize {
        plan.iter()
            .position(|n| n.handle == handle)
            .unwrap_or_else(|| panic!("no plan node for {handle}"))
    }

    // The JE node is create-only and carries no disposition, so it is NOT a plan
    // node; a fresh entity with no accepted match is `create`.
    #[tokio::test]
    async fn resolved_plan_omits_je_and_marks_new_entities_create() {
        let pool = memory_pool().await;
        let payload = serde_json::json!({
            "journal_entry": { "handle": "@je", "occurred_at": "2026-06-10T10:30:00", "body": [] },
            "entities": [
                { "handle": "@morris", "type": "person", "name": "Morris" },
                { "handle": "@leadads", "type": "project", "name": "Lead Ads" }
            ],
            "links": []
        });
        let plan = resolved_plan_for(&pool, &payload).await.unwrap();
        assert_eq!(plan.len(), 2, "the JE node is not a plan node");
        assert!(plan.iter().all(|n| n.disposition == "create"));
        let morris = &plan[node(&plan, "@morris")];
        assert_eq!(morris.r#type, "person");
        assert_eq!(morris.label, "Morris");
        assert!(morris.entity_id.is_none() && morris.candidates.is_none());
    }

    // An entity whose exact (case-insensitive) name+type matches exactly one
    // accepted row resolves to `reuse` carrying that id.
    #[tokio::test]
    async fn resolved_plan_marks_single_exact_match_reuse() {
        let pool = memory_pool().await;
        let existing = insert_named(&pool, "project", "Lead Ads").await;
        let payload = serde_json::json!({
            "entities": [{ "handle": "@leadads", "type": "project", "name": "lead ads" }],
            "links": []
        });
        let plan = resolved_plan_for(&pool, &payload).await.unwrap();
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].disposition, "reuse");
        assert_eq!(plan[0].entity_id.as_deref(), Some(existing.as_str()));
        assert!(plan[0].candidates.is_none());
    }

    // Two accepted same-named rows → `ambiguous`, surfacing BOTH candidates (the
    // Client renders the disambiguation hint; accept-all is blocked).
    #[tokio::test]
    async fn resolved_plan_marks_two_matches_ambiguous_with_candidates() {
        let pool = memory_pool().await;
        let a = insert_named(&pool, "person", "Morris").await;
        let b = insert_named(&pool, "person", "Morris").await;
        let payload = serde_json::json!({
            "entities": [{ "handle": "@morris", "type": "person", "name": "Morris" }],
            "links": []
        });
        let plan = resolved_plan_for(&pool, &payload).await.unwrap();
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].disposition, "ambiguous");
        assert!(plan[0].entity_id.is_none());
        let candidates = plan[0].candidates.as_ref().expect("candidates present");
        let ids: std::collections::HashSet<&str> =
            candidates.iter().map(|c| c.entity_id.as_str()).collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(a.as_str()) && ids.contains(b.as_str()));
    }

    // An `existing_id` hint naming an accepted entity of the right type is honored
    // as `reuse` (mirrors `resolve_disposition`'s hint path).
    #[tokio::test]
    async fn resolved_plan_honors_existing_id_hint() {
        let pool = memory_pool().await;
        let existing = insert_named(&pool, "project", "Some Other Name").await;
        let payload = serde_json::json!({
            "entities": [{
                "handle": "@p", "type": "project", "name": "Brand New Project",
                "existing_id": existing
            }],
            "links": []
        });
        let plan = resolved_plan_for(&pool, &payload).await.unwrap();
        assert_eq!(plan[0].disposition, "reuse");
        assert_eq!(plan[0].entity_id.as_deref(), Some(existing.as_str()));
    }

    // A structurally malformed graph yields an EMPTY plan (the Client degrades to
    // the raw card; decide is the authoritative reject gate).
    #[tokio::test]
    async fn resolved_plan_for_malformed_graph_is_empty() {
        let pool = memory_pool().await;
        let plan = resolved_plan_for(&pool, &serde_json::json!({ "not": "a graph" }))
            .await
            .unwrap();
        assert!(plan.is_empty());
    }
}
