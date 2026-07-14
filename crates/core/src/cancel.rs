//! Run cancellation as one deep, directly-testable verb (ADR-0029, extending the
//! `proposal/decide` → [`crate::decide`] precedent to `run/cancel`).
//!
//! [`cancel`] owns the whole decision: read the Run status, pick the parked vs
//! running guarded transition (ADR-0028), and on a won running-cancel perform the
//! Worker signal. It returns a typed [`Outcome`] — `Accepted` / `AlreadyTerminal`
//! / `UnknownRun` — the three [ADR-0014](../docs/adr/0014-client-core-wire-protocol.md)
//! result values, NOT error codes. The only failure channel is a DB fault, which
//! rides `anyhow::Error` (the handler maps it to `-32603`); the negative-but-
//! expected domain outcomes stay in the `Ok` payload (ADR-0029 "protocol error vs
//! result value").
//!
//! The hub interaction is INJECTED as a closure (`get_hub`) so the decision + the
//! Worker signal are assertable against a `:memory:` pool without the live `Hubs`
//! registry — mirroring how [`crate::decide::apply`] injects `worker::resume`
//! (ADR-0026: the verb takes no new subsystem dependency). On a won running-cancel
//! the verb signals the live Worker and returns the won [`RunHub`] inside
//! [`Outcome::Accepted`]; the terminal `Cancelled` publish + `hub::remove` are
//! performed by [`publish_cancelled`], which the thin handler calls AFTER framing
//! its Response — preserving the deterministic `response → cancelled` wire order.

use sqlx::SqlitePool;
use uuid::Uuid;

use crate::db::{self, RunStatus};
use crate::hub::{self, Hubs, RunHub};
use crate::protocol::RunEvent;

/// The result of a cancel request (ADR-0014 result values, not error codes). The
/// handler maps each to its wire `outcome` string.
pub enum Outcome {
    /// The Run was live (running) or parked and is now cancelling. For a won
    /// running-cancel this carries the live [`RunHub`] the verb signalled, so the
    /// handler can publish the terminal `Cancelled` AFTER framing its Response; a
    /// parked cancel carries `None` (no live Worker to signal or publish for).
    Accepted { hub: Option<RunHub> },
    /// The Run had already finished (terminal) or a concurrent winner committed the
    /// terminal transition first — nothing to cancel.
    AlreadyTerminal,
    /// No Run with this id.
    UnknownRun,
}

/// Cancel a Run (ADR-0014, ADR-0028). Reads the status, picks the guarded
/// transition, and on a won running-cancel signals the live Worker via the
/// injected `get_hub`. Returns the typed [`Outcome`]; a DB fault is the only
/// `Err`.
///
/// `get_hub` resolves the live [`RunHub`] for a run id (production: `|id|
/// hub::get(hubs, id)`); injected so the decision + Worker signal are testable
/// against `:memory:` without the live registry.
pub async fn cancel<F>(pool: &SqlitePool, run_id: Uuid, get_hub: F) -> anyhow::Result<Outcome>
where
    F: FnOnce(Uuid) -> Option<RunHub>,
{
    match db::run_status(pool, run_id).await? {
        // Unknown run id — an ADR-0014 result value, not an error code.
        None => Ok(Outcome::UnknownRun),
        Some(RunStatus::Parked) => {
            // Parked Run has no live Worker: a pure tier-2 flip of the Run + its
            // pending Proposal. A rollback (no pending Proposal, or a concurrent
            // decide/cancel already won) maps to AlreadyTerminal.
            if db::cancel_parked_run(pool, run_id, db::now_ms()).await? {
                Ok(Outcome::Accepted { hub: None })
            } else {
                Ok(Outcome::AlreadyTerminal)
            }
        }
        Some(RunStatus::Running) => {
            // Win the guarded running -> cancelled transition first; the DB
            // transition is the user-visible outcome. On a win, signal the live
            // Worker (cleanup) and hand the hub back so the handler publishes the
            // terminal Cancelled AFTER framing its Response.
            if db::cancel_running_run(pool, run_id, db::now_ms()).await?.won() {
                let hub = get_hub(run_id);
                if let Some(run_hub) = &hub {
                    run_hub.cancel();
                }
                Ok(Outcome::Accepted { hub })
            } else {
                // The Worker committed a terminal transition first.
                Ok(Outcome::AlreadyTerminal)
            }
        }
        // Completed, errored, or cancelled — the Run already ended. The terminal set
        // is classified once by `is_terminal` (ADR-0028), not re-spelled here.
        Some(status) if status.is_terminal() => Ok(Outcome::AlreadyTerminal),
        // Unreachable: the two live states are matched above and the rest are
        // terminal. A guarded arm does not count toward match exhaustiveness, so
        // this explicit arm is required.
        Some(_) => Ok(Outcome::AlreadyTerminal),
    }
}

/// Publish the terminal `Cancelled` Run Event and remove the hub, after a won
/// running-cancel. Called by the handler AFTER it frames the cancel Response, so
/// the client always sees `response → cancelled` (not a racing broadcast). The
/// gated publish (`lock → send → unlock`, ADR-0022) is
/// [`RunHub::publish_gated`]; then `hub::remove`.
pub async fn publish_cancelled(hubs: &Hubs, run_id: Uuid, hub: Option<RunHub>) {
    let Some(run_hub) = hub else {
        return;
    };

    run_hub.publish_gated(RunEvent::Cancelled).await;

    hub::remove(hubs, run_id);
}

#[cfg(test)]
mod tests {
    use crate::db::test_support::memory_pool;
    use super::{cancel, publish_cancelled, Outcome};
    use crate::db;
    use crate::hub;
    use crate::protocol::RunEvent;
    use crate::workflow::Workflow;
    use sqlx::SqlitePool;
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

    // 1. Parked Run → Accepted (no hub); the Run AND its pending Proposal flip to
    //    cancelled. The verb takes the pure tier-2 parked path; no Worker to signal.
    #[tokio::test]
    async fn parked_run_is_accepted_and_flips_run_and_proposal() {
        let pool = memory_pool().await;
        let run_id = seed_parked_run(&pool).await;
        assert_eq!(pending_proposal_count(&pool, run_id).await, 1, "seed: one pending proposal");

        // get_hub must NOT be consulted on the parked path — a parked Run has no
        // live Worker. Panic if it is, to pin the parked branch.
        let outcome = cancel(&pool, run_id, |_| panic!("parked path must not touch the hub"))
            .await
            .expect("cancel ok");

        assert!(
            matches!(outcome, Outcome::Accepted { hub: None }),
            "a parked cancel is Accepted with no hub"
        );
        assert_eq!(run_status_str(&pool, run_id).await, Some("cancelled"), "run cancelled");
        assert_eq!(
            pending_proposal_count(&pool, run_id).await,
            0,
            "the pending proposal is cancelled too"
        );
    }

    // 2. Running Run, cancel WINS → Accepted carrying the live hub; the verb
    //    signalled the Worker (is_cancelled), and publish_cancelled then broadcasts
    //    Cancelled + removes the hub.
    #[tokio::test]
    async fn running_won_signals_then_publishes_and_removes() {
        let pool = memory_pool().await;
        let run_id = seed_running_run(&pool).await;

        // A real registered hub + a tail subscriber to observe the published event.
        let hubs = hub::new_hubs();
        let registered = hub::create(&hubs, run_id);
        let mut tail = registered.subscribe_raw();

        let outcome = cancel(&pool, run_id, |id| hub::get(&hubs, id))
            .await
            .expect("cancel ok");

        let hub = match outcome {
            Outcome::Accepted { hub: Some(hub) } => hub,
            _ => panic!("a won running-cancel is Accepted with the live hub"),
        };
        assert_eq!(run_status_str(&pool, run_id).await, Some("cancelled"), "run cancelled");
        assert!(hub.is_cancelled(), "the verb signalled the live Worker");
        // No terminal event published yet — that's publish_cancelled's job, AFTER
        // the handler frames its Response.
        assert!(tail.try_recv().is_err(), "verb itself publishes no event");

        publish_cancelled(&hubs, run_id, Some(hub)).await;

        assert!(
            matches!(tail.try_recv(), Ok(RunEvent::Cancelled)),
            "publish_cancelled broadcasts the terminal Cancelled"
        );
        assert!(hub::get(&hubs, run_id).is_none(), "the hub is removed after publish");
    }

    // 3. Running Run, but a terminal transition already committed → cancel LOSES the
    //    guard → AlreadyTerminal; no signal, no publish.
    #[tokio::test]
    async fn running_lost_to_committed_terminal_is_already_terminal() {
        let pool = memory_pool().await;
        let run_id = seed_running_run(&pool).await;
        // The Worker reached `done` first: commit the running -> completed move.
        assert!(
            db::complete_run(&pool, run_id, db::now_ms()).await.expect("complete").won(),
            "seed: the run completes before the cancel"
        );

        let outcome = cancel(&pool, run_id, |_| panic!("a lost running-cancel must not touch the hub"))
            .await
            .expect("cancel ok");

        assert!(
            matches!(outcome, Outcome::AlreadyTerminal),
            "a running-cancel that lost the guard is AlreadyTerminal"
        );
        assert_eq!(
            run_status_str(&pool, run_id).await,
            Some("completed"),
            "the committed completion stands"
        );
    }

    // 4. A Run that already ended (terminal) → AlreadyTerminal, classified by
    //    is_terminal without re-reading the running/parked guards.
    #[tokio::test]
    async fn terminal_run_is_already_terminal() {
        let pool = memory_pool().await;
        let run_id = seed_running_run(&pool).await;
        assert!(db::complete_run(&pool, run_id, db::now_ms()).await.expect("complete").won());

        let outcome = cancel(&pool, run_id, |_| panic!("a terminal Run must not touch the hub"))
            .await
            .expect("cancel ok");

        assert!(
            matches!(outcome, Outcome::AlreadyTerminal),
            "cancelling an already-completed Run is AlreadyTerminal"
        );
    }

    // 5. An id with no Run row → UnknownRun.
    #[tokio::test]
    async fn unknown_run_is_unknown_run() {
        let pool = memory_pool().await;
        let outcome = cancel(&pool, Uuid::now_v7(), |_| panic!("unknown Run must not touch the hub"))
            .await
            .expect("cancel ok");
        assert!(
            matches!(outcome, Outcome::UnknownRun),
            "an unknown run id is UnknownRun"
        );
    }

    // 6. Parked Run whose pending Proposal already vanished (a concurrent decide won)
    //    → the guarded parked transition rolls back → AlreadyTerminal.
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

        let outcome = cancel(&pool, run_id, |_| panic!("a lost parked race must not touch the hub"))
            .await
            .expect("cancel ok");

        assert!(
            matches!(outcome, Outcome::AlreadyTerminal),
            "a parked cancel that lost the proposal race is AlreadyTerminal"
        );
        // The Run stays parked (the transition rolled back) — the live decide owns it.
        assert_eq!(run_status_str(&pool, run_id).await, Some("parked"), "run stays parked");
    }
}
