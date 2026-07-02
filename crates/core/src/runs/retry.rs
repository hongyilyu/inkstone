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
    // A DB fault frames `Internal` and returns; otherwise we get one of the three
    // outcome strings + the optional spawn payload.
    let outcome = match prepare(pool, hubs, run_id).await {
        Ok(o) => o,
        Err(e) => {
            handler::frame_error(out_tx, id, HandlerError::Internal(e));
            return;
        }
    };

    // A resolved provider with no credential is a typed ERROR frame (-32004),
    // not a normal outcome string — mirrors the fresh-send gate so "switch to a
    // disconnected model, then retry" fails loud with "connect it" instead of
    // re-driving into an opaque 401. Framed BEFORE any spawn; the flip already
    // did not happen (prepare gates before it).
    if let Outcome::ProviderNotConnected { provider } = outcome {
        handler::frame_error(out_tx, id, HandlerError::ProviderNotConnected { provider });
        return;
    }

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
    /// The re-resolved model's provider has no credential (ADR-0062). Framed by
    /// the handler as a `-32004` ERROR (never a `label()` outcome string), so it
    /// has no wire label — `label()` panics if reached, guarding the gap.
    ProviderNotConnected {
        provider: String,
    },
}

impl Outcome {
    fn label(&self) -> &'static str {
        match self {
            Outcome::Accepted(_) => "accepted",
            Outcome::NotErrored => "not_errored",
            Outcome::UnknownRun => "unknown_run",
            // Framed as an error frame by the caller, not a success outcome — it
            // must never reach here.
            Outcome::ProviderNotConnected { .. } => {
                unreachable!("ProviderNotConnected is framed as an error, not a labeled outcome")
            }
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
/// Pure of any wire framing — the caller owns the Response. A DB fault propagates
/// as `anyhow::Error` (framed `Internal` by the caller).
async fn prepare(pool: &SqlitePool, hubs: &Hubs, run_id: uuid::Uuid) -> anyhow::Result<Outcome> {
    // The original user prompt + the Run's Thread (for live Workflow resolution).
    // This is the single unknown-run gate: its first read is `thread_id_for_run`
    // (`SELECT … FROM runs`), so a missing Run resolves `None` here — a separate
    // `run_status` probe would catch nothing this does not.
    let Some((prompt, thread_id)) = db::run_prompt_and_thread(pool, run_id).await? else {
        return Ok(Outcome::UnknownRun);
    };

    // Re-resolve the Workflow from LIVE settings (NOT the snapshot), so a model
    // switch before retry takes effect (ADR-0024 contrast with resume).
    let workflow = dispatcher::dispatch_and_resolve(pool, thread_id, &prompt).await;

    // Gate on the re-resolved provider's credential BEFORE the errored→running
    // flip (ADR-0062): a disconnected provider must fail loud with "connect it",
    // not re-drive a tokenless Worker into another 401. A missing credential is
    // ProviderNotConnected; a corrupt store surfaces as the Err below (Internal).
    match crate::credentials::is_connected(&workflow.provider) {
        Ok(true) => {}
        Ok(false) => {
            return Ok(Outcome::ProviderNotConnected {
                provider: workflow.provider,
            });
        }
        Err(e) => return Err(e),
    }

    // The reused assistant Message id — the bubble identity stays stable. Read it
    // BEFORE the committing flip + hub::create: the id is immutable, so reading it
    // earlier is order-independent, and a fault/None here aborts with the Run still
    // in its true `errored` state and no producer-less hub left behind.
    let assistant_message_id = db::assistant_message_id_for_run(pool, run_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("retried run {run_id} has no assistant message"))?;

    // The guarded flip + clear-failed-output + re-snapshot, in one tx. A lost flip
    // (the Run was not `errored`) maps to not_errored, with nothing cleared.
    let moved = db::prepare_retry(pool, run_id, &workflow, db::now_ms()).await?;
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

    /// Point the credential store at a fresh temp dir holding a CONNECTED
    /// openai-codex credential, so the run-creation provider gate
    /// (`handler::ensure_provider_connected`, added for ADR-0062) passes in these
    /// Worker-free tests. Returns the env guard + tempdir; keep BOTH alive for the
    /// test (dropping the dir removes the credential, releasing the guard lets
    /// another test remap the process-global `INKSTONE_CREDENTIALS_DIR`).
    #[must_use]
    fn connect_codex() -> (std::sync::MutexGuard<'static, ()>, tempfile::TempDir) {
        let guard = crate::credentials::env_lock();
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("credentials");
        // SAFETY: serialized by the credentials env lock held in `guard`.
        unsafe {
            std::env::set_var("INKSTONE_CREDENTIALS_DIR", &dir);
        }
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
        (guard, tmp)
    }

    /// The accepted happy-arm of `prepare` (the testable unit — `handle_retry`'s
    /// spawn needs a real Worker binary). An ERRORED Run flips to `running`, yields
    /// `Outcome::Accepted` (label "accepted"), creates a hub, and the carried Spawn
    /// reuses the SAME assistant_message_id + the original prompt.
    #[tokio::test]
    async fn errored_run_prepares_accepted_with_reused_ids() {
        // The resolved provider (default openai-codex) must be connected or the
        // ADR-0062 gate would return ProviderNotConnected before the flip.
        let _cred = connect_codex();
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
    #[tokio::test]
    async fn non_errored_run_is_not_errored_no_spawn() {
        // Connected provider so the not_errored path is reached (the ADR-0062 gate
        // runs after dispatch_and_resolve, before the flip).
        let _cred = connect_codex();
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
        assert_eq!(v["result"], json!({ "outcome": "not_errored" }));
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
        let _guard = crate::credentials::env_lock();
        let tmp = tempfile::tempdir().expect("tempdir");
        // SAFETY: serialized by the credentials env lock.
        unsafe {
            std::env::set_var(
                "INKSTONE_CREDENTIALS_DIR",
                tmp.path().join("credentials"),
            );
        }

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

        // SAFETY: restore.
        unsafe {
            std::env::remove_var("INKSTONE_CREDENTIALS_DIR");
        }
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
