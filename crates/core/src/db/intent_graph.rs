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
use crate::protocol::NodeDecision;

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
/// re-wrapped in its `{todo: …}` envelope). `is_journal_anchor` marks the single
/// JE node — the only node that writes the `created_from` guard row, and the
/// anchor reported. `handle` is the node's graph-local label (`@je`/`@rodeo`) —
/// recorded into the handle→id map as the node mints, so a later todo's links can
/// join on it.
struct ResolvedCreate {
    kind: MutationKind,
    payload: serde_json::Value,
    is_journal_anchor: bool,
    handle: String,
}

/// One intended link between two graph handles (ADR-0042). `from`/`to` are
/// graph-local handles the resolver joins on the handle→id map; `role` is set only
/// for `todo_person`. Slice 4 applies `todo_project` + `todo_person` by folding
/// them into the linked Todo's create payload; a `journal_ref` link is parsed and
/// IGNORED this slice (the JE body weave is slice 6).
struct Link {
    kind: LinkKind,
    from: String,
    to: String,
    /// The `todo_person` role (`waiting_on`/`related`); `None` for the other kinds.
    role: Option<String>,
}

/// The three link kinds (ADR-0042). `JournalRef` is parsed so a malformed
/// `journal_ref` still fails extraction, but it applies NOTHING in slice 4 (the
/// body weave is slice 6).
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
    let mut non_todo_creates: Vec<ResolvedCreate> = Vec::new();
    let mut todo_creates: Vec<ResolvedCreate> = Vec::new();
    // Reject the @je node (ADR-0042 "Reject the @je node"): the journal-anchored
    // capture collapses — nothing is woven, there is no anchor — but the non-JE
    // nodes still apply as a JE-less graph (their journal_ref links are dropped by
    // the cascade; slice 6 weaves body refs). A rejected JE is simply not minted.
    if let Some(je) = graph.journal_entry
        && !decisions.is_rejected(&je.handle)
    {
        non_todo_creates.push(je);
    }
    for node in &graph.entities {
        // A node the decision vector REJECTS is not created/reused (ADR-0042). It
        // is skipped here; its handle never enters `handle_to_id`, so the cascade
        // in `fold_links_into_todo` drops every link to it (the reject-cascade).
        if decisions.is_rejected(&node.handle) {
            continue;
        }
        match resolve_node(&mut tx, node, decisions.for_handle(&node.handle)).await? {
            Disposition::Reuse(existing_id) => {
                // A reused node mints nothing; its handle resolves to the existing
                // id so a todo's link can target it (the #179 existing-project case,
                // and the `entity_id` override / picker path).
                handle_to_id.insert(node.handle.clone(), existing_id);
            }
            Disposition::Create(payload) => {
                let create = ResolvedCreate {
                    kind: node.kind,
                    // The payload may carry an `edited_fields` correction merged
                    // over the node's create payload (ADR-0042); else it is the
                    // node's own payload.
                    payload,
                    is_journal_anchor: false,
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

    // Mint the JE + non-todo creates FIRST, recording each minted handle → id so
    // the todos minted next can resolve their link endpoints. The JE node writes
    // its `created_from` guard source row; every entity node writes none.
    let mut anchor_entity_id: Option<String> = None;
    let mut first_entity_id: Option<String> = None;
    for create in &non_todo_creates {
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

        let entity_id = mint_create(&mut tx, create, proposal_id, source, now_ms).await?;

        handle_to_id.insert(create.handle.clone(), entity_id.clone());
        first_entity_id.get_or_insert_with(|| entity_id.clone());
        if create.is_journal_anchor {
            anchor_entity_id = Some(entity_id);
        }
    }

    // Mint the todos LAST, folding their `todo_project`/`todo_person` links into
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
            // A todo is never a journal_ref `from` (journal_ref is JE → entity), so
            // this arm is unreachable for a well-formed graph; ignore it regardless
            // (the JE body weave is slice 6).
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
            Disposition::Create(payload) => Ok(Disposition::Create(merge_edited_fields(
                node.type_str,
                payload,
                edits,
            )?)),
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
/// per-type validator runs at mint (via `apply_entity_mutation`). The graph wraps a
/// Todo's data in a `{todo: TodoData}` envelope, so a Todo's edits merge into the
/// INNER `todo` object; Person/Project edit the flat payload. `edited_fields` must
/// be a JSON object.
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
        target.insert(key.clone(), value.clone());
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
/// apply as `InvalidMutation` before any tx opens (slice 4's all-or-nothing
/// contract). The softer drop+report on a node a later decision REJECTS is slice 5.
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
                // JE → a referenceable entity (slice 6 weaves these; slice 4 only
                // type-checks so a malformed journal_ref fails loud, not silently).
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
    Ok(())
}

/// Parse one `links[]` element into a [`Link`] (ADR-0042). A `todo_project`/
/// `journal_ref` carries `{kind, from, to}`; a `todo_person` additionally carries
/// `role`. A malformed link (non-object, missing/blank `from`/`to`, unknown kind)
/// is `InvalidMutation` — the whole apply fails before any tx opens. A
/// `journal_ref` is parsed (so it must be well-formed) but applied NOWHERE in
/// slice 4 (the JE body weave is slice 6).
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
/// on the `ResolvedCreate` so a `journal_ref`/body weave (slice 6) and the
/// handle→id map can join on it.
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
        is_journal_anchor: true,
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
