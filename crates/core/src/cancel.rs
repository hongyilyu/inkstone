//! Run cancellation as one deep, directly-testable verb (ADR-0029, extending the
//! `proposal/decide` → [`crate::decide`] precedent to `run/cancel`).
//!
//! [`cancel`] owns the whole decision AND its side effects: read the Run status,
//! pick the parked vs running guarded transition (ADR-0028), and — for a won
//! running-cancel with a live hub — signal the Worker, frame the Response (via
//! the injected `respond`), settle + publish the interrupted external calls, and
//! publish the terminal `Cancelled`, ALL under ONE lifecycle-slot + hub-gate
//! acquisition. Holding both across the settle tx AND the raw event sends makes
//! generation changes and `run/subscribe` classification atomic with the whole
//! sequence.
//!
//! Response framing is INJECTED as `respond` so the verb frames it in the right
//! place (inside the gate, BEFORE the events — pinning the wire order
//! response → interrupted → cancelled) while staying assertable against a
//! `:memory:` pool. The only failure channel is a DB fault on `anyhow::Error`
//! (the handler maps it to `-32603`); expected domain outcomes ride the `respond`
//! string (`accepted` / `already_terminal` / `unknown_run`), ADR-0029.

use sqlx::SqlitePool;
use uuid::Uuid;

use crate::db::{self, RunStatus};
use crate::hub::{self, Hubs};
use crate::protocol::RunEvent;

/// Cancel a Run (ADR-0014/0028/0029). The transient lifecycle slot makes
/// the durable status, active hub generation, and any terminal drain one
/// linearized decision. `respond(outcome, live_tail)` is framed before live
/// terminal events so the initiating connection observes response first.
pub async fn cancel(
    pool: &SqlitePool,
    hubs: &Hubs,
    run_id: Uuid,
    respond: impl FnOnce(&str, bool),
) -> anyhow::Result<()> {
    let lifecycle = hub::lifecycle(hubs, run_id).await;
    match db::run_status(pool, run_id).await? {
        None => respond("unknown_run", false),
        Some(RunStatus::Parked) => cancel_parked(pool, hubs, run_id, &lifecycle, respond).await?,
        Some(RunStatus::Running) => {
            cancel_running(pool, hubs, run_id, &lifecycle, respond).await?;
        }
        Some(_) => respond("already_terminal", false),
    }
    Ok(())
}

/// The parked arm — the existing parked-cancel first, then a STATE MATRIX for
/// the TickTick write family (ticktick-writes W-A3/W-A4) when it loses:
///
/// - a pending proposal (the write family's `proposed` included) → the
///   existing path wins: cancel proposal + Run.
/// - the parked-cancel LOSES exactly when no proposal is pending — for the
///   write family that means a decide accepted it. Re-read the write state:
///   - `executing` → REFUSED with `write_in_flight`; nothing changes — the
///     Web keeps the card and the subscription (never a local "stopped" over
///     a POST that may land). This also closes the accept → held-POST → Stop
///     race: however the reads interleave with the decide, an accepted
///     in-flight write can only answer `write_in_flight`.
///   - `settled` (the phase-C-commit → resume window) → a REAL
///     `parked → cancelled` CAS racing resume's self-guarded
///     `parked → running`. Cancel wins: no spawn, the recorded outcome stays
///     readable. Resume wins: re-read and route through the running path, so
///     the response always reflects the durable state.
///   - anything else (a decided non-family proposal) → `already_terminal`,
///     as today.
async fn cancel_parked(
    pool: &SqlitePool,
    hubs: &Hubs,
    run_id: Uuid,
    lifecycle: &hub::LifecycleGuard,
    respond: impl FnOnce(&str, bool),
) -> anyhow::Result<()> {
    let accepted = db::cancel_parked_run(pool, run_id, db::now_ms()).await?;
    if accepted {
        respond("accepted", false);
        return Ok(());
    }

    match db::ticktick_writes::ticktick_write_state_for_parked_run(pool, run_id)
        .await?
        .as_deref()
    {
        Some("executing") => respond("write_in_flight", false),
        Some("settled") => {
            if db::ticktick_writes::cancel_parked_run_settled_write(pool, run_id, db::now_ms())
                .await?
            {
                respond("accepted", false);
                return Ok(());
            }
            // Resume won the CAS: the Run is (or is about to be) running —
            // route through the running path so the answer matches durable
            // state. Anything else (a concurrent cancel won, or the Run
            // advanced past running) is already terminal.
            match db::run_status(pool, run_id).await? {
                Some(RunStatus::Running) => {
                    cancel_running(pool, hubs, run_id, lifecycle, respond).await?;
                }
                _ => respond("already_terminal", false),
            }
        }
        // `proposed` (a concurrent plain cancel won) or not the write family.
        _ => respond("already_terminal", false),
    }
    Ok(())
}

/// The running arm, whole (also the settled-window CAS loser's re-route): win
/// the guarded `running → cancelled`, signal the live Worker, publish the
/// terminal `Cancelled` — all under one gated section when a hub is live.
async fn cancel_running(
    pool: &SqlitePool,
    hubs: &Hubs,
    run_id: Uuid,
    lifecycle: &hub::LifecycleGuard,
    respond: impl FnOnce(&str, bool),
) -> anyhow::Result<()> {
    match hub::get(hubs, run_id) {
        Some(run_hub) => {
            let gate = run_hub.gate().await;
            match db::cancel_running_run(pool, run_id, db::now_ms()).await? {
                db::Terminal::Won { interrupted } => {
                    run_hub.cancel();
                    respond("accepted", true);
                    crate::worker::publish_interrupted(&run_hub, interrupted);
                    run_hub.send(RunEvent::Cancelled);
                    hub::remove_own(hubs, run_id, &run_hub, lifecycle);
                }
                db::Terminal::Lost => respond("already_terminal", false),
            }
            drop(gate);
        }
        None => {
            let terminal = db::cancel_running_run(pool, run_id, db::now_ms()).await?;
            respond(
                if terminal.won() {
                    "accepted"
                } else {
                    "already_terminal"
                },
                false,
            );
        }
    }
    Ok(())
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
            None,
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
    async fn cancel_recording(pool: &SqlitePool, hubs: &hub::Hubs, run_id: Uuid) -> (String, bool) {
        let recorded: Cell<Option<(String, bool)>> = Cell::new(None);
        cancel(pool, hubs, run_id, |outcome, live_tail| {
            recorded.set(Some((outcome.to_string(), live_tail)));
        })
        .await
        .expect("cancel ok");
        recorded
            .into_inner()
            .expect("respond was called exactly once")
    }

    // 1. Parked Run → accepted (no live tail); the Run AND its pending Proposal
    //    flip to cancelled. Pure tier-2 parked path; no Worker to signal.
    #[tokio::test]
    async fn parked_run_is_accepted_and_flips_run_and_proposal() {
        let pool = memory_pool().await;
        let run_id = seed_parked_run(&pool).await;
        assert_eq!(
            pending_proposal_count(&pool, run_id).await,
            1,
            "seed: one pending proposal"
        );

        let hubs = hub::new_hubs();
        let (outcome, live_tail) = cancel_recording(&pool, &hubs, run_id).await;

        assert_eq!(outcome, "accepted");
        assert!(!live_tail, "a parked cancel has no live tail");
        assert_eq!(
            run_status_str(&pool, run_id).await,
            Some("cancelled"),
            "run cancelled"
        );
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

        let (outcome, live_tail) = cancel_recording(&pool, &hubs, run_id).await;

        assert_eq!(outcome, "accepted");
        assert!(live_tail, "a won running-cancel carries a live tail");
        assert_eq!(
            run_status_str(&pool, run_id).await,
            Some("cancelled"),
            "run cancelled"
        );
        assert!(
            registered.is_cancelled(),
            "the verb signalled the live Worker"
        );
        // The terminal Cancelled was published under the gate (no separate step),
        // and the hub was removed.
        assert!(
            matches!(tail.try_recv(), Ok(RunEvent::Cancelled)),
            "the gated section broadcasts the terminal Cancelled"
        );
        assert!(
            hub::get(&hubs, run_id).is_none(),
            "the hub is removed after publish"
        );
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

        let (outcome, _live_tail) = cancel_recording(&pool, &hubs, run_id).await;
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
        assert!(
            db::complete_run(&pool, run_id, db::now_ms())
                .await
                .expect("complete")
                .won()
        );

        let hubs = hub::new_hubs();
        let (outcome, live_tail) = cancel_recording(&pool, &hubs, run_id).await;

        assert_eq!(
            outcome, "already_terminal",
            "cancelling a completed Run is already_terminal"
        );
        assert!(!live_tail);
    }

    // 4. An id with no Run row → unknown_run.
    #[tokio::test]
    async fn unknown_run_is_unknown_run() {
        let pool = memory_pool().await;
        let hubs = hub::new_hubs();
        let (outcome, live_tail) = cancel_recording(&pool, &hubs, Uuid::now_v7()).await;
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
        let (outcome, _live_tail) = cancel_recording(&pool, &hubs, run_id).await;

        assert_eq!(
            outcome, "already_terminal",
            "a lost parked race is already_terminal"
        );
        // The Run stays parked (the transition rolled back) — the live decide owns it.
        assert_eq!(
            run_status_str(&pool, run_id).await,
            Some("parked"),
            "run stays parked"
        );
    }

    // ── the TickTick write family's cancel matrix (ticktick-writes W-A3) ──

    /// Seed a parked Run holding a pending `create_ticktick_task` Proposal
    /// (the real park path, fingerprint snapshot included). Returns
    /// `(run_id, proposal_id, tool_call_id)`.
    async fn seed_parked_write(pool: &SqlitePool) -> (Uuid, String, String) {
        let run_id = seed_running_run(pool).await;
        let proposal_id = Uuid::now_v7().to_string();
        let tool_call_id = format!("tc-{run_id}");
        let parked = db::park_on_proposal(
            pool,
            run_id,
            &proposal_id,
            &tool_call_id,
            "propose_ticktick_task",
            r#"{"payload":{"title":"buy milk"}}"#,
            crate::ticktick_write::MUTATION_KIND,
            Some("fp-test"),
            db::now_ms(),
        )
        .await
        .expect("park write proposal");
        assert!(parked.won());
        (run_id, proposal_id, tool_call_id)
    }

    /// `proposed` (proposal pending): the EXISTING parked-cancel path —
    /// proposal + Run cancelled; the write row stays `proposed`, inert.
    #[tokio::test]
    async fn write_family_proposed_cancels_through_the_existing_path() {
        let pool = memory_pool().await;
        let (run_id, proposal_id, _tc) = seed_parked_write(&pool).await;
        let hubs = hub::new_hubs();

        let (outcome, _live) = cancel_recording(&pool, &hubs, run_id).await;
        assert_eq!(outcome, "accepted");
        assert_eq!(run_status_str(&pool, run_id).await, Some("cancelled"));
        let write_state: String =
            sqlx::query_scalar("SELECT state FROM ticktick_writes WHERE proposal_id = ?")
                .bind(&proposal_id)
                .fetch_one(&pool)
                .await
                .expect("write row");
        assert_eq!(write_state, "proposed", "the write row stays inert provenance");
    }

    /// `executing`: REFUSED with `write_in_flight` — nothing changes; the Run
    /// stays parked, the write keeps executing (never a fake "stopped" over a
    /// live POST).
    #[tokio::test]
    async fn write_family_executing_refuses_with_write_in_flight() {
        let pool = memory_pool().await;
        let (run_id, proposal_id, _tc) = seed_parked_write(&pool).await;
        db::ticktick_writes::accept_ticktick_write(
            &pool,
            run_id,
            &proposal_id,
            None,
            Some("k1"),
            db::now_ms(),
        )
        .await
        .expect("phase A");
        let hubs = hub::new_hubs();

        let (outcome, live_tail) = cancel_recording(&pool, &hubs, run_id).await;
        assert_eq!(outcome, "write_in_flight");
        assert!(!live_tail);
        assert_eq!(run_status_str(&pool, run_id).await, Some("parked"));
        let write_state: String =
            sqlx::query_scalar("SELECT state FROM ticktick_writes WHERE proposal_id = ?")
                .bind(&proposal_id)
                .fetch_one(&pool)
                .await
                .expect("write row");
        assert_eq!(write_state, "executing", "nothing changed");
    }

    /// Settle the seeded write `created` (phase C committed, resume not yet
    /// run) — the settled→resume window's durable state.
    async fn settle_created(pool: &SqlitePool, run_id: Uuid, proposal_id: &str, tool_call_id: &str) {
        db::ticktick_writes::accept_ticktick_write(
            pool,
            run_id,
            proposal_id,
            None,
            Some("k1"),
            db::now_ms(),
        )
        .await
        .expect("phase A");
        let settle = db::ticktick_writes::settle_ticktick_write(
            pool,
            proposal_id,
            tool_call_id,
            "created",
            Some(200),
            Some("tt-1"),
            r#"{"decision":"accept","content":"Accepted. Created \"buy milk\" in TickTick (task tt-1).","is_error":false}"#,
            db::now_ms(),
        )
        .await
        .expect("phase C");
        assert!(matches!(settle, db::ticktick_writes::Settle::Won));
    }

    /// The post-phase-C-commit cancel/resume race, ORDERING 1 — cancel's CAS
    /// wins: a REAL `parked → cancelled`, no spawn, and the recorded outcome
    /// stays readable. A resume arriving after loses its self-guarded flip.
    #[tokio::test]
    async fn write_family_settled_window_cancel_wins_the_cas() {
        let pool = memory_pool().await;
        let (run_id, proposal_id, tool_call_id) = seed_parked_write(&pool).await;
        settle_created(&pool, run_id, &proposal_id, &tool_call_id).await;
        let hubs = hub::new_hubs();

        let (outcome, _live) = cancel_recording(&pool, &hubs, run_id).await;
        assert_eq!(outcome, "accepted", "cancel wins the settled-window CAS");
        assert_eq!(run_status_str(&pool, run_id).await, Some("cancelled"));
        // The recorded outcome stays readable on the card.
        let (state, recorded): (String, Option<String>) = sqlx::query_as(
            "SELECT state, outcome FROM ticktick_writes WHERE proposal_id = ?",
        )
        .bind(&proposal_id)
        .fetch_one(&pool)
        .await
        .expect("write row");
        assert_eq!(state, "settled");
        assert_eq!(recorded.as_deref(), Some("created"));

        // The late resume's self-guarded parked→running flip LOSES: no spawn.
        assert!(
            !db::mark_run_running(&pool, run_id).await.expect("flip").won(),
            "resume after a won cancel is a no-op"
        );
        assert_eq!(run_status_str(&pool, run_id).await, Some("cancelled"));
    }

    /// ORDERING 2 — resume wins first: the cancel re-reads `running` and
    /// routes through the running path, converging on a real cancellation of
    /// the resumed Run. Both orderings answer the durable state, never a
    /// local guess.
    #[tokio::test]
    async fn write_family_settled_window_resume_wins_then_cancel_routes_running() {
        let pool = memory_pool().await;
        let (run_id, proposal_id, tool_call_id) = seed_parked_write(&pool).await;
        settle_created(&pool, run_id, &proposal_id, &tool_call_id).await;
        // Resume won the race: the Run flipped parked→running before cancel's CAS.
        assert!(db::mark_run_running(&pool, run_id).await.expect("flip").won());
        let hubs = hub::new_hubs();

        let (outcome, _live) = cancel_recording(&pool, &hubs, run_id).await;
        assert_eq!(
            outcome, "accepted",
            "the cancel converges through the running path"
        );
        assert_eq!(run_status_str(&pool, run_id).await, Some("cancelled"));
        let recorded: Option<String> =
            sqlx::query_scalar("SELECT outcome FROM ticktick_writes WHERE proposal_id = ?")
                .bind(&proposal_id)
                .fetch_one(&pool)
                .await
                .expect("write row");
        assert_eq!(recorded.as_deref(), Some("created"), "the outcome stands");
    }

    /// The accept → Stop race in its lost-parked-race shape: cancel read
    /// `proposed`, took the existing path, and LOST (a decide flipped the
    /// proposal accepted concurrently). The re-read answers `write_in_flight`
    /// — never `already_terminal`, which the Web would settle locally as a
    /// fake "stopped" over a live write.
    #[tokio::test]
    async fn write_family_lost_parked_race_rereads_as_write_in_flight() {
        let pool = memory_pool().await;
        let (run_id, proposal_id, _tc) = seed_parked_write(&pool).await;
        let hubs = hub::new_hubs();

        // Simulate the interleave: by the time cancel_parked_run runs, the
        // decide has already accepted (proposal no longer pending, write
        // executing). The dispatch read is bypassed by flipping AFTER seed —
        // cancel() will re-read the matrix on the lost race.
        db::ticktick_writes::accept_ticktick_write(
            &pool,
            run_id,
            &proposal_id,
            None,
            Some("k1"),
            db::now_ms(),
        )
        .await
        .expect("concurrent decide accepted");

        let (outcome, _live) = cancel_recording(&pool, &hubs, run_id).await;
        assert_eq!(
            outcome, "write_in_flight",
            "an accepted-and-executing write answers write_in_flight, not already_terminal"
        );
        assert_eq!(run_status_str(&pool, run_id).await, Some("parked"));
    }
}
