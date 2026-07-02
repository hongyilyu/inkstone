//! `run/retry` handler (ADR-0028 retry amendment, #230): re-drive an errored Run
//! IN PLACE. Same `run_id`, same `assistant_message_id`; re-run the original user
//! prompt as a FRESH attempt and discard the failed attempt's output.
//!
//! This is NOT `resume`: `resume::reconstruct` is parked-only (its invariant is
//! "the final block is the Decision tool_result") and provider-hostile for an
//! errored Run (the Worker's `mode:"resume"` path rejects an assistant tail and
//! drops errored assistant turns). Retry mirrors `run/post_message`'s fresh-spawn
//! path instead: re-resolve the Workflow from LIVE settings
//! (`dispatcher::dispatch_and_resolve`, NOT the snapshot) so "switch model, then
//! retry" works, clear the failed output + re-snapshot the model columns
//! (`db::prepare_retry`), build prior history via `history_for_run` (which already
//! filters `status='completed'`, so the failed partial assistant text is
//! excluded), and `worker::spawn` with `mode:None` on the SAME ids.
//!
//! Outcome (mirrors `RunCancelResult`'s vocabulary + stance): `unknown_run` (no
//! such Run), `not_errored` (the Run was not `errored` — a normal response value,
//! NOT a JSON-RPC error frame), `accepted` (the `errored → running` flip won and
//! a fresh Worker is re-driving). A malformed `run_id` is `invalid_params`.
//!
//! The Response is framed BEFORE the spawn, mirroring `run/cancel`'s ordering
//! discipline (the post-response work — here the Worker spawn — happens after the
//! client has its answer).

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;

use super::handler::{self, HandlerError};
use super::reply::send_response;
use crate::db;
use crate::dispatcher;
use crate::hub::{self, Hubs};
use crate::protocol::{RunRetryParams, RunRetryResult};
use crate::worker;

pub(super) async fn handle_retry(
    pool: &SqlitePool,
    hubs: &Hubs,
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    let Some(params): Option<RunRetryParams> =
        handler::decode_params(out_tx, id.clone(), params)
    else {
        return;
    };
    let run_id = params.run_id;

    // Decide the outcome (and gather the spawn inputs for the `accepted` path).
    // `prepare` frames its own failures as HandlerError: a DB fault → Internal, a
    // disconnected provider → ProviderNotConnected (-32004). Both are framed here
    // BEFORE any spawn or response; the errored→running flip only happens on the
    // Ok path, so a rejected retry never leaves a half-flipped Run.
    let outcome = match prepare(pool, hubs, run_id).await {
        Ok(o) => o,
        Err(e) => {
            handler::frame_error(out_tx, id, e);
            return;
        }
    };

    // Frame the Response BEFORE the post-response Worker spawn (cancel's ordering).
    match serde_json::to_value(RunRetryResult {
        outcome: outcome.label().to_string(),
    }) {
        Ok(result) => send_response(out_tx, id, result),
        Err(e) => {
            handler::frame_error(out_tx, id, HandlerError::Internal(anyhow::Error::new(e)));
            return;
        }
    }

    // On `accepted`, spawn the re-driven Worker on the SAME run_id +
    // assistant_message_id (mode None/fresh) AFTER the Response is framed.
    if let Outcome::Accepted(spawn) = outcome {
        worker::spawn(
            run_id,
            spawn.workflow,
            spawn.prompt,
            spawn.history,
            pool.clone(),
            spawn.assistant_message_id,
            hubs.clone(),
            spawn.run_hub,
        );
    }
}

/// The decided retry outcome. `Accepted` carries everything the post-response
/// spawn needs (the hub is created in-band so a fast subscribe can't race it).
enum Outcome {
    Accepted(Box<Spawn>),
    NotErrored,
    UnknownRun,
}

impl Outcome {
    fn label(&self) -> &'static str {
        match self {
            Outcome::Accepted(_) => "accepted",
            Outcome::NotErrored => "not_errored",
            Outcome::UnknownRun => "unknown_run",
        }
    }
}

struct Spawn {
    workflow: crate::workflow::Workflow,
    prompt: String,
    history: Vec<(String, String)>,
    assistant_message_id: uuid::Uuid,
    run_hub: crate::hub::RunHub,
}

/// The decision + (for `accepted`) the in-place retry transaction and spawn prep.
/// Pure of any wire framing — the caller owns the Response. A DB fault maps to
/// `HandlerError::Internal`; a disconnected provider to `ProviderNotConnected`
/// (`-32004`), both framed as error frames by the caller. The three success
/// outcomes (`accepted`/`not_errored`/`unknown_run`) are the `Ok` values.
async fn prepare(
    pool: &SqlitePool,
    hubs: &Hubs,
    run_id: uuid::Uuid,
) -> Result<Outcome, HandlerError> {
    // The original user prompt + the Run's Thread (for live Workflow resolution).
    // This is the single unknown-run gate: its first read is `thread_id_for_run`
    // (`SELECT … FROM runs`), so a missing Run resolves `None` here — a separate
    // `run_status` probe would catch nothing this does not.
    let Some((prompt, thread_id)) = db::run_prompt_and_thread(pool, run_id)
        .await
        .map_err(|e| HandlerError::Internal(e.into()))?
    else {
        return Ok(Outcome::UnknownRun);
    };

    // Report `not_errored` for a non-errored Run BEFORE the provider gate: only an
    // errored Run is retryable, and that established outcome must win regardless of
    // provider connectivity (a disconnected provider on a running/completed Run is
    // still `not_errored`, not `-32004`). This read is non-mutating; the guarded
    // flip below is still the authoritative race-safe transition. A missing Run
    // was already handled above, so `None` here would be a TOCTOU delete — treat it
    // as not-errored (the flip would lose anyway).
    //
    // The advisory read and the authoritative flip can't produce a WRONG state: the
    // CAS in `prepare_retry` self-guards on `WHERE status='errored'`, so a Run that
    // races out of `errored` after this read still yields `not_errored` (below).
    // The only observable effect of a concurrent double-retry of the SAME errored
    // Run against a disconnected provider is which truthful message wins the tie
    // (`-32004` vs `not_errored`) — not reachable from one client (the retry
    // affordance disappears once the bubble leaves `errored`), so we do not pay the
    // cost of folding the credential gate into the flip transaction.
    let status = db::run_status(pool, run_id)
        .await
        .map_err(|e| HandlerError::Internal(e.into()))?;
    if status != Some(db::RunStatus::Errored) {
        return Ok(Outcome::NotErrored);
    }

    // Re-resolve the Workflow from LIVE settings (NOT the snapshot), so a model
    // switch before retry takes effect (ADR-0024 contrast with resume).
    let workflow = dispatcher::dispatch_and_resolve(pool, thread_id, &prompt).await;

    // Gate on the re-resolved provider's credential BEFORE the errored→running
    // flip (ADR-0062): a disconnected provider must fail loud with "connect it",
    // not re-drive a tokenless Worker into another 401. The shared helper maps
    // missing→ProviderNotConnected (-32004) and corrupt→Internal, exactly as the
    // fresh-send sites; the caller frames the returned HandlerError.
    handler::ensure_provider_connected(&workflow.provider)?;

    // The reused assistant Message id — the bubble identity stays stable. Read it
    // BEFORE the committing flip + hub::create: the id is immutable, so reading it
    // earlier is order-independent, and a fault/None here aborts with the Run still
    // in its true `errored` state and no producer-less hub left behind.
    let assistant_message_id = db::assistant_message_id_for_run(pool, run_id)
        .await
        .map_err(|e| HandlerError::Internal(e.into()))?
        .ok_or_else(|| {
            HandlerError::Internal(anyhow::anyhow!("retried run {run_id} has no assistant message"))
        })?;

    // The guarded flip + clear-failed-output + re-snapshot, in one tx. A lost flip
    // (the Run raced out of `errored` since the read above) maps to not_errored,
    // with nothing cleared — the transition stays authoritative even though the
    // status read already reported errored.
    let moved = db::prepare_retry(pool, run_id, &workflow, db::now_ms())
        .await
        .map_err(|e| HandlerError::Internal(e.into()))?;
    if !moved.won() {
        return Ok(Outcome::NotErrored);
    }

    // Create the hub BEFORE spawning so a subscribe arriving right after the
    // response can't find a missing hub (mirrors run/post_message). After the
    // committing flip + the last fallible read, so no abort leaves a stray hub.
    let run_hub = hub::create(hubs, run_id);

    // Prior-Run history, excluding this Run — `history_for_run` filters
    // `status='completed'`, so the just-cleared errored attempt's text is excluded
    // (the user Message stays; it is completed). A read failure falls back to none.
    let history = db::history_for_run(pool, thread_id, run_id)
        .await
        .unwrap_or_else(|e| {
            eprintln!("history_for_run failed for run {run_id}: {e}");
            Vec::new()
        });

    Ok(Outcome::Accepted(Box::new(Spawn {
        workflow,
        prompt,
        history,
        assistant_message_id,
        run_hub,
    })))
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};
    use sqlx::SqlitePool;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use tokio::sync::mpsc;
    use uuid::Uuid;

    use crate::db;
    use crate::hub;
    use crate::workflow::default_workflow;

    /// A migrated in-memory pool (mirrors the sibling handler test helpers).
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

    /// Seed a Thread + its first Run (status `running`) so the handler has a real,
    /// non-errored Run to reject. Returns the `run_id`. Loads the default Workflow
    /// (idempotent) so `persist_thread_with_first_run` + the handler's
    /// `dispatch_and_resolve` can resolve it.
    async fn seed_running_run(pool: &SqlitePool) -> Uuid {
        crate::workflow::init().expect("load default workflow");
        let thread_id = Uuid::now_v7();
        let run_id = Uuid::now_v7();
        db::persist_thread_with_first_run(
            pool,
            thread_id,
            run_id,
            Uuid::now_v7(),
            Uuid::now_v7(),
            default_workflow(),
            "the original prompt",
            "t",
            1,
        )
        .await
        .expect("seed run");
        run_id
    }

    /// Seed a Thread + first Run, then drive it to `errored` (assistant Message
    /// `incomplete`) by hand — what `RunStatus::fail` leaves behind, without a
    /// Worker. Returns `(run_id, assistant_message_id)` so the accepted-arm test can
    /// assert the reused id. Prompt is "the original prompt".
    async fn seed_errored_run(pool: &SqlitePool) -> (Uuid, Uuid) {
        crate::workflow::init().expect("load default workflow");
        let thread_id = Uuid::now_v7();
        let run_id = Uuid::now_v7();
        let assistant_message_id = Uuid::now_v7();
        db::persist_thread_with_first_run(
            pool,
            thread_id,
            run_id,
            Uuid::now_v7(),
            assistant_message_id,
            default_workflow(),
            "the original prompt",
            "t",
            1,
        )
        .await
        .expect("seed run");
        sqlx::query(
            "UPDATE runs SET status = 'errored', terminal_reason = 'errored', \
             error_code = 'agent_error', error_message = 'boom', ended_at = 2 WHERE id = ?1",
        )
        .bind(run_id.to_string())
        .execute(pool)
        .await
        .expect("mark run errored");
        sqlx::query("UPDATE messages SET status = 'incomplete' WHERE id = ?1")
            .bind(assistant_message_id.to_string())
            .execute(pool)
            .await
            .expect("mark assistant incomplete");
        (run_id, assistant_message_id)
    }

    fn recv_json(rx: &mut mpsc::UnboundedReceiver<String>) -> Value {
        let line = rx.try_recv().expect("a frame was queued");
        serde_json::from_str(&line).expect("frame is JSON")
    }

    /// Point `INKSTONE_CREDENTIALS_DIR` at a fresh temp dir for one test, returning
    /// an RAII guard that holds the env lock AND removes the var on drop — so the
    /// mutation can never strand a stale dir for a later test, even if the test
    /// panics mid-assert (the manual set/remove pattern leaks on a panic). When
    /// `connected`, seeds an openai-codex credential so the run-creation provider
    /// gate (`handler::ensure_provider_connected`, ADR-0062) passes; when not, the
    /// dir stays empty (a disconnected provider). Keep the guard bound for the test.
    #[must_use]
    fn credentials_env(connected: bool) -> CredentialGuard {
        let guard = crate::credentials::env_lock();
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("credentials");
        // SAFETY: serialized by the credentials env lock held in `guard`.
        unsafe {
            std::env::set_var("INKSTONE_CREDENTIALS_DIR", &dir);
        }
        if connected {
            crate::credentials::write(
                "openai-codex",
                &crate::credentials::StoredCredential::Oauth(crate::credentials::Credentials {
                    access: "tok".to_string(),
                    refresh: "ref".to_string(),
                    expires: 9_999_999_999_999,
                    account_id: "acct".to_string(),
                }),
            )
            .expect("write credential");
        }
        CredentialGuard { _guard: guard, _tmp: tmp }
    }

    /// RAII cleanup for [`credentials_env`]: removes `INKSTONE_CREDENTIALS_DIR` and
    /// releases the env lock + tempdir on drop, so the mutation can't strand a
    /// stale dir for a later test (fields are drop-order sinks, read via `_`).
    struct CredentialGuard {
        _guard: std::sync::MutexGuard<'static, ()>,
        _tmp: tempfile::TempDir,
    }

    impl Drop for CredentialGuard {
        fn drop(&mut self) {
            // SAFETY: the env lock (held in `_guard`) is still alive here — Drop
            // fields drop after this body — so no other test races this removal.
            unsafe {
                std::env::remove_var("INKSTONE_CREDENTIALS_DIR");
            }
        }
    }

    /// The accepted happy-arm of `prepare` (the testable unit — `handle_retry`'s
    /// spawn needs a real Worker binary). An ERRORED Run flips to `running`, yields
    /// `Outcome::Accepted` (label "accepted"), creates a hub, and the carried Spawn
    /// reuses the SAME assistant_message_id + the original prompt.
    #[tokio::test]
    async fn errored_run_prepares_accepted_with_reused_ids() {
        // The resolved provider (default openai-codex) must be connected or the
        // ADR-0062 gate would return ProviderNotConnected before the flip.
        let _cred = credentials_env(true);
        let pool = memory_pool().await;
        let hubs = hub::new_hubs();
        let (run_id, assistant_message_id) = seed_errored_run(&pool).await;

        let outcome = super::prepare(&pool, &hubs, run_id)
            .await
            .expect("prepare succeeds");

        assert_eq!(outcome.label(), "accepted");
        let super::Outcome::Accepted(spawn) = outcome else {
            panic!("expected Accepted, got {}", outcome.label());
        };
        assert_eq!(spawn.assistant_message_id, assistant_message_id, "reused id");
        assert_eq!(spawn.prompt, "the original prompt", "re-drives the original prompt");
        assert_eq!(
            db::run_status(&pool, run_id).await.unwrap().map(db::RunStatus::as_str),
            Some("running"),
            "the errored Run flipped to running"
        );
        assert!(hub::get(&hubs, run_id).is_some(), "the hub was created");
    }

    /// A non-errored (here `running`) Run frames `accepted:false` → `not_errored`,
    /// stays `running`, and spawns NOTHING (the guarded flip lost; nothing cleared).
    ///
    /// Runs with NO credential ON PURPOSE (empty creds dir): the not-errored check
    /// must precede the provider gate, so a non-errored Run reports `not_errored`
    /// regardless of connectivity — NOT `-32004`. This is the regression lock for
    /// the ordering bug (a connected-credential seed here would mask it).
    #[tokio::test]
    async fn non_errored_run_is_not_errored_no_spawn() {
        // NO credential (empty creds dir) on purpose — see the doc comment.
        let _cred = credentials_env(false);
        let pool = memory_pool().await;
        let hubs = hub::new_hubs();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let run_id = seed_running_run(&pool).await;

        super::handle_retry(
            &pool,
            &hubs,
            json!(1),
            json!({ "run_id": run_id.to_string() }),
            &tx,
        )
        .await;

        let v = recv_json(&mut rx);
        assert_eq!(
            v["result"],
            json!({ "outcome": "not_errored" }),
            "a non-errored Run reports not_errored even with a disconnected provider — the errored check precedes the gate"
        );
        assert!(v.get("error").is_none(), "not a -32004 error frame");
        assert_eq!(
            db::run_status(&pool, run_id).await.unwrap().map(db::RunStatus::as_str),
            Some("running"),
            "the running Run is untouched"
        );
        // No hub was created (no spawn) for a not_errored outcome.
        assert!(hub::get(&hubs, run_id).is_none(), "no hub → no Worker spawned");
    }

    /// Retrying an errored Run whose re-resolved provider is DISCONNECTED frames a
    /// `-32004` ProviderNotConnected ERROR (not an outcome string), does NOT flip the
    /// Run to running, and spawns nothing — the ADR-0062 gate before the flip.
    #[tokio::test]
    async fn disconnected_provider_frames_minus_32004_and_no_flip() {
        // Empty credential dir → the default openai-codex provider is not connected.
        let _cred = credentials_env(false);
        let pool = memory_pool().await;
        let hubs = hub::new_hubs();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let (run_id, _assistant_message_id) = seed_errored_run(&pool).await;

        super::handle_retry(
            &pool,
            &hubs,
            json!(4),
            json!({ "run_id": run_id.to_string() }),
            &tx,
        )
        .await;

        let v = recv_json(&mut rx);
        assert_eq!(v["error"]["code"], json!(-32004));
        assert!(v.get("result").is_none());
        // The Run stayed errored — the gate ran BEFORE the errored→running flip.
        assert_eq!(
            db::run_status(&pool, run_id).await.unwrap().map(db::RunStatus::as_str),
            Some("errored"),
            "a disconnected-provider retry must not flip the Run to running"
        );
        assert!(hub::get(&hubs, run_id).is_none(), "no hub → no Worker spawned");
    }

    /// An unknown run id frames `unknown_run` and spawns nothing.
    #[tokio::test]
    async fn unknown_run_is_unknown_run() {
        let pool = memory_pool().await;
        let hubs = hub::new_hubs();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let run_id = Uuid::now_v7();

        super::handle_retry(
            &pool,
            &hubs,
            json!(2),
            json!({ "run_id": run_id.to_string() }),
            &tx,
        )
        .await;

        let v = recv_json(&mut rx);
        assert_eq!(v["result"], json!({ "outcome": "unknown_run" }));
        assert!(hub::get(&hubs, run_id).is_none(), "no hub → no Worker spawned");
    }

    /// A malformed `run_id` fails decode at the seam → `invalid_params` (-32602),
    /// mirroring `run/cancel`.
    #[tokio::test]
    async fn malformed_run_id_is_invalid_params() {
        let pool = memory_pool().await;
        let hubs = hub::new_hubs();
        let (tx, mut rx) = mpsc::unbounded_channel();

        super::handle_retry(&pool, &hubs, json!(3), json!({ "run_id": "not-a-uuid" }), &tx).await;

        let v = recv_json(&mut rx);
        assert_eq!(v["error"]["code"], json!(-32602));
        assert!(v.get("result").is_none());
    }
}
