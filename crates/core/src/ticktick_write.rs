//! The TickTick write family (ticktick-writes plan, W-A3/W-A4): the
//! `create_ticktick_task` decide orchestration — the two-phase accept
//! (phase A tx → one POST outside any tx → the guarded settle), the
//! independent deadline watchdog, the boot sweep, family-aware
//! replay/recovery, and the wire-state derivation every read shares.
//!
//! The remote call NEVER runs inside a transaction, `unknown` NEVER
//! auto-refires (mcp-A14), and exactly three triggers run the guarded settle:
//! phase C, the watchdog, and the boot sweep (a past-bound decide replay is
//! the belt — a decide is already a write; reads never settle).

use std::pin::Pin;
use std::sync::Arc;

use sqlx::SqlitePool;
use uuid::Uuid;

use crate::db::{self, RunStatus};
use crate::protocol::TickTickWriteState;
use crate::ticktick::client::{CreateTaskBody, WriteOutcome};

/// The stored `proposals.mutation_kind` for this family — derived from the
/// TOOL NAME at park (the tool's params carry no `mutation_kind` field).
pub(crate) const MUTATION_KIND: &str = "create_ticktick_task";

/// Slack added to the A7 timeout before the deadline watchdog settles
/// `unknown`: phase B's own timeout should always fire first, so the watchdog
/// only catches a dead decide task. Tests shrink it (with a tiny timeout
/// override) so a watchdog deadline elapses in milliseconds — same logic,
/// shorter clock.
#[cfg(not(test))]
const DEADLINE_GRACE_MS: i64 = 5_000;
#[cfg(test)]
const DEADLINE_GRACE_MS: i64 = 250;

/// The Core-computed absolute deadline (epoch ms) for a write stamped
/// `requested_at`: the A7 timeout plus grace. Carried on the wire
/// (`{state:"executing", deadline_at}`) so the client's bounded observe-poll
/// never computes the bound itself (it has neither `requested_at` nor the
/// timeout knob).
fn deadline_at_ms(requested_at: i64) -> i64 {
    let timeout_ms = crate::config::get().ticktick_timeout.as_millis() as i64;
    requested_at + timeout_ms + DEADLINE_GRACE_MS
}

// ─── the validated v1 payload ───────────────────────────────────────────

/// The one due tuple (mirrors the read side's `TickTickDue`): an
/// OFFSET-BEARING instant (W1: TickTick parses a naive datetime as UTC and
/// ignores `time_zone`, so a naive local wall time would silently land at the
/// wrong instant — naive is rejected), the all-day flag, and the IANA zone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TaskDue {
    pub date: String,
    pub is_all_day: bool,
    pub time_zone: String,
}

/// The validated `{title, note?, due?}` v1 payload — no projectId, no tags,
/// no priority; every create lands in Inbox.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TaskPayload {
    pub title: String,
    pub note: Option<String>,
    pub due: Option<TaskDue>,
}

/// Validate a task payload (W-A2). The SAME validator runs pre-park (the
/// model's original params) and on the fresh decide path (the EFFECTIVE
/// payload — an edit REPLACES what phase B sends, so an unvalidated edit
/// would sail to TickTick).
pub(crate) fn validate_task_payload(payload: &serde_json::Value) -> Result<TaskPayload, String> {
    let obj = payload
        .as_object()
        .ok_or_else(|| "payload must be a JSON object".to_string())?;
    for key in obj.keys() {
        if !matches!(key.as_str(), "title" | "note" | "due") {
            return Err(format!("unsupported task payload field {key:?}"));
        }
    }
    let title = obj
        .get("title")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "title is required and must be a string".to_string())?
        .trim()
        .to_string();
    if title.is_empty() {
        return Err("title must be non-empty".to_string());
    }
    let note = match obj.get("note") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(note)) => Some(note.clone()),
        Some(_) => return Err("note must be a string".to_string()),
    };
    let due = match obj.get("due") {
        None | Some(serde_json::Value::Null) => None,
        Some(due) => Some(validate_due(due)?),
    };
    Ok(TaskPayload { title, note, due })
}

fn validate_due(due: &serde_json::Value) -> Result<TaskDue, String> {
    let obj = due
        .as_object()
        .ok_or_else(|| "due must be a JSON object".to_string())?;
    for key in obj.keys() {
        if !matches!(key.as_str(), "date" | "is_all_day" | "time_zone") {
            return Err(format!("unsupported due field {key:?}"));
        }
    }
    let date = obj
        .get("date")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "due.date is required and must be a string".to_string())?
        .to_string();
    validate_due_date(&date)?;
    let is_all_day = match obj.get("is_all_day") {
        None => false,
        Some(serde_json::Value::Bool(flag)) => *flag,
        Some(_) => return Err("due.is_all_day must be a boolean".to_string()),
    };
    let time_zone = match obj.get("time_zone") {
        None | Some(serde_json::Value::Null) => String::new(),
        Some(serde_json::Value::String(zone)) => zone.clone(),
        Some(_) => return Err("due.time_zone must be a string".to_string()),
    };
    // A timed due is meaningless without its zone (the card renders local
    // wall time from it); an all-day due's instant is already fixed by the
    // offset, so the zone may be absent (TickTick falls back to the account
    // default for display).
    if !is_all_day && time_zone.is_empty() {
        return Err("due.time_zone is required for a timed due".to_string());
    }
    Ok(TaskDue {
        date,
        is_all_day,
        time_zone,
    })
}

/// `YYYY-MM-DDTHH:MM:SS(.mmm)?(Z|±HH:MM|±HHMM)` — the offset-REQUIRED shape
/// (W1 format addendum: TickTick parses all three offset spellings and
/// normalizes; a naive datetime is silently UTC, so it is rejected here).
fn validate_due_date(date: &str) -> Result<(), String> {
    const SHAPE: &str = "due.date must be YYYY-MM-DDTHH:MM:SS(.mmm)?(Z|±HH:MM|±HHMM)";
    let bytes = date.as_bytes();
    if bytes.len() < 20 {
        return Err(SHAPE.to_string());
    }
    crate::localtime::parse_local_datetime(&date[..19], "due.date")?;
    let mut rest = &date[19..];
    // Optional fractional seconds: `.` + 1..=3 digits.
    if rest.starts_with('.') {
        let digits = rest[1..]
            .bytes()
            .take_while(|byte| byte.is_ascii_digit())
            .count();
        if digits == 0 || digits > 3 {
            return Err(SHAPE.to_string());
        }
        rest = &rest[1 + digits..];
    }
    match rest.as_bytes() {
        [b'Z'] => Ok(()),
        [sign, h1, h2, b':', m1, m2] | [sign, h1, h2, m1, m2]
            if matches!(sign, b'+' | b'-')
                && [h1, h2, m1, m2].iter().all(|byte| byte.is_ascii_digit()) =>
        {
            let hours = (h1 - b'0') * 10 + (h2 - b'0');
            let minutes = (m1 - b'0') * 10 + (m2 - b'0');
            if hours <= 23 && minutes <= 59 {
                Ok(())
            } else {
                Err(SHAPE.to_string())
            }
        }
        _ => Err(SHAPE.to_string()),
    }
}

/// The exact wire body phase B sends for a validated payload.
fn create_task_body(payload: &TaskPayload) -> CreateTaskBody {
    let due = payload.due.as_ref();
    CreateTaskBody {
        title: payload.title.clone(),
        content: payload.note.clone(),
        due_date: due.map(|d| d.date.clone()),
        is_all_day: due.map(|d| d.is_all_day),
        time_zone: due.and_then(|d| {
            if d.time_zone.is_empty() {
                None
            } else {
                Some(d.time_zone.clone())
            }
        }),
    }
}

// ─── wire-state derivation (every read shares it) ───────────────────────

/// Whether a parked write's credential snapshot is STALE against the current
/// boot connection: no connection, a different token's fingerprint, or a
/// connection that lost `tasks:write`. Derived at read (both inputs are
/// durable/boot-stable), enforced at decide (phase A).
fn stale_connection(row_fp: &str) -> bool {
    match crate::ticktick::connection() {
        None => true,
        Some(conn) => !conn.writable || conn.credential_fp != row_fp,
    }
}

/// Map a `ticktick_writes` row to its wire state (W-A4). `proposed` derives
/// staleness fresh on EVERY read, so a stale card warns on first render in
/// any tab; `executing` carries the Core-computed absolute deadline.
fn wire_state_from_row(row: &db::ticktick_writes::TickTickWriteRow) -> TickTickWriteState {
    match row.state.as_str() {
        "executing" => TickTickWriteState::Executing {
            deadline_at: deadline_at_ms(row.requested_at.unwrap_or_else(db::now_ms)),
        },
        "settled" => match row.outcome.as_deref() {
            Some("created") => TickTickWriteState::Created {
                task_id: row.remote_task_id.clone(),
            },
            Some("failed") => TickTickWriteState::Failed {
                http_status: row.http_status,
            },
            // `unknown`, and (defensively) a settled row with a novel outcome.
            _ => TickTickWriteState::Unknown,
        },
        // `proposed`, and (defensively) any novel state.
        _ => TickTickWriteState::Proposed {
            stale_connection: stale_connection(&row.credential_fp),
        },
    }
}

/// The wire state for a Proposal, or `None` when it is not the write family
/// (no row). Serves `proposal/get`, `Segment::Proposal`, and the decide
/// handler alike, so live and reload render identically.
pub(crate) async fn wire_state_for_proposal(
    pool: &SqlitePool,
    proposal_id: &str,
) -> sqlx::Result<Option<TickTickWriteState>> {
    Ok(db::ticktick_writes::ticktick_write_by_proposal(pool, proposal_id)
        .await?
        .map(|row| wire_state_from_row(&row)))
}

// ─── the model-facing Decision results (all `is_error: false`) ───────────

/// The Decision-result content for a settled outcome (W-A3): the Decision
/// resolved; the outcome is content the model must relay.
fn decision_content(outcome: &WriteOutcome, title: &str) -> String {
    match outcome {
        WriteOutcome::Created { task_id } => {
            format!("Accepted. Created \"{title}\" in TickTick (task {task_id}).")
        }
        WriteOutcome::Failed { http_status } => {
            let cause = match http_status {
                Some(status) => format!("HTTP {status}"),
                None => "the request could not be sent".to_string(),
            };
            format!(
                "Accepted, but the TickTick write FAILED ({cause}). The task was NOT \
                 created. Do not retry on your own — tell the user, and let them re-ask \
                 or add it in TickTick."
            )
        }
        WriteOutcome::Unknown { .. } => UNKNOWN_DECISION_CONTENT.to_string(),
    }
}

/// The `unknown` Decision content — shared by phase C, the watchdog, and the
/// boot sweep (the settle triggers that may run without the payload at hand).
const UNKNOWN_DECISION_CONTENT: &str = "Accepted, but the write outcome is UNKNOWN (the \
     request may or may not have reached TickTick). Ask the user to check TickTick before \
     proposing it again.";

fn decision_result_payload(content: &str) -> String {
    serde_json::json!({
        "decision": "accept",
        "content": content,
        "is_error": false,
    })
    .to_string()
}

// ─── the decide orchestration ────────────────────────────────────────────

/// The injected resume (`worker::resume` in production; a counter in tests).
/// Self-guarded `parked → running` — safe to fire whenever the Run reads
/// parked.
pub(crate) type ResumeFn =
    Arc<dyn Fn(Uuid) -> Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send>> + Send + Sync>;

/// The injected phase-B POST (`client::create_task` in production; a fake
/// that counts calls in tests). Exactly one call per accepted proposal.
pub(crate) type PostFn = Arc<
    dyn Fn(CreateTaskBody) -> Pin<Box<dyn Future<Output = WriteOutcome> + Send>> + Send + Sync,
>;

/// The injected `proposal/changed` push: `(run_id, status, write_state)`.
/// Fired on ACTUAL transitions only — phase A's accept (executing) and a won
/// watchdog settle; the decide response itself carries the terminal state.
pub(crate) type NotifyFn = Arc<dyn Fn(Uuid, &str, &TickTickWriteState) + Send + Sync>;

/// The family decide's collaborators, injected so the whole path is
/// assertable against a `:memory:` pool (ADR-0029, mirroring `decide::apply`).
#[derive(Clone)]
pub(crate) struct WriteDeps {
    pub pool: SqlitePool,
    pub post: PostFn,
    pub resume: ResumeFn,
    pub notify: NotifyFn,
}

/// A successful family decide.
#[derive(Debug)]
pub(crate) enum WriteDecide {
    Rejected { run_id: Uuid },
    Accepted { run_id: Uuid, write: TickTickWriteState },
}

/// The family decide's failure vocabulary. `StaleConnection` is the DEDICATED
/// typed error (its own wire code, never folded into `proposal_not_pending` —
/// the Web reads that as "another tab decided" and retries doomed).
#[derive(Debug)]
pub(crate) enum WriteDecideError {
    StaleConnection,
    NotDecidable(String),
    Invalid(String),
    Internal(anyhow::Error),
}

/// Apply a Decision on a `create_ticktick_task` Proposal (W-A3). The family
/// precedence mirrors `decide::apply` — keyed replay, already-decided
/// recovery, then the fresh guarded path — but is write-state-aware: a replay
/// or recovery that finds `executing` answers "executing" (no resume, no
/// POST; past the deadline it may run the guarded settle — the belt), and
/// once settled every replay returns the recorded outcome, never a second
/// POST.
pub(crate) async fn decide(
    deps: &WriteDeps,
    proposal_id: Uuid,
    decision: &str,
    edited_payload: Option<serde_json::Value>,
    idempotency_key: Option<String>,
) -> Result<WriteDecide, WriteDecideError> {
    if !matches!(decision, "accept" | "reject" | "edit") {
        return Err(WriteDecideError::Invalid(format!(
            "decision {decision:?} not implemented"
        )));
    }
    let proposal_id = proposal_id.to_string();
    let proposal = db::load_proposal_for_decide(&deps.pool, &proposal_id)
        .await
        .map_err(|e| WriteDecideError::Internal(e.into()))?
        .ok_or_else(|| WriteDecideError::NotDecidable(format!("no proposal {proposal_id}")))?;
    if proposal.mutation_kind != MUTATION_KIND {
        // The handler routes by kind; reaching here is a router bug.
        return Err(WriteDecideError::Internal(anyhow::anyhow!(
            "proposal {proposal_id} is {:?}, not the TickTick write family",
            proposal.mutation_kind
        )));
    }
    let row = load_row(&deps.pool, &proposal_id).await?;

    // 1. Keyed replay — a repeat decide with the SAME recorded key returns the
    //    recorded outcome (any Run status), no re-apply, never a second POST.
    if let Some(recorded) = proposal.decision_idempotency_key.as_deref()
        && idempotency_key.as_deref() == Some(recorded)
    {
        return recorded_outcome(deps, &proposal, &row).await;
    }

    // 2. Already decided without a key match — recovery if the Run is still
    //    parked (the settle/resume path may still be owed), else not decidable.
    if proposal.status != "pending" {
        if (proposal.status == "accepted" || proposal.status == "rejected")
            && run_is_parked(&deps.pool, proposal.run_id).await?
        {
            return recorded_outcome(deps, &proposal, &row).await;
        }
        return Err(WriteDecideError::NotDecidable(format!(
            "proposal {proposal_id} is {} (not pending)",
            proposal.status
        )));
    }

    // 3. Pending — the fresh path. The Run must be parked.
    if !run_is_parked(&deps.pool, proposal.run_id).await? {
        return Err(WriteDecideError::NotDecidable(format!(
            "run {} is not parked",
            proposal.run_id
        )));
    }

    if decision == "reject" {
        // Unchanged single-tx reject: flip + the declined tool result; the
        // `proposed` row stays inert; no HTTP.
        db::decide_proposal::reject(
            &deps.pool,
            db::decide_proposal::DecisionCtx {
                run_id: proposal.run_id,
                proposal_id: &proposal_id,
                tool_call_id: &proposal.tool_call_id,
                decision_idempotency_key: idempotency_key.as_deref(),
                now_ms: db::now_ms(),
            },
            crate::decide::DECLINED_CONTENT,
        )
        .await
        .map_err(apply_error)?;
        resume_if_parked(deps, proposal.run_id).await?;
        return Ok(WriteDecide::Rejected {
            run_id: proposal.run_id,
        });
    }

    // Accept / edit — PHASE A. Credential guard first: the connection must
    // exist, be writable, and the CURRENT token's fingerprint must EQUAL the
    // row's park-time snapshot. The same credential matches across restarts
    // (the overnight accept works); a real change refuses typed, no POST.
    if stale_connection(&row.credential_fp) {
        return Err(WriteDecideError::StaleConnection);
    }

    // An `edit` requires a payload; the EFFECTIVE payload (edited ?? original)
    // is validated through the SAME validator as pre-park. Positioned on the
    // FRESH path, AFTER the replay/recovery branches (the ADR-0025 ordering
    // lesson): a malformed edit RETRY of an in-flight decide answered
    // "executing" above, never `invalid_params`. A fresh invalid edit rejects
    // with ZERO state change — before any flip, before any POST.
    let edited = match decision {
        "edit" => match edited_payload {
            Some(payload) => Some(payload),
            None => {
                return Err(WriteDecideError::Invalid(
                    "edit requires edited_payload".to_string(),
                ));
            }
        },
        _ => None,
    };
    let effective = edited.as_ref().unwrap_or(&proposal.payload);
    let task = validate_task_payload(effective).map_err(WriteDecideError::Invalid)?;

    // Phase A's transaction: guarded accept flip (stamping edited_payload +
    // key) + guarded `proposed → executing` + `requested_at`. The awaited
    // tool call stays PENDING; the Run stays parked.
    let requested_at = db::now_ms();
    let edited_str = edited.as_ref().map(|value| value.to_string());
    db::ticktick_writes::accept_ticktick_write(
        &deps.pool,
        proposal.run_id,
        &proposal_id,
        edited_str.as_deref(),
        idempotency_key.as_deref(),
        requested_at,
    )
    .await
    .map_err(apply_error)?;

    // The commit arms the deadline watchdog — its OWN spawned task, keyed by
    // the write row, independent of this decide task: a panic or abort
    // anywhere in phase B kills THIS task silently, and the watchdog still
    // settles `unknown`, resolves the tool call, and resumes the Run with no
    // user input and no restart. It never POSTs.
    let deadline_at = deadline_at_ms(requested_at);
    arm_watchdog(WatchdogCtx {
        pool: deps.pool.clone(),
        resume: deps.resume.clone(),
        notify: deps.notify.clone(),
        run_id: proposal.run_id,
        proposal_id: proposal_id.clone(),
        tool_call_id: proposal.tool_call_id.clone(),
        deadline_at,
    });
    (deps.notify)(
        proposal.run_id,
        "accepted",
        &TickTickWriteState::Executing { deadline_at },
    );

    // Phase B (no tx): exactly one POST.
    let outcome = (deps.post)(create_task_body(&task)).await;

    // Phase C: the ONE guarded settle, then resume.
    let write = settle_and_resume(
        deps,
        proposal.run_id,
        &proposal_id,
        &proposal.tool_call_id,
        &outcome,
        &decision_content(&outcome, &task.title),
    )
    .await
    .map_err(WriteDecideError::Internal)?;
    Ok(WriteDecide::Accepted {
        run_id: proposal.run_id,
        write,
    })
}

/// The recorded outcome for a keyed replay or an already-decided recovery —
/// write-state-aware (W-A3):
/// - `rejected` → `Rejected` (re-driving resume if still parked).
/// - accepted + `executing` within the deadline → "executing", NO resume (the
///   awaited tool call is unresolved — a resume transcript would be
///   provider-invalid) and NO POST; the watchdog owns the deadline.
/// - accepted + `executing` PAST the deadline → the belt: this decide (a
///   write) runs the guarded settle to `unknown`, resolves, resumes.
/// - accepted + `settled` → the recorded outcome (re-driving resume if the
///   Run is still parked — the phase-C-commit → resume crash window).
async fn recorded_outcome(
    deps: &WriteDeps,
    proposal: &db::DecidableProposal,
    row: &db::ticktick_writes::TickTickWriteRow,
) -> Result<WriteDecide, WriteDecideError> {
    match proposal.status.as_str() {
        "rejected" => {
            resume_if_parked(deps, proposal.run_id).await?;
            Ok(WriteDecide::Rejected {
                run_id: proposal.run_id,
            })
        }
        "accepted" => match row.state.as_str() {
            "executing" => {
                let deadline_at = deadline_at_ms(row.requested_at.unwrap_or_else(db::now_ms));
                if db::now_ms() >= deadline_at {
                    // Past-bound belt: a decide is already a write, so it may
                    // legitimately settle. `unknown` — the POST's fate is lost.
                    let write = settle_and_resume(
                        deps,
                        proposal.run_id,
                        &row.proposal_id,
                        &proposal.tool_call_id,
                        &WriteOutcome::Unknown { http_status: None },
                        UNKNOWN_DECISION_CONTENT,
                    )
                    .await
                    .map_err(WriteDecideError::Internal)?;
                    return Ok(WriteDecide::Accepted {
                        run_id: proposal.run_id,
                        write,
                    });
                }
                Ok(WriteDecide::Accepted {
                    run_id: proposal.run_id,
                    write: TickTickWriteState::Executing { deadline_at },
                })
            }
            "settled" => {
                resume_if_parked(deps, proposal.run_id).await?;
                Ok(WriteDecide::Accepted {
                    run_id: proposal.run_id,
                    write: wire_state_from_row(row),
                })
            }
            other => Err(WriteDecideError::Internal(anyhow::anyhow!(
                "accepted ticktick write {} in impossible state {other:?}",
                row.proposal_id
            ))),
        },
        other => Err(WriteDecideError::NotDecidable(format!(
            "proposal {} is {other} (not decidable)",
            row.proposal_id
        ))),
    }
}

/// Settle (guarded) + re-drive resume + return the durable wire state. Losing
/// the flip means someone else settled — the recorded outcome is returned;
/// resume is re-driven either way (self-guarded; covers the settled-but-
/// parked window).
async fn settle_and_resume(
    deps: &WriteDeps,
    run_id: Uuid,
    proposal_id: &str,
    tool_call_id: &str,
    outcome: &WriteOutcome,
    content: &str,
) -> anyhow::Result<TickTickWriteState> {
    let (outcome_str, http_status, remote_task_id) = match outcome {
        WriteOutcome::Created { task_id } => ("created", None, Some(task_id.as_str())),
        WriteOutcome::Failed { http_status } => ("failed", *http_status, None),
        WriteOutcome::Unknown { http_status } => ("unknown", *http_status, None),
    };
    let settle = db::ticktick_writes::settle_ticktick_write(
        &deps.pool,
        proposal_id,
        tool_call_id,
        outcome_str,
        http_status,
        remote_task_id,
        &decision_result_payload(content),
        db::now_ms(),
    )
    .await?;
    let state = match settle {
        db::ticktick_writes::Settle::Won => match outcome {
            WriteOutcome::Created { task_id } => TickTickWriteState::Created {
                task_id: Some(task_id.clone()),
            },
            WriteOutcome::Failed { http_status } => TickTickWriteState::Failed {
                http_status: *http_status,
            },
            WriteOutcome::Unknown { .. } => TickTickWriteState::Unknown,
        },
        db::ticktick_writes::Settle::AlreadySettled(row) => {
            let row = row.ok_or_else(|| {
                anyhow::anyhow!("ticktick write row vanished for proposal {proposal_id}")
            })?;
            wire_state_from_row(&row)
        }
    };
    if run_is_parked_plain(&deps.pool, run_id).await? {
        (deps.resume)(run_id).await?;
    }
    Ok(state)
}

// ─── the deadline watchdog (settlement's independent owner) ─────────────

/// Everything the watchdog needs, owned (it outlives the decide task).
pub(crate) struct WatchdogCtx {
    pub pool: SqlitePool,
    pub resume: ResumeFn,
    pub notify: NotifyFn,
    pub run_id: Uuid,
    pub proposal_id: String,
    pub tool_call_id: String,
    pub deadline_at: i64,
}

/// Arm the deadline watchdog (W-A3 trigger 2): its OWN spawned task, keyed by
/// the write row — NEVER a timeout combinator inside the decide task, whose
/// panic would silently kill the deadline with it. At the deadline it runs
/// the guarded settle to `unknown` (a no-op if phase C already settled),
/// resolves the tool call, resumes the Run, and pushes the settle
/// notification. It never POSTs — it only settles.
pub(crate) fn arm_watchdog(ctx: WatchdogCtx) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let wait_ms = (ctx.deadline_at - db::now_ms()).max(0) as u64;
        tokio::time::sleep(std::time::Duration::from_millis(wait_ms)).await;
        let deps = WriteDeps {
            pool: ctx.pool.clone(),
            // The watchdog never POSTs — the post arm is unreachable here.
            post: Arc::new(|_body| {
                Box::pin(async move { WriteOutcome::Unknown { http_status: None } })
            }),
            resume: ctx.resume.clone(),
            notify: ctx.notify.clone(),
        };
        // Only settle if the row still reads `executing` — the guarded flip
        // makes the check-and-settle race-free; a lost flip is a no-op.
        let settled = settle_and_resume(
            &deps,
            ctx.run_id,
            &ctx.proposal_id,
            &ctx.tool_call_id,
            &WriteOutcome::Unknown { http_status: None },
            UNKNOWN_DECISION_CONTENT,
        )
        .await;
        match settled {
            Ok(state) => {
                // Push the settle notification for the deciding tab (its own
                // decide response died with the decide task, if it did).
                (ctx.notify)(ctx.run_id, "accepted", &state);
            }
            Err(error) => {
                tracing::error!(
                    event = "ticktick_write.watchdog_settle_failed",
                    proposal_id = %ctx.proposal_id,
                    error = ?error
                );
            }
        }
    })
}

// ─── the boot sweep (settlement's crash owner) ───────────────────────────

/// The boot sweep (W-A3 trigger 3), covering BOTH crash windows — NO POST in
/// either branch:
/// - rows in `executing` → guarded settle `unknown` (resolve the tool call,
///   resume the Run);
/// - rows in `settled` whose Run still reads `parked` (the crash landed after
///   phase C's commit but before resume) → re-drive resume only.
///
/// Returns `(settled, resumed)` counts for boot logging.
pub(crate) async fn sweep(pool: &SqlitePool, resume: ResumeFn) -> anyhow::Result<(u64, u64)> {
    let deps = WriteDeps {
        pool: pool.clone(),
        post: Arc::new(|_body| Box::pin(async move { WriteOutcome::Unknown { http_status: None } })),
        resume: resume.clone(),
        notify: Arc::new(|_run_id, _status, _state| {}),
    };
    let mut settled = 0u64;
    for (proposal_id, tool_call_id, run_id) in
        db::ticktick_writes::executing_ticktick_writes(pool).await?
    {
        let Ok(run_id) = Uuid::parse_str(&run_id) else {
            continue;
        };
        settle_and_resume(
            &deps,
            run_id,
            &proposal_id,
            &tool_call_id,
            &WriteOutcome::Unknown { http_status: None },
            UNKNOWN_DECISION_CONTENT,
        )
        .await?;
        settled += 1;
    }

    let mut resumed = 0u64;
    for run_id in db::ticktick_writes::settled_ticktick_writes_still_parked(pool).await? {
        let Ok(run_id) = Uuid::parse_str(&run_id) else {
            continue;
        };
        if run_is_parked_plain(pool, run_id).await? {
            resume(run_id).await?;
            resumed += 1;
        }
    }
    Ok((settled, resumed))
}

// ─── shared plumbing ─────────────────────────────────────────────────────

async fn load_row(
    pool: &SqlitePool,
    proposal_id: &str,
) -> Result<db::ticktick_writes::TickTickWriteRow, WriteDecideError> {
    db::ticktick_writes::ticktick_write_by_proposal(pool, proposal_id)
        .await
        .map_err(|e| WriteDecideError::Internal(e.into()))?
        .ok_or_else(|| {
            WriteDecideError::Internal(anyhow::anyhow!(
                "ticktick write proposal {proposal_id} has no ticktick_writes row"
            ))
        })
}

async fn run_is_parked(pool: &SqlitePool, run_id: Uuid) -> Result<bool, WriteDecideError> {
    run_is_parked_plain(pool, run_id)
        .await
        .map_err(WriteDecideError::Internal)
}

async fn run_is_parked_plain(pool: &SqlitePool, run_id: Uuid) -> anyhow::Result<bool> {
    Ok(db::run_status(pool, run_id)
        .await?
        .is_some_and(RunStatus::is_parked))
}

async fn resume_if_parked(deps: &WriteDeps, run_id: Uuid) -> Result<(), WriteDecideError> {
    if run_is_parked(&deps.pool, run_id).await? {
        (deps.resume)(run_id)
            .await
            .map_err(WriteDecideError::Internal)?;
    }
    Ok(())
}

fn apply_error(e: db::ApplyError) -> WriteDecideError {
    match e {
        db::ApplyError::NotPending => {
            WriteDecideError::NotDecidable("proposal is no longer pending".to_string())
        }
        db::ApplyError::InvalidMutation(reason) => {
            WriteDecideError::Internal(anyhow::anyhow!(reason))
        }
        db::ApplyError::TargetMissing => {
            WriteDecideError::NotDecidable("proposal target no longer exists".to_string())
        }
        db::ApplyError::Sql(e) => WriteDecideError::Internal(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::db::test_support::memory_pool;
    use crate::ticktick::token::test_override::{self as token_override, test_connection};

    const TOKEN: &str = "tok_write_family";

    /// Seed a parked Run holding a pending `create_ticktick_task` Proposal via
    /// the REAL park path (`db::park_on_proposal` with the fingerprint), so
    /// the `ticktick_writes` row exists exactly as production writes it.
    /// Returns `(run_id, proposal_id, tool_call_id)`.
    async fn seed_parked_write(pool: &SqlitePool, fp: &str) -> (Uuid, Uuid, String) {
        seed_parked_write_with_payload(
            pool,
            fp,
            serde_json::json!({ "title": "buy milk", "note": "2%" }),
        )
        .await
    }

    async fn seed_parked_write_with_payload(
        pool: &SqlitePool,
        fp: &str,
        payload: serde_json::Value,
    ) -> (Uuid, Uuid, String) {
        let run_id = Uuid::now_v7();
        let proposal_id = Uuid::now_v7();
        let tool_call_id = format!("tc-{run_id}");
        let workflow = crate::workflow::Workflow {
            name: "test".to_string(),
            version: "1".to_string(),
            provider: "faux".to_string(),
            model: Some("m".to_string()),
            system_prompt: "sp".to_string(),
            thinking_level: Some("off".to_string()),
            tools: vec![crate::tools::propose_ticktick_task::NAME.to_string()],
            external_tools: false,
        };
        db::persist_thread_with_first_run(
            pool,
            Uuid::now_v7(),
            run_id,
            Uuid::now_v7(),
            Uuid::now_v7(),
            &workflow,
            "remind me to buy milk",
            &[],
            "t",
            db::now_ms(),
        )
        .await
        .expect("seed running run");
        let request_payload =
            serde_json::json!({ "payload": payload, "rationale": "user asked" }).to_string();
        let parked = db::park_on_proposal(
            pool,
            run_id,
            &proposal_id.to_string(),
            &tool_call_id,
            crate::tools::propose_ticktick_task::NAME,
            &request_payload,
            MUTATION_KIND,
            Some(fp),
            db::now_ms(),
        )
        .await
        .expect("park on write proposal");
        assert!(parked.won(), "seed: running -> parked wins");
        (run_id, proposal_id, tool_call_id)
    }

    /// Test deps: a post that counts calls and returns a scripted outcome
    /// (asserting the proposal row is already accepted+committed when the
    /// POST arrives — the envelope-ordering pin), a resume that counts and
    /// flips parked→running like `worker::resume`, and a notify recorder.
    struct TestDeps {
        deps: WriteDeps,
        posts: Arc<AtomicUsize>,
        resumes: Arc<AtomicUsize>,
        notifications: Arc<Mutex<Vec<(String, TickTickWriteState)>>>,
    }

    fn test_deps(pool: &SqlitePool, outcome: WriteOutcome) -> TestDeps {
        let posts = Arc::new(AtomicUsize::new(0));
        let resumes = Arc::new(AtomicUsize::new(0));
        let notifications = Arc::new(Mutex::new(Vec::new()));

        let post: PostFn = {
            let posts = posts.clone();
            let pool = pool.clone();
            Arc::new(move |_body| {
                let posts = posts.clone();
                let pool = pool.clone();
                let outcome = outcome.clone();
                Box::pin(async move {
                    // ENVELOPE ORDERING (W-A3): by the time the POST fires,
                    // phase A has COMMITTED — the proposal reads accepted and
                    // the write row reads executing on a fresh connection.
                    let status: String =
                        sqlx::query_scalar("SELECT status FROM proposals LIMIT 1")
                            .fetch_one(&pool)
                            .await
                            .expect("proposal status");
                    assert_eq!(status, "accepted", "phase A committed before the POST");
                    let state: String =
                        sqlx::query_scalar("SELECT state FROM ticktick_writes LIMIT 1")
                            .fetch_one(&pool)
                            .await
                            .expect("write state");
                    assert_eq!(state, "executing", "the write row reads executing mid-POST");
                    posts.fetch_add(1, Ordering::SeqCst);
                    outcome
                })
            })
        };
        let resume: ResumeFn = {
            let resumes = resumes.clone();
            let pool = pool.clone();
            Arc::new(move |run_id| {
                let resumes = resumes.clone();
                let pool = pool.clone();
                Box::pin(async move {
                    resumes.fetch_add(1, Ordering::SeqCst);
                    db::mark_run_running(&pool, run_id).await?;
                    Ok(())
                })
            })
        };
        let notify: NotifyFn = {
            let notifications = notifications.clone();
            Arc::new(move |_run_id, status, state| {
                notifications
                    .lock()
                    .unwrap()
                    .push((status.to_string(), state.clone()));
            })
        };
        TestDeps {
            deps: WriteDeps {
                pool: pool.clone(),
                post,
                resume,
                notify,
            },
            posts,
            resumes,
            notifications,
        }
    }

    async fn write_row(pool: &SqlitePool, proposal_id: Uuid) -> db::ticktick_writes::TickTickWriteRow {
        db::ticktick_writes::ticktick_write_by_proposal(pool, &proposal_id.to_string())
            .await
            .expect("read write row")
            .expect("write row exists")
    }

    async fn tool_call_result(pool: &SqlitePool, tool_call_id: &str) -> (String, Option<String>) {
        sqlx::query_as("SELECT status, result_payload FROM tool_calls WHERE id = ?")
            .bind(tool_call_id)
            .fetch_one(pool)
            .await
            .expect("tool call row")
    }

    async fn run_status_str(pool: &SqlitePool, run_id: Uuid) -> &'static str {
        db::run_status(pool, run_id)
            .await
            .expect("run status")
            .expect("run exists")
            .as_str()
    }

    fn fp() -> String {
        crate::ticktick::token::credential_fingerprint(TOKEN)
    }

    // ── the fresh accept path ────────────────────────────────────────────

    /// Accept happy path: phase A commits before the POST (asserted inside
    /// the fake post), EXACTLY ONE POST fires, the row settles `created` with
    /// the task id, the tool call resolves with the created Decision text,
    /// the Run resumes, and proposal/changed fired at accept (executing).
    #[tokio::test]
    async fn accept_posts_once_settles_created_and_resumes() {
        let pool = memory_pool().await;
        let _conn = token_override::install(Some(test_connection(TOKEN, "conn-1")));
        let (run_id, proposal_id, tool_call_id) = seed_parked_write(&pool, &fp()).await;
        let t = test_deps(
            &pool,
            WriteOutcome::Created {
                task_id: "tt-42".to_string(),
            },
        );

        let outcome = decide(
            &t.deps,
            proposal_id,
            "accept",
            None,
            Some("k1".to_string()),
        )
        .await
        .expect("accept succeeds");

        match outcome {
            WriteDecide::Accepted { run_id: r, write } => {
                assert_eq!(r, run_id);
                assert_eq!(
                    write,
                    TickTickWriteState::Created {
                        task_id: Some("tt-42".to_string())
                    }
                );
            }
            other => panic!("expected Accepted, got {other:?}"),
        }
        assert_eq!(t.posts.load(Ordering::SeqCst), 1, "exactly one POST");
        assert_eq!(t.resumes.load(Ordering::SeqCst), 1, "resumed once");
        assert_eq!(run_status_str(&pool, run_id).await, "running");

        let row = write_row(&pool, proposal_id).await;
        assert_eq!(row.state, "settled");
        assert_eq!(row.outcome.as_deref(), Some("created"));
        assert_eq!(row.remote_task_id.as_deref(), Some("tt-42"));

        let (status, payload) = tool_call_result(&pool, &tool_call_id).await;
        assert_eq!(status, "completed");
        let payload: serde_json::Value =
            serde_json::from_str(&payload.expect("decision payload")).unwrap();
        assert_eq!(payload["decision"], "accept");
        assert_eq!(payload["is_error"], false);
        assert_eq!(
            payload["content"],
            "Accepted. Created \"buy milk\" in TickTick (task tt-42)."
        );

        // proposal/changed #1 fired at accept with the executing state.
        let notifications = t.notifications.lock().unwrap();
        assert_eq!(notifications.len(), 1);
        assert_eq!(notifications[0].0, "accepted");
        assert!(matches!(
            notifications[0].1,
            TickTickWriteState::Executing { .. }
        ));
    }

    /// A failed write is a failed write: `failed` + HTTP status recorded, the
    /// FAILED Decision text resolves the tool call (`is_error: false` — the
    /// Decision resolved; the outcome is content), the Run still resumes.
    #[tokio::test]
    async fn accept_failed_outcome_settles_failed_and_resumes() {
        let pool = memory_pool().await;
        let _conn = token_override::install(Some(test_connection(TOKEN, "conn-1")));
        let (run_id, proposal_id, tool_call_id) = seed_parked_write(&pool, &fp()).await;
        let t = test_deps(
            &pool,
            WriteOutcome::Failed {
                http_status: Some(401),
            },
        );

        let outcome = decide(&t.deps, proposal_id, "accept", None, Some("k1".to_string()))
            .await
            .expect("decide resolves");
        match outcome {
            WriteDecide::Accepted { write, .. } => assert_eq!(
                write,
                TickTickWriteState::Failed {
                    http_status: Some(401)
                }
            ),
            other => panic!("expected Accepted(failed), got {other:?}"),
        }
        let row = write_row(&pool, proposal_id).await;
        assert_eq!(row.outcome.as_deref(), Some("failed"));
        assert_eq!(row.http_status, Some(401));
        let (_, payload) = tool_call_result(&pool, &tool_call_id).await;
        let payload: serde_json::Value = serde_json::from_str(&payload.unwrap()).unwrap();
        let content = payload["content"].as_str().unwrap();
        assert!(
            content.contains("FAILED (HTTP 401)")
                && content.contains("NOT created")
                && content.contains("Do not retry on your own"),
            "the failed Decision text instructs the model: {content}"
        );
        assert_eq!(payload["is_error"], false, "the Decision itself resolved");
        assert_eq!(run_status_str(&pool, run_id).await, "running");
        assert_eq!(t.resumes.load(Ordering::SeqCst), 1);
    }

    /// An `unknown` outcome records `unknown` and instructs the model to have
    /// the user check TickTick — and NEVER refires (pinned by replay below).
    #[tokio::test]
    async fn accept_unknown_outcome_settles_unknown() {
        let pool = memory_pool().await;
        let _conn = token_override::install(Some(test_connection(TOKEN, "conn-1")));
        let (_run_id, proposal_id, tool_call_id) = seed_parked_write(&pool, &fp()).await;
        let t = test_deps(&pool, WriteOutcome::Unknown { http_status: Some(502) });

        let outcome = decide(&t.deps, proposal_id, "accept", None, Some("k1".to_string()))
            .await
            .expect("decide resolves");
        match outcome {
            WriteDecide::Accepted { write, .. } => {
                assert_eq!(write, TickTickWriteState::Unknown);
            }
            other => panic!("expected Accepted(unknown), got {other:?}"),
        }
        let row = write_row(&pool, proposal_id).await;
        assert_eq!(row.outcome.as_deref(), Some("unknown"));
        assert_eq!(row.http_status, Some(502));
        let (_, payload) = tool_call_result(&pool, &tool_call_id).await;
        assert!(
            payload.unwrap().contains("check TickTick before"),
            "the unknown text asks the user to check TickTick"
        );

        // The user's retry is a NEW proposal: a same-key replay returns the
        // recorded unknown, zero additional POSTs (never-refire, mcp-A14).
        let replay = decide(&t.deps, proposal_id, "accept", None, Some("k1".to_string()))
            .await
            .expect("replay resolves");
        assert!(matches!(
            replay,
            WriteDecide::Accepted {
                write: TickTickWriteState::Unknown,
                ..
            }
        ));
        assert_eq!(t.posts.load(Ordering::SeqCst), 1, "unknown NEVER refires");
    }

    /// The EDITED payload wins phase B (the effective payload), and the
    /// created content names the EDITED title.
    #[tokio::test]
    async fn edit_sends_the_edited_payload() {
        let pool = memory_pool().await;
        let _conn = token_override::install(Some(test_connection(TOKEN, "conn-1")));
        let (_run, proposal_id, _tc) = seed_parked_write(&pool, &fp()).await;

        // A post that captures the body it was handed.
        let sent: Arc<Mutex<Option<CreateTaskBody>>> = Arc::new(Mutex::new(None));
        let base = test_deps(
            &pool,
            WriteOutcome::Created {
                task_id: "tt-edited".to_string(),
            },
        );
        let post: PostFn = {
            let sent = sent.clone();
            Arc::new(move |body| {
                let sent = sent.clone();
                Box::pin(async move {
                    *sent.lock().unwrap() = Some(body);
                    WriteOutcome::Created {
                        task_id: "tt-edited".to_string(),
                    }
                })
            })
        };
        let deps = WriteDeps {
            post,
            ..base.deps.clone()
        };

        decide(
            &deps,
            proposal_id,
            "edit",
            Some(serde_json::json!({
                "title": "buy oat milk",
                "due": {
                    "date": "2026-09-01T17:30:00-0700",
                    "time_zone": "America/Los_Angeles"
                }
            })),
            Some("k-edit".to_string()),
        )
        .await
        .expect("edit accepts");

        let body = sent.lock().unwrap().clone().expect("POST fired");
        assert_eq!(body.title, "buy oat milk", "the EDITED payload is what phase B sends");
        assert_eq!(body.content, None, "the edit REPLACED the payload (note gone)");
        assert_eq!(body.due_date.as_deref(), Some("2026-09-01T17:30:00-0700"));
        assert_eq!(body.is_all_day, Some(false));
        // The stamped edited_payload is durable on the proposal row.
        let edited: Option<String> =
            sqlx::query_scalar("SELECT edited_payload FROM proposals WHERE id = ?")
                .bind(proposal_id.to_string())
                .fetch_one(&pool)
                .await
                .expect("edited_payload");
        assert!(edited.unwrap().contains("buy oat milk"));
    }

    // ── validation (fresh path only, after replay/recovery) ─────────────

    /// A FRESH malformed edit (empty title / bad due) rejects `Invalid` with
    /// ZERO state change — before any flip, before any POST.
    #[tokio::test]
    async fn fresh_malformed_edit_rejects_with_zero_state_change() {
        let pool = memory_pool().await;
        let _conn = token_override::install(Some(test_connection(TOKEN, "conn-1")));
        let (run_id, proposal_id, tool_call_id) = seed_parked_write(&pool, &fp()).await;
        let t = test_deps(&pool, WriteOutcome::Unknown { http_status: None });

        for bad in [
            serde_json::json!({ "title": "   " }),
            serde_json::json!({ "title": "x", "due": { "date": "2026-09-01T17:30:00" } }),
            serde_json::json!({ "title": "x", "due": { "date": "not-a-date" } }),
        ] {
            let outcome = decide(
                &t.deps,
                proposal_id,
                "edit",
                Some(bad),
                Some(Uuid::now_v7().to_string()),
            )
            .await;
            assert!(
                matches!(outcome, Err(WriteDecideError::Invalid(_))),
                "malformed edit is invalid: {outcome:?}"
            );
        }
        // Zero state change, zero POSTs, still decidable.
        assert_eq!(t.posts.load(Ordering::SeqCst), 0);
        assert_eq!(write_row(&pool, proposal_id).await.state, "proposed");
        assert_eq!(run_status_str(&pool, run_id).await, "parked");
        let (status, _) = tool_call_result(&pool, &tool_call_id).await;
        assert_eq!(status, "pending", "the awaited tool call is untouched");
        // A payload-less fresh edit is Invalid too.
        assert!(matches!(
            decide(&t.deps, proposal_id, "edit", None, Some("k-x".to_string())).await,
            Err(WriteDecideError::Invalid(_))
        ));
    }

    /// A malformed (or payload-less) edit RETRY of an already-executing
    /// decide answers "executing" — family recovery sits BEFORE validation
    /// (the ADR-0025 ordering lesson), never `invalid_params`.
    #[tokio::test]
    async fn malformed_edit_retry_while_executing_answers_executing() {
        let pool = memory_pool().await;
        let _conn = token_override::install(Some(test_connection(TOKEN, "conn-1")));
        let (run_id, proposal_id, _tc) = seed_parked_write(&pool, &fp()).await;
        let t = test_deps(&pool, WriteOutcome::Unknown { http_status: None });

        // Phase A committed (as a crashed/paused decide would leave it), key recorded.
        db::ticktick_writes::accept_ticktick_write(
            &pool,
            run_id,
            &proposal_id.to_string(),
            Some(r#"{"title":"buy milk"}"#),
            Some("k-retry"),
            db::now_ms(),
        )
        .await
        .expect("phase A");

        // The same-key retry arrives MALFORMED (the tab re-sent a broken edit)
        // — it must answer "executing", not invalid_params.
        let outcome = decide(
            &t.deps,
            proposal_id,
            "edit",
            Some(serde_json::json!({ "title": "" })),
            Some("k-retry".to_string()),
        )
        .await
        .expect("retry answers executing");
        assert!(
            matches!(
                outcome,
                WriteDecide::Accepted {
                    write: TickTickWriteState::Executing { .. },
                    ..
                }
            ),
            "an executing retry answers executing: {outcome:?}"
        );
        // And a payload-less retry recovers identically.
        let outcome = decide(&t.deps, proposal_id, "edit", None, Some("k-retry".to_string()))
            .await
            .expect("payload-less retry answers executing");
        assert!(matches!(
            outcome,
            WriteDecide::Accepted {
                write: TickTickWriteState::Executing { .. },
                ..
            }
        ));
        assert_eq!(t.posts.load(Ordering::SeqCst), 0, "recovery never POSTs");
        assert_eq!(t.resumes.load(Ordering::SeqCst), 0, "executing never resumes");
        assert_eq!(run_status_str(&pool, run_id).await, "parked");
    }

    // ── the credential-fingerprint guard ─────────────────────────────────

    /// A plain restart with the SAME credential accepts — the overnight flow.
    /// (The test connection derives its fingerprint from the same token, as a
    /// rebooted Core would.)
    #[tokio::test]
    async fn same_credential_restart_accepts() {
        let pool = memory_pool().await;
        let (_run, proposal_id, _tc) = seed_parked_write(&pool, &fp()).await;
        // A "restart": a NEW Connection instance (new connection_id) from the
        // SAME token file.
        let _conn = token_override::install(Some(test_connection(TOKEN, "conn-after-reboot")));
        let t = test_deps(
            &pool,
            WriteOutcome::Created {
                task_id: "tt-morning".to_string(),
            },
        );
        let outcome = decide(&t.deps, proposal_id, "accept", None, Some("k1".to_string()))
            .await
            .expect("the morning accept succeeds");
        assert!(matches!(
            outcome,
            WriteDecide::Accepted {
                write: TickTickWriteState::Created { .. },
                ..
            }
        ));
        assert_eq!(t.posts.load(Ordering::SeqCst), 1);
    }

    /// A swapped credential refuses with the DEDICATED typed error and ZERO
    /// POSTs; the Proposal stays pending and reject still works.
    #[tokio::test]
    async fn swapped_credential_refuses_typed_and_reject_still_works() {
        let pool = memory_pool().await;
        let (run_id, proposal_id, tool_call_id) = seed_parked_write(&pool, &fp()).await;
        let _conn = token_override::install(Some(test_connection("tok_DIFFERENT", "conn-2")));
        let t = test_deps(&pool, WriteOutcome::Unknown { http_status: None });

        let outcome = decide(&t.deps, proposal_id, "accept", None, Some("k1".to_string())).await;
        assert!(
            matches!(outcome, Err(WriteDecideError::StaleConnection)),
            "a swapped credential is the dedicated typed error: {outcome:?}"
        );
        assert_eq!(t.posts.load(Ordering::SeqCst), 0, "no POST ever fires");
        assert_eq!(write_row(&pool, proposal_id).await.state, "proposed");
        let status: String = sqlx::query_scalar("SELECT status FROM proposals WHERE id = ?")
            .bind(proposal_id.to_string())
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(status, "pending", "the Proposal stays pending (reject remains available)");

        // A REMOVED credential refuses the same way.
        {
            let _disconnected = token_override::install(None);
            let outcome =
                decide(&t.deps, proposal_id, "accept", None, Some("k2".to_string())).await;
            assert!(matches!(outcome, Err(WriteDecideError::StaleConnection)));
        }

        // Reject still works under the stale connection.
        let outcome = decide(&t.deps, proposal_id, "reject", None, Some("k3".to_string()))
            .await
            .expect("reject succeeds");
        assert!(matches!(outcome, WriteDecide::Rejected { .. }));
        assert_eq!(
            write_row(&pool, proposal_id).await.state,
            "proposed",
            "a reject leaves the write row inert"
        );
        let (status, payload) = tool_call_result(&pool, &tool_call_id).await;
        assert_eq!(status, "completed");
        assert!(payload.unwrap().contains("declined"));
        assert_eq!(run_status_str(&pool, run_id).await, "running", "reject resumed");
    }

    // ── reject ───────────────────────────────────────────────────────────

    #[tokio::test]
    async fn reject_leaves_the_row_inert_no_http() {
        let pool = memory_pool().await;
        let _conn = token_override::install(Some(test_connection(TOKEN, "conn-1")));
        let (run_id, proposal_id, tool_call_id) = seed_parked_write(&pool, &fp()).await;
        let t = test_deps(&pool, WriteOutcome::Unknown { http_status: None });

        let outcome = decide(&t.deps, proposal_id, "reject", None, Some("r1".to_string()))
            .await
            .expect("reject succeeds");
        assert!(matches!(outcome, WriteDecide::Rejected { .. }));
        assert_eq!(t.posts.load(Ordering::SeqCst), 0, "no HTTP on reject");
        assert_eq!(write_row(&pool, proposal_id).await.state, "proposed");
        let (status, payload) = tool_call_result(&pool, &tool_call_id).await;
        assert_eq!(status, "completed");
        let payload: serde_json::Value = serde_json::from_str(&payload.unwrap()).unwrap();
        assert_eq!(payload["decision"], "reject");
        assert_eq!(payload["is_error"], false);
        assert_eq!(run_status_str(&pool, run_id).await, "running");
        assert_eq!(t.resumes.load(Ordering::SeqCst), 1);
    }

    // ── replay / recovery ────────────────────────────────────────────────

    /// Once settled, replays return the recorded outcome — never a second
    /// POST — and a settled-but-parked recovery re-drives resume.
    #[tokio::test]
    async fn settled_replay_returns_recorded_outcome_and_redrives_resume() {
        let pool = memory_pool().await;
        let _conn = token_override::install(Some(test_connection(TOKEN, "conn-1")));
        let (run_id, proposal_id, _tc) = seed_parked_write(&pool, &fp()).await;

        // First accept with a resume that FAILS to advance the Run (the
        // phase-C-commit → resume crash window).
        let t = test_deps(
            &pool,
            WriteOutcome::Created {
                task_id: "tt-9".to_string(),
            },
        );
        let failing_resume: ResumeFn =
            Arc::new(|_run_id| Box::pin(async move { anyhow::bail!("spawn failed") }));
        let deps = WriteDeps {
            resume: failing_resume,
            ..t.deps.clone()
        };
        let first = decide(&deps, proposal_id, "accept", None, Some("k1".to_string())).await;
        assert!(
            matches!(first, Err(WriteDecideError::Internal(_))),
            "the failed resume surfaces as internal (the decide retry recovers): {first:?}"
        );
        // The settle COMMITTED even though resume failed.
        assert_eq!(write_row(&pool, proposal_id).await.state, "settled");
        assert_eq!(run_status_str(&pool, run_id).await, "parked");

        // The same-key retry recovers: returns the recorded outcome and
        // re-drives resume — NO second POST.
        let retry = decide(&t.deps, proposal_id, "accept", None, Some("k1".to_string()))
            .await
            .expect("retry recovers");
        match retry {
            WriteDecide::Accepted { write, .. } => assert_eq!(
                write,
                TickTickWriteState::Created {
                    task_id: Some("tt-9".to_string())
                }
            ),
            other => panic!("expected recorded Created, got {other:?}"),
        }
        assert_eq!(t.posts.load(Ordering::SeqCst), 1, "exactly one POST ever");
        assert_eq!(run_status_str(&pool, run_id).await, "running", "resume re-driven");

        // An UN-keyed decide now that the Run advanced: not decidable.
        let stale = decide(&t.deps, proposal_id, "accept", None, Some("other".to_string())).await;
        assert!(matches!(stale, Err(WriteDecideError::NotDecidable(_))));
    }

    /// The past-bound belt: a keyed replay finding `executing` PAST the
    /// deadline runs the guarded settle itself — `unknown`, resolve, resume —
    /// and never POSTs. (This is exactly what the card's "Resolve now" issues.)
    #[tokio::test]
    async fn past_deadline_replay_settles_unknown_and_resumes() {
        let pool = memory_pool().await;
        let _conn = token_override::install(Some(test_connection(TOKEN, "conn-1")));
        let (run_id, proposal_id, tool_call_id) = seed_parked_write(&pool, &fp()).await;
        let t = test_deps(&pool, WriteOutcome::Unknown { http_status: None });

        // Phase A stamped FAR in the past — the deadline has long passed.
        let long_ago = db::now_ms() - 3_600_000;
        db::ticktick_writes::accept_ticktick_write(
            &pool,
            run_id,
            &proposal_id.to_string(),
            None,
            Some("k-belt"),
            long_ago,
        )
        .await
        .expect("phase A (stale)");

        let outcome = decide(&t.deps, proposal_id, "accept", None, Some("k-belt".to_string()))
            .await
            .expect("past-bound replay settles");
        assert!(matches!(
            outcome,
            WriteDecide::Accepted {
                write: TickTickWriteState::Unknown,
                ..
            }
        ));
        assert_eq!(t.posts.load(Ordering::SeqCst), 0, "the belt never POSTs");
        let row = write_row(&pool, proposal_id).await;
        assert_eq!(row.state, "settled");
        assert_eq!(row.outcome.as_deref(), Some("unknown"));
        let (status, _) = tool_call_result(&pool, &tool_call_id).await;
        assert_eq!(status, "completed");
        assert_eq!(run_status_str(&pool, run_id).await, "running");
    }

    // ── crash points + the boot sweep ────────────────────────────────────

    /// Crash after phase A (or mid-POST — the durable state is identical):
    /// the boot sweep settles `unknown`, resolves the tool call, resumes the
    /// Run — and never POSTs.
    #[tokio::test]
    async fn sweep_settles_executing_rows_unknown_and_resumes() {
        let pool = memory_pool().await;
        let _conn = token_override::install(Some(test_connection(TOKEN, "conn-1")));
        let (run_id, proposal_id, tool_call_id) = seed_parked_write(&pool, &fp()).await;
        db::ticktick_writes::accept_ticktick_write(
            &pool,
            run_id,
            &proposal_id.to_string(),
            None,
            Some("k-crash"),
            db::now_ms(),
        )
        .await
        .expect("phase A then crash");

        let resumes = Arc::new(AtomicUsize::new(0));
        let resume: ResumeFn = {
            let resumes = resumes.clone();
            let pool = pool.clone();
            Arc::new(move |run_id| {
                let resumes = resumes.clone();
                let pool = pool.clone();
                Box::pin(async move {
                    resumes.fetch_add(1, Ordering::SeqCst);
                    db::mark_run_running(&pool, run_id).await?;
                    Ok(())
                })
            })
        };
        let (settled, resumed) = sweep(&pool, resume).await.expect("sweep");
        assert_eq!(settled, 1);
        assert_eq!(resumed, 0, "branch 1 already resumed this run");
        assert_eq!(resumes.load(Ordering::SeqCst), 1);

        let row = write_row(&pool, proposal_id).await;
        assert_eq!(row.state, "settled");
        assert_eq!(row.outcome.as_deref(), Some("unknown"));
        let (status, payload) = tool_call_result(&pool, &tool_call_id).await;
        assert_eq!(status, "completed");
        assert!(payload.unwrap().contains("UNKNOWN"));
        assert_eq!(run_status_str(&pool, run_id).await, "running");
    }

    /// Crash after phase C's commit but before resume: the sweep's second
    /// branch re-drives resume ONLY — the recorded outcome is untouched and
    /// nothing re-settles.
    #[tokio::test]
    async fn sweep_resumes_settled_but_parked_runs_without_resettling() {
        let pool = memory_pool().await;
        let _conn = token_override::install(Some(test_connection(TOKEN, "conn-1")));
        let (run_id, proposal_id, tool_call_id) = seed_parked_write(&pool, &fp()).await;
        db::ticktick_writes::accept_ticktick_write(
            &pool,
            run_id,
            &proposal_id.to_string(),
            None,
            Some("k-c"),
            db::now_ms(),
        )
        .await
        .expect("phase A");
        // Phase C committed (created), then the crash — before resume.
        let settle = db::ticktick_writes::settle_ticktick_write(
            &pool,
            &proposal_id.to_string(),
            &tool_call_id,
            "created",
            Some(200),
            Some("tt-77"),
            r#"{"decision":"accept","content":"Accepted. Created \"buy milk\" in TickTick (task tt-77).","is_error":false}"#,
            db::now_ms(),
        )
        .await
        .expect("phase C");
        assert!(matches!(settle, db::ticktick_writes::Settle::Won));
        assert_eq!(run_status_str(&pool, run_id).await, "parked");

        let resumes = Arc::new(AtomicUsize::new(0));
        let resume: ResumeFn = {
            let resumes = resumes.clone();
            let pool = pool.clone();
            Arc::new(move |run_id| {
                let resumes = resumes.clone();
                let pool = pool.clone();
                Box::pin(async move {
                    resumes.fetch_add(1, Ordering::SeqCst);
                    db::mark_run_running(&pool, run_id).await?;
                    Ok(())
                })
            })
        };
        let (settled, resumed) = sweep(&pool, resume).await.expect("sweep");
        assert_eq!(settled, 0, "nothing re-settles");
        assert_eq!(resumed, 1, "resume only");
        let row = write_row(&pool, proposal_id).await;
        assert_eq!(row.outcome.as_deref(), Some("created"), "the recorded outcome stands");
        assert_eq!(row.remote_task_id.as_deref(), Some("tt-77"));
        assert_eq!(run_status_str(&pool, run_id).await, "running");
    }

    // ── the deadline watchdog ────────────────────────────────────────────

    /// WATCHDOG INDEPENDENCE (W-A3): panic/abort the decide task mid-POST —
    /// the independently-spawned watchdog STILL settles `unknown`, resolves
    /// the tool call, and resumes the Run, with NO restart and NO user input.
    /// (A timeout combinator inside the decide task fails this by
    /// construction: the panic would kill the deadline with it.) A tiny
    /// timeout override + the test grace keep the deadline in milliseconds.
    #[tokio::test]
    async fn watchdog_survives_a_panicking_decide_task_and_settles() {
        let _config = crate::config::test_override::install(crate::config::Config {
            ticktick_timeout: std::time::Duration::from_millis(50),
            ..Default::default()
        });
        let pool = memory_pool().await;
        let _conn = token_override::install(Some(test_connection(TOKEN, "conn-1")));
        let (run_id, proposal_id, tool_call_id) = seed_parked_write(&pool, &fp()).await;

        let resumes = Arc::new(AtomicUsize::new(0));
        let resume: ResumeFn = {
            let resumes = resumes.clone();
            let pool = pool.clone();
            Arc::new(move |run_id| {
                let resumes = resumes.clone();
                let pool = pool.clone();
                Box::pin(async move {
                    resumes.fetch_add(1, Ordering::SeqCst);
                    db::mark_run_running(&pool, run_id).await?;
                    Ok(())
                })
            })
        };
        let notifications = Arc::new(Mutex::new(Vec::new()));
        let notify: NotifyFn = {
            let notifications = notifications.clone();
            Arc::new(move |_run_id, status, state| {
                notifications
                    .lock()
                    .unwrap()
                    .push((status.to_string(), state.clone()));
            })
        };
        // The post PANICS mid-B — the decide task dies silently (detached).
        let post: PostFn = Arc::new(|_body| {
            Box::pin(async move { panic!("provider exploded mid-POST") })
        });
        let deps = WriteDeps {
            pool: pool.clone(),
            post,
            resume,
            notify,
        };

        // Run the decide as production does: a detached task whose panic is
        // swallowed once the JoinHandle drops.
        let decide_task = tokio::spawn({
            let deps = deps.clone();
            async move {
                let _ = decide(&deps, proposal_id, "accept", None, Some("k-boom".to_string()))
                    .await;
            }
        });
        let _ = decide_task.await; // joins with a panic — production drops the handle

        // The row is stuck executing; the decide task is DEAD. No restart, no
        // further input: the deadline elapses and the watchdog settles.
        assert_eq!(write_row(&pool, proposal_id).await.state, "executing");
        for _ in 0..100 {
            if write_row(&pool, proposal_id).await.state == "settled" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }

        let row = write_row(&pool, proposal_id).await;
        assert_eq!(row.state, "settled", "the watchdog settled without the decide task");
        assert_eq!(row.outcome.as_deref(), Some("unknown"));
        let (status, _) = tool_call_result(&pool, &tool_call_id).await;
        assert_eq!(status, "completed", "the watchdog resolved the tool call");
        assert_eq!(run_status_str(&pool, run_id).await, "running", "the watchdog resumed");
        assert_eq!(resumes.load(Ordering::SeqCst), 1);
        // The watchdog pushed the settle notification for the deciding tab.
        let notes = notifications.lock().unwrap();
        assert!(
            notes
                .iter()
                .any(|(status, state)| status == "accepted"
                    && matches!(state, TickTickWriteState::Unknown)),
            "the watchdog pushes the settle notification: {notes:?}"
        );
    }

    /// A normally-completing phase C beats the watchdog: when the deadline
    /// later fires, the guarded settle is a NO-OP (the recorded outcome and
    /// the tool result stand untouched).
    #[tokio::test]
    async fn watchdog_is_a_noop_after_phase_c_settled() {
        let _config = crate::config::test_override::install(crate::config::Config {
            ticktick_timeout: std::time::Duration::from_millis(50),
            ..Default::default()
        });
        let pool = memory_pool().await;
        let _conn = token_override::install(Some(test_connection(TOKEN, "conn-1")));
        let (run_id, proposal_id, tool_call_id) = seed_parked_write(&pool, &fp()).await;
        let t = test_deps(
            &pool,
            WriteOutcome::Created {
                task_id: "tt-fast".to_string(),
            },
        );

        decide(&t.deps, proposal_id, "accept", None, Some("k1".to_string()))
            .await
            .expect("accept settles created");
        let settled_row = write_row(&pool, proposal_id).await;
        assert_eq!(settled_row.outcome.as_deref(), Some("created"));
        let (_, payload_before) = tool_call_result(&pool, &tool_call_id).await;

        // Wait past the deadline; the armed watchdog fires and loses the
        // guarded flip.
        tokio::time::sleep(std::time::Duration::from_millis(700)).await;
        tokio::task::yield_now().await;

        let row = write_row(&pool, proposal_id).await;
        assert_eq!(row.outcome.as_deref(), Some("created"), "the outcome stands");
        assert_eq!(row.remote_task_id.as_deref(), Some("tt-fast"));
        let (_, payload_after) = tool_call_result(&pool, &tool_call_id).await;
        assert_eq!(payload_before, payload_after, "the tool result stands");
        assert_eq!(run_status_str(&pool, run_id).await, "running");
    }

    /// The watchdog contract end-to-end without a decide task at all (the
    /// "phase-C persistence failure" shape): phase A committed, a same-key
    /// retry answers "executing", then — NO further input — the armed
    /// watchdog settles `unknown`, resolves, resumes.
    #[tokio::test]
    async fn watchdog_settles_after_retry_answered_executing() {
        let _config = crate::config::test_override::install(crate::config::Config {
            ticktick_timeout: std::time::Duration::from_millis(50),
            ..Default::default()
        });
        let pool = memory_pool().await;
        let _conn = token_override::install(Some(test_connection(TOKEN, "conn-1")));
        let (run_id, proposal_id, tool_call_id) = seed_parked_write(&pool, &fp()).await;
        let t = test_deps(&pool, WriteOutcome::Unknown { http_status: None });

        let requested_at = db::now_ms();
        db::ticktick_writes::accept_ticktick_write(
            &pool,
            run_id,
            &proposal_id.to_string(),
            None,
            Some("k-wd"),
            requested_at,
        )
        .await
        .expect("phase A");
        arm_watchdog(WatchdogCtx {
            pool: pool.clone(),
            resume: t.deps.resume.clone(),
            notify: t.deps.notify.clone(),
            run_id,
            proposal_id: proposal_id.to_string(),
            tool_call_id: tool_call_id.clone(),
            deadline_at: deadline_at_ms(requested_at),
        });

        // One immediate same-key retry answers "executing".
        let retry = decide(&t.deps, proposal_id, "accept", None, Some("k-wd".to_string()))
            .await
            .expect("retry answers executing");
        assert!(matches!(
            retry,
            WriteDecide::Accepted {
                write: TickTickWriteState::Executing { .. },
                ..
            }
        ));

        // No further input: the watchdog settles at the deadline.
        for _ in 0..100 {
            if write_row(&pool, proposal_id).await.state == "settled" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let row = write_row(&pool, proposal_id).await;
        assert_eq!(row.state, "settled");
        assert_eq!(row.outcome.as_deref(), Some("unknown"));
        let (status, _) = tool_call_result(&pool, &tool_call_id).await;
        assert_eq!(status, "completed");
        assert_eq!(run_status_str(&pool, run_id).await, "running");
        assert_eq!(t.posts.load(Ordering::SeqCst), 0, "the watchdog never POSTs");
    }

    // ── wire-state derivation ────────────────────────────────────────────

    /// The derived `proposed` staleness: fresh under the SAME credential,
    /// stale under a swapped/absent/read-only one — recomputed on EVERY read,
    /// never connection-local state.
    #[tokio::test]
    async fn pending_wire_state_derives_staleness_per_read() {
        let pool = memory_pool().await;
        let (_run, proposal_id, _tc) = seed_parked_write(&pool, &fp()).await;
        let proposal_id = proposal_id.to_string();

        {
            let _same = token_override::install(Some(test_connection(TOKEN, "conn-1")));
            assert_eq!(
                wire_state_for_proposal(&pool, &proposal_id).await.unwrap(),
                Some(TickTickWriteState::Proposed {
                    stale_connection: false
                })
            );
        }
        {
            let _swapped = token_override::install(Some(test_connection("tok_OTHER", "conn-2")));
            assert_eq!(
                wire_state_for_proposal(&pool, &proposal_id).await.unwrap(),
                Some(TickTickWriteState::Proposed {
                    stale_connection: true
                })
            );
        }
        {
            let _gone = token_override::install(None);
            assert_eq!(
                wire_state_for_proposal(&pool, &proposal_id).await.unwrap(),
                Some(TickTickWriteState::Proposed {
                    stale_connection: true
                })
            );
        }
        {
            // The SAME token that lost tasks:write is stale too — accept must
            // not proceed on a read-only connection.
            let _read_only = token_override::install(Some(
                token_override::test_connection_read_only(TOKEN, "conn-3"),
            ));
            assert_eq!(
                wire_state_for_proposal(&pool, &proposal_id).await.unwrap(),
                Some(TickTickWriteState::Proposed {
                    stale_connection: true
                })
            );
        }
    }

    /// A non-family proposal derives NO write state (`None` — the field is
    /// omitted on the wire).
    #[tokio::test]
    async fn non_family_proposal_has_no_wire_state() {
        let pool = memory_pool().await;
        assert_eq!(
            wire_state_for_proposal(&pool, "no-such-proposal").await.unwrap(),
            None
        );
    }

    // ── payload validation ───────────────────────────────────────────────

    #[test]
    fn validate_task_payload_covers_the_contract() {
        // Minimal and full happy paths.
        let minimal = validate_task_payload(&serde_json::json!({ "title": " buy milk " }))
            .expect("minimal validates");
        assert_eq!(minimal.title, "buy milk", "the title is trimmed");
        assert_eq!(minimal.note, None);
        assert_eq!(minimal.due, None);

        let full = validate_task_payload(&serde_json::json!({
            "title": "buy milk",
            "note": "2%",
            "due": {
                "date": "2026-09-01T17:30:00-0700",
                "is_all_day": false,
                "time_zone": "America/Los_Angeles"
            }
        }))
        .expect("full validates");
        assert_eq!(full.due.as_ref().unwrap().time_zone, "America/Los_Angeles");

        // Every accepted offset spelling (W1 format addendum).
        for date in [
            "2026-09-01T17:30:00Z",
            "2026-09-01T17:30:00+0000",
            "2026-09-01T17:30:00-07:00",
            "2026-09-01T17:30:00.000+0000",
            "2026-09-01T17:30:00.5-0700",
        ] {
            validate_task_payload(&serde_json::json!({
                "title": "x",
                "due": { "date": date, "time_zone": "America/Los_Angeles" }
            }))
            .unwrap_or_else(|e| panic!("{date} validates: {e}"));
        }

        // Rejections.
        for (payload, why) in [
            (serde_json::json!({}), "missing title"),
            (serde_json::json!({ "title": "  " }), "whitespace title"),
            (serde_json::json!({ "title": 42 }), "non-string title"),
            (serde_json::json!({ "title": "x", "note": 42 }), "non-string note"),
            (
                serde_json::json!({ "title": "x", "projectId": "p" }),
                "projectId is not in the v1 payload (Inbox only)",
            ),
            (
                // NAIVE datetime: TickTick would silently parse it as UTC.
                serde_json::json!({ "title": "x", "due": { "date": "2026-09-01T17:30:00", "time_zone": "America/Los_Angeles" } }),
                "naive datetime",
            ),
            (
                serde_json::json!({ "title": "x", "due": { "date": "2026-13-01T17:30:00Z", "time_zone": "Z" } }),
                "month 13",
            ),
            (
                serde_json::json!({ "title": "x", "due": { "date": "2026-09-01T17:30:00+2500", "time_zone": "Z" } }),
                "offset hour 25",
            ),
            (
                serde_json::json!({ "title": "x", "due": { "date": "2026-09-01T17:30:00.1234Z", "time_zone": "Z" } }),
                "4 fractional digits",
            ),
            (
                serde_json::json!({ "title": "x", "due": { "date": "2026-09-01T17:30:00Z", "extra": 1, "time_zone": "Z" } }),
                "stray due field",
            ),
            (
                // A TIMED due requires its zone.
                serde_json::json!({ "title": "x", "due": { "date": "2026-09-01T17:30:00Z" } }),
                "timed due without time_zone",
            ),
            (
                serde_json::json!({ "title": "x", "due": { "is_all_day": true, "time_zone": "Z" } }),
                "due without date",
            ),
        ] {
            assert!(
                validate_task_payload(&payload).is_err(),
                "{why} must be rejected: {payload}"
            );
        }

        // An ALL-DAY due may omit the zone (the instant is already fixed).
        validate_task_payload(&serde_json::json!({
            "title": "x",
            "due": { "date": "2026-09-01T00:00:00-0700", "is_all_day": true }
        }))
        .expect("an all-day due without a zone validates");
    }
}
