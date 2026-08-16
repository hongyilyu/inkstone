//! Run cancellation as one deep, directly-testable verb (ADR-0029, extending the
//! `proposal/decide` → [`crate::decide`] precedent to `run/cancel`).
//!
//! [`cancel`] owns the whole decision AND its side effects: read the Run status,
//! pick the parked vs running guarded transition (ADR-0028), and — for a won
//! running-cancel with a live hub — signal the Worker, frame the Response (via
//! the injected `respond`), settle + publish the interrupted external calls, and
//! publish the terminal `Cancelled`, ALL under ONE hub-gate acquisition (review
//! P1 #3). Holding the gate across the settle tx AND the raw event sends makes a
//! concurrent `run/subscribe` snapshot-then-attach atomic w.r.t. the whole
//! sequence — it can never snapshot a pending call, miss the interrupted event,
//! then see only the terminal one.
//!
//! Response framing is INJECTED as `respond` so the verb frames it in the right
//! place (inside the gate, BEFORE the events — pinning the wire order
//! response → interrupted → cancelled) while staying assertable against a
//! `:memory:` pool. The hub lookup is likewise injected (`get_hub`), mirroring
//! how [`crate::decide::apply`] injects `worker::resume` (ADR-0026). The only
//! failure channel is a DB fault on `anyhow::Error` (the handler maps it to
//! `-32603`); the negative-but-expected domain outcomes ride the `respond`
//! string (`accepted` / `already_terminal` / `unknown_run`), ADR-0029.

use sqlx::SqlitePool;
use uuid::Uuid;

use crate::db::{self, RunStatus};
use crate::hub::{self, Hubs, RunHub};
use crate::protocol::RunEvent;

/// Cancel a Run (ADR-0014/0028/0029), framing the wire outcome through
/// `respond(outcome, live_tail)`:
///
/// - unknown / already-terminal / parked / running-without-hub: `respond` only,
///   no live stream (`live_tail = false`; the Client settles off the Response).
/// - a won running-cancel WITH a live hub: ONE gated critical section — settle
///   the guarded transition (interrupting still-pending external calls), signal
///   the Worker, `respond("accepted", true)`, then publish the interrupted
///   `tool_call` event(s) and the terminal `Cancelled` via RAW `send` under the
///   held gate (the gate is not re-entrant), then remove the hub. The Response
///   is framed BEFORE the events, so a subscriber that also
///   owns this connection sees `response → interrupted → cancelled`.
///
/// `get_hub` resolves the live [`RunHub`] (production: `|id| hub::get(hubs, id)`),
/// injected so the flow is testable against `:memory:` without the live registry.
pub async fn cancel<F>(
    pool: &SqlitePool,
    hubs: &Hubs,
    run_id: Uuid,
    get_hub: F,
    respond: impl FnOnce(&str, bool),
) -> anyhow::Result<()>
where
    F: Fn(Uuid) -> Option<RunHub>,
{
    // The status→hub→gate walk can be OUTRUN by a generation turnover (review
    // R11 #1): the gate wait may span the old generation's drain AND a new
    // activation, and committing then would cancel the NEW generation's status
    // while signalling only the OLD hub. Every stale observation loops back to
    // a fresh status read; drains are gated-atomic, so one revalidation per
    // turnover settles it.
    loop {
        match db::run_status(pool, run_id).await? {
            // Unknown run id — an ADR-0014 result value, not an error code.
            None => respond("unknown_run", false),
            Some(RunStatus::Parked) => {
                // Parked Run has no live Worker: a pure tier-2 flip of the Run + its
                // pending Proposal. A rollback (no pending Proposal, or a concurrent
                // decide/cancel already won) maps to already_terminal.
                let accepted = db::cancel_parked_run(pool, run_id, db::now_ms()).await?;
                respond(if accepted { "accepted" } else { "already_terminal" }, false);
            }
            Some(RunStatus::Running) => match get_hub(run_id) {
                // Won running-cancel WITH a live hub → the ONE gated critical section
                // (review P1 #3): settle → respond → publish interrupted → publish
                // Cancelled, all under a single `gate()` acquisition.
                Some(run_hub) => {
                    let guard = run_hub.gate().await;
                    // Post-gate generation revalidation (review R11 #1): stale →
                    // the run turned over while we waited; decide afresh.
                    if !hub::is_current(hubs, run_id, &run_hub) {
                        drop(guard);
                        continue;
                    }
                    let terminal = db::cancel_running_run(pool, run_id, db::now_ms()).await?;
                    if let db::Terminal::Won { interrupted } = terminal {
                        // Signal the live Worker (cleanup), frame the Response, then
                        // publish the interrupted rows and the terminal event — the
                        // Response BEFORE the events pins the wire order.
                        run_hub.cancel();
                        respond("accepted", true);
                        crate::worker::publish_interrupted(&run_hub, interrupted);
                        run_hub.send(RunEvent::Cancelled);
                        // Drain atomically (review R9 #1): removal joins the settle +
                        // publishes under this one gate acquisition, so an activation
                        // waiting on it observes only the fully-drained slot.
                        hub::remove_own(hubs, run_id, &run_hub);
                        drop(guard);
                    } else {
                        // The Worker committed a terminal transition first.
                        drop(guard);
                        respond("already_terminal", false);
                    }
                }
                // Running with NO live hub. Usually the boot-recovery window (the
                // sweep errors these Runs), BUT the `running` we read may be
                // STALE: generation A drained and B activated (registered + flipped
                // back to `running`) behind this walk — the CAS below would then
                // cancel B while signalling nothing (review R12 #1). Two closures:
                // a hub appearing before the CAS re-decides through the with-hub
                // branch; and hub-first activation means any generation whose
                // `running` this CAS could win against HAS a registered hub by
                // commit time — so a won CAS re-checks the registry and signals
                // the generation it actually cancelled.
                None => {
                    if get_hub(run_id).is_some() {
                        continue;
                    }
                    let terminal = db::cancel_running_run(pool, run_id, db::now_ms()).await?;
                    match terminal {
                        db::Terminal::Won { interrupted } => {
                            if let Some(run_hub) = get_hub(run_id) {
                                // The cancelled `running` belonged to a generation
                                // that activated mid-walk: deliver the full
                                // signalled path under its gate (mirrors the
                                // with-hub branch; the settle already committed).
                                let guard = run_hub.gate().await;
                                run_hub.cancel();
                                respond("accepted", true);
                                crate::worker::publish_interrupted(&run_hub, interrupted);
                                run_hub.send(RunEvent::Cancelled);
                                hub::remove_own(hubs, run_id, &run_hub);
                                drop(guard);
                            } else {
                                // Genuine boot-window zombie: no producer, no live
                                // stream — the Client settles off the Response.
                                respond("accepted", false);
                            }
                        }
                        _ => respond("already_terminal", false),
                    }
                }
            },
            // The two live states are matched above; everything else is terminal
            // (ADR-0028) — the Run already ended.
            Some(_) => respond("already_terminal", false),
        }
        return Ok(());
    }
}

#[cfg(test)]
mod tests {
    use super::cancel;
    use crate::db;
    use crate::db::test_support::memory_pool;
    use crate::hub;
    use crate::protocol::{RunEvent, ToolCallStatus, TranscriptToolResult};
    use crate::workflow::Workflow;
    use sqlx::SqlitePool;
    use std::cell::Cell;
    use uuid::Uuid;

    fn test_workflow() -> Workflow {
        Workflow {
            name: "test".to_string(),
            version: "1".to_string(),
            provider: "faux".to_string(),
            model: Some("m".to_string()),
            system_prompt: "sp".to_string(),
            thinking_level: Some("off".to_string()),
            tools: vec!["propose_workspace_mutation".to_string()],
            external_tools: false,
        }
    }

    /// Seed a Thread + initial Run via the real verb. The Run lands `running`
    /// (the state `run/post_message` leaves it in). Returns `run_id`.
    async fn seed_running_run(pool: &SqlitePool) -> Uuid {
        let run_id = Uuid::now_v7();
        db::persist_thread_with_first_run(
            pool,
            Uuid::now_v7(),
            run_id,
            Uuid::now_v7(),
            Uuid::now_v7(),
            &test_workflow(),
            "prompt",
            &[],
            "t",
            db::now_ms(),
        )
        .await
        .expect("seed running run");
        run_id
    }

    /// Seed a running Run, then park it on a Proposal via the real verb (the path
    /// the Worker loop takes). Returns `run_id` of the now-`parked` Run.
    async fn seed_parked_run(pool: &SqlitePool) -> Uuid {
        let run_id = seed_running_run(pool).await;
        let proposal_id = Uuid::now_v7().to_string();
        let tool_call_id = format!("tc-{run_id}");
        let parked = db::park_on_proposal(
            pool,
            run_id,
            &proposal_id,
            &tool_call_id,
            "propose_workspace_mutation",
            r#"{"mutation_kind":"create_journal_entry","payload":{}}"#,
            "create_journal_entry",
            db::now_ms(),
        )
        .await
        .expect("park on proposal");
        assert!(parked.won(), "seed: the running -> parked transition wins");
        run_id
    }

    async fn run_status_str(pool: &SqlitePool, run_id: Uuid) -> Option<&'static str> {
        db::run_status(pool, run_id)
            .await
            .expect("read run status")
            .map(db::RunStatus::as_str)
    }

    async fn pending_proposal_count(pool: &SqlitePool, run_id: Uuid) -> i64 {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM proposals p JOIN tool_calls tc ON tc.id = p.tool_call_id \
             WHERE tc.run_id = ?1 AND p.status = 'pending'",
        )
        .bind(run_id.to_string())
        .fetch_one(pool)
        .await
        .expect("count pending proposals")
    }

    /// Run `cancel`, recording the single `respond(outcome, live_tail)` call.
    async fn cancel_recording<F>(
        pool: &SqlitePool,
        hubs: &hub::Hubs,
        run_id: Uuid,
        get_hub: F,
    ) -> (String, bool)
    where
        F: Fn(Uuid) -> Option<hub::RunHub>,
    {
        let recorded: Cell<Option<(String, bool)>> = Cell::new(None);
        cancel(pool, hubs, run_id, get_hub, |outcome, live_tail| {
            recorded.set(Some((outcome.to_string(), live_tail)));
        })
        .await
        .expect("cancel ok");
        recorded.into_inner().expect("respond was called exactly once")
    }

    /// Post-gate generation revalidation (review R11 #1): a cancel whose
    /// status→hub walk resolved a STALE generation must not commit against the
    /// NEW generation's status while signalling only the old hub. The injected
    /// `get_hub` serves the stale hub first (the pre-turnover observation), then
    /// the current one — the revalidation loops and the cancel lands on B.
    #[tokio::test]
    async fn cancel_revalidates_the_generation_after_the_gate() {
        let pool = memory_pool().await;
        let hubs = hub::new_hubs();
        let run_id = seed_running_run(&pool).await;

        // Generation A was observed by the walk, then drained + replaced by B.
        let stale = hub::register(&hubs, run_id).expect("A registers");
        hub::remove_own(&hubs, run_id, &stale);
        let current = hub::register(&hubs, run_id).expect("B registers");

        let calls = Cell::new(0);
        let (outcome, live_tail) = cancel_recording(&pool, &hubs, run_id, |_| {
            calls.set(calls.get() + 1);
            Some(if calls.get() == 1 {
                stale.clone()
            } else {
                current.clone()
            })
        })
        .await;

        assert_eq!(outcome, "accepted");
        assert!(live_tail);
        assert!(
            current.is_cancelled(),
            "the CURRENT generation's Worker is signalled"
        );
        assert!(
            !stale.is_cancelled(),
            "the stale generation is never the one signalled"
        );
        assert!(
            hub::get(&hubs, run_id).is_none(),
            "the cancel drained the current generation's slot"
        );
    }

    /// The no-hub TOCTOU (review R12 #1): the walk observed a stale `running`
    /// with NO hub, but the `running` the CAS actually cancels belongs to a
    /// generation that activated mid-walk (hub-first: its hub is registered by
    /// the time its flip is visible). The post-CAS registry re-check must find
    /// and SIGNAL it — never cancel a generation while leaving its Worker
    /// streaming. The injected `get_hub` serves None for the walk and the
    /// pre-CAS check, then the live generation.
    #[tokio::test]
    async fn no_hub_cancel_signals_a_generation_that_activated_mid_walk() {
        let pool = memory_pool().await;
        let hubs = hub::new_hubs();
        let run_id = seed_running_run(&pool).await;
        let generation = hub::register(&hubs, run_id).expect("generation registers");

        let calls = Cell::new(0);
        let (outcome, live_tail) = cancel_recording(&pool, &hubs, run_id, |_| {
            calls.set(calls.get() + 1);
            if calls.get() <= 2 {
                None
            } else {
                Some(generation.clone())
            }
        })
        .await;

        assert_eq!(outcome, "accepted");
        assert!(live_tail, "the cancelled generation has a live tail");
        assert!(
            generation.is_cancelled(),
            "the generation whose `running` was cancelled IS signalled"
        );
        assert!(
            hub::get(&hubs, run_id).is_none(),
            "the cancel drained the generation's slot"
        );
    }

    // 1. Parked Run → accepted (no live tail); the Run AND its pending Proposal
    //    flip to cancelled. Pure tier-2 parked path; no Worker to signal.
    #[tokio::test]
    async fn parked_run_is_accepted_and_flips_run_and_proposal() {
        let pool = memory_pool().await;
        let run_id = seed_parked_run(&pool).await;
        assert_eq!(pending_proposal_count(&pool, run_id).await, 1, "seed: one pending proposal");

        // get_hub must NOT be consulted on the parked path — a parked Run has no
        // live Worker. Panic if it is, to pin the parked branch.
        let hubs = hub::new_hubs();
        let (outcome, live_tail) =
            cancel_recording(&pool, &hubs, run_id, |_| panic!("parked path must not touch the hub"))
                .await;

        assert_eq!(outcome, "accepted");
        assert!(!live_tail, "a parked cancel has no live tail");
        assert_eq!(run_status_str(&pool, run_id).await, Some("cancelled"), "run cancelled");
        assert_eq!(
            pending_proposal_count(&pool, run_id).await,
            0,
            "the pending proposal is cancelled too"
        );
    }

    // 2. Running Run, cancel WINS → accepted with a live tail; the verb signals
    //    the Worker (is_cancelled), publishes the terminal Cancelled, and removes
    //    the hub — ALL inside one gated section (review P1 #3).
    #[tokio::test]
    async fn running_won_signals_publishes_and_removes_under_the_gate() {
        let pool = memory_pool().await;
        let run_id = seed_running_run(&pool).await;

        let hubs = hub::new_hubs();
        let registered = hub::register(&hubs, run_id).expect("fresh run registers");
        let mut tail = registered.subscribe_raw();

        let (outcome, live_tail) =
            cancel_recording(&pool, &hubs, run_id, |id| hub::get(&hubs, id)).await;

        assert_eq!(outcome, "accepted");
        assert!(live_tail, "a won running-cancel carries a live tail");
        assert_eq!(run_status_str(&pool, run_id).await, Some("cancelled"), "run cancelled");
        assert!(registered.is_cancelled(), "the verb signalled the live Worker");
        // The terminal Cancelled was published under the gate (no separate step),
        // and the hub was removed.
        assert!(
            matches!(tail.try_recv(), Ok(RunEvent::Cancelled)),
            "the gated section broadcasts the terminal Cancelled"
        );
        assert!(hub::get(&hubs, run_id).is_none(), "the hub is removed after publish");
    }

    // 2b. Cancel-after-started (external-task-views A4): a running Run with a
    //     PENDING external call settles it as interrupted inside the SAME gated
    //     section, publishing interrupted `tool_call` → `Cancelled` in order.
    #[tokio::test]
    async fn cancel_after_external_started_publishes_interrupted_then_cancelled() {
        let pool = memory_pool().await;
        let run_id = seed_running_run(&pool).await;
        // The Worker reported an external call started; no finished frame yet.
        db::persist_tool_call(
            &pool,
            run_id,
            "tc-ext",
            "ticktick_filter_tasks",
            r#"{"filter":{"status":[0]}}"#,
            db::now_ms(),
        )
        .await
        .expect("persist pending external call");

        let hubs = hub::new_hubs();
        let registered = hub::register(&hubs, run_id).expect("fresh run registers");
        let mut tail = registered.subscribe_raw();

        let (outcome, _live_tail) =
            cancel_recording(&pool, &hubs, run_id, |id| hub::get(&hubs, id)).await;
        assert_eq!(outcome, "accepted");

        // The row settled in the cancel transition, as an error carrying the
        // Core-generated interrupted result.
        let (status, payload): (String, Option<String>) =
            sqlx::query_as("SELECT status, result_payload FROM tool_calls WHERE id = 'tc-ext'")
                .fetch_one(&pool)
                .await
                .expect("read settled row");
        assert_eq!(status, "errored");
        assert_eq!(
            serde_json::from_str::<TranscriptToolResult>(&payload.unwrap()).unwrap(),
            TranscriptToolResult::interrupted()
        );

        // Pinned order (all published under the one gate): interrupted tool_call
        // event(s) BEFORE the terminal Cancelled.
        let mut events = Vec::new();
        while let Ok(event) = tail.try_recv() {
            events.push(event);
        }
        match events.as_slice() {
            [
                RunEvent::ToolCall {
                    tool_call_id,
                    status: ToolCallStatus::Error,
                    result: Some(result),
                    ..
                },
                RunEvent::Cancelled,
            ] => {
                assert_eq!(tool_call_id, "tc-ext");
                assert_eq!(*result, TranscriptToolResult::interrupted());
            }
            other => panic!("expected [interrupted tool_call, Cancelled], got {other:?}"),
        }
    }

    // 3. A Run that already ended (terminal) → already_terminal, classified by
    //    is_terminal without touching the hub.
    #[tokio::test]
    async fn terminal_run_is_already_terminal() {
        let pool = memory_pool().await;
        let run_id = seed_running_run(&pool).await;
        assert!(db::complete_run(&pool, run_id, db::now_ms()).await.expect("complete").won());

        let hubs = hub::new_hubs();
        let (outcome, live_tail) =
            cancel_recording(&pool, &hubs, run_id, |_| panic!("a terminal Run must not touch the hub"))
                .await;

        assert_eq!(outcome, "already_terminal", "cancelling a completed Run is already_terminal");
        assert!(!live_tail);
    }

    // 4. An id with no Run row → unknown_run.
    #[tokio::test]
    async fn unknown_run_is_unknown_run() {
        let pool = memory_pool().await;
        let hubs = hub::new_hubs();
        let (outcome, live_tail) =
            cancel_recording(&pool, &hubs, Uuid::now_v7(), |_| panic!("unknown Run must not touch the hub"))
                .await;
        assert_eq!(outcome, "unknown_run");
        assert!(!live_tail);
    }

    // 5. Parked Run whose pending Proposal already vanished (a concurrent decide
    //    won) → the guarded parked transition rolls back → already_terminal.
    #[tokio::test]
    async fn parked_race_lost_is_already_terminal() {
        let pool = memory_pool().await;
        let run_id = seed_parked_run(&pool).await;
        // The concurrent decide accepted the Proposal out from under us: flip it off
        // 'pending' so cancel_parked_run finds no pending proposal and rolls back.
        sqlx::query(
            "UPDATE proposals SET status='accepted' \
             WHERE tool_call_id IN (SELECT id FROM tool_calls WHERE run_id = ?1)",
        )
        .bind(run_id.to_string())
        .execute(&pool)
        .await
        .expect("force proposal accepted");

        let hubs = hub::new_hubs();
        let (outcome, _live_tail) =
            cancel_recording(&pool, &hubs, run_id, |_| panic!("a lost parked race must not touch the hub"))
                .await;

        assert_eq!(outcome, "already_terminal", "a lost parked race is already_terminal");
        // The Run stays parked (the transition rolled back) — the live decide owns it.
        assert_eq!(run_status_str(&pool, run_id).await, Some("parked"), "run stays parked");
    }
}
