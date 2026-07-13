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
//! client has its answer). The Run-start sequence itself (dispatch → provider
//! gate → CAS persist → hub → history → spawn) lives in the deep verb
//! [`crate::start_run`] via `PersistStep::RetryCas` + `deferred_spawn`; this
//! shell owns the retry-only decision reads (`unknown_run` / `not_errored`),
//! the wire framing, and firing the deferred spawn after the Response.

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;

use super::handler::{self, HandlerError};
use super::media::encode_manifest_attachments;
use super::reply::send_response;
use crate::db;
use crate::hub::Hubs;
use crate::protocol::{RunRetryParams, RunRetryResult};
use crate::start_run::{self, PersistStep, StartRunError, StartRunParams};

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

    // Decide the outcome (and, for `accepted`, drive the verb up to its deferred
    // spawn). Failures arrive as HandlerError: a DB fault → Internal, a
    // disconnected provider → ProviderNotConnected (-32004). Both are framed here
    // BEFORE any spawn or response; the errored→running flip only happens on the
    // Accepted path, so a rejected retry never leaves a half-flipped Run.
    let outcome = match prepare(pool, hubs, run_id).await {
        Ok(o) => o,
        Err(e) => {
            handler::frame_error(out_tx, id, e);
            return;
        }
    };

    // Frame the Response BEFORE the post-response Worker spawn (cancel's ordering).
    // On serialize failure: frame -32603 and return WITHOUT firing the spawn —
    // the client never learned the retry was accepted, so nothing re-drives.
    match serde_json::to_value(RunRetryResult {
        outcome: outcome.label().to_string(),
    }) {
        Ok(result) => send_response(out_tx, id, result),
        Err(e) => {
            handler::frame_error(out_tx, id, HandlerError::Internal(anyhow::Error::new(e)));
            return;
        }
    }

    // On `accepted`, fire the verb's deferred spawn — the re-driven Worker on the
    // SAME run_id + assistant_message_id (mode None/fresh) AFTER the Response.
    //
    // INVARIANT: on this path the closure MUST be fired. By now the verb has
    // committed the errored→running flip and registered the hub; dropping the
    // closure unfired would leak a producer-less hub and strand the Run
    // `running` forever with no Worker driving it.
    if let Outcome::Accepted(spawn) = outcome {
        spawn();
    }
}

/// The decided retry outcome. `Accepted` carries the verb's deferred spawn,
/// unfired (the hub is already created in-band by the verb, so a fast subscribe
/// can't race it).
enum Outcome {
    Accepted(Box<dyn FnOnce() + Send>),
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

/// The decision + (for `accepted`) the verb-driven in-place retry. Pure of any
/// wire framing — the caller owns the Response. A DB fault maps to
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
    let Some((prompt, thread_id, user_message_id)) = db::run_prompt_and_thread(pool, run_id)
        .await
        .map_err(|e| HandlerError::Internal(e.into()))?
    else {
        return Ok(Outcome::UnknownRun);
    };

    // Report `not_errored` for a non-errored Run BEFORE the provider gate: only an
    // errored Run is retryable, and that established outcome must win regardless of
    // provider connectivity (a disconnected provider on a running/completed Run is
    // still `not_errored`, not `-32004`). This read is non-mutating; the guarded
    // flip inside the verb is still the authoritative race-safe transition. A
    // missing Run was already handled above, so `None` here would be a TOCTOU
    // delete — treat it as not-errored (the flip would lose anyway).
    //
    // The advisory read and the authoritative flip can't produce a WRONG state: the
    // CAS in `prepare_retry` self-guards on `WHERE status='errored'`, so a Run that
    // races out of `errored` after this read still yields `not_errored` (below, via
    // `PersistRaceLost`). The only observable effect of a concurrent double-retry
    // of the SAME errored Run against a disconnected provider is which truthful
    // message wins the tie (`-32004` vs `not_errored`) — not reachable from one
    // client (the retry affordance disappears once the bubble leaves `errored`),
    // so we do not pay the cost of folding the credential gate into the flip
    // transaction.
    let status = db::run_status(pool, run_id)
        .await
        .map_err(|e| HandlerError::Internal(e.into()))?;
    if status != Some(db::RunStatus::Errored) {
        return Ok(Outcome::NotErrored);
    }

    // The reused assistant Message id — the bubble identity stays stable. Read it
    // BEFORE handing off to the verb (whose dispatch → gate → CAS follows): the id
    // is immutable, so reading it earlier is order-independent, and a fault/None
    // here aborts with the Run still in its true `errored` state and no
    // producer-less hub left behind.
    let assistant_message_id = db::assistant_message_id_for_run(pool, run_id)
        .await
        .map_err(|e| HandlerError::Internal(e.into()))?
        .ok_or_else(|| {
            HandlerError::Internal(anyhow::anyhow!("retried run {run_id} has no assistant message"))
        })?;

    // Re-read + re-encode the original turn's attachments (the durable
    // `media_attachments` rows keyed by the user Message) so the retried fresh
    // manifest replays them — a retried "what's in this image?" must reach the
    // model WITH the image. Like the send path, a read failure is Internal with
    // no spawn; placed BEFORE the verb (whose committing flip follows) so the
    // failure leaves the Run in its true `errored` state (still retryable) and
    // no producer-less hub.
    let media_ids = db::media_ids_for_message(pool, &user_message_id)
        .await
        .map_err(|e| HandlerError::Internal(e.into()))?;
    let manifest_attachments = encode_manifest_attachments(pool, &media_ids).await?;

    // The deep verb: re-resolve the Workflow from LIVE settings (NOT the
    // snapshot, so a model switch before retry takes effect — ADR-0024 contrast
    // with resume), gate on the re-resolved provider's credential BEFORE the
    // errored→running flip (ADR-0062), run `db::prepare_retry`'s guarded CAS on
    // the SAME ids, create the hub, and assemble history — returning the spawn
    // as an UNFIRED closure (`deferred_spawn`) so the caller frames its Response
    // first.
    match start_run::start_run(
        pool,
        hubs,
        StartRunParams {
            thread_id,
            prompt,
            // Retry REPLAYS the original turn's images (re-read + re-encoded
            // above): the retried fresh manifest carries them like the
            // original send did. (Parked-resume still passes none — that cut
            // stands.)
            manifest_attachments,
            persist_step: PersistStep::RetryCas {
                run_id,
                assistant_message_id,
                now: db::now_ms(),
            },
            skip_history: false,
            deferred_spawn: true,
        },
        start_run::default_spawn,
    )
    .await
    {
        Ok(started) => Ok(Outcome::Accepted(
            started
                .deferred_spawn
                .expect("deferred_spawn: true always yields a closure"),
        )),
        // A lost CAS (the Run raced out of `errored` since the advisory read) is
        // `not_errored`, with nothing cleared, no hub, no spawn — matched HERE,
        // before the From<StartRunError> conversion, because only retry's
        // RetryCas can lose a persist race.
        Err(StartRunError::PersistRaceLost) => Ok(Outcome::NotErrored),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use crate::db::test_support::memory_pool;
    use serde_json::{Value, json};
    use sqlx::SqlitePool;
    use tokio::sync::mpsc;
    use uuid::Uuid;

    use crate::db;
    use crate::hub;
    use crate::workflow::default_workflow;

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
            &[],
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
            &[],
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

    /// A panic-safe credentials-dir fixture (shared [`crate::credentials::
    /// test_credentials_dir`]) for these Worker-free retry tests. When `connected`,
    /// seeds an openai-codex credential so the run-creation provider gate
    /// (the verb's `start_run::ensure_provider_connected`, ADR-0062) passes; when not, the dir
    /// stays empty (a disconnected provider). Keep the returned guard bound for the
    /// whole test — it restores the thread's previous Config override on drop.
    fn credentials_dir(connected: bool) -> crate::credentials::CredentialsDirGuard {
        let guard = crate::credentials::test_credentials_dir();
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
        guard
    }

    /// The accepted happy-arm, driven through the deep verb with
    /// `PersistStep::RetryCas` + `deferred_spawn: true` (the testable unit —
    /// `handle_retry`'s production spawn needs a real Worker binary). An
    /// ERRORED Run flips to `running`, creates a hub, and firing the deferred
    /// closure hands the recorder a manifest reusing the SAME
    /// assistant_message_id + the original prompt.
    #[tokio::test]
    async fn errored_run_prepares_accepted_with_reused_ids() {
        use std::sync::{Arc, Mutex};

        use crate::start_run::{PersistStep, SpawnManifest, StartRunParams, start_run};

        // The resolved provider (default openai-codex) must be connected or the
        // ADR-0062 gate would return ProviderNotConnected before the flip.
        let _cred = credentials_dir(true);
        let pool = memory_pool().await;
        let hubs = hub::new_hubs();
        let (run_id, assistant_message_id) = seed_errored_run(&pool).await;
        let (prompt, thread_id, _user_message_id) = db::run_prompt_and_thread(&pool, run_id)
            .await
            .expect("read prompt+thread")
            .expect("seeded run exists");

        let recorded: Arc<Mutex<Vec<(Uuid, Uuid, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let recorder = {
            let recorded = recorded.clone();
            move |m: SpawnManifest| {
                recorded.lock().unwrap().push((m.run_id, m.assistant_message_id, m.prompt));
            }
        };

        let started = start_run(
            &pool,
            &hubs,
            StartRunParams {
                thread_id,
                prompt,
                manifest_attachments: Vec::new(),
                persist_step: PersistStep::RetryCas {
                    run_id,
                    assistant_message_id,
                    now: db::now_ms(),
                },
                skip_history: false,
                deferred_spawn: true,
            },
            recorder,
        )
        .await
        .expect("start_run accepts the errored run");

        assert_eq!(started.run_id, run_id, "reused run id");
        assert!(recorded.lock().unwrap().is_empty(), "deferred: unfired at return");
        started.deferred_spawn.expect("the unfired spawn closure")();

        let recorded = recorded.lock().unwrap();
        assert_eq!(
            *recorded,
            vec![(run_id, assistant_message_id, "the original prompt".to_string())],
            "the spawn reuses the SAME ids and re-drives the original prompt"
        );
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
        let _cred = credentials_dir(false);
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
        let _cred = credentials_dir(false);
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
