//! `run/post_message` handler: add a message (and a new Run) to an EXISTING
//! Thread (ADR-0022 — `thread_id` is required, never optional).
//!
//! Validation (ADR-0014): a malformed `thread_id` → `invalid_params`; a
//! well-formed but unknown one → `unknown_thread` with zero rows written.
//!
//! Pure-subscribe (ADR-0022): the response carries ONLY `{run_id}` — the
//! Client gets events by following with `run/subscribe(run_id)`. The whole
//! Run-start sequence (dispatch → provider gate → persist → hub → history →
//! spawn, with its ordering invariants) lives in the deep verb
//! [`crate::start_run`]; this shell only validates the Thread, resolves the
//! attachments, mints ids, and maps the verb's errors onto the wire.

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;
use uuid::Uuid;

use super::handler::{self, HandlerError};
use super::media::resolve_attachments;
use crate::db;
use crate::hub::Hubs;
use crate::protocol::{PostMessageParams, PostMessageResult};
use crate::start_run::{self, PersistStep, StartRunParams};

pub(super) async fn handle(
    pool: &SqlitePool,
    hubs: &Hubs,
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    handler::handle(id, params, out_tx, |params: PostMessageParams| async move {
        let thread_id = params.thread_id;

        // A well-formed but unknown thread_id is rejected BEFORE any
        // persistence — zero rows (ADR-0022).
        if !db::thread_exists(pool, thread_id)
            .await
            .map_err(|e| HandlerError::Internal(e.into()))?
        {
            return Err(HandlerError::UnknownThread(thread_id));
        }

        // Resolve each attachment id via the media substrate (ADR-0058) BEFORE
        // the verb runs — pre-verb validation, like the unknown-thread gate
        // above: an unknown id is invalid_params, an unreadable file internal,
        // both with zero rows. `manifest_attachments` carries the bytes
        // (base64) for the fresh spawn manifest so the model sees the current
        // turn's images.
        let (attachments, manifest_attachments) =
            resolve_attachments(pool, &params.attachment_ids).await?;

        let started = start_run::start_run(
            pool,
            hubs,
            StartRunParams {
                thread_id,
                prompt: params.prompt,
                manifest_attachments,
                persist_step: PersistStep::FreshRun {
                    run_id: Uuid::now_v7(),
                    user_message_id: Uuid::now_v7(),
                    assistant_message_id: Uuid::now_v7(),
                    attachments,
                    now: db::now_ms(),
                },
                skip_history: false,
                deferred_spawn: false,
            },
            crate::worker::spawn,
        )
        .await
        .map_err(HandlerError::from)?;

        Ok(PostMessageResult {
            run_id: started.run_id.to_string(),
        })
    })
    .await;
}
