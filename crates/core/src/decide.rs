//! Idempotent Decision-application for `proposal/decide` (ADR-0025, ADR-0016).
//!
//! [`apply`] owns the whole transaction: idempotency precedence, the guarded
//! apply/reject (lost race → [`DecideError::LostRace`]), and one trailing resume
//! gate. The `resume` seam is a closure so this module takes no `worker`
//! dependency (ADR-0026). Mutation dispatch stays behind [`crate::entities`].

use sqlx::SqlitePool;
use uuid::Uuid;

use crate::db::{self, RunStatus};
use crate::entities;
use crate::mutation::{self, MutationKind, ProposableMutation};
use crate::protocol::NodeDecision;

/// The user's resolution of a Proposal, parsed from the wire `decision` string.
/// An `edit`'s payload-presence is enforced later (fresh apply path), not here.
enum Decision {
    Accept,
    Reject,
    Edit,
}

/// A successful decide: accepted (an Entity landed) or rejected. Both carry the
/// `run_id` so the handler can push `proposal/changed` without re-reading it.
#[derive(Debug)]
pub enum DecideOutcome {
    Accepted { run_id: Uuid, entity_id: String },
    Rejected { run_id: Uuid },
}

/// The decide failure vocabulary. The handler maps each to a wire code:
/// `LostRace`/`NotDecidable` → `-32002`, `Invalid` → `-32602`, `Internal` →
/// `-32603`.
#[derive(Debug)]
pub enum DecideError {
    /// The guarded apply/reject flip affected 0 rows — a concurrent decide won.
    LostRace,
    /// The Proposal cannot be decided in its current state (unknown id, already
    /// decided and not recoverable, or its Run is not parked).
    NotDecidable(String),
    /// Invalid inputs (unknown decision, edit without payload, or the applied
    /// payload fails mutation validation).
    Invalid(String),
    /// A DB error or inconsistency. Logged server-side; never surfaced verbatim.
    Internal(anyhow::Error),
}

/// Apply a Decision on a Proposal (ADR-0025, ADR-0016), then re-drive resume if
/// the Run is still parked:
///
/// 1. parse the `decision` string (unknown → `Invalid`);
/// 2. load the Proposal (unknown id → `NotDecidable`);
/// 3. compute the outcome — keyed replay, else already-decided
///    recovery-if-still-parked, else a fresh guarded apply/reject;
/// 4. one trailing resume gate: if the Run still reads `parked`, re-drive the
///    injected `resume` (a no-op once the Run advanced).
///
/// `worker::resume` self-guards the `parked → running` flip, so the gate is safe
/// to fire whenever the Run reads `parked`.
#[allow(clippy::too_many_arguments)]
pub async fn apply<F, Fut>(
    pool: &SqlitePool,
    proposal_id: Uuid,
    decision: &str,
    edited_payload: Option<serde_json::Value>,
    decisions: Option<Vec<NodeDecision>>,
    idempotency_key: Option<String>,
    resume: F,
) -> Result<DecideOutcome, DecideError>
where
    F: FnOnce(Uuid) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<()>>,
{
    let decision = parse_decision(decision)?;
    let proposal_id = proposal_id.to_string();

    let proposal = db::load_proposal_for_decide(pool, &proposal_id)
        .await
        .map_err(|e| DecideError::Internal(e.into()))?
        .ok_or_else(|| DecideError::NotDecidable(format!("no proposal {proposal_id}")))?;

    // Resolve the stored `mutation_kind` once (the single string→type point on the
    // agent path). An unknown stored kind is corrupt data Core itself wrote — a
    // LOUD `Internal`, not a client `Invalid` (the propose schema cannot emit one).
    let kind = MutationKind::from_wire(&proposal.mutation_kind).ok_or_else(|| {
        DecideError::Internal(anyhow::anyhow!(
            "stored proposal mutation_kind {:?} is not a known kind",
            proposal.mutation_kind
        ))
    })?;

    let outcome = compute_outcome(
        pool,
        &proposal_id,
        &proposal,
        kind,
        &decision,
        edited_payload.as_ref(),
        decisions.as_deref(),
        idempotency_key.as_deref(),
    )
    .await?;

    // Single resume gate, reached only on the Ok path.
    if run_is_parked(pool, proposal.run_id).await? {
        resume(proposal.run_id)
            .await
            .map_err(DecideError::Internal)?;
    }

    Ok(outcome)
}

/// Parse the wire `decision` string; unknown → [`DecideError::Invalid`]. Only
/// the string — an `edit`'s payload-presence is deferred to [`apply_or_reject`]
/// so a payload-less `edit` retry still replays/recovers rather than erroring.
fn parse_decision(decision: &str) -> Result<Decision, DecideError> {
    match decision {
        "accept" => Ok(Decision::Accept),
        "reject" => Ok(Decision::Reject),
        "edit" => Ok(Decision::Edit),
        other => Err(DecideError::Invalid(format!(
            "decision {other:?} not implemented"
        ))),
    }
}

/// The decide precedence (ADR-0025):
///
/// 1. **Keyed replay** — a repeat decide with the SAME recorded key returns the
///    prior result (any Run status), no re-apply.
/// 2. **Already decided** without a key match — return the prior result if the
///    Run is still parked (recovery; trailing gate re-resumes), else not
///    decidable.
/// 3. **Pending** — the Run must be parked, then apply/reject under the guard.
///
/// Steps 1–2 never inspect `edited_payload`, so a payload-less retry/replay
/// recovers rather than erroring.
#[allow(clippy::too_many_arguments)]
async fn compute_outcome(
    pool: &SqlitePool,
    proposal_id: &str,
    proposal: &db::DecidableProposal,
    kind: MutationKind,
    decision: &Decision,
    edited_payload: Option<&serde_json::Value>,
    decisions: Option<&[NodeDecision]>,
    idempotency_key: Option<&str>,
) -> Result<DecideOutcome, DecideError> {
    if let Some(recorded) = proposal.decision_idempotency_key.as_deref()
        && idempotency_key == Some(recorded)
    {
        return prior_outcome(pool, proposal_id, proposal, kind).await;
    }

    if proposal.status != "pending" {
        if (proposal.status == "accepted" || proposal.status == "rejected")
            && run_is_parked(pool, proposal.run_id).await?
        {
            return prior_outcome(pool, proposal_id, proposal, kind).await;
        }
        return Err(DecideError::NotDecidable(format!(
            "proposal {proposal_id} is {} (not pending)",
            proposal.status
        )));
    }

    if !run_is_parked(pool, proposal.run_id).await? {
        return Err(DecideError::NotDecidable(format!(
            "run {} is not parked",
            proposal.run_id
        )));
    }

    apply_or_reject(
        pool,
        proposal_id,
        proposal,
        kind,
        decision,
        edited_payload,
        decisions,
        idempotency_key,
    )
    .await
}

/// The prior result of an already-decided Proposal: `rejected` → `Rejected`;
/// `accepted` → its created `entity_id`. An accepted Proposal with no Entity is
/// a DB inconsistency → `Internal`. Only reached for accepted/rejected.
async fn prior_outcome(
    pool: &SqlitePool,
    proposal_id: &str,
    proposal: &db::DecidableProposal,
    kind: MutationKind,
) -> Result<DecideOutcome, DecideError> {
    match proposal.status.as_str() {
        "rejected" => Ok(DecideOutcome::Rejected {
            run_id: proposal.run_id,
        }),
        "accepted" => {
            let entity_id = db::entity_id_for_proposal(pool, proposal_id)
                .await
                .map_err(|e| DecideError::Internal(e.into()))?
                .or_else(|| {
                    mutation::target_entity_id(kind.describe(), &proposal.payload)
                        .map(str::to_string)
                })
                .ok_or_else(|| {
                    DecideError::Internal(anyhow::anyhow!(
                        "accepted proposal {proposal_id} has no entity"
                    ))
                })?;
            Ok(DecideOutcome::Accepted {
                run_id: proposal.run_id,
                entity_id,
            })
        }
        other => Err(DecideError::Internal(anyhow::anyhow!(
            "prior outcome for proposal {proposal_id} with unexpected status {other}"
        ))),
    }
}

/// The fresh guarded transaction: render the Decision as the awaited tool's
/// result, validate accept/edit (not reject) via [`crate::entities`], then one
/// atomic [`db::apply_proposal`] / [`db::reject_proposal`]. `NotPending` →
/// `LostRace`; `InvalidMutation` → `Invalid`; `Sql` → `Internal`. Also where an
/// `edit` without an `edited_payload` is rejected as `Invalid` (late, so the
/// recovery branches upstream never depend on the retry carrying a payload).
#[allow(clippy::too_many_arguments)]
async fn apply_or_reject(
    pool: &SqlitePool,
    proposal_id: &str,
    proposal: &db::DecidableProposal,
    kind: MutationKind,
    decision: &Decision,
    edited_payload: Option<&serde_json::Value>,
    decisions: Option<&[NodeDecision]>,
    idempotency_key: Option<&str>,
) -> Result<DecideOutcome, DecideError> {
    let run_id = proposal.run_id;

    if matches!(decision, Decision::Reject) {
        // A decline renders as a NORMAL (non-error) tool result so the resumed
        // model continues conversationally. A reject touches no entity store and
        // needs no `ProposableMutation` — even a (should-be-impossible) non-
        // proposable stored kind can still be declined cleanly.
        let decision_payload = serde_json::json!({
            "decision": "reject",
            "content": "User declined this proposal.",
            "is_error": false,
        })
        .to_string();
        return match db::reject_proposal(
            pool,
            run_id,
            proposal_id,
            &proposal.tool_call_id,
            idempotency_key,
            &decision_payload,
            db::now_ms(),
        )
        .await
        {
            Ok(()) => Ok(DecideOutcome::Rejected { run_id }),
            Err(db::ApplyError::InvalidMutation(reason)) => Err(DecideError::Invalid(reason)),
            Err(db::ApplyError::NotPending) => Err(DecideError::LostRace),
            // `reject_proposal` touches no entity store (it only flips the
            // proposal status + resolves the tool_call), so it can NEVER return
            // TargetMissing — a reject is never wedged by a deleted target. The
            // arm exists solely for match exhaustiveness.
            Err(db::ApplyError::TargetMissing) => {
                unreachable!("reject_proposal never touches an entity, so cannot miss a target")
            }
            Err(db::ApplyError::Sql(e)) => Err(DecideError::Internal(e.into())),
        };
    }

    // Accept or edit: this is the agent ACCEPT path, so the kind must be
    // agent-proposable. A stored kind that is not (mark_project_reviewed /
    // bookmark — the propose schema cannot emit them) is a graceful `Invalid`,
    // replacing the former render_accept panic. Done AFTER the reject branch so a
    // corrupt proposal can still be rejected.
    let proposable = ProposableMutation::try_from(kind)
        .map_err(|e| DecideError::Invalid(format!("{} cannot be proposed", e.0.as_wire())))?;

    // The intent graph (ADR-0042) is not a single-entity mutation, so it takes a
    // SIBLING apply path (`db::apply_intent_graph_proposal`) rather than
    // `db::apply_proposal`. It does not support the whole-payload `edit` verb
    // (`supports_edit` is false) — corrections ride the per-node decision vector
    // (slice 5). An `edit` decision is rejected loud HERE: the generic
    // `supports_edit` gate sits below this early return, so without this check an
    // edit would silently degrade to a plain accept with the `edited_payload`
    // dropped. The structural validate gate (graph shape) still runs inside
    // `apply_intent_graph`; the run-independent target check is a no-op for the
    // graph in slice 2 (links land in slice 4).
    if kind == MutationKind::ApplyIntentGraph {
        if matches!(decision, Decision::Edit) {
            return Err(DecideError::Invalid(
                "apply_intent_graph does not support edit".to_string(),
            ));
        }
        return apply_intent_graph(
            pool,
            proposal,
            proposal_id,
            proposable,
            decisions,
            idempotency_key,
        )
        .await;
    }

    // An `edit` requires an `edited_payload` (absence → `Invalid`, checked here so
    // a payload-less retry replays via the branches above); a plain accept ignores
    // any wire payload. The applied payload is the edited one for an edit, else the
    // proposed payload; validate it first.
    if matches!(decision, Decision::Edit) && !proposable.supports_edit() {
        return Err(DecideError::Invalid(format!(
            "{} does not support edit",
            proposal.mutation_kind
        )));
    }

    let edited_payload = match decision {
        Decision::Edit => match edited_payload {
            Some(payload) => Some(preserve_update_target_entity_id(
                kind,
                &proposal.payload,
                payload,
            )?),
            None => {
                return Err(DecideError::Invalid(
                    "edit requires edited_payload".to_string(),
                ));
            }
        },
        _ => None,
    };
    let edited_payload = edited_payload.as_ref();
    let applied_payload = edited_payload.unwrap_or(&proposal.payload);

    entities::validate(kind, applied_payload).map_err(DecideError::Invalid)?;
    validate_mutation_target(pool, proposal.run_id, kind, applied_payload).await?;

    match db::apply_proposal(
        pool,
        run_id,
        proposal_id,
        &proposal.tool_call_id,
        kind,
        mutation::target_entity_id(kind.describe(), applied_payload),
        &proposal.payload,
        edited_payload,
        kind.describe().write_op.source_relation(),
        idempotency_key,
        |entity_id| {
            serde_json::json!({
                "decision": "accept",
                "content": entities::render_accept(proposable, applied_payload, Some(entity_id)),
            })
            .to_string()
        },
        db::now_ms(),
    )
    .await
    {
        Ok(entity_id) => Ok(DecideOutcome::Accepted { run_id, entity_id }),
        Err(db::ApplyError::InvalidMutation(reason)) => Err(DecideError::Invalid(reason)),
        Err(db::ApplyError::NotPending) => Err(DecideError::LostRace),
        // A user deleted the target Entity out from under this parked Proposal
        // (ADR-0033). Surface NotDecidable (-32002, "no longer pending") so the
        // parked Run resolves cleanly, not an opaque Internal (-32603).
        Err(db::ApplyError::TargetMissing) => Err(DecideError::NotDecidable(
            "proposal target no longer exists".to_string(),
        )),
        Err(db::ApplyError::Sql(e)) => Err(DecideError::Internal(e.into())),
    }
}

/// The intent-graph accept path (ADR-0042): structurally validate the stored
/// graph, then resolve+apply it in one transaction via
/// [`db::apply_intent_graph_proposal`] (the sibling of `apply_proposal` for the
/// not-a-single-entity kind). Mirrors `apply_or_reject`'s `ApplyError` →
/// `DecideError` mapping; any failure rolls the whole tx back, so a graph that is
/// broken at commit time writes nothing. The reported `entity_id` is the JE
/// anchor (or the first created entity for a JE-less direct-capture graph).
async fn apply_intent_graph(
    pool: &SqlitePool,
    proposal: &db::DecidableProposal,
    proposal_id: &str,
    proposable: ProposableMutation,
    decisions: Option<&[NodeDecision]>,
    idempotency_key: Option<&str>,
) -> Result<DecideOutcome, DecideError> {
    let run_id = proposal.run_id;
    let kind = MutationKind::ApplyIntentGraph;

    // Decide-time structural gate (ADR-0042 "Validation: receipt + decide"): the
    // graph shape (optional journal_entry, >= 1 entity nodes, the link kinds) is
    // checked before the tx opens. The cross-node graph invariants (handle
    // references, duplicate handles, journal_ref-without-journal_entry) are the
    // resolver's pre-checks.
    entities::validate(kind, &proposal.payload).map_err(DecideError::Invalid)?;
    // Run-independent target-ref check — a no-op for the graph (it has no single
    // target; link endpoints are validated inside the resolver against the
    // surviving node set, see the cascade below).
    validate_mutation_target(pool, run_id, kind, &proposal.payload).await?;

    match db::apply_intent_graph_proposal(
        pool,
        run_id,
        proposal_id,
        &proposal.tool_call_id,
        &proposal.payload,
        decisions,
        idempotency_key,
        |entity_id| {
            serde_json::json!({
                "decision": "accept",
                "content": entities::render_accept(proposable, &proposal.payload, Some(entity_id)),
            })
            .to_string()
        },
        db::now_ms(),
    )
    .await
    {
        // The decision vector accepted at least one node — the anchor is the JE
        // (or the first created entity for a JE-less graph).
        Ok(db::IntentGraphOutcome::Applied(entity_id)) => {
            Ok(DecideOutcome::Accepted { run_id, entity_id })
        }
        // The decision vector rejected EVERY node (ADR-0042: a vector rejecting all
        // nodes is effectively a `reject`). The resolver flipped the Proposal
        // rejected and resolved the tool call as a decline; nothing was minted.
        Ok(db::IntentGraphOutcome::RejectedAll) => Ok(DecideOutcome::Rejected { run_id }),
        Err(db::ApplyError::InvalidMutation(reason)) => Err(DecideError::Invalid(reason)),
        Err(db::ApplyError::NotPending) => Err(DecideError::LostRace),
        // A link to a node REJECTED by the decision vector is dropped (the
        // cascade), so the graph touches no pre-existing target — `TargetMissing`
        // stays unreachable. Map it the same way the single-entity path does: a
        // clean NotDecidable.
        Err(db::ApplyError::TargetMissing) => Err(DecideError::NotDecidable(
            "proposal target no longer exists".to_string(),
        )),
        Err(db::ApplyError::Sql(e)) => Err(DecideError::Internal(e.into())),
    }
}

async fn validate_mutation_target(
    pool: &SqlitePool,
    run_id: Uuid,
    kind: MutationKind,
    payload: &serde_json::Value,
) -> Result<(), DecideError> {
    // Run-INDEPENDENT target-reference checks are shared with the user path
    // (`mutate`, ADR-0033): a create's `source_journal_entry_id` anchor, a Todo's
    // `project_id`/person refs, an update/delete target's type, and a reference's
    // `target_entity_id` type. Checked BEFORE apply so a bad reference writes
    // nothing.
    crate::mutation_target::validate_mutation_target_refs(pool, kind, payload)
        .await
        .map_err(|e| match e {
            // The primary target Entity was deleted out from under this parked
            // Proposal (ADR-0033). NotDecidable (-32002) so the Run resolves
            // cleanly, not Invalid (-32602) which the model would try to "fix".
            crate::mutation_target::TargetError::TargetMissing(_) => {
                DecideError::NotDecidable("proposal target no longer exists".to_string())
            }
            crate::mutation_target::TargetError::Invalid(reason) => DecideError::Invalid(reason),
            crate::mutation_target::TargetError::Internal(err) => DecideError::Internal(err),
        })?;

    // The SAME-THREAD JOURNAL GUARD is run-coupled (keyed on `run_id`) and stays
    // here. A reference's `source_entity_id` must be a Journal Entry in the
    // current Thread; the shared helper already verified its `target_entity_id`.
    // A reference's source is a model-supplied REFERENCE, not the Entity being
    // mutated — a missing/non-thread source is a payload error (-32602), never a
    // delete-race, so `missing_is_not_decidable: false`.
    if kind == MutationKind::ReferenceExistingEntityFromJournalEntry {
        let source_entity_id =
            mutation::target_entity_id(kind.describe(), payload).ok_or_else(|| {
                DecideError::Invalid(
                    "source_entity_id is required for reference_existing_entity_from_journal_entry"
                        .to_string(),
                )
            })?;
        validate_current_thread_journal_entry(pool, run_id, kind, source_entity_id, false).await?;
        return Ok(());
    }

    // A journal-entry update/delete keeps the stricter same-thread guard: the
    // target must be a Journal Entry originally created_from a user Message in the
    // current Thread.
    if kind != MutationKind::UpdateJournalEntry && kind != MutationKind::DeleteJournalEntry {
        return Ok(());
    }

    // Here the Journal Entry IS the primary target being mutated, so a GONE row is
    // the delete-race (ADR-0033) → NotDecidable; `missing_is_not_decidable: true`.
    let entity_id = mutation::target_entity_id(kind.describe(), payload).ok_or_else(|| {
        DecideError::Invalid(format!("entity_id is required for {}", kind.as_wire()))
    })?;
    validate_current_thread_journal_entry(pool, run_id, kind, entity_id, true).await?;

    Ok(())
}

/// The same-thread Journal-Entry guard. `missing_is_not_decidable` selects how a
/// GONE Journal Entry row is reported: as the primary update/delete target it is
/// the delete-race (NotDecidable, ADR-0033); as a reference's source it is a
/// payload error (Invalid). A Journal Entry that EXISTS but fails the thread
/// check is always a cross-thread attempt → Invalid.
async fn validate_current_thread_journal_entry(
    pool: &SqlitePool,
    run_id: Uuid,
    kind: MutationKind,
    entity_id: &str,
    missing_is_not_decidable: bool,
) -> Result<(), DecideError> {
    let allowed = db::journal_entry_target_is_valid(pool, run_id, entity_id)
        .await
        .map_err(|e| DecideError::Internal(e.into()))?;
    if !allowed {
        // The guard fails for two distinct reasons; tell them apart with a cheap
        // existence check.
        if missing_is_not_decidable {
            let exists =
                db::entity_is_type(pool, entity_id, mutation::EntityType::JournalEntry.as_str())
                    .await
                    .map_err(|e| DecideError::Internal(e.into()))?;
            if !exists {
                return Err(DecideError::NotDecidable(
                    "proposal target no longer exists".to_string(),
                ));
            }
        }
        return Err(DecideError::Invalid(format!(
            "{} target must be a Journal Entry originally created_from a user Message in the current Thread",
            kind.as_wire()
        )));
    }
    Ok(())
}

fn preserve_update_target_entity_id(
    kind: MutationKind,
    proposal_payload: &serde_json::Value,
    edited_payload: &serde_json::Value,
) -> Result<serde_json::Value, DecideError> {
    // Only the editable update kinds carry a target id to preserve. This gate is
    // the editable-UPDATE set (not merely `target_key.is_some()`, which would also
    // catch deletes, the reference weave, mark_project_reviewed, and bookmarks —
    // none of which take an edit). Reference/deletes were already rejected by the
    // edit-guard upstream; this stays explicit so the set cannot silently widen.
    if !matches!(
        kind,
        MutationKind::UpdateJournalEntry
            | MutationKind::UpdatePerson
            | MutationKind::UpdateProject
            | MutationKind::UpdateTodo
    ) {
        return Ok(edited_payload.clone());
    }

    // The target key (`todo_id` for update_todo, `entity_id` for the others) is a
    // pure function of the kind — taken from the descriptor, not hand-rolled.
    let desc = kind.describe();
    let target_key = desc
        .target_key
        .map(|k| k.as_str())
        .expect("an update kind always has a target key");
    let wire = kind.as_wire();

    let Some(target_id) = mutation::target_entity_id(desc, proposal_payload) else {
        return Err(DecideError::Invalid(format!(
            "{wire} proposal is missing {target_key}"
        )));
    };
    if let Some(edited_target_id) = mutation::target_entity_id(desc, edited_payload) {
        if edited_target_id != target_id {
            return Err(DecideError::Invalid(format!(
                "{wire} edit cannot change {target_key}"
            )));
        }
        return Ok(edited_payload.clone());
    }

    let Some(mut payload) = edited_payload.as_object().cloned() else {
        return Ok(edited_payload.clone());
    };

    payload.insert(
        target_key.to_string(),
        serde_json::Value::String(target_id.to_string()),
    );
    Ok(serde_json::Value::Object(payload))
}

/// Whether the Run currently reads `parked`. Backs the pending-decide
/// precondition and the trailing resume gate.
async fn run_is_parked(pool: &SqlitePool, run_id: Uuid) -> Result<bool, DecideError> {
    Ok(db::run_status(pool, run_id)
        .await
        .map_err(|e| DecideError::Internal(e.into()))?
        .is_some_and(RunStatus::is_parked))
}

#[cfg(test)]
mod tests {
    use super::{DecideError, DecideOutcome, apply};
    use crate::db;
    use sqlx::SqlitePool;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use uuid::Uuid;

    /// A migrated in-memory pool with `max_connections(1)` so the single
    /// `:memory:` database persists across calls.
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

    /// Seed a parked Run + assistant Message + a pending Journal Entry Proposal.
    /// Returns `(run_id, proposal_id)`. The `awaiting_tool_call_id` waitpoint is
    /// set by a trailing UPDATE because that FK is non-deferrable while the
    /// `tool_calls.run_id` FK points back at the Run.
    async fn seed_parked_proposal(pool: &SqlitePool) -> (Uuid, Uuid) {
        let run_id = Uuid::now_v7();
        let proposal_id = Uuid::now_v7();
        let run = run_id.to_string();
        let thread = format!("thr-{run}");
        let user_msg = format!("umsg-{run}");
        let asst_msg = format!("amsg-{run}");
        let tool_call_id = format!("tc-{run}");
        let now = db::now_ms();

        let mut tx = pool.begin().await.expect("begin seed");

        sqlx::query(
            "INSERT INTO threads (id, title, created_at, last_activity_at) VALUES (?, 't', ?, ?)",
        )
        .bind(&thread)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await
        .expect("insert thread");

        // Run starts parked; awaiting_tool_call_id is set below once the
        // tool_call exists. user_message_id's FK is DEFERRABLE (resolved at COMMIT).
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, \
              thinking_level, user_message_id, status, started_at) \
             VALUES (?, ?, 'w', '1', 'p', 'm', 'off', ?, 'parked', ?)",
        )
        .bind(&run)
        .bind(&thread)
        .bind(&user_msg)
        .bind(now)
        .execute(&mut *tx)
        .await
        .expect("insert run");

        sqlx::query(
            "INSERT INTO messages (id, thread_id, run_id, role, status, created_at, updated_at) \
             VALUES (?, ?, ?, 'user', 'completed', ?, ?)",
        )
        .bind(&user_msg)
        .bind(&thread)
        .bind(&run)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await
        .expect("insert user message");
        sqlx::query(
            "INSERT INTO messages (id, thread_id, run_id, role, status, created_at, updated_at) \
             VALUES (?, ?, ?, 'assistant', 'streaming', ?, ?)",
        )
        .bind(&asst_msg)
        .bind(&thread)
        .bind(&run)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await
        .expect("insert assistant message");

        sqlx::query(
            "INSERT INTO tool_calls (id, run_id, name, request_payload, status, requested_at) \
             VALUES (?, ?, 'propose_workspace_mutation', ?, 'pending', ?)",
        )
        .bind(&tool_call_id)
        .bind(&run)
        .bind(r#"{"mutation_kind":"create_journal_entry","payload":{"occurred_at":"2026-06-10T10:30:00","body":[{"type":"text","text":"Bought milk."}]},"rationale":"track the moment"}"#)
        .bind(now)
        .execute(&mut *tx)
        .await
        .expect("insert tool_call");

        sqlx::query(
            "INSERT INTO proposals (id, tool_call_id, mutation_kind, status) \
             VALUES (?, ?, 'create_journal_entry', 'pending')",
        )
        .bind(proposal_id.to_string())
        .bind(&tool_call_id)
        .execute(&mut *tx)
        .await
        .expect("insert proposal");

        sqlx::query("UPDATE runs SET awaiting_tool_call_id = ? WHERE id = ?")
            .bind(&tool_call_id)
            .bind(&run)
            .execute(&mut *tx)
            .await
            .expect("set waitpoint");

        tx.commit().await.expect("commit seed");
        (run_id, proposal_id)
    }

    /// A fake resume: sets the shared flag AND flips the Run `parked → running`
    /// like the real `worker::resume`, so a follow-up observes an advanced Run.
    fn resume_closure(
        pool: SqlitePool,
        flag: Arc<AtomicBool>,
    ) -> impl FnOnce(Uuid) -> futures_util::future::BoxFuture<'static, anyhow::Result<()>> {
        use futures_util::FutureExt;
        move |run_id| {
            async move {
                flag.store(true, Ordering::SeqCst);
                db::mark_run_running(&pool, run_id).await?;
                Ok(())
            }
            .boxed()
        }
    }

    async fn entity_count(pool: &SqlitePool) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM entities")
            .fetch_one(pool)
            .await
            .expect("count entities")
    }

    async fn entity_count_of_type(pool: &SqlitePool, entity_type: &str) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM entities WHERE type = ?")
            .bind(entity_type)
            .fetch_one(pool)
            .await
            .expect("count entities of type")
    }

    /// The single entity id of `entity_type` (the test graph mints exactly one
    /// of each).
    async fn only_entity_id_of_type(pool: &SqlitePool, entity_type: &str) -> String {
        sqlx::query_scalar("SELECT id FROM entities WHERE type = ?")
            .bind(entity_type)
            .fetch_one(pool)
            .await
            .expect("entity id of type")
    }

    async fn entity_sources_count_for(pool: &SqlitePool, entity_id: &str) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM entity_sources WHERE entity_id = ?")
            .bind(entity_id)
            .fetch_one(pool)
            .await
            .expect("count entity_sources for entity")
    }

    async fn proposal_status(pool: &SqlitePool, proposal_id: &str) -> String {
        sqlx::query_scalar("SELECT status FROM proposals WHERE id = ?")
            .bind(proposal_id)
            .fetch_one(pool)
            .await
            .expect("proposal status")
    }

    async fn tool_call_result(pool: &SqlitePool, proposal_id: &str) -> (String, Option<String>) {
        sqlx::query_as(
            "SELECT tc.status, tc.result_payload FROM tool_calls tc \
             JOIN proposals p ON p.tool_call_id = tc.id WHERE p.id = ?",
        )
        .bind(proposal_id)
        .fetch_one(pool)
        .await
        .expect("tool_call row")
    }

    async fn entity_data(pool: &SqlitePool, entity_id: &str) -> serde_json::Value {
        let data: String = sqlx::query_scalar("SELECT data FROM entities WHERE id = ?")
            .bind(entity_id)
            .fetch_one(pool)
            .await
            .expect("entity data");
        serde_json::from_str(&data).expect("entity data json")
    }

    /// Retarget a seeded pending Proposal to `mutation_kind` with `payload` as
    /// its inner proposed payload (mirrors `load_proposal_for_decide`, which reads
    /// the proposed payload from the tool_call `request_payload.payload`).
    async fn retarget_proposal(
        pool: &SqlitePool,
        proposal_id: &str,
        mutation_kind: &str,
        payload: serde_json::Value,
    ) {
        sqlx::query("UPDATE proposals SET mutation_kind = ? WHERE id = ?")
            .bind(mutation_kind)
            .bind(proposal_id)
            .execute(pool)
            .await
            .expect("retarget proposal kind");
        sqlx::query(
            "UPDATE tool_calls SET request_payload = ? \
             WHERE id = (SELECT tool_call_id FROM proposals WHERE id = ?)",
        )
        .bind(
            serde_json::json!({
                "mutation_kind": mutation_kind,
                "payload": payload,
                "rationale": "retargeted in test",
            })
            .to_string(),
        )
        .bind(proposal_id)
        .execute(pool)
        .await
        .expect("retarget proposal payload");
    }

    /// Insert a canonical Person Entity (created_by='user', no Proposal anchor).
    /// Returns its id.
    async fn insert_person(pool: &SqlitePool) -> String {
        let entity_id = Uuid::now_v7().to_string();
        let now = db::now_ms();
        sqlx::query(
            "INSERT INTO entities \
             (id, type, schema_version, data, created_by, created_at, updated_at) \
             VALUES (?, 'person', 1, ?, 'user', ?, ?)",
        )
        .bind(&entity_id)
        .bind(r#"{"name":"Target Person"}"#)
        .bind(now)
        .bind(now)
        .execute(pool)
        .await
        .expect("insert person");
        entity_id
    }

    /// Insert a canonical accepted Entity of `entity_type` whose label
    /// (`name`/`title`) is `label` (created_by='user', no Proposal anchor) — the
    /// "accepted" set slice-3 exact-match resolution reads via `list_by_type`.
    /// Returns its id.
    async fn insert_named_entity(pool: &SqlitePool, entity_type: &str, label: &str) -> String {
        let entity_id = Uuid::now_v7().to_string();
        let now = db::now_ms();
        let label_key = if entity_type == "todo" { "title" } else { "name" };
        let data = serde_json::json!({ label_key: label }).to_string();
        sqlx::query(
            "INSERT INTO entities \
             (id, type, schema_version, data, created_by, created_at, updated_at) \
             VALUES (?, ?, 1, ?, 'user', ?, ?)",
        )
        .bind(&entity_id)
        .bind(entity_type)
        .bind(&data)
        .bind(now)
        .bind(now)
        .execute(pool)
        .await
        .expect("insert named entity");
        entity_id
    }

    /// Insert a canonical Journal Entry Entity with a `created_from` source row
    /// pointing at `source_message_id`. Used to seed an update/delete target the
    /// same-thread guard accepts (in-thread message) or rejects (wrong-thread).
    async fn insert_journal_entry(pool: &SqlitePool, source_message_id: &str) -> String {
        let entity_id = Uuid::now_v7().to_string();
        let now = db::now_ms();
        sqlx::query(
            "INSERT INTO entities \
             (id, type, schema_version, data, created_by, created_at, updated_at) \
             VALUES (?, 'journal_entry', 1, ?, 'user', ?, ?)",
        )
        .bind(&entity_id)
        .bind(
            r#"{"occurred_at":"2026-06-10T10:30:00","body":[{"type":"text","text":"Original."}]}"#,
        )
        .bind(now)
        .bind(now)
        .execute(pool)
        .await
        .expect("insert journal entry");
        sqlx::query(
            "INSERT INTO entity_sources \
             (id, entity_id, source_message_id, relation, created_at) \
             VALUES (?, ?, ?, 'created_from', ?)",
        )
        .bind(Uuid::now_v7().to_string())
        .bind(&entity_id)
        .bind(source_message_id)
        .bind(now)
        .execute(pool)
        .await
        .expect("insert journal entry source");
        entity_id
    }

    /// Seed a standalone thread with one completed user Message (its `run_id`
    /// reuses `run_id`, an existing Run, only to satisfy the NOT NULL FK — the
    /// thread differs, which is what the same-thread guard keys on). Returns the
    /// message id. Used to anchor a wrong-thread Journal Entry.
    async fn insert_foreign_thread_user_message(pool: &SqlitePool, run_id: Uuid) -> String {
        let suffix = Uuid::now_v7();
        let thread = format!("thr-foreign-{suffix}");
        let message = format!("umsg-foreign-{suffix}");
        let now = db::now_ms();
        sqlx::query(
            "INSERT INTO threads (id, title, created_at, last_activity_at) VALUES (?, 't', ?, ?)",
        )
        .bind(&thread)
        .bind(now)
        .bind(now)
        .execute(pool)
        .await
        .expect("insert foreign thread");
        sqlx::query(
            "INSERT INTO messages (id, thread_id, run_id, role, status, created_at, updated_at) \
             VALUES (?, ?, ?, 'user', 'completed', ?, ?)",
        )
        .bind(&message)
        .bind(&thread)
        .bind(run_id.to_string())
        .bind(now)
        .bind(now)
        .execute(pool)
        .await
        .expect("insert foreign user message");
        message
    }

    /// Force a Proposal to `accepted` (simulating a prior decide), with an
    /// optional recorded idempotency key.
    async fn force_proposal_accepted(pool: &SqlitePool, proposal_id: &str, key: Option<&str>) {
        let now = db::now_ms();
        sqlx::query(
            "UPDATE proposals SET status='accepted', decided_by='user', \
             decided_at=?, applied_at=?, decision_idempotency_key=? WHERE id=?",
        )
        .bind(now)
        .bind(now)
        .bind(key)
        .bind(proposal_id)
        .execute(pool)
        .await
        .expect("force proposal accepted");
    }

    async fn force_run_status(pool: &SqlitePool, run_id: Uuid, status: &str) {
        sqlx::query("UPDATE runs SET status=? WHERE id=?")
            .bind(status)
            .bind(run_id.to_string())
            .execute(pool)
            .await
            .expect("force run status");
    }

    /// Insert an accepted Entity created via `proposal_id` (so a recovery /
    /// keyed-replay lookup finds it). Returns its id.
    async fn insert_accepted_entity(pool: &SqlitePool, proposal_id: &str) -> String {
        let entity_id = Uuid::now_v7().to_string();
        let now = db::now_ms();
        sqlx::query(
            "INSERT INTO entities \
             (id, type, schema_version, data, created_by, created_via_proposal_id, \
              created_at, updated_at) \
             VALUES (?, 'journal_entry', 1, ?, 'proposal', ?, ?, ?)",
        )
        .bind(&entity_id)
        .bind(r#"{"occurred_at":"2026-06-10T10:30:00","body":[{"type":"text","text":"Bought milk."}]}"#)
        .bind(proposal_id)
        .bind(now)
        .bind(now)
        .execute(pool)
        .await
        .expect("insert accepted entity");
        entity_id
    }

    // 1. accept → Accepted{entity_id}; exactly one entity lands; resume invoked.
    #[tokio::test]
    async fn accept_applies_once_and_resumes() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let resumed = Arc::new(AtomicBool::new(false));

        let outcome = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            None,
            Some("k1".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await
        .expect("accept succeeds");

        let entity_id = match outcome {
            DecideOutcome::Accepted { entity_id, .. } => entity_id,
            other => panic!("expected Accepted, got {other:?}"),
        };
        assert!(!entity_id.is_empty(), "accept yields an entity id");
        assert_eq!(entity_count(&pool).await, 1, "exactly one entity lands");
        assert_eq!(
            proposal_status(&pool, &proposal_id.to_string()).await,
            "accepted"
        );
        assert!(resumed.load(Ordering::SeqCst), "resume closure invoked");
    }

    // 2. reject → Rejected; no entity; tool_call resolved with a non-error
    //    decline; resume invoked.
    #[tokio::test]
    async fn reject_resolves_without_applying_and_resumes() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let resumed = Arc::new(AtomicBool::new(false));

        let outcome = apply(
            &pool,
            proposal_id,
            "reject",
            None,
            None,
            Some("r1".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await
        .expect("reject succeeds");

        assert!(
            matches!(outcome, DecideOutcome::Rejected { .. }),
            "reject yields Rejected: {outcome:?}"
        );
        assert_eq!(entity_count(&pool).await, 0, "reject applies no entity");
        assert_eq!(
            proposal_status(&pool, &proposal_id.to_string()).await,
            "rejected"
        );
        let (tc_status, payload) = tool_call_result(&pool, &proposal_id.to_string()).await;
        assert_eq!(tc_status, "completed", "decline resolves the tool call");
        let payload: serde_json::Value =
            serde_json::from_str(&payload.expect("decline carries a result payload")).unwrap();
        assert_eq!(payload["decision"], "reject");
        assert_ne!(
            payload["is_error"].as_bool(),
            Some(true),
            "decline is a NORMAL (non-error) tool result"
        );
        assert!(
            resumed.load(Ordering::SeqCst),
            "reject resumes the parked run"
        );
    }

    // 3. edit → Accepted; the entity data holds the EDITED values; resume invoked.
    #[tokio::test]
    async fn edit_applies_edited_payload_and_resumes() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let resumed = Arc::new(AtomicBool::new(false));

        let outcome = apply(
            &pool,
            proposal_id,
            "edit",
            Some(serde_json::json!({
                "occurred_at": "2026-06-10T10:35:00",
                "body": [{ "type": "text", "text": "Bought oat milk." }]
            })),
            None,
            Some("e1".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await
        .expect("edit succeeds");

        let entity_id = match outcome {
            DecideOutcome::Accepted { entity_id, .. } => entity_id,
            other => panic!("expected Accepted, got {other:?}"),
        };
        assert_eq!(
            entity_data(&pool, &entity_id).await["body"][0]["text"],
            "Bought oat milk.",
            "entity carries the EDITED body, not the model's proposed payload"
        );
        assert_eq!(
            entity_count(&pool).await,
            1,
            "edit lands exactly one entity"
        );
        assert!(
            resumed.load(Ordering::SeqCst),
            "edit resumes the parked run"
        );
    }

    #[tokio::test]
    async fn edit_update_rejects_targetless_original_proposal() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        sqlx::query("UPDATE proposals SET mutation_kind = 'update_journal_entry' WHERE id = ?")
            .bind(&proposal_id_str)
            .execute(&pool)
            .await
            .expect("force update proposal kind");
        sqlx::query(
            "UPDATE tool_calls SET request_payload = ? \
             WHERE id = (SELECT tool_call_id FROM proposals WHERE id = ?)",
        )
        .bind(
            serde_json::json!({
                "mutation_kind": "update_journal_entry",
                "payload": {
                    "occurred_at": "2026-06-10T10:30:00",
                    "body": [{ "type": "text", "text": "Missing target." }]
                },
                "rationale": "malformed update proposal"
            })
            .to_string(),
        )
        .bind(&proposal_id_str)
        .execute(&pool)
        .await
        .expect("force targetless proposal payload");

        let resumed = Arc::new(AtomicBool::new(false));
        let outcome = apply(
            &pool,
            proposal_id,
            "edit",
            Some(serde_json::json!({
                "entity_id": Uuid::now_v7().to_string(),
                "occurred_at": "2026-06-10T10:35:00",
                "body": [{ "type": "text", "text": "Retargeted edit." }]
            })),
            None,
            Some("targetless-update-edit".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await;

        let Err(DecideError::Invalid(reason)) = outcome else {
            panic!("expected invalid targetless update edit, got {outcome:?}");
        };
        assert!(
            reason.contains("missing entity_id"),
            "invalid reason names missing proposal target: {reason}"
        );
        assert_eq!(entity_count(&pool).await, 0, "invalid edit applies nothing");
        assert_eq!(
            proposal_status(&pool, &proposal_id_str).await,
            "pending",
            "invalid edit leaves the proposal pending"
        );
        assert!(
            !resumed.load(Ordering::SeqCst),
            "invalid edit does not resume"
        );
    }

    // 4. same-key replay → the second decide returns the prior Accepted{same
    //    entity_id} and inserts NO second entity (and does not re-resume the
    //    already-advanced Run).
    #[tokio::test]
    async fn same_key_replay_returns_prior_without_reapplying() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;

        let first_flag = Arc::new(AtomicBool::new(false));
        let first = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            None,
            Some("same".to_string()),
            resume_closure(pool.clone(), first_flag.clone()),
        )
        .await
        .expect("first accept");
        let first_entity = match first {
            DecideOutcome::Accepted { entity_id, .. } => entity_id,
            other => panic!("expected Accepted, got {other:?}"),
        };
        assert!(
            first_flag.load(Ordering::SeqCst),
            "first decide resumes the parked run"
        );

        let second_flag = Arc::new(AtomicBool::new(false));
        let second = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            None,
            Some("same".to_string()),
            resume_closure(pool.clone(), second_flag.clone()),
        )
        .await
        .expect("second accept (replay)");
        match second {
            DecideOutcome::Accepted { entity_id, .. } => {
                assert_eq!(
                    entity_id, first_entity,
                    "replay returns the prior entity id"
                );
            }
            other => panic!("expected Accepted replay, got {other:?}"),
        }
        assert_eq!(
            entity_count(&pool).await,
            1,
            "replay inserts no second entity"
        );
        assert!(
            !second_flag.load(Ordering::SeqCst),
            "replay does not re-resume an already-advanced run"
        );
    }

    // 5. A Proposal pre-decided by a concurrent decide whose Run already advanced
    //    off `parked` is no longer decidable; nothing re-applies, resume is NOT
    //    invoked. `LostRace` itself needs a genuine TOCTOU (unreachable single-
    //    threaded); the deterministic outcome here is `NotDecidable`, which maps
    //    to the same wire code (`-32002`). `LostRace` is covered by the db-layer
    //    guarded-race tests.
    #[tokio::test]
    async fn stale_decide_after_concurrent_winner_is_not_decidable() {
        let pool = memory_pool().await;
        let (run_id, proposal_id) = seed_parked_proposal(&pool).await;
        force_proposal_accepted(&pool, &proposal_id.to_string(), Some("winner")).await;
        force_run_status(&pool, run_id, "running").await;
        let resumed = Arc::new(AtomicBool::new(false));

        let outcome = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            None,
            Some("loser".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await;

        assert!(
            matches!(outcome, Err(DecideError::NotDecidable(_))),
            "a stale decide on an already-decided, advanced Run is not decidable: {outcome:?}"
        );
        assert_eq!(
            entity_count(&pool).await,
            0,
            "the stale decide applies nothing"
        );
        assert!(
            !resumed.load(Ordering::SeqCst),
            "a non-fresh decide does not resume"
        );
    }

    // 6a. still-parked recovery → an already-accepted Proposal whose Run is still
    //     parked returns the prior result AND re-drives resume (the recovery path).
    #[tokio::test]
    async fn still_parked_recovery_returns_prior_and_re_resumes() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        // A prior decide accepted but its resume failed before flipping the Run.
        force_proposal_accepted(&pool, &proposal_id.to_string(), None).await;
        let prior_entity = insert_accepted_entity(&pool, &proposal_id.to_string()).await;
        let resumed = Arc::new(AtomicBool::new(false));

        let outcome = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            None,
            None,
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await
        .expect("recovery returns the prior result");

        match outcome {
            DecideOutcome::Accepted { entity_id, .. } => {
                assert_eq!(
                    entity_id, prior_entity,
                    "recovery returns the prior entity id"
                );
            }
            other => panic!("expected prior Accepted, got {other:?}"),
        }
        assert_eq!(
            entity_count(&pool).await,
            1,
            "recovery inserts no second entity"
        );
        assert!(
            resumed.load(Ordering::SeqCst),
            "still-parked recovery re-drives resume"
        );
    }

    // 6b. for a Run already past `parked`, a keyed replay returns the prior
    //     result but resume is NOT invoked.
    #[tokio::test]
    async fn keyed_replay_after_run_advanced_does_not_re_resume() {
        let pool = memory_pool().await;
        let (run_id, proposal_id) = seed_parked_proposal(&pool).await;
        force_proposal_accepted(&pool, &proposal_id.to_string(), Some("k")).await;
        let prior_entity = insert_accepted_entity(&pool, &proposal_id.to_string()).await;
        force_run_status(&pool, run_id, "completed").await;
        let resumed = Arc::new(AtomicBool::new(false));

        let outcome = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            None,
            Some("k".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await
        .expect("keyed replay returns the prior result");

        match outcome {
            DecideOutcome::Accepted { entity_id, .. } => {
                assert_eq!(
                    entity_id, prior_entity,
                    "keyed replay returns the prior entity id"
                );
            }
            other => panic!("expected prior Accepted, got {other:?}"),
        }
        assert!(
            !resumed.load(Ordering::SeqCst),
            "a Run already past parked is not re-resumed"
        );
    }

    // Regression: a payload-less `edit` retry of an already-decided Proposal whose
    // Run is still parked must RECOVER (replay + re-drive resume), not short-circuit
    // to `Invalid`. The "edit requires edited_payload" check belongs on the fresh
    // path, after the recovery/idempotency branches.
    #[tokio::test]
    async fn still_parked_edit_retry_without_payload_recovers() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        // A prior decide accepted but its resume failed before flipping the Run.
        // The retry re-sends `decision="edit"` but WITHOUT the payload.
        force_proposal_accepted(&pool, &proposal_id.to_string(), None).await;
        let prior_entity = insert_accepted_entity(&pool, &proposal_id.to_string()).await;
        let resumed = Arc::new(AtomicBool::new(false));

        let outcome = apply(
            &pool,
            proposal_id,
            "edit",
            None,
            None, // payload-less edit retry — must NOT short-circuit to Invalid
            None,
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await
        .expect("payload-less edit retry recovers the prior result (NOT Invalid)");

        match outcome {
            DecideOutcome::Accepted { entity_id, .. } => {
                assert_eq!(
                    entity_id, prior_entity,
                    "recovery returns the prior entity id"
                );
            }
            other => panic!("expected prior Accepted, got {other:?}"),
        }
        assert_eq!(
            entity_count(&pool).await,
            1,
            "recovery inserts no second entity"
        );
        assert!(
            resumed.load(Ordering::SeqCst),
            "still-parked recovery re-drives resume even for a payload-less edit"
        );
    }

    // A fresh pending + parked Proposal decided `edit` WITHOUT a payload is
    // `Invalid` — nothing applied, nothing resumed, Proposal stays re-decidable.
    #[tokio::test]
    async fn fresh_edit_without_payload_is_invalid() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let resumed = Arc::new(AtomicBool::new(false));

        let outcome = apply(
            &pool,
            proposal_id,
            "edit",
            None,
            None, // a FRESH edit genuinely requires a payload
            Some("e-none".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await;

        assert!(
            matches!(outcome, Err(DecideError::Invalid(_))),
            "a fresh payload-less edit is Invalid on the fresh path: {outcome:?}"
        );
        assert_eq!(
            entity_count(&pool).await,
            0,
            "an Invalid edit applies nothing"
        );
        assert_eq!(
            proposal_status(&pool, &proposal_id.to_string()).await,
            "pending",
            "an Invalid edit leaves the Proposal pending + re-decidable"
        );
        assert!(
            !resumed.load(Ordering::SeqCst),
            "an Invalid edit does not resume"
        );
    }

    /// Resume pre-spawn failure recovery (ADR-0025): when `resume` fails BEFORE
    /// flipping the Run off `parked`, the accept stays committed and the decide
    /// surfaces `Internal`, but the Run is left parked. A follow-up keyed replay
    /// with a working resume replays the prior result AND re-drives resume via the
    /// still-parked recovery branch.
    #[tokio::test]
    async fn resume_failure_leaves_run_parked_and_recovers_on_retry() {
        use futures_util::FutureExt;

        let pool = memory_pool().await;
        let (run_id, proposal_id) = seed_parked_proposal(&pool).await;

        // First decide: accept applies, then the resume closure fails without
        // flipping the Run.
        let failing_resume =
            |_run_id| async { Err(anyhow::anyhow!("token resolution failed")) }.boxed();
        let first = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            None,
            Some("k-resume-fail".to_string()),
            failing_resume,
        )
        .await;

        assert!(
            matches!(first, Err(DecideError::Internal(_))),
            "a resume failure surfaces as Internal: {first:?}"
        );
        // The accept is durable: entity landed once, Proposal accepted.
        assert_eq!(entity_count(&pool).await, 1, "the accept applied once");
        assert_eq!(
            proposal_status(&pool, &proposal_id.to_string()).await,
            "accepted"
        );
        // The Run is still parked (resume returned Err before flipping), so the
        // still-parked recovery branch is reachable.
        assert_eq!(
            db::run_status(&pool, run_id).await.unwrap().map(db::RunStatus::as_str),
            Some("parked"),
            "a failed resume leaves the Run parked, not errored"
        );

        // Retry with the SAME key and a working resume: keyed replay returns the
        // prior result AND the trailing gate re-drives resume.
        let resumed = Arc::new(AtomicBool::new(false));
        let second = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            None,
            Some("k-resume-fail".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await
        .expect("retry recovers");

        assert!(
            matches!(second, DecideOutcome::Accepted { .. }),
            "retry replays the prior Accepted: {second:?}"
        );
        assert_eq!(
            entity_count(&pool).await,
            1,
            "retry inserts no second entity"
        );
        assert!(
            resumed.load(Ordering::SeqCst),
            "the still-parked retry re-drives resume"
        );
    }

    // ADR-0033 "Delete vs. a parked Proposal": a user deletes the GTD Entity a
    // parked Proposal targets, THEN accepts the Proposal. The decide must surface
    // `NotDecidable` (-32002, "no longer pending") — NOT `Invalid` (-32602) and
    // NOT `Internal` — so the parked Run resolves cleanly. The deleted primary
    // target is caught at pre-validation (before apply), so this exercises the
    // mutation_target TargetMissing → NotDecidable mapping, not the apply-layer
    // TOCTOU path.
    #[tokio::test]
    async fn accept_with_deleted_gtd_target_is_not_decidable() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        let person_id = insert_person(&pool).await;
        retarget_proposal(
            &pool,
            &proposal_id_str,
            "delete_person",
            serde_json::json!({ "entity_id": person_id }),
        )
        .await;

        // The user deletes the target Person out from under the parked Proposal.
        sqlx::query("DELETE FROM entities WHERE id = ?")
            .bind(&person_id)
            .execute(&pool)
            .await
            .expect("delete target person");

        let resumed = Arc::new(AtomicBool::new(false));
        let outcome = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            None,
            Some("k-gtd-gone".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await;

        assert!(
            matches!(outcome, Err(DecideError::NotDecidable(_))),
            "accepting a Proposal whose deleted GTD target is gone is NotDecidable, got {outcome:?}"
        );
        assert_eq!(
            entity_count(&pool).await,
            0,
            "nothing is written when the target is gone"
        );
        assert_eq!(
            proposal_status(&pool, &proposal_id_str).await,
            "pending",
            "the Proposal stays pending — the Run can still resolve it"
        );
        assert!(
            !resumed.load(Ordering::SeqCst),
            "a NotDecidable accept does not resume"
        );
    }

    // ADR-0033 "Delete vs. a parked Proposal" for the JOURNAL kind: the target
    // Journal Entry row is hard-deleted before the parked `update_journal_entry`
    // Proposal is accepted. The same-thread guard must distinguish "JE row gone"
    // (→ NotDecidable, the delete race) from "wrong thread" (→ Invalid, next test).
    #[tokio::test]
    async fn accept_with_deleted_journal_target_is_not_decidable() {
        let pool = memory_pool().await;
        let (run_id, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        // The seeded user Message `umsg-{run}` lives in the Run's own thread, so a
        // JE created_from it satisfies the same-thread guard while it exists.
        let in_thread_user_msg = format!("umsg-{run_id}");
        let je_id = insert_journal_entry(&pool, &in_thread_user_msg).await;
        retarget_proposal(
            &pool,
            &proposal_id_str,
            "update_journal_entry",
            serde_json::json!({
                "entity_id": je_id,
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "text", "text": "Edited." }]
            }),
        )
        .await;

        // The user deletes the target Journal Entry.
        sqlx::query("DELETE FROM entities WHERE id = ?")
            .bind(&je_id)
            .execute(&pool)
            .await
            .expect("delete target journal entry");

        let resumed = Arc::new(AtomicBool::new(false));
        let outcome = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            None,
            Some("k-je-gone".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await;

        assert!(
            matches!(outcome, Err(DecideError::NotDecidable(_))),
            "accepting an update_journal_entry whose JE row was deleted is NotDecidable, got {outcome:?}"
        );
        assert_eq!(
            entity_count(&pool).await,
            0,
            "nothing is written when the JE target is gone"
        );
        assert_eq!(
            proposal_status(&pool, &proposal_id_str).await,
            "pending",
            "the Proposal stays pending"
        );
        assert!(
            !resumed.load(Ordering::SeqCst),
            "a NotDecidable accept does not resume"
        );
    }

    // FIX #2: a `reference_existing_entity_from_journal_entry` whose SOURCE Journal
    // Entry (the reference's primary anchor) was deleted out from under the parked
    // Proposal is NotDecidable (-32002), not Internal (-32603) — the shared
    // validator now checks the source's existence run-independently, so the apply
    // path never trips the entity_refs FK on a vanished source. A source that
    // EXISTS but is the WRONG TYPE (not a journal_entry) stays Invalid (-32602).
    #[tokio::test]
    async fn reference_with_deleted_source_is_not_decidable_wrong_type_is_invalid() {
        let pool = memory_pool().await;
        let (run_id, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        // A valid referenceable target (a Person) for both sub-cases.
        let target_person = insert_person(&pool).await;

        // Sub-case A: deleted source → NotDecidable. Seed a Journal Entry anchored
        // in the Run's own thread (so the same-thread guard would pass), then
        // delete it before the decide.
        let in_thread_user_msg = format!("umsg-{run_id}");
        let source_je = insert_journal_entry(&pool, &in_thread_user_msg).await;
        retarget_proposal(
            &pool,
            &proposal_id_str,
            "reference_existing_entity_from_journal_entry",
            serde_json::json!({
                "source_entity_id": source_je,
                "target_entity_id": target_person,
                "label_snapshot": "Target Person",
                "body": [
                    { "type": "text", "text": "Linked " },
                    { "type": "entity_ref" }
                ]
            }),
        )
        .await;
        sqlx::query("DELETE FROM entities WHERE id = ?")
            .bind(&source_je)
            .execute(&pool)
            .await
            .expect("delete source journal entry");

        let resumed = Arc::new(AtomicBool::new(false));
        let outcome = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            None,
            Some("k-ref-source-gone".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await;
        assert!(
            matches!(outcome, Err(DecideError::NotDecidable(_))),
            "a deleted reference source is NotDecidable (primary anchor delete-race), got {outcome:?}"
        );
        assert!(
            !resumed.load(Ordering::SeqCst),
            "a NotDecidable accept does not resume"
        );

        // Sub-case B: wrong-type source (a Person, not a Journal Entry) → Invalid.
        let person_source = insert_person(&pool).await;
        retarget_proposal(
            &pool,
            &proposal_id_str,
            "reference_existing_entity_from_journal_entry",
            serde_json::json!({
                "source_entity_id": person_source,
                "target_entity_id": target_person,
                "label_snapshot": "Target Person",
                "body": [
                    { "type": "text", "text": "Linked " },
                    { "type": "entity_ref" }
                ]
            }),
        )
        .await;
        let resumed_b = Arc::new(AtomicBool::new(false));
        let outcome_b = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            None,
            Some("k-ref-source-wrong-type".to_string()),
            resume_closure(pool.clone(), resumed_b.clone()),
        )
        .await;
        assert!(
            matches!(outcome_b, Err(DecideError::Invalid(_))),
            "a wrong-type reference source is Invalid (payload error), got {outcome_b:?}"
        );
    }

    /// The slice-2 graph fixture (ADR-0042): a journal-anchored, create-only
    /// graph — one `journal_entry` node (TEXT-only body, so no slice-6 weave) +
    /// one new Person, no links. The shape both the accept and reject tests use.
    fn create_only_graph() -> serde_json::Value {
        serde_json::json!({
            "journal_entry": {
                "handle": "@je",
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "text", "text": "Met Morris about the Rodeo side." }]
            },
            "entities": [
                { "handle": "@morris", "type": "person", "name": "Morris" }
            ],
            "links": []
        })
    }

    // Slice 2 (ADR-0042): accepting an `apply_intent_graph` Proposal RESOLVES and
    // APPLIES the create-only graph atomically — the Journal Entry node + the
    // Person, in one tx. Exactly the JE node writes its `created_from`
    // user-Message GUARD row (the cross-thread-guard input, NOT entity
    // provenance); the extracted Person writes ZERO entity_sources rows ("No
    // provenance writes"). The reported `entity_id` is the JE anchor; the
    // Proposal is accepted and the Run resumes.
    #[tokio::test]
    async fn accept_apply_intent_graph_creates_je_and_entity_with_only_je_source() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        retarget_proposal(&pool, &proposal_id_str, "apply_intent_graph", create_only_graph()).await;

        let resumed = Arc::new(AtomicBool::new(false));
        let outcome = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            None,
            Some("k-graph".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await
        .expect("graph accept succeeds");

        let entity_id = match outcome {
            DecideOutcome::Accepted { entity_id, .. } => entity_id,
            other => panic!("expected Accepted, got {other:?}"),
        };

        // Exactly TWO entities: one journal_entry + one person.
        assert_eq!(entity_count(&pool).await, 2, "graph mints the JE + the Person");
        assert_eq!(entity_count_of_type(&pool, "journal_entry").await, 1);
        assert_eq!(entity_count_of_type(&pool, "person").await, 1);

        let je_id = only_entity_id_of_type(&pool, "journal_entry").await;
        let person_id = only_entity_id_of_type(&pool, "person").await;

        // The anchor reported is the JE node's id (ADR-0042).
        assert_eq!(entity_id, je_id, "the reported anchor is the JE node's id");

        // Exactly ONE entity_sources row total, and it points at the JE — the
        // `created_from` user-Message guard row.
        let total_sources: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM entity_sources")
            .fetch_one(&pool)
            .await
            .expect("count entity_sources");
        assert_eq!(total_sources, 1, "only the JE guard row is written");
        assert_eq!(
            entity_sources_count_for(&pool, &je_id).await,
            1,
            "the one source row points at the JE, not the Person"
        );
        let (source_message_id, relation): (Option<String>, String) = sqlx::query_as(
            "SELECT source_message_id, relation FROM entity_sources WHERE entity_id = ?",
        )
        .bind(&je_id)
        .fetch_one(&pool)
        .await
        .expect("JE source row");
        assert!(
            source_message_id.is_some(),
            "the JE guard row is a FromMessage (created_from user message) row"
        );
        assert_eq!(relation, "created_from");

        // ADR-0042 "No provenance writes": the Person has ZERO entity_sources rows.
        assert_eq!(
            entity_sources_count_for(&pool, &person_id).await,
            0,
            "the extracted Person writes no provenance row"
        );

        assert_eq!(
            proposal_status(&pool, &proposal_id_str).await,
            "accepted",
            "the graph Proposal is accepted"
        );
        assert!(resumed.load(Ordering::SeqCst), "the graph accept resumes the run");
    }

    // Slice 2: rejecting the same graph Proposal writes ZERO entities (the reject
    // path touches no entity store) and resolves the Proposal as rejected.
    #[tokio::test]
    async fn reject_apply_intent_graph_writes_no_entities() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        retarget_proposal(&pool, &proposal_id_str, "apply_intent_graph", create_only_graph()).await;

        let resumed = Arc::new(AtomicBool::new(false));
        let outcome = apply(
            &pool,
            proposal_id,
            "reject",
            None,
            None,
            Some("r-graph".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await
        .expect("graph reject succeeds");

        assert!(
            matches!(outcome, DecideOutcome::Rejected { .. }),
            "reject yields Rejected: {outcome:?}"
        );
        assert_eq!(entity_count(&pool).await, 0, "a rejected graph writes no entity");
        assert_eq!(proposal_status(&pool, &proposal_id_str).await, "rejected");
        assert!(resumed.load(Ordering::SeqCst), "the graph reject resumes the run");
    }

    // Slice 6 (was the slice-2 reject-until-weave guard): a graph whose Journal
    // Entry body carries a SINGLE `entity_ref` placeholder is now WOVEN — the body
    // node legitimately carries the placeholder, the matching journal_ref link
    // mints one entity_ref, and the placeholder is rewritten to its `ref_id` in the
    // JE's single revision (no dangling `target` handle). This replaces the
    // slice-2 "entity_ref body is Invalid until the weave lands" assertion.
    #[tokio::test]
    async fn accept_apply_intent_graph_with_single_entity_ref_body_weaves() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        // A journal-anchored graph whose JE body has one entity_ref placeholder
        // targeting the Person handle, with the matching journal_ref link.
        let graph = serde_json::json!({
            "journal_entry": {
                "handle": "@je",
                "occurred_at": "2026-06-10T10:30:00",
                "body": [
                    { "type": "text", "text": "Met " },
                    { "type": "entity_ref", "target": "@morris" }
                ]
            },
            "entities": [
                { "handle": "@morris", "type": "person", "name": "Morris" }
            ],
            "links": [{ "kind": "journal_ref", "from": "@je", "to": "@morris" }]
        });
        retarget_proposal(&pool, &proposal_id_str, "apply_intent_graph", graph).await;

        let resumed = Arc::new(AtomicBool::new(false));
        let outcome = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            None,
            Some("k-graph-ref-body".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await
        .expect("single-ref graph weave succeeds");

        match outcome {
            DecideOutcome::Accepted { .. } => {}
            other => panic!("expected Accepted, got {other:?}"),
        }

        assert_eq!(entity_count(&pool).await, 2, "JE + Person woven");
        let je_id = only_entity_id_of_type(&pool, "journal_entry").await;
        let person_id = only_entity_id_of_type(&pool, "person").await;

        let refs = entity_refs_from(&pool, &je_id).await;
        assert_eq!(refs.len(), 1, "one entity_ref woven: {refs:?}");
        assert_eq!(refs[0].1, person_id, "the ref targets Morris");

        assert_eq!(
            entity_revision_count(&pool, &je_id).await,
            1,
            "the JE is written once"
        );

        let je = entity_data(&pool, &je_id).await;
        let body = je.get("body").and_then(serde_json::Value::as_array).expect("JE body array");
        let ref_node = body
            .iter()
            .find(|n| n.get("type").and_then(serde_json::Value::as_str) == Some("entity_ref"))
            .expect("the entity_ref body node survives");
        assert!(ref_node.get("target").is_none(), "no `target` survives: {ref_node}");
        assert_eq!(
            ref_node.get("ref_id").and_then(serde_json::Value::as_str),
            Some(refs[0].0.as_str()),
            "the body node points at the minted entity_ref"
        );

        assert_eq!(proposal_status(&pool, &proposal_id_str).await, "accepted");
        assert!(resumed.load(Ordering::SeqCst), "the weave resumes the run");
    }

    // Slice 2 fix (review): the graph does not support the whole-payload `edit`
    // verb (corrections ride the per-node decision vector, slice 5). An `edit`
    // decision on a graph must fail loud (Invalid) rather than silently degrade to
    // a plain accept with the edited_payload dropped.
    #[tokio::test]
    async fn edit_apply_intent_graph_is_invalid() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        retarget_proposal(&pool, &proposal_id_str, "apply_intent_graph", create_only_graph()).await;

        let resumed = Arc::new(AtomicBool::new(false));
        let outcome = apply(
            &pool,
            proposal_id,
            "edit",
            Some(create_only_graph()),
            None,
            Some("k-graph-edit".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await;

        let Err(DecideError::Invalid(reason)) = outcome else {
            panic!("expected Invalid for edit on a graph, got {outcome:?}");
        };
        assert!(
            reason.contains("does not support edit"),
            "the reason names the unsupported edit verb: {reason}"
        );
        assert_eq!(entity_count(&pool).await, 0, "a rejected edit writes nothing");
        assert_eq!(
            proposal_status(&pool, &proposal_id_str).await,
            "pending",
            "an Invalid edit leaves the graph Proposal pending"
        );
        assert!(!resumed.load(Ordering::SeqCst), "an Invalid edit does not resume");
    }

    // Guards the gone-vs-wrong-thread distinction: a Journal Entry that EXISTS but
    // was created_from a Message in a DIFFERENT thread is a genuine cross-thread
    // attempt, not a delete race. It must stay `Invalid` (-32602), not become
    // NotDecidable.
    #[tokio::test]
    async fn accept_with_wrong_thread_journal_target_is_invalid() {
        let pool = memory_pool().await;
        let (run_id, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        // JE exists, but its created_from Message is in a foreign thread.
        let foreign_msg = insert_foreign_thread_user_message(&pool, run_id).await;
        let je_id = insert_journal_entry(&pool, &foreign_msg).await;
        retarget_proposal(
            &pool,
            &proposal_id_str,
            "update_journal_entry",
            serde_json::json!({
                "entity_id": je_id,
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "text", "text": "Edited." }]
            }),
        )
        .await;

        let resumed = Arc::new(AtomicBool::new(false));
        let outcome = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            None,
            Some("k-je-wrong-thread".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await;

        assert!(
            matches!(outcome, Err(DecideError::Invalid(_))),
            "a wrong-thread JE target (still present) is Invalid, not NotDecidable, got {outcome:?}"
        );
        assert_eq!(
            entity_count(&pool).await,
            1,
            "the wrong-thread JE remains; nothing else is written"
        );
        assert!(
            !resumed.load(Ordering::SeqCst),
            "an Invalid accept does not resume"
        );
    }

    // Slice 3 (ADR-0042): a graph entity node whose exact (case-insensitive)
    // name+type matches exactly ONE accepted entity resolves to `reuse` — Core
    // mints NO duplicate. Pre-seed an accepted Project "Lead Ads", then accept a
    // graph naming a project node "Lead Ads": the project count stays 1 (the
    // existing row is reused, not re-created); only the JE node mints. A
    // case-insensitive "lead ads" node reuses the same row too.
    #[tokio::test]
    async fn accept_apply_intent_graph_reuses_exact_match_no_duplicate() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        let existing_project = insert_named_entity(&pool, "project", "Lead Ads").await;

        // Graph: a JE + a project node whose name exactly matches the accepted
        // Project (different case to prove case-insensitivity), no links.
        let graph = serde_json::json!({
            "journal_entry": {
                "handle": "@je",
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "text", "text": "Worked on the project." }]
            },
            "entities": [
                { "handle": "@leadads", "type": "project", "name": "lead ads" }
            ],
            "links": []
        });
        retarget_proposal(&pool, &proposal_id_str, "apply_intent_graph", graph).await;

        let resumed = Arc::new(AtomicBool::new(false));
        let outcome = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            None,
            Some("k-graph-reuse".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await
        .expect("graph accept (reuse) succeeds");

        assert!(
            matches!(outcome, DecideOutcome::Accepted { .. }),
            "a reuse graph accepts: {outcome:?}"
        );

        // The existing Project is REUSED — no second project minted.
        assert_eq!(
            entity_count_of_type(&pool, "project").await,
            1,
            "the exact-match Project is reused, not duplicated"
        );
        // The reused project row is the SAME one (the pre-seeded id), unchanged.
        assert_eq!(
            only_entity_id_of_type(&pool, "project").await,
            existing_project,
            "the reused id is the pre-seeded Project, not a fresh mint"
        );
        // Total entities = the pre-seeded Project + the newly minted JE only.
        assert_eq!(
            entity_count(&pool).await,
            2,
            "only the JE is minted; the Project is reused"
        );
        assert_eq!(entity_count_of_type(&pool, "journal_entry").await, 1);

        assert_eq!(
            proposal_status(&pool, &proposal_id_str).await,
            "accepted",
            "the reuse graph Proposal is accepted"
        );
        assert!(resumed.load(Ordering::SeqCst), "the reuse graph accept resumes");
    }

    // Slice 3 (ADR-0042 "An ambiguous node has no silent fallback"): a graph
    // entity node whose exact name+type matches TWO OR MORE accepted entities is
    // `ambiguous` — Core neither guesses nor mints a duplicate. The whole accept
    // fails `Invalid`, the tx rolls back (nothing written: no JE, no Person), the
    // Proposal stays pending, and the Run is not resumed.
    #[tokio::test]
    async fn accept_apply_intent_graph_ambiguous_match_fails_whole_apply() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        // TWO accepted People both named "Morris".
        insert_named_entity(&pool, "person", "Morris").await;
        insert_named_entity(&pool, "person", "Morris").await;

        let graph = serde_json::json!({
            "journal_entry": {
                "handle": "@je",
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "text", "text": "Met Morris again." }]
            },
            "entities": [
                { "handle": "@morris", "type": "person", "name": "Morris" }
            ],
            "links": []
        });
        retarget_proposal(&pool, &proposal_id_str, "apply_intent_graph", graph).await;

        let resumed = Arc::new(AtomicBool::new(false));
        let outcome = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            None,
            Some("k-graph-ambiguous".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await;

        let Err(DecideError::Invalid(reason)) = outcome else {
            panic!("expected Invalid for an ambiguous node, got {outcome:?}");
        };
        assert!(
            reason.contains("@morris") || reason.contains("Morris"),
            "the ambiguous reason names the offending handle/label: {reason}"
        );

        // Whole tx rolled back: nothing minted. Only the two seeded People remain;
        // no JE, no third Person.
        assert_eq!(
            entity_count(&pool).await,
            2,
            "the ambiguous graph writes nothing — only the two seeded People remain"
        );
        assert_eq!(entity_count_of_type(&pool, "journal_entry").await, 0);
        assert_eq!(entity_count_of_type(&pool, "person").await, 2);

        assert_eq!(
            proposal_status(&pool, &proposal_id_str).await,
            "pending",
            "an ambiguous graph stays pending + re-decidable"
        );
        assert!(
            !resumed.load(Ordering::SeqCst),
            "an ambiguous graph does not resume"
        );
    }

    // Slice 3 (review): pin that the match is EXACT, not substring/prefix. A node
    // named "Lead" must NOT reuse an accepted Project "Lead Ads" — it mints a
    // fresh Project. Guards against a `.contains()`/`starts_with` regression the
    // same-string-modulo-case reuse test cannot catch.
    #[tokio::test]
    async fn accept_apply_intent_graph_near_miss_label_creates_not_reuses() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        insert_named_entity(&pool, "project", "Lead Ads").await;

        // The node's name is a PREFIX of the accepted Project, not equal to it.
        let graph = serde_json::json!({
            "journal_entry": {
                "handle": "@je",
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "text", "text": "Started something new." }]
            },
            "entities": [
                { "handle": "@lead", "type": "project", "name": "Lead" }
            ],
            "links": []
        });
        retarget_proposal(&pool, &proposal_id_str, "apply_intent_graph", graph).await;

        let resumed = Arc::new(AtomicBool::new(false));
        apply(
            &pool,
            proposal_id,
            "accept",
            None,
            None,
            Some("k-graph-near-miss".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await
        .expect("near-miss graph accept succeeds");

        // A substring/prefix match would have REUSED "Lead Ads" (count stays 1);
        // exact match mints a fresh "Lead", so there are TWO Projects.
        assert_eq!(
            entity_count_of_type(&pool, "project").await,
            2,
            "a prefix label is NOT an exact match — a fresh Project is minted, not reused"
        );
    }

    // Slice 3 (review): pin the `existing_id` hint branch — the model's primary
    // reuse signal. A node carrying an accepted same-type `existing_id` reuses it
    // WITHOUT relying on a name match (the node's name here differs from the
    // seeded Project's, so only the hint can drive the reuse).
    #[tokio::test]
    async fn accept_apply_intent_graph_existing_id_hint_reuses() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        let existing_project = insert_named_entity(&pool, "project", "Lead Ads").await;

        // The node's NAME does not match the seeded Project; only the
        // `existing_id` hint points at it. A reuse here proves the hint is honored.
        let graph = serde_json::json!({
            "journal_entry": {
                "handle": "@je",
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "text", "text": "Worked on it." }]
            },
            "entities": [
                {
                    "handle": "@p",
                    "type": "project",
                    "name": "A Differently Named Project",
                    "existing_id": existing_project
                }
            ],
            "links": []
        });
        retarget_proposal(&pool, &proposal_id_str, "apply_intent_graph", graph).await;

        let resumed = Arc::new(AtomicBool::new(false));
        apply(
            &pool,
            proposal_id,
            "accept",
            None,
            None,
            Some("k-graph-hint".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await
        .expect("existing_id-hint graph accept succeeds");

        // The hint drives reuse: no second Project minted, only the JE is new.
        assert_eq!(
            entity_count_of_type(&pool, "project").await,
            1,
            "the existing_id hint reuses the accepted Project (no duplicate), despite the name mismatch"
        );
        assert_eq!(
            only_entity_id_of_type(&pool, "project").await,
            existing_project,
            "the reused id is the hinted Project"
        );
        assert_eq!(entity_count_of_type(&pool, "journal_entry").await, 1);
    }

    /// The #179 graph fixture (ADR-0042): a JE + a Project + a Person + a Todo,
    /// with a `todo_project` link (Todo → Project) and a `todo_person` link
    /// (Todo → Person, role=related).
    fn linked_graph() -> serde_json::Value {
        serde_json::json!({
            "journal_entry": {
                "handle": "@je",
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "text", "text": "Talked through the Lead Ads work with Morris." }]
            },
            "entities": [
                { "handle": "@leadads", "type": "project", "name": "Lead Ads" },
                { "handle": "@morris", "type": "person", "name": "Morris" },
                { "handle": "@rodeo", "type": "todo", "title": "Figure out the Rodeo side" }
            ],
            "links": [
                { "kind": "todo_project", "from": "@rodeo", "to": "@leadads" },
                { "kind": "todo_person", "from": "@rodeo", "to": "@morris", "role": "related" }
            ]
        })
    }

    /// The `todo_person_refs` rows for a Todo, as `(person_id, role)` pairs.
    async fn todo_person_refs(pool: &SqlitePool, todo_id: &str) -> Vec<(String, String)> {
        sqlx::query_as("SELECT person_id, role FROM todo_person_refs WHERE todo_id = ?")
            .bind(todo_id)
            .fetch_all(pool)
            .await
            .expect("todo_person_refs rows")
    }

    /// How many `entity_revisions` rows exist for an entity (the "updated once"
    /// criterion: a freshly-minted JE has exactly ONE, its seq-1 revision).
    async fn entity_revision_count(pool: &SqlitePool, entity_id: &str) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM entity_revisions WHERE entity_id = ?")
            .bind(entity_id)
            .fetch_one(pool)
            .await
            .expect("count entity_revisions for entity")
    }

    /// The `(id, target_entity_id, label_snapshot)` of every `entity_ref` row whose
    /// source is `source_entity_id` (the JE), ordered by creation.
    async fn entity_refs_from(
        pool: &SqlitePool,
        source_entity_id: &str,
    ) -> Vec<(String, String, Option<String>)> {
        sqlx::query_as(
            "SELECT id, target_entity_id, label_snapshot FROM entity_refs \
             WHERE source_entity_id = ? ORDER BY created_at, id",
        )
        .bind(source_entity_id)
        .fetch_all(pool)
        .await
        .expect("entity_refs rows")
    }

    /// A journal-anchored graph whose JE body weaves two `entity_ref` placeholders
    /// (ADR-0042 slice 6): `[text, entity_ref @morris, text, entity_ref @leadads]`,
    /// with `journal_ref` links @je→@morris and @je→@leadads. Both referenced
    /// entities are fresh creates.
    fn woven_graph() -> serde_json::Value {
        serde_json::json!({
            "journal_entry": {
                "handle": "@je",
                "occurred_at": "2026-06-10T10:30:00",
                "body": [
                    { "type": "text", "text": "Talked with " },
                    { "type": "entity_ref", "target": "@morris" },
                    { "type": "text", "text": " about " },
                    { "type": "entity_ref", "target": "@leadads" }
                ]
            },
            "entities": [
                { "handle": "@morris", "type": "person", "name": "Morris" },
                { "handle": "@leadads", "type": "project", "name": "Lead Ads" }
            ],
            "links": [
                { "kind": "journal_ref", "from": "@je", "to": "@morris" },
                { "kind": "journal_ref", "from": "@je", "to": "@leadads" }
            ]
        })
    }

    // Slice 6 (ADR-0042 "Multi-ref Journal Entry weave is one write"): accepting a
    // journal-anchored graph whose JE body carries TWO entity_ref placeholders +
    // two journal_ref links weaves BOTH refs into the JE in a SINGLE revision. The
    // JE entity has exactly ONE entity_revisions row (the "updated once"
    // criterion); two entity_refs rows exist (JE→Morris, JE→Lead Ads); both body
    // placeholders are rewritten to `ref_id` nodes pointing at those rows (no
    // `target` key survives).
    #[tokio::test]
    async fn accept_apply_intent_graph_weaves_journal_refs_in_one_revision() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        retarget_proposal(&pool, &proposal_id_str, "apply_intent_graph", woven_graph()).await;

        let resumed = Arc::new(AtomicBool::new(false));
        let outcome = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            None,
            Some("k-graph-weave".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await
        .expect("woven graph accept succeeds");

        let anchor = match outcome {
            DecideOutcome::Accepted { entity_id, .. } => entity_id,
            other => panic!("expected Accepted, got {other:?}"),
        };

        // Three entities: JE + Person + Project.
        assert_eq!(entity_count(&pool).await, 3, "JE + Person + Project");
        let je_id = only_entity_id_of_type(&pool, "journal_entry").await;
        let person_id = only_entity_id_of_type(&pool, "person").await;
        let project_id = only_entity_id_of_type(&pool, "project").await;
        assert_eq!(anchor, je_id, "the reported anchor is the JE node's id");

        // "Updated once": the JE has EXACTLY ONE entity_revisions row (seq 1). The
        // weave is written WITH the JE's first revision, never as a follow-up update.
        assert_eq!(
            entity_revision_count(&pool, &je_id).await,
            1,
            "the JE is written ONCE — its woven body is its seq-1 revision"
        );

        // Two entity_refs rows: JE→Morris and JE→Lead Ads, each with a label
        // snapshot for fallback rendering.
        let refs = entity_refs_from(&pool, &je_id).await;
        assert_eq!(refs.len(), 2, "two entity_refs woven: {refs:?}");
        let targets: std::collections::HashSet<&str> =
            refs.iter().map(|(_, t, _)| t.as_str()).collect();
        assert!(
            targets.contains(person_id.as_str()) && targets.contains(project_id.as_str()),
            "the refs target Morris and Lead Ads: {refs:?}"
        );
        let labels: std::collections::HashSet<Option<&str>> =
            refs.iter().map(|(_, _, l)| l.as_deref()).collect();
        assert!(
            labels.contains(&Some("Morris")) && labels.contains(&Some("Lead Ads")),
            "each ref carries the entity's label snapshot: {refs:?}"
        );

        // Both body placeholders are rewritten to `ref_id` nodes that point at the
        // minted entity_refs — no `target` key remains anywhere in the stored body.
        let je = entity_data(&pool, &je_id).await;
        let body = je.get("body").and_then(serde_json::Value::as_array).expect("JE body array");
        let ref_nodes: Vec<&serde_json::Value> = body
            .iter()
            .filter(|n| n.get("type").and_then(serde_json::Value::as_str) == Some("entity_ref"))
            .collect();
        assert_eq!(ref_nodes.len(), 2, "two entity_ref body nodes survive: {je}");
        let minted_ref_ids: std::collections::HashSet<&str> =
            refs.iter().map(|(id, _, _)| id.as_str()).collect();
        for node in &ref_nodes {
            assert!(
                node.get("target").is_none(),
                "no `target` key remains on a woven body node: {node}"
            );
            let ref_id = node
                .get("ref_id")
                .and_then(serde_json::Value::as_str)
                .expect("woven body node carries ref_id");
            assert!(
                minted_ref_ids.contains(ref_id),
                "body ref_id {ref_id} points at a minted entity_ref: {refs:?}"
            );
        }

        assert_eq!(proposal_status(&pool, &proposal_id_str).await, "accepted");
        assert!(resumed.load(Ordering::SeqCst), "the woven graph accept resumes");
    }

    // Slice 6 (ADR-0042 "its body entity_ref placeholder collapses to text"):
    // rejecting a referenced entity drops its journal_ref and collapses its body
    // placeholder to text — no entity_ref row, no dangling ref_id, and the rejected
    // entity is never minted. The surviving ref is still woven.
    #[tokio::test]
    async fn decision_vector_rejected_ref_collapses_body_to_text() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        retarget_proposal(&pool, &proposal_id_str, "apply_intent_graph", woven_graph()).await;

        let resumed = Arc::new(AtomicBool::new(false));
        // Reject @morris; accept @je and @leadads.
        let outcome = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            Some(vec![
                node_decision("@je", "accept", None, None),
                node_decision("@morris", "reject", None, None),
                node_decision("@leadads", "accept", None, None),
            ]),
            Some("k-graph-weave-reject".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await
        .expect("woven graph w/ rejection accept succeeds");

        match outcome {
            DecideOutcome::Accepted { .. } => {}
            other => panic!("expected Accepted, got {other:?}"),
        }

        // Morris is NOT minted: only JE + Project survive.
        assert_eq!(entity_count(&pool).await, 2, "JE + Project (Morris rejected)");
        assert_eq!(entity_count_of_type(&pool, "person").await, 0, "Morris not minted");
        let je_id = only_entity_id_of_type(&pool, "journal_entry").await;
        let project_id = only_entity_id_of_type(&pool, "project").await;

        // Exactly ONE entity_ref row — JE→Lead Ads — and the JE is still written once.
        let refs = entity_refs_from(&pool, &je_id).await;
        assert_eq!(refs.len(), 1, "only the surviving ref is woven: {refs:?}");
        assert_eq!(refs[0].1, project_id, "the surviving ref targets Lead Ads");
        assert_eq!(
            entity_revision_count(&pool, &je_id).await,
            1,
            "the JE is still written once"
        );

        // The Morris placeholder collapsed to text: exactly ONE entity_ref body
        // node (Lead Ads), and no body node carries a dangling ref_id or target for
        // a rejected entity.
        let je = entity_data(&pool, &je_id).await;
        let body = je.get("body").and_then(serde_json::Value::as_array).expect("JE body array");
        let ref_nodes: Vec<&serde_json::Value> = body
            .iter()
            .filter(|n| n.get("type").and_then(serde_json::Value::as_str) == Some("entity_ref"))
            .collect();
        assert_eq!(
            ref_nodes.len(),
            1,
            "only Lead Ads remains an entity_ref; Morris collapsed to text: {je}"
        );
        let surviving_ref_id = refs[0].0.as_str();
        assert_eq!(
            ref_nodes[0].get("ref_id").and_then(serde_json::Value::as_str),
            Some(surviving_ref_id),
            "the surviving body ref points at the one minted entity_ref"
        );
        // No body node names a `target` handle (every placeholder either wove to a
        // ref_id or collapsed to text).
        assert!(
            body.iter().all(|n| n.get("target").is_none()),
            "no `target` handle survives in the stored body: {je}"
        );

        assert_eq!(proposal_status(&pool, &proposal_id_str).await, "accepted");
        assert!(resumed.load(Ordering::SeqCst));
    }

    // Slice 4 (ADR-0042): accepting the #179-shaped graph APPLIES the
    // `todo_project` + `todo_person` links — topo-ordered so the Project/Person
    // exist before the Todo is minted. The Todo's stored `data.project_id` is the
    // minted Project's id, and one `todo_person_refs` row links it to Morris
    // (role=related). All four entities (JE + Project + Person + Todo) are created
    // in one tx, anchored on the JE.
    #[tokio::test]
    async fn accept_apply_intent_graph_applies_todo_project_and_person_links() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        retarget_proposal(&pool, &proposal_id_str, "apply_intent_graph", linked_graph()).await;

        let resumed = Arc::new(AtomicBool::new(false));
        let outcome = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            None,
            Some("k-graph-links".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await
        .expect("linked graph accept succeeds");

        let anchor = match outcome {
            DecideOutcome::Accepted { entity_id, .. } => entity_id,
            other => panic!("expected Accepted, got {other:?}"),
        };

        // Four entities, one of each type, all in one tx.
        assert_eq!(entity_count(&pool).await, 4, "JE + Project + Person + Todo");
        assert_eq!(entity_count_of_type(&pool, "journal_entry").await, 1);
        assert_eq!(entity_count_of_type(&pool, "project").await, 1);
        assert_eq!(entity_count_of_type(&pool, "person").await, 1);
        assert_eq!(entity_count_of_type(&pool, "todo").await, 1);

        let je_id = only_entity_id_of_type(&pool, "journal_entry").await;
        let project_id = only_entity_id_of_type(&pool, "project").await;
        let person_id = only_entity_id_of_type(&pool, "person").await;
        let todo_id = only_entity_id_of_type(&pool, "todo").await;

        assert_eq!(anchor, je_id, "the reported anchor is the JE node's id");

        // The Todo's stored data carries the minted Project's id (todo_project).
        let todo = entity_data(&pool, &todo_id).await;
        assert_eq!(
            todo.get("project_id").and_then(serde_json::Value::as_str),
            Some(project_id.as_str()),
            "the todo_project link sets the Todo's project_id to the minted Project: {todo}"
        );

        // Exactly one todo_person_refs row: (todo, Morris, related) from todo_person.
        let refs = todo_person_refs(&pool, &todo_id).await;
        assert_eq!(
            refs,
            vec![(person_id, "related".to_string())],
            "the todo_person link writes one ref to Morris with role=related"
        );

        assert_eq!(
            proposal_status(&pool, &proposal_id_str).await,
            "accepted",
            "the linked graph Proposal is accepted"
        );
        assert!(resumed.load(Ordering::SeqCst), "the linked graph accept resumes");
    }

    // Slice 4 (ADR-0042, #179 existing-project case): when the graph's Project
    // node resolves to an EXISTING accepted Project (reuse), the `todo_project`
    // link points the Todo at the PRE-SEEDED id — no duplicate Project. Pre-seed
    // "Lead Ads", then accept the #179 graph; the Todo links to the seeded id and
    // the project count stays 1.
    #[tokio::test]
    async fn accept_apply_intent_graph_links_todo_to_reused_project() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        let existing_project = insert_named_entity(&pool, "project", "Lead Ads").await;

        retarget_proposal(&pool, &proposal_id_str, "apply_intent_graph", linked_graph()).await;

        let resumed = Arc::new(AtomicBool::new(false));
        apply(
            &pool,
            proposal_id,
            "accept",
            None,
            None,
            Some("k-graph-links-reuse".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await
        .expect("reuse-linked graph accept succeeds");

        // No duplicate Project: the existing one is reused.
        assert_eq!(
            entity_count_of_type(&pool, "project").await,
            1,
            "the exact-match Project is reused, not duplicated"
        );
        assert_eq!(
            only_entity_id_of_type(&pool, "project").await,
            existing_project,
            "the reused id is the pre-seeded Project"
        );

        // The Todo links to the PRE-SEEDED Project id.
        let todo_id = only_entity_id_of_type(&pool, "todo").await;
        let todo = entity_data(&pool, &todo_id).await;
        assert_eq!(
            todo.get("project_id").and_then(serde_json::Value::as_str),
            Some(existing_project.as_str()),
            "the Todo links to the reused Project id, not a fresh mint: {todo}"
        );
    }

    // Slice 4 (review): a todo_person link whose `to` is a NON-Person handle (here
    // a Project) must FAIL the whole apply — `todo_person_refs.person_id` has no
    // type check downstream, so an un-validated endpoint would silently write a
    // corrupt ref. The up-front link-type validation rejects it before any write.
    #[tokio::test]
    async fn accept_apply_intent_graph_todo_person_to_non_person_is_invalid() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        // todo_person points at @leadads, which is a PROJECT node — type mismatch.
        let graph = serde_json::json!({
            "journal_entry": {
                "handle": "@je",
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "text", "text": "Lead Ads work." }]
            },
            "entities": [
                { "handle": "@leadads", "type": "project", "name": "Lead Ads" },
                { "handle": "@rodeo", "type": "todo", "title": "Figure out the Rodeo side" }
            ],
            "links": [
                { "kind": "todo_person", "from": "@rodeo", "to": "@leadads", "role": "related" }
            ]
        });
        retarget_proposal(&pool, &proposal_id_str, "apply_intent_graph", graph).await;

        let resumed = Arc::new(AtomicBool::new(false));
        let outcome = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            None,
            Some("k-graph-person-wrongtype".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await;

        assert!(
            matches!(outcome, Err(DecideError::Invalid(_))),
            "a todo_person link to a Project handle is Invalid, got {outcome:?}"
        );
        assert_eq!(entity_count(&pool).await, 0, "nothing is written — no corrupt person ref");
        let refs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM todo_person_refs")
            .fetch_one(&pool)
            .await
            .expect("count todo_person_refs");
        assert_eq!(refs, 0, "no todo_person_refs row is written");
        assert_eq!(proposal_status(&pool, &proposal_id_str).await, "pending");
        assert!(!resumed.load(Ordering::SeqCst));
    }

    // Slice 4 (review): a link endpoint naming an UNKNOWN handle fails the whole
    // apply (slice 4's all-or-nothing contract; the softer drop+report on a
    // decision-rejected node is slice 5).
    #[tokio::test]
    async fn accept_apply_intent_graph_unknown_link_endpoint_is_invalid() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        let graph = serde_json::json!({
            "journal_entry": {
                "handle": "@je",
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "text", "text": "Lead Ads work." }]
            },
            "entities": [
                { "handle": "@rodeo", "type": "todo", "title": "Figure out the Rodeo side" }
            ],
            // @ghost names no node.
            "links": [
                { "kind": "todo_project", "from": "@rodeo", "to": "@ghost" }
            ]
        });
        retarget_proposal(&pool, &proposal_id_str, "apply_intent_graph", graph).await;

        let outcome = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            None,
            Some("k-graph-unknown-endpoint".to_string()),
            resume_closure(pool.clone(), Arc::new(AtomicBool::new(false))),
        )
        .await;

        assert!(
            matches!(outcome, Err(DecideError::Invalid(_))),
            "an unknown link endpoint is Invalid, got {outcome:?}"
        );
        assert_eq!(entity_count(&pool).await, 0, "nothing is written");
        assert_eq!(proposal_status(&pool, &proposal_id_str).await, "pending");
    }

    // Slice 4 (review): the todo_person ROLE propagates from the link — a
    // `waiting_on` link round-trips to a `waiting_on` ref row (not silently
    // defaulted to `related`). Pins that the resolver reads link.role.
    #[tokio::test]
    async fn accept_apply_intent_graph_todo_person_waiting_on_role_round_trips() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        let graph = serde_json::json!({
            "journal_entry": {
                "handle": "@je",
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "text", "text": "Waiting on Morris." }]
            },
            "entities": [
                { "handle": "@morris", "type": "person", "name": "Morris" },
                { "handle": "@rodeo", "type": "todo", "title": "Figure out the Rodeo side" }
            ],
            "links": [
                { "kind": "todo_person", "from": "@rodeo", "to": "@morris", "role": "waiting_on" }
            ]
        });
        retarget_proposal(&pool, &proposal_id_str, "apply_intent_graph", graph).await;

        apply(
            &pool,
            proposal_id,
            "accept",
            None,
            None,
            Some("k-graph-waiting-on".to_string()),
            resume_closure(pool.clone(), Arc::new(AtomicBool::new(false))),
        )
        .await
        .expect("waiting_on graph accept succeeds");

        let person_id = only_entity_id_of_type(&pool, "person").await;
        let todo_id = only_entity_id_of_type(&pool, "todo").await;
        assert_eq!(
            todo_person_refs(&pool, &todo_id).await,
            vec![(person_id, "waiting_on".to_string())],
            "the waiting_on role propagates from the link, not defaulted to related"
        );
    }

    /// Build a per-node decision (slice 5): `(handle, accept|reject)` with optional
    /// `entity_id` override / `edited_fields` correction.
    fn node_decision(
        handle: &str,
        decision: &str,
        entity_id: Option<&str>,
        edited_fields: Option<serde_json::Value>,
    ) -> crate::protocol::NodeDecision {
        crate::protocol::NodeDecision {
            handle: handle.to_string(),
            decision: decision.to_string(),
            entity_id: entity_id.map(str::to_string),
            edited_fields,
        }
    }

    // Slice 5 (ADR-0042, the #179-adjacent case): accept the #179 graph but with a
    // decision vector REJECTING the Project node (@leadads) and accepting the rest.
    // The reject cascades: the Todo's `todo_project` link (→ @leadads) is DROPPED,
    // so the Todo lands STANDALONE (no project_id). The JE + Person are minted; NO
    // Project is minted. Exactly 3 entities (JE + Person + Todo).
    #[tokio::test]
    async fn decision_vector_reject_project_lands_todo_standalone() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        retarget_proposal(&pool, &proposal_id_str, "apply_intent_graph", linked_graph()).await;

        let resumed = Arc::new(AtomicBool::new(false));
        let outcome = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            Some(vec![
                node_decision("@je", "accept", None, None),
                node_decision("@leadads", "reject", None, None),
                node_decision("@morris", "accept", None, None),
                node_decision("@rodeo", "accept", None, None),
            ]),
            Some("k-reject-project".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await
        .expect("reject-project graph accept succeeds");

        assert!(
            matches!(outcome, DecideOutcome::Accepted { .. }),
            "rejecting one node still accepts the rest: {outcome:?}"
        );

        // No Project minted; JE + Person + Todo only.
        assert_eq!(entity_count(&pool).await, 3, "JE + Person + Todo, no Project");
        assert_eq!(
            entity_count_of_type(&pool, "project").await,
            0,
            "the rejected Project is not minted"
        );
        assert_eq!(entity_count_of_type(&pool, "journal_entry").await, 1);
        assert_eq!(entity_count_of_type(&pool, "person").await, 1);
        assert_eq!(entity_count_of_type(&pool, "todo").await, 1);

        // The Todo lands STANDALONE: the todo_project link to the rejected Project
        // is dropped, so the Todo carries NO project_id.
        let todo_id = only_entity_id_of_type(&pool, "todo").await;
        let todo = entity_data(&pool, &todo_id).await;
        assert!(
            todo.get("project_id")
                .and_then(serde_json::Value::as_str)
                .is_none(),
            "the rejected Project's todo_project link is dropped — the Todo is standalone: {todo}"
        );

        // The Person link survives (Morris was accepted).
        let person_id = only_entity_id_of_type(&pool, "person").await;
        assert_eq!(
            todo_person_refs(&pool, &todo_id).await,
            vec![(person_id, "related".to_string())],
            "the accepted Person's todo_person link survives the Project rejection"
        );

        assert_eq!(proposal_status(&pool, &proposal_id_str).await, "accepted");
        assert!(
            resumed.load(Ordering::SeqCst),
            "the partial-accept graph resumes"
        );
    }

    // Slice 5 (ADR-0042): a decision vector that REJECTS EVERY node writes nothing
    // and resolves the Proposal as `Rejected` (a vector rejecting all nodes is
    // effectively a plain `reject`). entity_count stays 0; the Run resumes.
    #[tokio::test]
    async fn decision_vector_reject_all_writes_nothing_and_rejects() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        retarget_proposal(&pool, &proposal_id_str, "apply_intent_graph", linked_graph()).await;

        let resumed = Arc::new(AtomicBool::new(false));
        let outcome = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            Some(vec![
                node_decision("@je", "reject", None, None),
                node_decision("@leadads", "reject", None, None),
                node_decision("@morris", "reject", None, None),
                node_decision("@rodeo", "reject", None, None),
            ]),
            Some("k-reject-all".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await
        .expect("reject-all graph decide succeeds");

        assert!(
            matches!(outcome, DecideOutcome::Rejected { .. }),
            "rejecting every node resolves as Rejected: {outcome:?}"
        );
        assert_eq!(entity_count(&pool).await, 0, "reject-all writes no entity");
        assert_eq!(
            proposal_status(&pool, &proposal_id_str).await,
            "rejected",
            "the all-rejected graph Proposal is rejected"
        );
        assert!(
            resumed.load(Ordering::SeqCst),
            "the reject-all graph resumes"
        );
    }

    // Slice 5 (ADR-0042, the picker path): an AMBIGUOUS node (two accepted "Morris")
    // is resolved by an `entity_id` override on its accept — the node collapses to
    // reuse-that-id. No new Person is minted; the todo_person link points at the
    // chosen Morris id. (Without the override this graph fails ambiguous, slice 3.)
    #[tokio::test]
    async fn decision_vector_entity_id_override_resolves_ambiguous() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        // Two accepted People named "Morris" — @morris is ambiguous.
        let morris_a = insert_named_entity(&pool, "person", "Morris").await;
        let morris_b = insert_named_entity(&pool, "person", "Morris").await;

        // A graph: JE + @morris (person) + @rodeo (todo) with a todo_person link.
        let graph = serde_json::json!({
            "journal_entry": {
                "handle": "@je",
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "text", "text": "Followed up with Morris." }]
            },
            "entities": [
                { "handle": "@morris", "type": "person", "name": "Morris" },
                { "handle": "@rodeo", "type": "todo", "title": "Figure out the Rodeo side" }
            ],
            "links": [
                { "kind": "todo_person", "from": "@rodeo", "to": "@morris", "role": "related" }
            ]
        });
        retarget_proposal(&pool, &proposal_id_str, "apply_intent_graph", graph).await;

        let resumed = Arc::new(AtomicBool::new(false));
        let outcome = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            Some(vec![
                node_decision("@je", "accept", None, None),
                // Override the ambiguous @morris to the FIRST seeded Morris id.
                node_decision("@morris", "accept", Some(&morris_a), None),
                node_decision("@rodeo", "accept", None, None),
            ]),
            Some("k-override".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await
        .expect("entity_id-override graph accept succeeds");

        assert!(
            matches!(outcome, DecideOutcome::Accepted { .. }),
            "the override resolves the ambiguity → accept: {outcome:?}"
        );

        // No third Person minted — only the two seeded Morrises remain.
        assert_eq!(
            entity_count_of_type(&pool, "person").await,
            2,
            "the override reuses an existing Morris — no new Person minted"
        );

        // The todo_person link points at the CHOSEN Morris (morris_a), not morris_b.
        let todo_id = only_entity_id_of_type(&pool, "todo").await;
        assert_eq!(
            todo_person_refs(&pool, &todo_id).await,
            vec![(morris_a.clone(), "related".to_string())],
            "the todo_person link uses the overridden id (morris_a), not morris_b ({morris_b})"
        );
    }

    // Slice 5 regression (ADR-0042 "accept-everything-unchanged"): a plain `accept`
    // with NO decisions vector applies the WHOLE slice-4 linked graph — a missing
    // vector means accept everything. Guards that the cascade doesn't break the
    // common path.
    #[tokio::test]
    async fn decision_vector_absent_accepts_whole_graph() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        retarget_proposal(&pool, &proposal_id_str, "apply_intent_graph", linked_graph()).await;

        let resumed = Arc::new(AtomicBool::new(false));
        let outcome = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            None, // NO decisions vector — accept everything.
            Some("k-accept-all-unchanged".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await
        .expect("accept-all (no vector) graph accept succeeds");

        assert!(matches!(outcome, DecideOutcome::Accepted { .. }));
        // All four entities land, links applied (the slice-4 behavior, unchanged).
        assert_eq!(entity_count(&pool).await, 4, "JE + Project + Person + Todo");
        let project_id = only_entity_id_of_type(&pool, "project").await;
        let person_id = only_entity_id_of_type(&pool, "person").await;
        let todo_id = only_entity_id_of_type(&pool, "todo").await;
        let todo = entity_data(&pool, &todo_id).await;
        assert_eq!(
            todo.get("project_id").and_then(serde_json::Value::as_str),
            Some(project_id.as_str()),
            "a missing vector accepts the todo_project link too: {todo}"
        );
        assert_eq!(
            todo_person_refs(&pool, &todo_id).await,
            vec![(person_id, "related".to_string())],
            "a missing vector accepts the todo_person link too"
        );
    }

    // Slice 5 (ADR-0042 `edited_fields`): an accept node carrying `edited_fields`
    // merges those fields over the CREATE node's payload BEFORE minting, then the
    // per-type validator runs. Here the Todo's title is corrected; the minted Todo
    // carries the EDITED title, not the model's proposed one.
    #[tokio::test]
    async fn decision_vector_edited_fields_corrects_create_node() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        retarget_proposal(&pool, &proposal_id_str, "apply_intent_graph", linked_graph()).await;

        let resumed = Arc::new(AtomicBool::new(false));
        apply(
            &pool,
            proposal_id,
            "accept",
            None,
            Some(vec![
                node_decision("@je", "accept", None, None),
                node_decision("@leadads", "accept", None, None),
                node_decision("@morris", "accept", None, None),
                // Correct the Todo's title before it is minted.
                node_decision(
                    "@rodeo",
                    "accept",
                    None,
                    Some(serde_json::json!({ "title": "Sort out the Rodeo logistics" })),
                ),
            ]),
            Some("k-edited-fields".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await
        .expect("edited_fields graph accept succeeds");

        let todo_id = only_entity_id_of_type(&pool, "todo").await;
        let todo = entity_data(&pool, &todo_id).await;
        assert_eq!(
            todo.get("title").and_then(serde_json::Value::as_str),
            Some("Sort out the Rodeo logistics"),
            "the Todo carries the edited_fields title, not the proposed one: {todo}"
        );
        // The links still apply over the edited node (the Project link survives).
        let project_id = only_entity_id_of_type(&pool, "project").await;
        assert_eq!(
            todo.get("project_id").and_then(serde_json::Value::as_str),
            Some(project_id.as_str()),
            "the edited Todo keeps its todo_project link"
        );
    }

    // Slice 5 (ADR-0042 mutual exclusion): a node carrying BOTH `entity_id` and
    // `edited_fields` is Invalid (you edit what you create; you override what you
    // reuse — never both). Nothing is written; the Proposal stays pending.
    #[tokio::test]
    async fn decision_vector_entity_id_and_edited_fields_is_invalid() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        let existing = insert_named_entity(&pool, "project", "Lead Ads").await;
        retarget_proposal(&pool, &proposal_id_str, "apply_intent_graph", linked_graph()).await;

        let resumed = Arc::new(AtomicBool::new(false));
        let outcome = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            Some(vec![
                node_decision("@je", "accept", None, None),
                // Both an override AND an edit on @leadads — contradictory.
                node_decision(
                    "@leadads",
                    "accept",
                    Some(&existing),
                    Some(serde_json::json!({ "name": "Renamed" })),
                ),
                node_decision("@morris", "accept", None, None),
                node_decision("@rodeo", "accept", None, None),
            ]),
            Some("k-both-override-edit".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await;

        assert!(
            matches!(outcome, Err(DecideError::Invalid(_))),
            "carrying both entity_id and edited_fields is Invalid, got {outcome:?}"
        );
        // Whole tx rolled back: only the pre-seeded Project remains.
        assert_eq!(
            entity_count(&pool).await,
            1,
            "nothing minted — only the pre-seeded Project remains"
        );
        assert_eq!(proposal_status(&pool, &proposal_id_str).await, "pending");
        assert!(!resumed.load(Ordering::SeqCst));
    }

    // Slice 5 (ADR-0042): an `entity_id` override that names a WRONG-TYPE entity is
    // Invalid (the override must be an accepted entity of the node's type). Here
    // @morris (person) is overridden to a Project id — rejected, nothing written.
    #[tokio::test]
    async fn decision_vector_entity_id_override_wrong_type_is_invalid() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        // A Project the override will wrongly point a Person node at.
        let project = insert_named_entity(&pool, "project", "Lead Ads").await;
        let graph = serde_json::json!({
            "journal_entry": {
                "handle": "@je",
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "text", "text": "Met Morris." }]
            },
            "entities": [
                { "handle": "@morris", "type": "person", "name": "Morris" }
            ],
            "links": []
        });
        retarget_proposal(&pool, &proposal_id_str, "apply_intent_graph", graph).await;

        let outcome = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            Some(vec![
                node_decision("@je", "accept", None, None),
                // Override @morris (person) to a PROJECT id — type mismatch.
                node_decision("@morris", "accept", Some(&project), None),
            ]),
            Some("k-override-wrong-type".to_string()),
            resume_closure(pool.clone(), Arc::new(AtomicBool::new(false))),
        )
        .await;

        assert!(
            matches!(outcome, Err(DecideError::Invalid(_))),
            "an entity_id override to a wrong-type entity is Invalid, got {outcome:?}"
        );
        // Only the pre-seeded Project remains; no JE, no Person minted.
        assert_eq!(entity_count(&pool).await, 1, "nothing minted on a wrong-type override");
        assert_eq!(entity_count_of_type(&pool, "journal_entry").await, 0);
        assert_eq!(proposal_status(&pool, &proposal_id_str).await, "pending");
    }

    // Slice 5 (review): `edited_fields` on a node that resolves to REUSE is Invalid
    // — you edit what you create, never rewrite what you reuse (ADR-0030 "entities
    // own their current structured state"). Pre-seed "Lead Ads"; the @leadads node
    // exact-matches it (reuse) but carries edited_fields → Invalid, nothing written.
    #[tokio::test]
    async fn decision_vector_edited_fields_on_reuse_is_invalid() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        insert_named_entity(&pool, "project", "Lead Ads").await;
        retarget_proposal(&pool, &proposal_id_str, "apply_intent_graph", linked_graph()).await;

        let resumed = Arc::new(AtomicBool::new(false));
        let outcome = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            Some(vec![
                node_decision("@je", "accept", None, None),
                // @leadads exact-matches the seeded Project → reuse; edited_fields
                // on a reuse node is not allowed.
                node_decision(
                    "@leadads",
                    "accept",
                    None,
                    Some(serde_json::json!({ "name": "Renamed Lead Ads" })),
                ),
                node_decision("@morris", "accept", None, None),
                node_decision("@rodeo", "accept", None, None),
            ]),
            Some("k-edit-reuse".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await;

        assert!(
            matches!(outcome, Err(DecideError::Invalid(_))),
            "edited_fields on a reuse node is Invalid, got {outcome:?}"
        );
        // The reused Project is untouched: count stays 1, nothing else minted.
        assert_eq!(entity_count(&pool).await, 1, "nothing minted; the reused Project is untouched");
        assert_eq!(
            entity_data(&pool, &only_entity_id_of_type(&pool, "project").await)
                .await
                .get("name")
                .and_then(serde_json::Value::as_str),
            Some("Lead Ads"),
            "the reused Project's name is NOT rewritten by edited_fields"
        );
        assert_eq!(proposal_status(&pool, &proposal_id_str).await, "pending");
        assert!(!resumed.load(Ordering::SeqCst));
    }

    // Slice 5 (review): rejecting ONLY the JE node (keeping the entities) applies
    // the rest as a JE-less graph — the entities mint, journal_ref links drop, and
    // the anchor falls to the first minted entity (ADR-0042 "Reject the @je node").
    #[tokio::test]
    async fn decision_vector_reject_je_only_applies_je_less_graph() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        retarget_proposal(&pool, &proposal_id_str, "apply_intent_graph", linked_graph()).await;

        let resumed = Arc::new(AtomicBool::new(false));
        let outcome = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            Some(vec![
                node_decision("@je", "reject", None, None),
                node_decision("@leadads", "accept", None, None),
                node_decision("@morris", "accept", None, None),
                node_decision("@rodeo", "accept", None, None),
            ]),
            Some("k-reject-je".to_string()),
            resume_closure(pool.clone(), resumed.clone()),
        )
        .await
        .expect("reject-JE-only graph accept succeeds");

        assert!(matches!(outcome, DecideOutcome::Accepted { .. }));
        // The JE is dropped; the three entities still mint as a JE-less graph.
        assert_eq!(entity_count_of_type(&pool, "journal_entry").await, 0, "the rejected JE is not minted");
        assert_eq!(entity_count_of_type(&pool, "project").await, 1);
        assert_eq!(entity_count_of_type(&pool, "person").await, 1);
        assert_eq!(entity_count_of_type(&pool, "todo").await, 1);
        // The todo_project / todo_person links still apply (their endpoints survived).
        let todo_id = only_entity_id_of_type(&pool, "todo").await;
        let project_id = only_entity_id_of_type(&pool, "project").await;
        assert_eq!(
            entity_data(&pool, &todo_id).await.get("project_id").and_then(serde_json::Value::as_str),
            Some(project_id.as_str()),
            "links between surviving entities still apply in a JE-less graph"
        );
        // No entity_sources row at all (the JE guard row is the only source the
        // graph ever writes, and the JE was rejected).
        let sources: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM entity_sources")
            .fetch_one(&pool)
            .await
            .expect("count entity_sources");
        assert_eq!(sources, 0, "no JE → no guard source row");
        assert_eq!(proposal_status(&pool, &proposal_id_str).await, "accepted");
    }

    // Slice 5 (review): a PRESENT but PARTIAL decision vector that OMITS a graph
    // handle still ACCEPTS that handle (missing entry = accept). Omit @morris from
    // a present vector; it must still mint and its todo_person link survive.
    #[tokio::test]
    async fn decision_vector_partial_omitted_handle_is_accepted() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        retarget_proposal(&pool, &proposal_id_str, "apply_intent_graph", linked_graph()).await;

        // A present vector that names every handle EXCEPT @morris.
        apply(
            &pool,
            proposal_id,
            "accept",
            None,
            Some(vec![
                node_decision("@je", "accept", None, None),
                node_decision("@leadads", "accept", None, None),
                node_decision("@rodeo", "accept", None, None),
                // @morris intentionally omitted → must still be accepted.
            ]),
            Some("k-partial-omit".to_string()),
            resume_closure(pool.clone(), Arc::new(AtomicBool::new(false))),
        )
        .await
        .expect("partial-vector graph accept succeeds");

        assert_eq!(
            entity_count_of_type(&pool, "person").await,
            1,
            "the omitted @morris handle is still accepted and minted (missing entry = accept)"
        );
        let todo_id = only_entity_id_of_type(&pool, "todo").await;
        let person_id = only_entity_id_of_type(&pool, "person").await;
        assert_eq!(
            todo_person_refs(&pool, &todo_id).await,
            vec![(person_id, "related".to_string())],
            "the omitted Person's todo_person link survives (accepted by omission)"
        );
    }

    // Slice 6 (review): TWO distinct handles that resolve to the SAME target entity
    // must share ONE entity_ref (UNIQUE(source,target)) — never a dangling body
    // ref_id. Pre-seed one accepted "Morris"; a graph with @m1 + @m2 both naming
    // "Morris" (both reuse the seeded id) + a journal_ref each → exactly ONE
    // entity_ref row, and BOTH body placeholders rewrite to its ref_id (every body
    // ref_id backed by a real row).
    #[tokio::test]
    async fn accept_apply_intent_graph_two_handles_same_target_share_one_ref() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        let morris = insert_named_entity(&pool, "person", "Morris").await;

        let graph = serde_json::json!({
            "journal_entry": {
                "handle": "@je",
                "occurred_at": "2026-06-10T10:30:00",
                "body": [
                    { "type": "text", "text": "Morris " },
                    { "type": "entity_ref", "target": "@m1" },
                    { "type": "text", "text": " and again " },
                    { "type": "entity_ref", "target": "@m2" }
                ]
            },
            "entities": [
                { "handle": "@m1", "type": "person", "name": "Morris" },
                { "handle": "@m2", "type": "person", "name": "Morris" }
            ],
            "links": [
                { "kind": "journal_ref", "from": "@je", "to": "@m1" },
                { "kind": "journal_ref", "from": "@je", "to": "@m2" }
            ]
        });
        retarget_proposal(&pool, &proposal_id_str, "apply_intent_graph", graph).await;

        apply(
            &pool,
            proposal_id,
            "accept",
            None,
            None,
            Some("k-same-target".to_string()),
            resume_closure(pool.clone(), Arc::new(AtomicBool::new(false))),
        )
        .await
        .expect("same-target graph accept succeeds");

        // No duplicate person minted (both handles reuse the seeded Morris).
        assert_eq!(entity_count_of_type(&pool, "person").await, 1, "no duplicate Morris minted");
        let je_id = only_entity_id_of_type(&pool, "journal_entry").await;

        // EXACTLY ONE entity_ref row (JE→Morris) — UNIQUE(source,target).
        let refs = entity_refs_from(&pool, &je_id).await;
        assert_eq!(refs.len(), 1, "two handles to one entity share ONE entity_ref: {refs:?}");
        assert_eq!(refs[0].1, morris, "the ref targets the seeded Morris");
        let real_ref_id = refs[0].0.as_str();

        // BOTH body placeholders rewrite to that SAME real ref_id — none dangling.
        let je = entity_data(&pool, &je_id).await;
        let body = je.get("body").and_then(serde_json::Value::as_array).expect("JE body");
        let ref_nodes: Vec<&serde_json::Value> = body
            .iter()
            .filter(|n| n.get("type").and_then(serde_json::Value::as_str) == Some("entity_ref"))
            .collect();
        assert_eq!(ref_nodes.len(), 2, "both placeholders survive as entity_ref nodes: {je}");
        for node in &ref_nodes {
            assert!(node.get("target").is_none(), "no target key remains: {node}");
            assert_eq!(
                node.get("ref_id").and_then(serde_json::Value::as_str),
                Some(real_ref_id),
                "every body ref_id is the single real entity_ref id (no dangling): {node}"
            );
        }
    }

    // Slice 6 (review): validate_body_targets rejects a JE body entity_ref whose
    // target has NO matching journal_ref link — a malformed graph that would
    // otherwise weave a dangling/collapsed placeholder. The whole apply fails before
    // any write.
    #[tokio::test]
    async fn accept_apply_intent_graph_body_ref_without_link_is_invalid() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        // Body references @morris, but there is NO journal_ref link to it.
        let graph = serde_json::json!({
            "journal_entry": {
                "handle": "@je",
                "occurred_at": "2026-06-10T10:30:00",
                "body": [
                    { "type": "text", "text": "Talked with " },
                    { "type": "entity_ref", "target": "@morris" }
                ]
            },
            "entities": [
                { "handle": "@morris", "type": "person", "name": "Morris" }
            ],
            "links": []
        });
        retarget_proposal(&pool, &proposal_id_str, "apply_intent_graph", graph).await;

        let outcome = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            None,
            Some("k-body-no-link".to_string()),
            resume_closure(pool.clone(), Arc::new(AtomicBool::new(false))),
        )
        .await;

        assert!(
            matches!(outcome, Err(DecideError::Invalid(_))),
            "a body entity_ref with no matching journal_ref link is Invalid, got {outcome:?}"
        );
        assert_eq!(entity_count(&pool).await, 0, "nothing is written");
        assert_eq!(proposal_status(&pool, &proposal_id_str).await, "pending");
    }

    // Final review (deep-review): a graph declaring the SAME handle on two nodes is
    // rejected before any tx — a duplicate would silently last-write-win in the
    // handle→id / handle→type maps and mis-resolve a link to an arbitrary entity
    // (the silent mis-link #179 set out to eliminate). ADR-0042 lists duplicate
    // handles as a structural error the gates must catch.
    #[tokio::test]
    async fn accept_apply_intent_graph_duplicate_handle_is_invalid() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        // Two entity nodes share the handle @dup (different types).
        let graph = serde_json::json!({
            "journal_entry": {
                "handle": "@je",
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "text", "text": "Dup handles." }]
            },
            "entities": [
                { "handle": "@dup", "type": "person", "name": "Morris" },
                { "handle": "@dup", "type": "project", "name": "Lead Ads" }
            ],
            "links": []
        });
        retarget_proposal(&pool, &proposal_id_str, "apply_intent_graph", graph).await;

        let outcome = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            None,
            Some("k-dup-handle".to_string()),
            resume_closure(pool.clone(), Arc::new(AtomicBool::new(false))),
        )
        .await;

        let Err(DecideError::Invalid(reason)) = outcome else {
            panic!("expected Invalid for a duplicate handle, got {outcome:?}");
        };
        assert!(
            reason.contains("@dup") || reason.to_lowercase().contains("more than one"),
            "the reason names the duplicate handle: {reason}"
        );
        assert_eq!(entity_count(&pool).await, 0, "nothing is written — no orphan, no mis-link");
        assert_eq!(proposal_status(&pool, &proposal_id_str).await, "pending");
    }

    // Final review (CodeRabbit): a Todo node that resolves to REUSE but carries
    // outgoing relationship links fails loud — the graph does not edit an existing
    // Todo's links (ADR-0042 create-and-link-only; ADR-0030 a reuse owns its state),
    // and silently dropping the link is forbidden. Pre-seed a Todo by title; the
    // graph reuses it (exact title match) and links it to a Project → Invalid.
    #[tokio::test]
    async fn accept_apply_intent_graph_reused_todo_with_links_is_invalid() {
        let pool = memory_pool().await;
        let (_run, proposal_id) = seed_parked_proposal(&pool).await;
        let proposal_id_str = proposal_id.to_string();

        insert_named_entity(&pool, "todo", "Figure out the Rodeo side").await;

        // @rodeo exact-matches the seeded Todo → reuse; it links to a new Project.
        let graph = serde_json::json!({
            "journal_entry": {
                "handle": "@je",
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "text", "text": "Rodeo work for Lead Ads." }]
            },
            "entities": [
                { "handle": "@leadads", "type": "project", "name": "Lead Ads" },
                { "handle": "@rodeo", "type": "todo", "title": "Figure out the Rodeo side" }
            ],
            "links": [
                { "kind": "todo_project", "from": "@rodeo", "to": "@leadads" }
            ]
        });
        retarget_proposal(&pool, &proposal_id_str, "apply_intent_graph", graph).await;

        let outcome = apply(
            &pool,
            proposal_id,
            "accept",
            None,
            None,
            Some("k-reused-todo-links".to_string()),
            resume_closure(pool.clone(), Arc::new(AtomicBool::new(false))),
        )
        .await;

        assert!(
            matches!(outcome, Err(DecideError::Invalid(_))),
            "a reused Todo with outgoing links is Invalid (no silent drop), got {outcome:?}"
        );
        // Only the pre-seeded Todo remains; the would-be Project + JE are not minted.
        assert_eq!(entity_count_of_type(&pool, "project").await, 0, "the linked Project is not minted");
        assert_eq!(entity_count_of_type(&pool, "journal_entry").await, 0);
        assert_eq!(entity_count(&pool).await, 1, "only the pre-seeded Todo remains");
        assert_eq!(proposal_status(&pool, &proposal_id_str).await, "pending");
    }
}
