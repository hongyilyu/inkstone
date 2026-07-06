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
//!     the tx rolls back, nothing is written — UNLESS the per-node decision carries
//!     an `entity_id` override (the disambiguation picker, #181), which resolves the
//!     node to reuse-that-id before this step (see [`resolve_node`]).
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
use super::journal_weave::{
    Placement, join_with_separator, splice_entity_ref_into_body, weave_journal_body,
};
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
    /// The JE node's optional `existing_id` anchor-reuse hint (ADR-0042). A
    /// graph-local hint key (like `handle`) STRIPPED from `payload`; carried here so
    /// `apply_intent_graph_proposal` can route a JE node WITH one to
    /// `anchor_reuse_journal_entry` (reuse the named JE) instead of minting.
    /// `None` for entity-node `ResolvedCreate`s and JE-less direct capture.
    existing_id: Option<String>,
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
    /// The `journal_ref` link's optional `match_text` — the substring of the JE body
    /// the model recognized, for later stored-body splicing (ADR-0042). `None` for
    /// the other kinds.
    match_text: Option<String>,
    /// The `journal_ref` link's optional `append_text` — a model-proposed clause for an
    /// entity NOT in the entry's prose, appended to the stored body with the chip
    /// spliced inside it (ADR-0042 amendment, #221). Exactly one of `match_text` /
    /// `append_text` is set per anchor-reuse `journal_ref` (enforced at apply). `None`
    /// for the other kinds.
    append_text: Option<String>,
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
            PlanDisposition::Create(near_matches) => ResolvedNode {
                handle: node.handle.clone(),
                r#type: node.type_str.to_string(),
                disposition: "create".to_string(),
                label,
                entity_id: None,
                candidates: None,
                // Advisory near-matches (ADR-0042 amendment): empty → omit the field.
                near_matches: (!near_matches.is_empty()).then_some(near_matches),
            },
            PlanDisposition::Reuse(entity_id) => ResolvedNode {
                handle: node.handle.clone(),
                r#type: node.type_str.to_string(),
                disposition: "reuse".to_string(),
                label,
                entity_id: Some(entity_id),
                candidates: None,
                near_matches: None,
            },
            PlanDisposition::Ambiguous(candidates) => ResolvedNode {
                handle: node.handle.clone(),
                r#type: node.type_str.to_string(),
                disposition: "ambiguous".to_string(),
                label,
                entity_id: None,
                candidates: Some(candidates),
                near_matches: None,
            },
        });
    }
    Ok(plan)
}

pub(crate) fn validate_intent_graph_payload(payload: &serde_json::Value) -> Result<(), String> {
    extract_graph(payload).map(|_| ()).map_err(|err| err.to_string())
}

/// One entity node's resolved disposition for the READ-ONLY plan (ADR-0042). The
/// display analogue of the resolver's [`Disposition`]: `Ambiguous` is a VARIANT
/// here (the plan surfaces the competing candidates so the Client can show the
/// "needs disambiguation" hint), where the resolver fails the whole apply.
///
/// `Create` carries advisory NEAR-MATCHES (ADR-0042 amendment): accepted same-type
/// entities whose name token-overlaps this node's (subset/superset). Empty when
/// there is no overlap. Never authority — the apply path stays exact-only.
enum PlanDisposition {
    Create(Vec<ResolvedNodeCandidate>),
    Reuse(String),
    Ambiguous(Vec<ResolvedNodeCandidate>),
}

/// The whitespace-tokenized, lowercased token set of a name — the unit the
/// near-match predicate compares (ADR-0042 amendment). Empty/whitespace-only names
/// yield an empty set (which never overlaps, so a blank name near-matches nothing).
fn name_tokens(name: &str) -> std::collections::BTreeSet<String> {
    name.split_whitespace().map(str::to_lowercase).collect()
}

/// The near-match predicate (ADR-0042 amendment): two names are near-matches when
/// one's non-empty token set is a SUBSET of the other's (either direction) — e.g.
/// {lead,ads} ⊆ {lead,ads,testing}. An exact token-set equality also satisfies
/// this, but the caller only computes near-matches on the `create` (non-exact-label)
/// path, so an exact-label match never reaches here. Both sets must be non-empty.
fn is_near_match(
    a: &std::collections::BTreeSet<String>,
    b: &std::collections::BTreeSet<String>,
) -> bool {
    !a.is_empty() && !b.is_empty() && (a.is_subset(b) || b.is_subset(a))
}

/// The most near-matches surfaced per node (ADR-0042 amendment). A single one
/// drives the Client's default-to-existing; 2+ defer to the picker (#181). Capped
/// so a pathological accepted set can't bloat the advisory plan.
const MAX_NEAR_MATCHES: usize = 5;

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
    //    there is nothing to match on → `create` (no near-matches without a name).
    let Some(label) = node.label.as_deref() else {
        return Ok(PlanDisposition::Create(Vec::new()));
    };
    let needle = label.trim().to_lowercase();
    let label_key = label_key_for(node.type_str);

    // One pass over the accepted same-type rows collects BOTH the exact matches and
    // the token-overlap near-matches (ADR-0042 amendment) — the near-match list is
    // only used when the node falls through to `create` (zero exact matches), so a
    // single `list_by_type` read backs both (no double-query).
    let node_tokens = name_tokens(label);
    let rows = queries::list_by_type(pool, node.type_str).await?;
    let mut matches: Vec<ResolvedNodeCandidate> = Vec::new();
    let mut near_matches: Vec<ResolvedNodeCandidate> = Vec::new();
    for (id, _, data, _, _) in rows {
        let Some(stored) = serde_json::from_str::<serde_json::Value>(&data)
            .ok()
            .as_ref()
            .and_then(|v| v.get(label_key))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
        else {
            continue;
        };
        if stored.trim().to_lowercase() == needle {
            matches.push(ResolvedNodeCandidate {
                entity_id: id,
                label: stored,
            });
        } else if is_near_match(&node_tokens, &name_tokens(&stored)) {
            near_matches.push(ResolvedNodeCandidate {
                entity_id: id,
                label: stored,
            });
        }
    }

    Ok(match matches.len() {
        0 => {
            near_matches.truncate(MAX_NEAR_MATCHES);
            PlanDisposition::Create(near_matches)
        }
        // An exact match wins outright — near-matches are advisory only for a node
        // with NO exact resolution, so a reuse/ambiguous node carries none.
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
        // Record EVERY declared node's label first — including a rejected one's —
        // so the JE body weave can collapse a rejected ref's placeholder to that
        // node's NAME as plain text (ADR-0042 "the name stays plain text"), not an
        // empty text node. The label map is read downstream only for resolved
        // handles (the `entity_ref.label_snapshot`) plus this collapse fallback, so
        // carrying rejected labels is harmless to the snapshot path.
        if let Some(label) = node.label.clone() {
            handle_to_label.insert(node.handle.clone(), label);
        }
        // A node the decision vector REJECTS is not created/reused (ADR-0042). It
        // is skipped here; its handle never enters `handle_to_id`, so the cascade
        // in `fold_links_into_todo` (and the JE body weave) drops every link/
        // placeholder to it (the reject-cascade: a rejected ref collapses to text).
        if decisions.is_rejected(&node.handle) {
            continue;
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
                    // Anchor-reuse is a JE-node concept; entity-node creates carry none.
                    existing_id: None,
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

    // Resolve the JE LAST — every entity it could reference is now in `handle_to_id`.
    // The JE node has TWO modes (ADR-0042):
    //   - ANCHOR-REUSE (`existing_id` is Some): the re-scan path. No new JE is minted
    //     — the named EXISTING JE is reused; each surviving `journal_ref` splices a
    //     chip into its STORED body (one new revision of the SAME entity row) and
    //     inserts a backlink row. See [`anchor_reuse_journal_entry`].
    //   - CREATE (`existing_id` is None): today's path. Mint a fresh JE LAST
    //     (ADR-0042 "Multi-ref Journal Entry weave is one write"); the JE body's
    //     `{entity_ref, target:@handle}` placeholders weave into stored
    //     `{entity_ref, ref_id}` nodes in the JE's SINGLE seq-1 revision — never a
    //     text-only insert followed by an update. The JE *entity row* is minted last
    //     because its body needs the referenced ids; its `entity_ref` rows
    //     (source = JE) are inserted after the JE row exists.
    let mut anchor_entity_id: Option<String> = None;
    if let Some(je) = &je_create {
        let je_id = match je.existing_id.as_deref().filter(|id| !id.trim().is_empty()) {
            Some(existing_id) => {
                anchor_reuse_journal_entry(
                    &mut tx,
                    run_id,
                    je,
                    existing_id,
                    &graph.links,
                    &handle_to_id,
                    &handle_to_label,
                    &decisions,
                    proposal_id,
                    now_ms,
                )
                .await?
            }
            None => {
                weave_and_mint_journal_entry(
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
                .await?
            }
        };
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
///    else collapses to a `{type:text, text:<label>}` node carrying the target's
///    name (the rejected-ref cascade — never an empty text node).
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
    //    collapse to the target's NAME as plain text when it was rejected/dropped.
    let mut payload = je.payload.clone();
    weave_journal_body(&mut payload, &target_ref_id, handle_to_label)?;

    // Defense in depth (ADR-0042): the woven body is Core-constructed, but validate
    // it against the same per-node content rules the client codec enforces before
    // minting — so a future weave bug fails loud as InvalidMutation rather than
    // persisting a body (e.g. an empty text node) that the advertised schema forbids
    // and that would later black out the client's Library read. A CREATE-mode JE
    // (this function — `existing_id` is None) MUST carry a body: the journal_entry
    // node's `body` is schema-OPTIONAL only to let an ANCHOR-REUSE node omit it
    // (that path keeps the stored body and never reaches here), so a body-less
    // create node is rejected here rather than minting an empty Journal Entry.
    let body = payload.get("body").ok_or_else(|| {
        ApplyError::InvalidMutation(
            "intent graph journal_entry create node must carry a body".to_string(),
        )
    })?;
    crate::entities::validate_woven_journal_body(body).map_err(ApplyError::InvalidMutation)?;

    // 3. Mint the JE entity (its only write) with the woven body + the guard row.
    let woven_je = ResolvedCreate {
        kind: je.kind,
        payload,
        handle: je.handle.clone(),
        // This is the create-mode weave: it is only reached when the JE node carries
        // NO `existing_id` (a node WITH one routes to `anchor_reuse_journal_entry`
        // instead). So this is always `None`, and the minted JE is newborn.
        existing_id: None,
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

/// Anchor-reuse the JE node into an EXISTING Journal Entry (ADR-0042 re-scan): the
/// model recognized entities it MISSED when the JE was first captured, and the user
/// accepted them. Instead of minting a new JE, this reuses the named `existing_id`
/// and folds each surviving `journal_ref` into that JE's STORED body + backlinks, in
/// ONE new revision of the SAME entity row (the JE id never changes). Called AFTER
/// every referenced entity is resolved (in `handle_to_id`), exactly like the
/// create-mode weave.
///
/// 1. CROSS-THREAD GUARD: the existing JE's origin user-Message must be in THIS Run's
///    Thread (`journal_entry_target_is_valid`, in-tx). A re-scan re-anchoring a JE
///    from a DIFFERENT thread is refused (`InvalidMutation`) — this is what keeps the
///    v1 re-scan same-thread (the cross-thread surface is a later concern).
/// 2. Read the existing JE's STORED body via `current_journal_entry_by_id` (the JE
///    vanished under the parked Proposal → `TargetMissing`).
/// 3. For each surviving `journal_ref` link (`from == @je`, `to` not rejected and
///    resolved): require EXACTLY ONE of `match_text` / `append_text` (both-set or
///    neither-set → `InvalidMutation`); create/reuse an `entity_ref` id keyed by the
///    resolved TARGET ENTITY id (so two handles resolving to one entity share one
///    ref_id, like the create-mode weave); then place the chip. `match_text` splices it
///    into the EXISTING prose at the first un-chipped occurrence (#221's original
///    re-scan path); `append_text` APPENDS the model-proposed clause as a new body text
///    node and splices the chip on the entity's name WITHIN it (the ADR-0042
///    amendment). Both go through `splice_entity_ref_into_body`, which fails LOUD if the
///    substring is gone — the whole tx rolls back. Plan the backlink row.
/// 4. Write the modified body as ONE new revision of the EXISTING JE (update_entity +
///    insert_entity_revision — NO new `entities` row), then insert the backlink rows
///    (source = the existing JE id, target = the resolved entity; ON CONFLICT DO
///    NOTHING, so re-anchoring an already-anchored entity is a no-op).
///
/// Returns the existing JE id (the graph anchor — unchanged).
#[allow(clippy::too_many_arguments)]
async fn anchor_reuse_journal_entry(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    run_id: Uuid,
    je: &ResolvedCreate,
    existing_id: &str,
    links: &[Link],
    handle_to_id: &std::collections::HashMap<String, String>,
    handle_to_label: &std::collections::HashMap<String, String>,
    decisions: &NodeDecisions,
    proposal_id: &str,
    now_ms: i64,
) -> Result<String, ApplyError> {
    // 1. Cross-thread guard: the re-anchored JE's origin user-Message must be in this
    //    Run's Thread. A cross-thread re-scan is refused — nothing is written.
    if !queries::journal_entry_target_is_valid(&mut **tx, run_id, existing_id).await? {
        return Err(ApplyError::InvalidMutation(format!(
            "intent graph anchor-reuse target {existing_id:?} is not a Journal Entry created from \
             this thread; cross-thread re-scan is refused"
        )));
    }

    // 2. Read the existing JE's stored body. A vanished JE (deleted under the parked
    //    Proposal) is TargetMissing, not an opaque fault.
    let (_, current_data) = queries::current_journal_entry_by_id(&mut **tx, existing_id)
        .await?
        .ok_or(ApplyError::TargetMissing)?;
    let mut data: serde_json::Value = serde_json::from_str(&current_data).map_err(|e| {
        ApplyError::InvalidMutation(format!("stored Journal Entry data is malformed JSON: {e}"))
    })?;
    let mut body: Vec<serde_json::Value> = data
        .get("body")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .ok_or_else(|| {
            ApplyError::InvalidMutation(
                "stored Journal Entry data is missing its body array".to_string(),
            )
        })?;

    // 3. For each surviving journal_ref: write its backlink, read back the
    //    AUTHORITATIVE ref_id, then splice that id into the stored body.
    //    Keyed by the resolved TARGET ENTITY id (UNIQUE(source,target) on entity_refs),
    //    so two handles → one entity share one ref_id and one row.
    //
    //    The backlink is inserted HERE (before the revision write) — not after —
    //    so the body chip carries the row's REAL id. `insert_entity_ref` is
    //    ON CONFLICT(source,target) DO NOTHING, so when this (JE, target) was
    //    already anchored (a repeat re-scan, or the same entity chipped earlier),
    //    the insert no-ops and KEEPS the existing row's id; re-reading it via
    //    `entity_ref_id_for_source_target` returns that authoritative id, which the
    //    body then splices on — never a freshly-minted id with no backing row (the
    //    dangling-chip bug). This mirrors the single-entity reference path
    //    (`apply::reference_existing_entity_from_journal_entry`).
    let mut entity_ref_id: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    for link in links
        .iter()
        .filter(|l| matches!(l.kind, LinkKind::JournalRef) && l.from == je.handle)
    {
        if decisions.is_rejected(&link.to) {
            continue;
        }
        let Some(entity_id) = handle_to_id.get(&link.to) else {
            // The target resolved to no id (rejected, or a degenerate handle): drop it.
            continue;
        };
        // A re-scan ref needs exactly ONE placement (ADR-0042 amendment, #221):
        // `match_text` splices the chip at a substring already in the entry's prose
        // (the original re-scan path); `append_text` appends a model-proposed clause
        // (the entity is NOT yet in the prose) and splices the chip inside it. Both-set
        // or neither-set fails loud here — the whole tx rolls back — so the four cases
        // are enumerated ONCE and the rest of the loop branches on a `Placement` value.
        let placement = match (
            link.match_text.as_deref().filter(|s| !s.is_empty()),
            link.append_text.as_deref().filter(|s| !s.is_empty()),
        ) {
            (Some(match_text), None) => Placement::Splice(match_text),
            (None, Some(append_text)) => Placement::Append(append_text),
            (Some(_), Some(_)) => {
                return Err(ApplyError::InvalidMutation(format!(
                    "intent graph anchor-reuse journal_ref to {:?} sets both match_text and append_text; exactly one is required",
                    link.to
                )));
            }
            (None, None) => {
                return Err(ApplyError::InvalidMutation(format!(
                    "intent graph anchor-reuse journal_ref to {:?} needs match_text or append_text to place the chip",
                    link.to
                )));
            }
        };
        // Reuse this entity's authoritative ref_id if a prior link this call already
        // resolved it; else insert the backlink + read the row's real id.
        let ref_id = match entity_ref_id.get(entity_id) {
            Some(existing) => existing.clone(),
            None => {
                let proposed_ref_id = Uuid::now_v7().to_string();
                let label = handle_to_label.get(&link.to).cloned();
                queries::insert_entity_ref(
                    &mut **tx,
                    &proposed_ref_id,
                    existing_id,
                    entity_id,
                    label.as_deref(),
                    now_ms,
                )
                .await?;
                // Read the row's id back: on ON CONFLICT this is the EXISTING row's
                // id (re-anchor), not the proposed one — so the body never carries a
                // dangling ref_id.
                let authoritative = queries::entity_ref_id_for_source_target(
                    &mut **tx,
                    existing_id,
                    entity_id,
                )
                .await?
                .ok_or_else(|| {
                    ApplyError::InvalidMutation(
                        "failed to create or find entity_ref for source and target".to_string(),
                    )
                })?;
                entity_ref_id.insert(entity_id.clone(), authoritative.clone());
                authoritative
            }
        };
        // Place the chip per the resolved `Placement`.
        match placement {
            // `match_text`: splice into the EXISTING prose — fails LOUD (whole tx rolls
            // back) if the recognized substring is gone.
            Placement::Splice(match_text) => {
                body = splice_entity_ref_into_body(&body, match_text, &ref_id)?;
            }
            // `append_text`: splice the chip on the entity's recognized NAME within the
            // just-appended clause ALONE (a 1-element slice), then extend the body. Splicing
            // in isolation means the chip can ONLY land in the new clause — if the label
            // also appears in the original prose, that occurrence is left untouched and
            // every original node stays byte-identical (see the prose-collision test). The
            // separating space between prose and clause is a STRUCTURAL JOIN (Core's job);
            // `join_with_separator` folds it onto a real text node at the boundary (never a
            // standalone `{text:" "}` node, which `validate_woven_journal_body` rejects). The
            // clause CONTENT stays the model's; its label must be a verbatim substring (else
            // fail loud).
            Placement::Append(append_text) => {
                let label = handle_to_label.get(&link.to).map(String::as_str).ok_or_else(|| {
                    ApplyError::InvalidMutation(format!(
                        "intent graph anchor-reuse journal_ref to {:?} has no recognized name to splice into its append_text clause",
                        link.to
                    ))
                })?;
                // Core OWNS the prose↔clause join space (`join_with_separator`), so any
                // incidental leading/trailing whitespace the model put on the clause is
                // not content — trim it. This also removes the failure mode where a
                // clause like " Priya was also there." (leading space AND label-leading)
                // splices to a standalone `{text:" "}` node that `validate_woven_journal_body`
                // rejects. The trim stays non-empty (the field is schema-validated non-blank).
                let appended_node =
                    serde_json::json!({ "type": "text", "text": append_text.trim() });
                let mut spliced_clause =
                    splice_entity_ref_into_body(&[appended_node], label, &ref_id)?;
                join_with_separator(&mut body, &mut spliced_clause);
                body.extend(spliced_clause);
            }
        }
    }

    // Defense in depth (ADR-0042 parity with the create-mode weave): the spliced body
    // is Core-constructed; validate it against the same per-node content rules the
    // client codec enforces before persisting.
    let body = serde_json::Value::Array(body);
    crate::entities::validate_woven_journal_body(&body).map_err(ApplyError::InvalidMutation)?;

    // 4. Write the modified body as ONE new revision of the EXISTING JE — the entity
    //    ROW id is unchanged; only a new `data` + revision land. No new entities row.
    if let Some(obj) = data.as_object_mut() {
        obj.insert("body".to_string(), body);
    }
    let data_str = data.to_string();
    let schema_version = crate::mutation::EntityType::JournalEntry.schema_version();
    let updated = queries::update_entity(
        &mut **tx,
        existing_id,
        crate::mutation::EntityType::JournalEntry.as_str(),
        schema_version,
        &data_str,
        now_ms,
    )
    .await?;
    if updated != 1 {
        // The JE vanished between the guard read and the write (ADR-0033 target-gone).
        return Err(ApplyError::TargetMissing);
    }
    let next_seq = queries::next_entity_revision_seq(&mut **tx, existing_id).await?;
    queries::insert_entity_revision(
        &mut **tx,
        existing_id,
        next_seq,
        &data_str,
        Some(proposal_id),
        now_ms,
    )
    .await?;

    // Backlinks were already inserted in step 3 (before the splice) so the body
    // could carry each row's authoritative ref_id; nothing more to write here.

    Ok(existing_id.to_string())
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
    // The optional `journal_ref` match_text (parsed generically like `role`; only
    // meaningful for journal_ref) — the recognized body substring for later splicing.
    let match_text = obj
        .get("match_text")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    // The optional `journal_ref` append_text (parsed generically like `match_text`;
    // only meaningful for journal_ref) — the model-proposed clause to append.
    let append_text = obj
        .get("append_text")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    Ok(Link {
        kind,
        from,
        to,
        role,
        match_text,
        append_text,
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

    // Only the JE data keys land in the create payload — `handle` and the
    // `existing_id` anchor-reuse hint are graph-local and never JE data.
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

    // The model's optional anchor-reuse hint (ADR-0042) — carried through for a
    // later slice; the create path above never sees it (stripped from `payload`).
    let existing_id = obj
        .get("existing_id")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);

    Ok(ResolvedCreate {
        kind: MutationKind::CreateJournalEntry,
        payload: serde_json::Value::Object(payload),
        handle,
        existing_id,
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

    // NEAR-MATCH (ADR-0042 amendment): a `create` node whose normalized token set
    // is a SUPERSET of an accepted same-type entity's ("Lead Ads testing" ⊇ "Lead
    // Ads") carries that entity in `near_matches` — advisory, the node stays
    // `create`, the apply path is untouched. This is the reported bug's safety net.
    #[tokio::test]
    async fn resolved_plan_flags_near_match_on_create_node() {
        let pool = memory_pool().await;
        let existing = insert_named(&pool, "project", "Lead Ads").await;
        let payload = serde_json::json!({
            "entities": [{ "handle": "@leadads", "type": "project", "name": "Lead Ads testing" }],
            "links": []
        });
        let plan = resolved_plan_for(&pool, &payload).await.unwrap();
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].disposition, "create", "an extra qualifier is NOT an exact match");
        assert!(plan[0].entity_id.is_none() && plan[0].candidates.is_none());
        let near = plan[0]
            .near_matches
            .as_ref()
            .expect("near_matches present for the near-twin create node");
        assert_eq!(near.len(), 1);
        assert_eq!(near[0].entity_id, existing);
        assert_eq!(near[0].label, "Lead Ads");
    }

    // The predicate fires in the OTHER direction too (prioritize existing): a node
    // named "Lead Ads" with an accepted "Lead Ads testing" — the model dropped a
    // qualifier — still surfaces the existing entity. {lead,ads} ⊆ {lead,ads,testing}.
    #[tokio::test]
    async fn resolved_plan_flags_near_match_when_node_is_subset() {
        let pool = memory_pool().await;
        let existing = insert_named(&pool, "project", "Lead Ads testing").await;
        let payload = serde_json::json!({
            "entities": [{ "handle": "@leadads", "type": "project", "name": "Lead Ads" }],
            "links": []
        });
        let plan = resolved_plan_for(&pool, &payload).await.unwrap();
        assert_eq!(plan[0].disposition, "create");
        let near = plan[0].near_matches.as_ref().expect("near_matches present");
        assert_eq!(near.len(), 1);
        assert_eq!(near[0].entity_id, existing);
    }

    // An exact match resolves to `reuse` and carries NO near_matches (the existing
    // entity is the resolution, not a hint). No false near-match on the exact path.
    #[tokio::test]
    async fn resolved_plan_exact_match_has_no_near_matches() {
        let pool = memory_pool().await;
        insert_named(&pool, "project", "Lead Ads").await;
        let payload = serde_json::json!({
            "entities": [{ "handle": "@leadads", "type": "project", "name": "lead ads" }],
            "links": []
        });
        let plan = resolved_plan_for(&pool, &payload).await.unwrap();
        assert_eq!(plan[0].disposition, "reuse");
        assert!(plan[0].near_matches.is_none());
    }

    // A disjoint name (no shared tokens) on a `create` node carries NO near_matches,
    // and a near-match only matches the SAME type (a Person "Lead Ads" does not
    // near-match a Project "Lead Ads").
    #[tokio::test]
    async fn resolved_plan_no_near_match_for_disjoint_or_cross_type() {
        let pool = memory_pool().await;
        insert_named(&pool, "project", "Lead Ads").await;
        let payload = serde_json::json!({
            "entities": [
                { "handle": "@other", "type": "project", "name": "Quarterly Planning" },
                { "handle": "@person", "type": "person", "name": "Lead Ads" }
            ],
            "links": []
        });
        let plan = resolved_plan_for(&pool, &payload).await.unwrap();
        let other = &plan[node(&plan, "@other")];
        assert_eq!(other.disposition, "create");
        assert!(other.near_matches.is_none(), "no shared tokens → no near-match");
        let person = &plan[node(&plan, "@person")];
        assert_eq!(person.disposition, "create");
        assert!(
            person.near_matches.is_none(),
            "a Person must not near-match a Project of the same name (same-type only)"
        );
    }

    // The advisory near-match list is CAPPED at MAX_NEAR_MATCHES so a pathological
    // accepted set can't bloat the plan. Seed more overlapping rows than the cap and
    // assert the surfaced list is truncated.
    #[tokio::test]
    async fn resolved_plan_caps_near_matches_at_max() {
        let pool = memory_pool().await;
        // More than MAX_NEAR_MATCHES accepted projects, each token-overlapping the
        // node "Lead Ads testing" (subset or superset), so all are near-matches.
        let names = [
            "Lead",
            "Ads",
            "Lead Ads",
            "Lead testing",
            "Ads testing",
            "testing Lead",
            "Ads Lead",
        ];
        assert!(names.len() > MAX_NEAR_MATCHES, "fixture must exceed the cap");
        for name in names {
            insert_named(&pool, "project", name).await;
        }
        let payload = serde_json::json!({
            "entities": [{ "handle": "@leadads", "type": "project", "name": "Lead Ads testing" }],
            "links": []
        });
        let plan = resolved_plan_for(&pool, &payload).await.unwrap();
        assert_eq!(plan[0].disposition, "create");
        let near = plan[0].near_matches.as_ref().expect("near_matches present");
        assert_eq!(near.len(), MAX_NEAR_MATCHES, "the list is capped");
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

    // The JE node's `existing_id` anchor-reuse hint (this slice) is THREADED THROUGH
    // onto the JE `ResolvedCreate`, AND stripped out of the reconstructed create
    // `payload` (it is a graph-local hint key like handle/type, never JE data —
    // the create path must not see it). And a `journal_ref` link carries its
    // `match_text` through onto the parsed `Link` (later slices splice the stored
    // body on it). Pure structural extract — no pool, no write, apply untouched.
    #[test]
    fn extract_threads_je_existing_id_and_journal_ref_match_text() {
        let anchor = Uuid::now_v7().to_string();
        let payload = serde_json::json!({
            "journal_entry": {
                "handle": "@je",
                "existing_id": anchor,
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "entity_ref", "target": "@p" }]
            },
            "entities": [{ "handle": "@p", "type": "person", "name": "Priya" }],
            "links": [{ "kind": "journal_ref", "from": "@je", "to": "@p", "match_text": "Priya" }]
        });
        let graph = extract_graph(&payload).expect("graph extracts");

        let je = graph.journal_entry.expect("journal_entry present");
        assert_eq!(
            je.existing_id.as_deref(),
            Some(anchor.as_str()),
            "the JE node's existing_id anchor-reuse hint is threaded onto ResolvedCreate"
        );
        assert!(
            je.payload.get("existing_id").is_none(),
            "existing_id is a graph-local hint key and MUST be stripped from the create payload"
        );

        assert_eq!(graph.links.len(), 1);
        assert_eq!(
            graph.links[0].match_text.as_deref(),
            Some("Priya"),
            "the journal_ref link's match_text is parsed onto the Link"
        );
    }

    // ─── Anchor-reuse apply (slice 3) ───────────────────────────────────────
    //
    // These exercise `apply_intent_graph_proposal`'s end-to-end ANCHOR-REUSE branch
    // against a real (in-memory) pool. The scaffold seeds a Thread + Run + user
    // Message + a pending Proposal/tool_call (the re-scan run's waitpoint) + an
    // ACCEPTED Journal Entry whose `created_from` is that user Message, so the
    // cross-thread guard (`journal_entry_target_is_valid`) passes for the JE in the
    // Run's Thread.

    /// IDs the anchor-reuse scaffold returns: the existing JE id, the Run id (the
    /// apply call needs it for the accept-flip + cross-thread guard), the pending
    /// Proposal id, and its tool_call id.
    struct Scaffold {
        je_id: String,
        run_id: Uuid,
        proposal_id: String,
        tool_call_id: String,
    }

    /// Seed one Thread + Run + user Message + a pending re-scan Proposal/tool_call +
    /// an accepted Journal Entry (`created_from` the user Message) with the given
    /// stored body. `thread_for_je` is the Thread the JE is anchored in (defaults to
    /// the Run's Thread); pass a DIFFERENT thread to exercise the cross-thread guard.
    async fn seed_anchor_reuse(
        pool: &sqlx::SqlitePool,
        je_body: serde_json::Value,
    ) -> Scaffold {
        seed_anchor_reuse_cross_thread(pool, je_body, false).await
    }

    /// `cross_thread = true` puts the JE's origin user Message in a DIFFERENT Thread
    /// than the re-scan Run, so the in-tx cross-thread guard must refuse the apply.
    async fn seed_anchor_reuse_cross_thread(
        pool: &sqlx::SqlitePool,
        je_body: serde_json::Value,
        cross_thread: bool,
    ) -> Scaffold {
        let now = crate::db::now_ms();
        let run_thread = Uuid::now_v7().to_string();
        // The JE's origin Thread: the same as the Run's unless we're forcing a
        // cross-thread mismatch.
        let je_thread = if cross_thread {
            Uuid::now_v7().to_string()
        } else {
            run_thread.clone()
        };
        let run_id = Uuid::now_v7();
        let rescan_user_msg = Uuid::now_v7().to_string();
        // The JE's own origin Run + user Message (its `created_from`). For the
        // same-thread case this can share the run thread; we model it as its own Run.
        let je_run = Uuid::now_v7().to_string();
        let je_user_msg = Uuid::now_v7().to_string();
        let je_id = Uuid::now_v7().to_string();
        let tool_call_id = format!("tc_{}", Uuid::now_v7());
        let proposal_id = Uuid::now_v7().to_string();

        let mut tx = pool.begin().await.expect("begin seed tx");
        // Threads.
        for tid in [&run_thread, &je_thread] {
            // `je_thread` may equal `run_thread`; INSERT OR IGNORE keeps it idempotent.
            sqlx::query(
                "INSERT OR IGNORE INTO threads (id, title, created_at, last_activity_at) \
                 VALUES (?1, 'T', ?2, ?2)",
            )
            .bind(tid)
            .bind(now)
            .execute(&mut *tx)
            .await
            .expect("insert thread");
        }
        // The JE's origin Run + user Message (provenance for the guard).
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, thinking_level, user_message_id, status, started_at, ended_at, terminal_reason) \
             VALUES (?1, ?2, 'default', '1.0.0', 'faux', 'm', 'off', ?3, 'completed', ?4, ?4, 'completed')",
        )
        .bind(&je_run)
        .bind(&je_thread)
        .bind(&je_user_msg)
        .bind(now)
        .execute(&mut *tx)
        .await
        .expect("insert je run");
        sqlx::query(
            "INSERT INTO messages (id, thread_id, run_id, role, status, created_at, updated_at) \
             VALUES (?1, ?2, ?3, 'user', 'completed', ?4, ?4)",
        )
        .bind(&je_user_msg)
        .bind(&je_thread)
        .bind(&je_run)
        .bind(now)
        .execute(&mut *tx)
        .await
        .expect("insert je user message");

        // The re-scan Run (the apply target) + its user Message.
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, thinking_level, user_message_id, status, started_at) \
             VALUES (?1, ?2, 'default', '1.0.0', 'faux', 'm', 'off', ?3, 'parked', ?4)",
        )
        .bind(run_id.to_string())
        .bind(&run_thread)
        .bind(&rescan_user_msg)
        .bind(now)
        .execute(&mut *tx)
        .await
        .expect("insert rescan run");
        sqlx::query(
            "INSERT INTO messages (id, thread_id, run_id, role, status, created_at, updated_at) \
             VALUES (?1, ?2, ?3, 'user', 'completed', ?4, ?4)",
        )
        .bind(&rescan_user_msg)
        .bind(&run_thread)
        .bind(run_id.to_string())
        .bind(now)
        .execute(&mut *tx)
        .await
        .expect("insert rescan user message");

        // The pending re-scan Proposal + its tool_call (the apply flips this).
        sqlx::query(
            "INSERT INTO tool_calls (id, run_id, name, request_payload, status, requested_at) \
             VALUES (?1, ?2, 'apply_intent_graph', '{}', 'pending', ?3)",
        )
        .bind(&tool_call_id)
        .bind(run_id.to_string())
        .bind(now)
        .execute(&mut *tx)
        .await
        .expect("insert tool call");
        sqlx::query(
            "INSERT INTO proposals (id, tool_call_id, mutation_kind, status) \
             VALUES (?1, ?2, 'apply_intent_graph', 'pending')",
        )
        .bind(&proposal_id)
        .bind(&tool_call_id)
        .execute(&mut *tx)
        .await
        .expect("insert proposal");

        // The accepted Journal Entry (created_by='user', so no proposal-id CHECK) +
        // its seq-1 revision + `created_from` the JE's user Message.
        let je_data = serde_json::json!({
            "occurred_at": "2026-06-10T10:30:00",
            "body": je_body,
        })
        .to_string();
        sqlx::query(
            "INSERT INTO entities (id, type, schema_version, data, created_by, created_at, updated_at) \
             VALUES (?1, 'journal_entry', 1, ?2, 'user', ?3, ?3)",
        )
        .bind(&je_id)
        .bind(&je_data)
        .bind(now)
        .execute(&mut *tx)
        .await
        .expect("insert je entity");
        sqlx::query(
            "INSERT INTO entity_revisions (entity_id, seq, data, proposal_id, created_at) \
             VALUES (?1, 1, ?2, NULL, ?3)",
        )
        .bind(&je_id)
        .bind(&je_data)
        .bind(now)
        .execute(&mut *tx)
        .await
        .expect("insert je revision");
        sqlx::query(
            "INSERT INTO entity_sources (id, entity_id, source_message_id, relation, created_at) \
             VALUES (?1, ?2, ?3, 'created_from', ?4)",
        )
        .bind(Uuid::now_v7().to_string())
        .bind(&je_id)
        .bind(&je_user_msg)
        .bind(now)
        .execute(&mut *tx)
        .await
        .expect("insert je source");

        tx.commit().await.expect("commit seed tx");
        Scaffold {
            je_id,
            run_id,
            proposal_id,
            tool_call_id,
        }
    }

    /// The latest-revision body of `je_id` (the array nodes). Reads the `entities`
    /// current `data`, which always equals the latest revision.
    async fn current_je_body(
        pool: &sqlx::SqlitePool,
        je_id: &str,
    ) -> Vec<serde_json::Value> {
        let data: String = sqlx::query_scalar("SELECT data FROM entities WHERE id = ?1")
            .bind(je_id)
            .fetch_one(pool)
            .await
            .expect("read je data");
        serde_json::from_str::<serde_json::Value>(&data)
            .expect("je data is json")
            .get("body")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .expect("je body is an array")
    }

    /// Count `entity_refs` rows from `source` to `target`.
    async fn entity_ref_count(
        pool: &sqlx::SqlitePool,
        source: &str,
        target: &str,
    ) -> i64 {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM entity_refs WHERE source_entity_id = ?1 AND target_entity_id = ?2",
        )
        .bind(source)
        .bind(target)
        .fetch_one(pool)
        .await
        .expect("count entity_refs")
    }

    /// The number of `journal_entry` rows + the number of revisions of `je_id`.
    async fn je_row_and_revision_counts(pool: &sqlx::SqlitePool, je_id: &str) -> (i64, i64) {
        let je_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM entities WHERE type = 'journal_entry'")
            .fetch_one(pool)
            .await
            .expect("count je rows");
        let revisions: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM entity_revisions WHERE entity_id = ?1")
                .bind(je_id)
                .fetch_one(pool)
                .await
                .expect("count revisions");
        (je_rows, revisions)
    }

    /// The id of the sole new Person of `name` (the minted entity), or None.
    async fn person_id_named(pool: &sqlx::SqlitePool, name: &str) -> Option<String> {
        sqlx::query_scalar(
            "SELECT id FROM entities WHERE type = 'person' AND json_extract(data, '$.name') = ?1",
        )
        .bind(name)
        .fetch_optional(pool)
        .await
        .expect("look up person")
    }

    // Test 1 — the headline anchor-reuse: the JE node carries existing_id, a NEW
    // Person "Priya" is minted, a backlink row source=J target=priya is written, NO
    // new JE row appears (the existing JE id is the anchor), the existing JE's latest
    // body has a chip where "Priya" was (surrounding prose byte-identical), and the
    // returned anchor == the existing JE id.
    #[tokio::test]
    async fn anchor_reuse_mints_entity_chips_existing_body_and_keeps_je_row() {
        let pool = memory_pool().await;
        let scaffold = seed_anchor_reuse(
            &pool,
            serde_json::json!([{ "type": "text", "text": "synced with Wenqian and Priya today" }]),
        )
        .await;
        let payload = serde_json::json!({
            "journal_entry": {
                "handle": "@je",
                "existing_id": scaffold.je_id,
                "occurred_at": "2026-06-10T10:30:00"
            },
            "entities": [{ "handle": "@priya", "type": "person", "name": "Priya" }],
            "links": [{ "kind": "journal_ref", "from": "@je", "to": "@priya", "match_text": "Priya" }]
        });

        let outcome = apply_intent_graph_proposal(
            &pool,
            scaffold.run_id,
            &scaffold.proposal_id,
            &scaffold.tool_call_id,
            &payload,
            None,
            None,
            |anchor| format!("anchor:{anchor}"),
            crate::db::now_ms(),
        )
        .await
        .expect("anchor-reuse applies");

        // (e) the returned anchor is the existing JE id (NOT a new id).
        match outcome {
            IntentGraphOutcome::Applied(anchor) => assert_eq!(anchor, scaffold.je_id),
            IntentGraphOutcome::RejectedAll => panic!("expected Applied"),
        }

        // (a) a new Person "Priya" was minted.
        let priya = person_id_named(&pool, "Priya").await.expect("Priya minted");

        // (b) a backlink row source=J target=priya exists.
        assert_eq!(entity_ref_count(&pool, &scaffold.je_id, &priya).await, 1);

        // (c) exactly ONE journal_entry row and it is still J (no new JE minted), and
        //     J gained a SECOND revision (the spliced body).
        let (je_rows, revisions) = je_row_and_revision_counts(&pool, &scaffold.je_id).await;
        assert_eq!(je_rows, 1, "no new journal_entry row was minted");
        assert_eq!(revisions, 2, "the spliced body is one new revision");

        // (d) J's latest body now chips "Priya"; the surrounding prose is byte-exact.
        let body = current_je_body(&pool, &scaffold.je_id).await;
        // Pull the ref_id from the chip so we can assert the full shape.
        let chip_ref_id = body
            .iter()
            .find_map(|n| n.get("ref_id").and_then(serde_json::Value::as_str))
            .expect("a chip with a ref_id");
        assert_eq!(
            body,
            vec![
                serde_json::json!({ "type": "text", "text": "synced with Wenqian and " }),
                serde_json::json!({ "type": "entity_ref", "ref_id": chip_ref_id }),
                serde_json::json!({ "type": "text", "text": " today" }),
            ]
        );
    }

    // Test 2 — an existing chip (Wenqian, ref_id R_old) is PRESERVED byte-for-byte
    // when a new entity (Priya) is spliced; its backing entity_ref row is intact.
    #[tokio::test]
    async fn anchor_reuse_preserves_existing_chip() {
        let pool = memory_pool().await;
        // Seed a body that ALREADY chips Wenqian and has plain "Priya".
        let r_old = Uuid::now_v7().to_string();
        let scaffold = seed_anchor_reuse(
            &pool,
            serde_json::json!([
                { "type": "text", "text": "synced with " },
                { "type": "entity_ref", "ref_id": r_old },
                { "type": "text", "text": " and Priya today" }
            ]),
        )
        .await;
        // Seed Wenqian + its backing entity_ref (R_old) so the existing chip resolves.
        let wenqian = insert_named(&pool, "person", "Wenqian").await;
        queries::insert_entity_ref(
            &pool,
            &r_old,
            &scaffold.je_id,
            &wenqian,
            Some("Wenqian"),
            crate::db::now_ms(),
        )
        .await
        .expect("seed existing chip row");

        let payload = serde_json::json!({
            "journal_entry": {
                "handle": "@je", "existing_id": scaffold.je_id, "occurred_at": "2026-06-10T10:30:00"
            },
            "entities": [{ "handle": "@priya", "type": "person", "name": "Priya" }],
            "links": [{ "kind": "journal_ref", "from": "@je", "to": "@priya", "match_text": "Priya" }]
        });
        apply_intent_graph_proposal(
            &pool,
            scaffold.run_id,
            &scaffold.proposal_id,
            &scaffold.tool_call_id,
            &payload,
            None,
            None,
            |a| a.to_string(),
            crate::db::now_ms(),
        )
        .await
        .expect("anchor-reuse applies");

        let body = current_je_body(&pool, &scaffold.je_id).await;
        // The Wenqian chip is untouched (same ref_id, same node).
        assert!(
            body.contains(&serde_json::json!({ "type": "entity_ref", "ref_id": r_old })),
            "the pre-existing Wenqian chip is preserved byte-identical: {body:?}"
        );
        // Its backing entity_ref row is intact.
        assert_eq!(entity_ref_count(&pool, &scaffold.je_id, &wenqian).await, 1);
        // Priya got chipped + her backlink.
        let priya = person_id_named(&pool, "Priya").await.expect("Priya minted");
        assert_eq!(entity_ref_count(&pool, &scaffold.je_id, &priya).await, 1);
    }

    // Test 3 — suppression no-op: an anchor-reuse graph that re-proposes an entity
    // ALREADY anchored (exact-name reuse → same id) and whose name STILL sits in
    // plain prose writes NO duplicate entity_ref row and does not error.
    #[tokio::test]
    async fn anchor_reuse_reanchor_is_no_op() {
        let pool = memory_pool().await;
        // Body has Priya as plain text TWICE so the splice can find an un-chipped one.
        let scaffold = seed_anchor_reuse(
            &pool,
            serde_json::json!([{ "type": "text", "text": "Priya and later Priya again" }]),
        )
        .await;
        // Priya already exists (accepted) AND is already anchored to J.
        let priya = insert_named(&pool, "person", "Priya").await;
        let pre_ref = Uuid::now_v7().to_string();
        queries::insert_entity_ref(
            &pool,
            &pre_ref,
            &scaffold.je_id,
            &priya,
            Some("Priya"),
            crate::db::now_ms(),
        )
        .await
        .expect("seed existing backlink");
        assert_eq!(entity_ref_count(&pool, &scaffold.je_id, &priya).await, 1);

        // The graph re-proposes Priya by exact name → resolves to REUSE (existing id),
        // and journal_refs to her again.
        let payload = serde_json::json!({
            "journal_entry": {
                "handle": "@je", "existing_id": scaffold.je_id, "occurred_at": "2026-06-10T10:30:00"
            },
            "entities": [{ "handle": "@priya", "type": "person", "name": "Priya" }],
            "links": [{ "kind": "journal_ref", "from": "@je", "to": "@priya", "match_text": "Priya" }]
        });
        apply_intent_graph_proposal(
            &pool,
            scaffold.run_id,
            &scaffold.proposal_id,
            &scaffold.tool_call_id,
            &payload,
            None,
            None,
            |a| a.to_string(),
            crate::db::now_ms(),
        )
        .await
        .expect("re-anchor is a clean no-op");

        // STILL exactly one backlink row (ON CONFLICT DO NOTHING suppressed the dup).
        assert_eq!(
            entity_ref_count(&pool, &scaffold.je_id, &priya).await,
            1,
            "re-anchoring an already-anchored entity writes no duplicate row"
        );
        // The spliced body chip points at the SURVIVING row's id (`pre_ref`), NOT a
        // freshly-minted one — re-anchor must reuse the existing entity_ref id, or the
        // body would carry a dangling ref_id with no backing row (the chip would render
        // as an un-clickable "Referenced entity" and orphan the backlink).
        let body = current_je_body(&pool, &scaffold.je_id).await;
        assert!(
            body.contains(&serde_json::json!({ "type": "entity_ref", "ref_id": pre_ref })),
            "the re-anchor chip reuses the existing backlink's ref_id, never a dangling new one: {body:?}"
        );
        // And no orphan: the body's entity_ref ref_id resolves to a real row.
        let surviving_id: String = sqlx::query_scalar(
            "SELECT id FROM entity_refs WHERE source_entity_id = ?1 AND target_entity_id = ?2",
        )
        .bind(&scaffold.je_id)
        .bind(&priya)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(surviving_id, pre_ref, "the surviving entity_ref row kept its original id");
        // No NEW Priya minted.
        let person_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM entities WHERE type = 'person'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(person_count, 1, "the existing Priya was reused, not duplicated");
    }

    // Test 4 — match_text absent from the stored body → Err(InvalidMutation), the
    // whole tx rolls back: NO new Person, NO new revision, the JE body unchanged.
    #[tokio::test]
    async fn anchor_reuse_match_text_not_found_rolls_back() {
        let pool = memory_pool().await;
        let original_body =
            serde_json::json!([{ "type": "text", "text": "synced with the team today" }]);
        let scaffold = seed_anchor_reuse(&pool, original_body.clone()).await;
        let payload = serde_json::json!({
            "journal_entry": {
                "handle": "@je", "existing_id": scaffold.je_id, "occurred_at": "2026-06-10T10:30:00"
            },
            "entities": [{ "handle": "@priya", "type": "person", "name": "Priya" }],
            "links": [{ "kind": "journal_ref", "from": "@je", "to": "@priya", "match_text": "Priya" }]
        });
        let result = apply_intent_graph_proposal(
            &pool,
            scaffold.run_id,
            &scaffold.proposal_id,
            &scaffold.tool_call_id,
            &payload,
            None,
            None,
            |a| a.to_string(),
            crate::db::now_ms(),
        )
        .await;
        match result {
            Err(ApplyError::InvalidMutation(_)) => {}
            other => panic!("expected InvalidMutation, got {:?}", other.err()),
        }

        // Nothing landed: no Priya, the JE keeps its one revision, body unchanged.
        assert!(person_id_named(&pool, "Priya").await.is_none(), "no Person minted");
        let (_, revisions) = je_row_and_revision_counts(&pool, &scaffold.je_id).await;
        assert_eq!(revisions, 1, "no new revision was written");
        let body = current_je_body(&pool, &scaffold.je_id).await;
        assert_eq!(
            serde_json::Value::Array(body),
            original_body,
            "the JE body is unchanged after the rollback"
        );
        // The proposal stayed pending (the accept-flip rolled back with the tx).
        let status: String =
            sqlx::query_scalar("SELECT status FROM proposals WHERE id = ?1")
                .bind(&scaffold.proposal_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "pending", "the rolled-back accept-flip leaves the proposal pending");
    }

    // Test 5 — cross-thread guard: an anchor-reuse for a JE whose origin Message is in
    // a DIFFERENT Thread than the Run → Err(InvalidMutation), nothing written.
    #[tokio::test]
    async fn anchor_reuse_cross_thread_is_refused() {
        let pool = memory_pool().await;
        let original_body =
            serde_json::json!([{ "type": "text", "text": "synced with Priya today" }]);
        let scaffold =
            seed_anchor_reuse_cross_thread(&pool, original_body.clone(), true).await;
        let payload = serde_json::json!({
            "journal_entry": {
                "handle": "@je", "existing_id": scaffold.je_id, "occurred_at": "2026-06-10T10:30:00"
            },
            "entities": [{ "handle": "@priya", "type": "person", "name": "Priya" }],
            "links": [{ "kind": "journal_ref", "from": "@je", "to": "@priya", "match_text": "Priya" }]
        });
        let result = apply_intent_graph_proposal(
            &pool,
            scaffold.run_id,
            &scaffold.proposal_id,
            &scaffold.tool_call_id,
            &payload,
            None,
            None,
            |a| a.to_string(),
            crate::db::now_ms(),
        )
        .await;
        match result {
            Err(ApplyError::InvalidMutation(_)) => {}
            other => panic!("expected InvalidMutation, got {:?}", other.err()),
        }

        // Nothing written: no Priya, no new revision, body unchanged.
        assert!(person_id_named(&pool, "Priya").await.is_none());
        let (_, revisions) = je_row_and_revision_counts(&pool, &scaffold.je_id).await;
        assert_eq!(revisions, 1, "cross-thread refusal writes no revision");
        assert_eq!(
            serde_json::Value::Array(current_je_body(&pool, &scaffold.je_id).await),
            original_body,
        );
    }

    // Test 6 — create-mode regression: a JE node WITHOUT existing_id still MINTS a new
    // JE (the create-mode weave is byte-for-byte unchanged when existing_id is None).
    #[tokio::test]
    async fn create_mode_without_existing_id_still_mints_new_je() {
        let pool = memory_pool().await;
        // The scaffold seeds an existing JE J; the create-mode graph IGNORES it
        // (no existing_id) and mints a SECOND, fresh JE.
        let scaffold = seed_anchor_reuse(
            &pool,
            serde_json::json!([{ "type": "text", "text": "unrelated" }]),
        )
        .await;
        let payload = serde_json::json!({
            "journal_entry": {
                "handle": "@je",
                "occurred_at": "2026-06-11T09:00:00",
                "body": [
                    { "type": "text", "text": "met " },
                    { "type": "entity_ref", "target": "@priya" }
                ]
            },
            "entities": [{ "handle": "@priya", "type": "person", "name": "Priya" }],
            "links": [{ "kind": "journal_ref", "from": "@je", "to": "@priya" }]
        });
        let outcome = apply_intent_graph_proposal(
            &pool,
            scaffold.run_id,
            &scaffold.proposal_id,
            &scaffold.tool_call_id,
            &payload,
            None,
            None,
            |a| a.to_string(),
            crate::db::now_ms(),
        )
        .await
        .expect("create-mode applies");

        // A NEW JE was minted (now TWO journal_entry rows) and the anchor is NOT the
        // seeded JE id.
        match outcome {
            IntentGraphOutcome::Applied(anchor) => {
                assert_ne!(anchor, scaffold.je_id, "create-mode mints a fresh JE, not the seeded one")
            }
            IntentGraphOutcome::RejectedAll => panic!("expected Applied"),
        }
        let je_rows: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM entities WHERE type = 'journal_entry'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(je_rows, 2, "create-mode added a second JE row");
    }

    // The body field went OPTIONAL on the JE node so an ANCHOR-REUSE proposal can
    // omit it (Core keeps the stored body). The create-mode guard pins that a
    // create-mode JE node (no existing_id) STILL must carry a body: an ABSENT body
    // fails loud as InvalidMutation, the tx rolls back, and no JE is minted. Without
    // this test the guard could be reordered/removed in a refactor and the schema
    // relaxation would silently let a bodyless JE mint.
    #[tokio::test]
    async fn create_mode_without_body_is_rejected_and_mints_nothing() {
        let pool = memory_pool().await;
        let scaffold = seed_anchor_reuse(
            &pool,
            serde_json::json!([{ "type": "text", "text": "unrelated" }]),
        )
        .await;
        // create mode (no existing_id) + NO body on the JE node.
        let payload = serde_json::json!({
            "journal_entry": { "handle": "@je", "occurred_at": "2026-06-11T09:00:00" },
            "entities": [{ "handle": "@priya", "type": "person", "name": "Priya" }],
            "links": []
        });
        let result = apply_intent_graph_proposal(
            &pool,
            scaffold.run_id,
            &scaffold.proposal_id,
            &scaffold.tool_call_id,
            &payload,
            None,
            None,
            |a| a.to_string(),
            crate::db::now_ms(),
        )
        .await;
        assert!(
            matches!(result, Err(ApplyError::InvalidMutation(_))),
            "a create-mode JE node without a body is rejected"
        );
        // The tx rolled back: still only the seeded JE, and Priya never minted.
        let je_rows: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM entities WHERE type = 'journal_entry'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(je_rows, 1, "no new JE minted on the rejected create");
        let person_rows: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM entities WHERE type = 'person'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(person_rows, 0, "nothing minted — atomic rollback");
    }

    // The companion to the absent-body guard: a create-mode JE node with an EMPTY
    // body array is rejected by the woven-body min-length validation (a JE body must
    // have >= 1 node), again minting nothing.
    #[tokio::test]
    async fn create_mode_with_empty_body_is_rejected_and_mints_nothing() {
        let pool = memory_pool().await;
        let scaffold = seed_anchor_reuse(
            &pool,
            serde_json::json!([{ "type": "text", "text": "unrelated" }]),
        )
        .await;
        let payload = serde_json::json!({
            "journal_entry": { "handle": "@je", "occurred_at": "2026-06-11T09:00:00", "body": [] },
            "entities": [{ "handle": "@priya", "type": "person", "name": "Priya" }],
            "links": []
        });
        let result = apply_intent_graph_proposal(
            &pool,
            scaffold.run_id,
            &scaffold.proposal_id,
            &scaffold.tool_call_id,
            &payload,
            None,
            None,
            |a| a.to_string(),
            crate::db::now_ms(),
        )
        .await;
        assert!(
            matches!(result, Err(ApplyError::InvalidMutation(_))),
            "a create-mode JE node with an empty body is rejected"
        );
        let je_rows: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM entities WHERE type = 'journal_entry'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(je_rows, 1, "no new JE minted on the rejected empty-body create");
    }

    // Test — anchor-reuse APPEND (#221, ADR-0042 amendment): a journal_ref carrying
    // `append_text` (and NO match_text) for a name NOT in the entry's prose mints the
    // new Person, APPENDS the model-proposed clause as a new body node, splices the
    // entity's chip inside that appended clause, writes the backlink, and lands ONE new
    // revision of the SAME JE row. The ORIGINAL prose (head of body) is byte-identical.
    #[tokio::test]
    async fn anchor_reuse_append_text_appends_clause_chip_and_backlink() {
        let pool = memory_pool().await;
        // The entry's own prose never names Priya.
        let original_head = serde_json::json!({ "type": "text", "text": "synced with the team today" });
        let scaffold = seed_anchor_reuse(&pool, serde_json::json!([original_head])).await;
        let payload = serde_json::json!({
            "journal_entry": {
                "handle": "@je", "existing_id": scaffold.je_id, "occurred_at": "2026-06-10T10:30:00"
            },
            "entities": [{ "handle": "@priya", "type": "person", "name": "Priya" }],
            "links": [{
                "kind": "journal_ref", "from": "@je", "to": "@priya",
                "append_text": "Followed up with Priya."
            }]
        });

        let outcome = apply_intent_graph_proposal(
            &pool,
            scaffold.run_id,
            &scaffold.proposal_id,
            &scaffold.tool_call_id,
            &payload,
            None,
            None,
            |a| a.to_string(),
            crate::db::now_ms(),
        )
        .await
        .expect("append-mode anchor-reuse applies");
        match outcome {
            IntentGraphOutcome::Applied(anchor) => assert_eq!(anchor, scaffold.je_id),
            IntentGraphOutcome::RejectedAll => panic!("expected Applied"),
        }

        // (a) a new Person "Priya" was minted.
        let priya = person_id_named(&pool, "Priya").await.expect("Priya minted");
        // (b) a backlink row source=J target=priya exists.
        assert_eq!(entity_ref_count(&pool, &scaffold.je_id, &priya).await, 1);
        // (c) exactly ONE journal_entry row (still J) and J gained a SECOND revision.
        let (je_rows, revisions) = je_row_and_revision_counts(&pool, &scaffold.je_id).await;
        assert_eq!(je_rows, 1, "no new journal_entry row was minted");
        assert_eq!(revisions, 2, "the appended body is one new revision");

        // (d) the latest body keeps the ORIGINAL head byte-identical, then carries the
        //     appended clause split around exactly ONE new chip whose ref_id == the
        //     backlink id.
        let body = current_je_body(&pool, &scaffold.je_id).await;
        let chip_ref_id = body
            .iter()
            .find_map(|n| n.get("ref_id").and_then(serde_json::Value::as_str))
            .expect("a chip with a ref_id");
        // The backlink id the chip must point at.
        let backlink_id: String = sqlx::query_scalar(
            "SELECT id FROM entity_refs WHERE source_entity_id = ?1 AND target_entity_id = ?2",
        )
        .bind(&scaffold.je_id)
        .bind(&priya)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(chip_ref_id, backlink_id, "the appended chip points at the backlink row");
        // Core folds the single separating space onto the appended clause's leading text
        // node (a STRUCTURAL JOIN concern): the original head stays byte-identical and the
        // clause opens " Followed up with [chip].", so the rendered prose reads
        // "…today Followed up with [chip]." with proper separation, not a "todayFollowed"
        // collision.
        assert_eq!(
            body,
            vec![
                original_head,
                serde_json::json!({ "type": "text", "text": " Followed up with " }),
                serde_json::json!({ "type": "entity_ref", "ref_id": chip_ref_id }),
                serde_json::json!({ "type": "text", "text": "." }),
            ]
        );
    }

    // Test — anchor-reuse APPEND with a label COLLISION in the original prose (#221):
    // the entity's label ALSO occurs as plain text in the existing prose, ahead of the
    // appended clause. The chip must land in the APPENDED clause, NOT weld into the
    // earlier plain-text occurrence. This pins the iteration-2 fix: the append chip is
    // spliced within the just-appended node in isolation, so the original prose stays
    // byte-identical and the appended clause carries the only new chip.
    #[tokio::test]
    async fn anchor_reuse_append_text_label_also_in_existing_prose_chips_appended_clause() {
        let pool = memory_pool().await;
        // The ORIGINAL prose names "Priya" as plain text (a missed mention the user is
        // NOT chipping here) — it must survive byte-identical and un-chipped.
        let original_head =
            serde_json::json!({ "type": "text", "text": "Met with Priya's manager about Q3" });
        let scaffold = seed_anchor_reuse(&pool, serde_json::json!([original_head])).await;
        let payload = serde_json::json!({
            "journal_entry": {
                "handle": "@je", "existing_id": scaffold.je_id, "occurred_at": "2026-06-10T10:30:00"
            },
            "entities": [{ "handle": "@priya", "type": "person", "name": "Priya" }],
            "links": [{
                "kind": "journal_ref", "from": "@je", "to": "@priya",
                "append_text": "Looped in Priya directly afterwards."
            }]
        });

        let outcome = apply_intent_graph_proposal(
            &pool,
            scaffold.run_id,
            &scaffold.proposal_id,
            &scaffold.tool_call_id,
            &payload,
            None,
            None,
            |a| a.to_string(),
            crate::db::now_ms(),
        )
        .await
        .expect("append-mode anchor-reuse applies even when the label is in the prose");
        match outcome {
            IntentGraphOutcome::Applied(anchor) => assert_eq!(anchor, scaffold.je_id),
            IntentGraphOutcome::RejectedAll => panic!("expected Applied"),
        }

        // (a) a backlink row J → priya exists; still exactly ONE journal_entry row.
        let priya = person_id_named(&pool, "Priya").await.expect("Priya minted");
        assert_eq!(entity_ref_count(&pool, &scaffold.je_id, &priya).await, 1);
        let (je_rows, _) = je_row_and_revision_counts(&pool, &scaffold.je_id).await;
        assert_eq!(je_rows, 1, "no new journal_entry row was minted");

        // (b) exactly ONE entity_ref chip lives in the body…
        let body = current_je_body(&pool, &scaffold.je_id).await;
        let chip_count =
            body.iter().filter(|n| n.get("type").and_then(|t| t.as_str()) == Some("entity_ref")).count();
        assert_eq!(chip_count, 1, "exactly one chip — the front-scan bug would still be one chip, so position is what matters");
        let chip_ref_id = body
            .iter()
            .find_map(|n| n.get("ref_id").and_then(serde_json::Value::as_str))
            .expect("a chip with a ref_id");

        // (c) the ORIGINAL prose node is byte-identical and un-chipped — the head is the
        //     whole "Met with Priya's manager about Q3" string, NOT split around a chip,
        //     and NOT mutated (the join-space rides on the clause's leading node, below).
        //     This is what the front-scan impl would FAIL: it would split this node.
        assert_eq!(
            body[0],
            serde_json::json!({ "type": "text", "text": "Met with Priya's manager about Q3" }),
            "the original prose stays byte-identical, the 'Priya' in it is NOT chipped"
        );

        // (d) the chip sits INSIDE the appended clause region (the body tail), with the
        //     surrounding clause text split byte-faithfully around it. The separating space
        //     is folded onto the clause's leading node, so the tail opens " Looped in ".
        assert_eq!(
            body,
            vec![
                serde_json::json!({ "type": "text", "text": "Met with Priya's manager about Q3" }),
                serde_json::json!({ "type": "text", "text": " Looped in " }),
                serde_json::json!({ "type": "entity_ref", "ref_id": chip_ref_id }),
                serde_json::json!({ "type": "text", "text": " directly afterwards." }),
            ]
        );
    }

    // Test — anchor-reuse APPEND whose clause OPENS with the entity's name (#221): a
    // legitimate clause like "Priya was also there." (label is the first token). The
    // separating space must NOT become a standalone `{text:" "}` node (which
    // `validate_woven_journal_body` rejects → whole tx rolls back) — it is folded onto
    // the existing prose's trailing text node instead, so the clause splices cleanly to
    // `[chip][" was also there."]` and the apply SUCCEEDS.
    #[tokio::test]
    async fn anchor_reuse_append_text_label_leading_clause_applies() {
        let pool = memory_pool().await;
        let original_head = serde_json::json!({ "type": "text", "text": "stand-up notes" });
        let scaffold = seed_anchor_reuse(&pool, serde_json::json!([original_head])).await;
        let payload = serde_json::json!({
            "journal_entry": {
                "handle": "@je", "existing_id": scaffold.je_id, "occurred_at": "2026-06-10T10:30:00"
            },
            "entities": [{ "handle": "@priya", "type": "person", "name": "Priya" }],
            "links": [{
                "kind": "journal_ref", "from": "@je", "to": "@priya",
                "append_text": "Priya was also there."
            }]
        });

        let outcome = apply_intent_graph_proposal(
            &pool,
            scaffold.run_id,
            &scaffold.proposal_id,
            &scaffold.tool_call_id,
            &payload,
            None,
            None,
            |a| a.to_string(),
            crate::db::now_ms(),
        )
        .await
        .expect("a clause that opens with the entity name applies (no standalone-space rejection)");
        assert!(matches!(outcome, IntentGraphOutcome::Applied(_)));

        let priya = person_id_named(&pool, "Priya").await.expect("Priya minted");
        assert_eq!(entity_ref_count(&pool, &scaffold.je_id, &priya).await, 1);
        let body = current_je_body(&pool, &scaffold.je_id).await;
        let chip_ref_id = body
            .iter()
            .find_map(|n| n.get("ref_id").and_then(serde_json::Value::as_str))
            .expect("a chip with a ref_id");
        // The separator rides on the prose head ("stand-up notes "), the chip leads the
        // clause, and no `{text:" "}` node exists (which would have rolled the tx back).
        assert_eq!(
            body,
            vec![
                serde_json::json!({ "type": "text", "text": "stand-up notes " }),
                serde_json::json!({ "type": "entity_ref", "ref_id": chip_ref_id }),
                serde_json::json!({ "type": "text", "text": " was also there." }),
            ]
        );
    }

    // Test — anchor-reuse APPEND onto a stored body that ALREADY ENDS in a chip (#221):
    // an earlier mention was chipped at the end of the prose ("…synced with [chip]"),
    // and now a new entity is folded in by appending. The separator must NOT be lost at
    // the chip→clause boundary (a "welding" regression): for a label-mid clause it folds
    // onto the CLAUSE's leading text node, so the new clause still opens with a space and
    // does not abut the prior chip.
    #[tokio::test]
    async fn anchor_reuse_append_text_after_chip_trailing_body_keeps_separator() {
        let pool = memory_pool().await;
        // A stored body whose LAST node is an entity_ref chip (an end-of-prose mention).
        let stored = serde_json::json!([
            { "type": "text", "text": "synced with " },
            { "type": "entity_ref", "ref_id": "019f0000-0000-7000-8000-0000000000aa" },
        ]);
        let scaffold = seed_anchor_reuse(&pool, stored).await;
        let payload = serde_json::json!({
            "journal_entry": {
                "handle": "@je", "existing_id": scaffold.je_id, "occurred_at": "2026-06-10T10:30:00"
            },
            "entities": [{ "handle": "@priya", "type": "person", "name": "Priya" }],
            "links": [{
                "kind": "journal_ref", "from": "@je", "to": "@priya",
                "append_text": "Looped in Priya too."
            }]
        });

        let outcome = apply_intent_graph_proposal(
            &pool,
            scaffold.run_id,
            &scaffold.proposal_id,
            &scaffold.tool_call_id,
            &payload,
            None,
            None,
            |a| a.to_string(),
            crate::db::now_ms(),
        )
        .await
        .expect("append onto a chip-trailing body applies");
        assert!(matches!(outcome, IntentGraphOutcome::Applied(_)));

        let priya = person_id_named(&pool, "Priya").await.expect("Priya minted");
        let body = current_je_body(&pool, &scaffold.je_id).await;
        let new_chip_ref_id = body
            .iter()
            .filter_map(|n| n.get("ref_id").and_then(serde_json::Value::as_str))
            .find(|id| *id != "019f0000-0000-7000-8000-0000000000aa")
            .expect("the new chip");
        // The clause folds the separator onto ITS OWN leading node (" Looped in "), so the
        // prior trailing chip is followed by a space-led clause, never welded.
        assert_eq!(
            body,
            vec![
                serde_json::json!({ "type": "text", "text": "synced with " }),
                serde_json::json!({ "type": "entity_ref", "ref_id": "019f0000-0000-7000-8000-0000000000aa" }),
                serde_json::json!({ "type": "text", "text": " Looped in " }),
                serde_json::json!({ "type": "entity_ref", "ref_id": new_chip_ref_id }),
                serde_json::json!({ "type": "text", "text": " too." }),
            ]
        );
        assert_eq!(entity_ref_count(&pool, &scaffold.je_id, &priya).await, 1);
    }

    // Test — anchor-reuse APPEND of a LABEL-LEADING clause onto a CHIP-TRAILING body
    // (#221, the chip↔chip boundary `join_with_separator` deliberately leaves
    // unseparated): the stored body ends in a chip AND the clause opens with the entity
    // name, so neither side has a text node to carry the join space. Core must NOT emit a
    // standalone `{text:" "}` node (it would roll the tx back); the two chips sit adjacent
    // and inter-chip spacing is the renderer's concern. The apply still SUCCEEDS.
    #[tokio::test]
    async fn anchor_reuse_append_label_leading_after_chip_trailing_body_applies() {
        let pool = memory_pool().await;
        let stored = serde_json::json!([
            { "type": "text", "text": "saw " },
            { "type": "entity_ref", "ref_id": "019f0000-0000-7000-8000-0000000000bb" },
        ]);
        let scaffold = seed_anchor_reuse(&pool, stored).await;
        let payload = serde_json::json!({
            "journal_entry": {
                "handle": "@je", "existing_id": scaffold.je_id, "occurred_at": "2026-06-10T10:30:00"
            },
            "entities": [{ "handle": "@priya", "type": "person", "name": "Priya" }],
            "links": [{
                "kind": "journal_ref", "from": "@je", "to": "@priya",
                "append_text": "Priya joined late."
            }]
        });

        let outcome = apply_intent_graph_proposal(
            &pool,
            scaffold.run_id,
            &scaffold.proposal_id,
            &scaffold.tool_call_id,
            &payload,
            None,
            None,
            |a| a.to_string(),
            crate::db::now_ms(),
        )
        .await
        .expect("label-leading clause onto a chip-trailing body applies (no standalone-space node)");
        assert!(matches!(outcome, IntentGraphOutcome::Applied(_)));

        let body = current_je_body(&pool, &scaffold.je_id).await;
        // No `{type:text, text:" "}` node exists anywhere (it would have failed validation).
        assert!(
            !body.iter().any(|n| n.get("text").and_then(serde_json::Value::as_str) == Some(" ")),
            "no standalone separator node",
        );
        let new_chip_ref_id = body
            .iter()
            .filter_map(|n| n.get("ref_id").and_then(serde_json::Value::as_str))
            .find(|id| *id != "019f0000-0000-7000-8000-0000000000bb")
            .expect("the new chip");
        // The prior trailing chip is followed directly by the clause's leading chip (the
        // chip↔chip boundary), then the clause tail. No join space between the two chips.
        assert_eq!(
            body,
            vec![
                serde_json::json!({ "type": "text", "text": "saw " }),
                serde_json::json!({ "type": "entity_ref", "ref_id": "019f0000-0000-7000-8000-0000000000bb" }),
                serde_json::json!({ "type": "entity_ref", "ref_id": new_chip_ref_id }),
                serde_json::json!({ "type": "text", "text": " joined late." }),
            ]
        );
    }

    // Test — anchor-reuse APPEND of an already-space-led clause (#221): the model emits
    // `append_text` that already opens with a space. Core trims the incidental whitespace
    // (it owns the join space), so the result is a SINGLE leading space, not "  Followed".
    #[tokio::test]
    async fn anchor_reuse_append_text_already_spaced_clause_is_not_double_spaced() {
        let pool = memory_pool().await;
        let original_head = serde_json::json!({ "type": "text", "text": "morning sync" });
        let scaffold = seed_anchor_reuse(&pool, serde_json::json!([original_head])).await;
        let payload = serde_json::json!({
            "journal_entry": {
                "handle": "@je", "existing_id": scaffold.je_id, "occurred_at": "2026-06-10T10:30:00"
            },
            "entities": [{ "handle": "@priya", "type": "person", "name": "Priya" }],
            "links": [{
                "kind": "journal_ref", "from": "@je", "to": "@priya",
                // NOTE the leading space the model already supplied.
                "append_text": " Followed up with Priya."
            }]
        });

        let outcome = apply_intent_graph_proposal(
            &pool,
            scaffold.run_id,
            &scaffold.proposal_id,
            &scaffold.tool_call_id,
            &payload,
            None,
            None,
            |a| a.to_string(),
            crate::db::now_ms(),
        )
        .await
        .expect("an already-spaced clause applies");
        assert!(matches!(outcome, IntentGraphOutcome::Applied(_)));

        let body = current_je_body(&pool, &scaffold.je_id).await;
        let chip_ref_id = body
            .iter()
            .find_map(|n| n.get("ref_id").and_then(serde_json::Value::as_str))
            .expect("a chip");
        // Exactly ONE leading space on the clause's first node — not two.
        assert_eq!(
            body,
            vec![
                serde_json::json!({ "type": "text", "text": "morning sync" }),
                serde_json::json!({ "type": "text", "text": " Followed up with " }),
                serde_json::json!({ "type": "entity_ref", "ref_id": chip_ref_id }),
                serde_json::json!({ "type": "text", "text": "." }),
            ]
        );
    }

    // Test — anchor-reuse APPEND of a clause that BOTH leads with whitespace AND opens
    // with the label (#221, CodeRabbit): `" Priya was also there."`. Without the trim,
    // the splice on "Priya" yields a `before = " "` standalone whitespace node that
    // `validate_woven_journal_body` rejects → tx rollback. Core trims the clause first,
    // so it applies cleanly and the join space rides on the prose head ("morning sync ").
    #[tokio::test]
    async fn anchor_reuse_append_text_leading_space_and_label_leading_applies() {
        let pool = memory_pool().await;
        let original_head = serde_json::json!({ "type": "text", "text": "morning sync" });
        let scaffold = seed_anchor_reuse(&pool, serde_json::json!([original_head])).await;
        let payload = serde_json::json!({
            "journal_entry": {
                "handle": "@je", "existing_id": scaffold.je_id, "occurred_at": "2026-06-10T10:30:00"
            },
            "entities": [{ "handle": "@priya", "type": "person", "name": "Priya" }],
            "links": [{
                "kind": "journal_ref", "from": "@je", "to": "@priya",
                // Leading space AND the label leads the clause — the rejected-node case.
                "append_text": " Priya was also there."
            }]
        });

        let outcome = apply_intent_graph_proposal(
            &pool,
            scaffold.run_id,
            &scaffold.proposal_id,
            &scaffold.tool_call_id,
            &payload,
            None,
            None,
            |a| a.to_string(),
            crate::db::now_ms(),
        )
        .await
        .expect("a leading-space label-leading clause applies (trimmed, no standalone-space node)");
        assert!(matches!(outcome, IntentGraphOutcome::Applied(_)));

        let body = current_je_body(&pool, &scaffold.je_id).await;
        assert!(
            !body.iter().any(|n| n.get("text").and_then(serde_json::Value::as_str) == Some(" ")),
            "no standalone separator node",
        );
        let chip_ref_id = body
            .iter()
            .find_map(|n| n.get("ref_id").and_then(serde_json::Value::as_str))
            .expect("a chip");
        // The clause trims to "Priya was also there."; the chip leads it, and the join
        // space folds onto the prose head ("morning sync ").
        assert_eq!(
            body,
            vec![
                serde_json::json!({ "type": "text", "text": "morning sync " }),
                serde_json::json!({ "type": "entity_ref", "ref_id": chip_ref_id }),
                serde_json::json!({ "type": "text", "text": " was also there." }),
            ]
        );
    }

    // Test — XOR reject (BOTH): a journal_ref carrying both match_text AND append_text
    // is InvalidMutation; the tx rolls back (no Person, no new revision).
    #[tokio::test]
    async fn anchor_reuse_journal_ref_both_placements_reject() {
        let pool = memory_pool().await;
        let original_body =
            serde_json::json!([{ "type": "text", "text": "synced with Priya today" }]);
        let scaffold = seed_anchor_reuse(&pool, original_body.clone()).await;
        let payload = serde_json::json!({
            "journal_entry": {
                "handle": "@je", "existing_id": scaffold.je_id, "occurred_at": "2026-06-10T10:30:00"
            },
            "entities": [{ "handle": "@priya", "type": "person", "name": "Priya" }],
            "links": [{
                "kind": "journal_ref", "from": "@je", "to": "@priya",
                "match_text": "Priya", "append_text": "Followed up with Priya."
            }]
        });
        let result = apply_intent_graph_proposal(
            &pool,
            scaffold.run_id,
            &scaffold.proposal_id,
            &scaffold.tool_call_id,
            &payload,
            None,
            None,
            |a| a.to_string(),
            crate::db::now_ms(),
        )
        .await;
        match result {
            Err(ApplyError::InvalidMutation(_)) => {}
            other => panic!("expected InvalidMutation, got {:?}", other.err()),
        }
        assert!(person_id_named(&pool, "Priya").await.is_none(), "no Person minted");
        let (_, revisions) = je_row_and_revision_counts(&pool, &scaffold.je_id).await;
        assert_eq!(revisions, 1, "the rolled-back both-set apply writes no revision");
    }

    // Test — XOR reject (NEITHER): a journal_ref carrying neither match_text nor
    // append_text is InvalidMutation; the tx rolls back.
    #[tokio::test]
    async fn anchor_reuse_journal_ref_no_placement_reject() {
        let pool = memory_pool().await;
        let original_body =
            serde_json::json!([{ "type": "text", "text": "synced with Priya today" }]);
        let scaffold = seed_anchor_reuse(&pool, original_body.clone()).await;
        let payload = serde_json::json!({
            "journal_entry": {
                "handle": "@je", "existing_id": scaffold.je_id, "occurred_at": "2026-06-10T10:30:00"
            },
            "entities": [{ "handle": "@priya", "type": "person", "name": "Priya" }],
            "links": [{ "kind": "journal_ref", "from": "@je", "to": "@priya" }]
        });
        let result = apply_intent_graph_proposal(
            &pool,
            scaffold.run_id,
            &scaffold.proposal_id,
            &scaffold.tool_call_id,
            &payload,
            None,
            None,
            |a| a.to_string(),
            crate::db::now_ms(),
        )
        .await;
        match result {
            Err(ApplyError::InvalidMutation(_)) => {}
            other => panic!("expected InvalidMutation, got {:?}", other.err()),
        }
        assert!(person_id_named(&pool, "Priya").await.is_none(), "no Person minted");
        let (_, revisions) = je_row_and_revision_counts(&pool, &scaffold.je_id).await;
        assert_eq!(revisions, 1, "the rolled-back neither-set apply writes no revision");
    }

    // ─── plan/decide exact-match agreement (shared-core lock) ──────────────
    //
    // These two tests pin the property the resolve_plan_disposition doc used to
    // merely PROMISE in prose ("mirrors resolve_disposition's natural path"):
    // what proposal/get shows at review time is what the decide-time apply does.
    // They run the plan (pool read) AND the apply (in-tx resolution) against the
    // same seeded state and assert the two resolvers agree — reuse resolves the
    // SAME id; ambiguous fails the apply as InvalidMutation.

    /// Seed the run/proposal scaffold for a DIRECT-CAPTURE graph apply (no JE
    /// node) so the agreement tests can drive `apply_intent_graph_proposal`
    /// with an arbitrary payload. Reuses the anchor-reuse scaffold; the JE it
    /// seeds is simply unused by a JE-less payload.
    async fn seed_direct_capture(pool: &sqlx::SqlitePool) -> Scaffold {
        seed_anchor_reuse(pool, serde_json::json!([])).await
    }

    #[tokio::test]
    async fn plan_and_decide_agree_on_reuse() {
        let pool = memory_pool().await;
        let ana = insert_named(&pool, "person", "Ana").await;
        // Whitespace + case differences must normalize away in BOTH resolvers.
        // A fresh `@bob` rides along: a reuse-ONLY graph mints nothing and has
        // no anchor (a documented loud failure), so the minted node keeps the
        // apply on its happy path while `@ana` exercises the reuse agreement.
        let payload = serde_json::json!({
            "entities": [
                { "handle": "@ana", "type": "person", "name": "  ana " },
                { "handle": "@bob", "type": "person", "name": "Bob" }
            ],
            "links": []
        });

        // Plan side: proposal/get's badge says `reuse` of the accepted id.
        let plan = resolved_plan_for(&pool, &payload).await.unwrap();
        assert_eq!(plan.len(), 2);
        let ana_node = &plan[node(&plan, "@ana")];
        assert_eq!(ana_node.disposition, "reuse");
        assert_eq!(ana_node.entity_id.as_deref(), Some(ana.as_str()));
        assert_eq!(plan[node(&plan, "@bob")].disposition, "create");

        // Decide side: the apply resolves the SAME id — no second person row.
        let scaffold = seed_direct_capture(&pool).await;
        let outcome = apply_intent_graph_proposal(
            &pool,
            scaffold.run_id,
            &scaffold.proposal_id,
            &scaffold.tool_call_id,
            &payload,
            None,
            None,
            |anchor| format!("anchor:{anchor}"),
            crate::db::now_ms(),
        )
        .await
        .expect("reuse+create apply succeeds");
        // The agreement assertion is on the ROWS: still exactly ONE Ana (the
        // pre-existing row was reused), while Bob minted fresh.
        drop(outcome);
        let ana_rows: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM entities WHERE type = 'person' \
             AND LOWER(TRIM(json_extract(data, '$.name'))) = 'ana'",
        )
        .fetch_one(&pool)
        .await
        .expect("count anas");
        assert_eq!(ana_rows, 1, "decide reused the accepted Ana; no second row");
        assert_eq!(
            person_id_named(&pool, "Ana").await.as_deref(),
            Some(ana.as_str()),
            "the surviving row is the pre-seeded one"
        );
    }

    #[tokio::test]
    async fn plan_and_decide_agree_on_ambiguous() {
        let pool = memory_pool().await;
        insert_named(&pool, "person", "Ana").await;
        insert_named(&pool, "person", "ana").await;
        let payload = serde_json::json!({
            "entities": [{ "handle": "@ana", "type": "person", "name": "Ana" }],
            "links": []
        });

        // Plan side: two exact matches → `ambiguous`, candidates carried.
        let plan = resolved_plan_for(&pool, &payload).await.unwrap();
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].disposition, "ambiguous");
        assert_eq!(
            plan[0].candidates.as_ref().map(Vec::len),
            Some(2),
            "both competing rows surface as candidates"
        );

        // Decide side: the SAME two matches fail the apply — InvalidMutation,
        // nothing minted (tx rolled back).
        let scaffold = seed_direct_capture(&pool).await;
        let result = apply_intent_graph_proposal(
            &pool,
            scaffold.run_id,
            &scaffold.proposal_id,
            &scaffold.tool_call_id,
            &payload,
            None,
            None,
            |anchor| format!("anchor:{anchor}"),
            crate::db::now_ms(),
        )
        .await;
        match result {
            Err(ApplyError::InvalidMutation(_)) => {}
            other => panic!(
                "ambiguous at decide must be a loud InvalidMutation, got {:?}",
                other.map(|_| "Applied/RejectedAll").err()
            ),
        }
    }
}
