//! `thread/create` handler: message-first thread creation (ADR-0022). Mint a
//! NEW Thread (title derived from the prompt) plus its first Run + user
//! message in one transaction, then frame `{thread_id, run_id}`.
//!
//! Empty/whitespace-only prompts are rejected with `invalid_params` BEFORE any
//! DB write — zero rows persisted (ADR-0014).
//!
//! Pure-subscribe (ADR-0022): the response carries ONLY `{thread_id, run_id}`;
//! the Client follows with `run/subscribe(run_id)`. The whole Run-start
//! sequence (dispatch → provider gate → persist → hub → spawn, with its
//! ordering invariants) lives in the deep verb [`crate::start_run`] via
//! `PersistStep::CreateThread`; this shell validates the prompt, resolves the
//! attachments, derives the placeholder title, mints ids, fires the titler,
//! and maps the verb's errors onto the wire.

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;
use uuid::Uuid;

use super::handler::{self, HandlerError};
use super::media::resolve_attachments;
use crate::db;
use crate::hub::Hubs;
use crate::protocol::{ThreadCreateParams, ThreadCreateResult};
use crate::start_run::{self, PersistStep, StartRunParams};
use crate::worker;

use super::title;

pub(super) async fn handle(
    pool: &SqlitePool,
    hubs: &Hubs,
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    handler::handle(id, params, out_tx, |params: ThreadCreateParams| async move {
        // Empty-prompt guard — BEFORE any persistence so a rejection writes
        // zero rows (ADR-0002).
        let trimmed = params.prompt.trim();
        if trimmed.is_empty() {
            return Err(HandlerError::InvalidParams(
                "prompt must not be empty".to_string(),
            ));
        }

        // Fallback title: a word-boundary slug derived from the prompt (ADR-0048)
        // — a terse, legible name (≤ 32 scalars, last whole word, no ellipsis),
        // not the prompt dumped and cut mid-word. Never empty (the guard above
        // rejected blanks; an overlong single word is hard-cut). The titler
        // (ADR-0046) overwrites it with a generated title on success.
        let title = title::placeholder_title(trimmed);

        // Resolve each attachment id via the media substrate (ADR-0058) BEFORE
        // the verb runs — pre-verb validation, like the empty-prompt guard
        // above: an unknown id is invalid_params, an unreadable file internal,
        // both with NO Thread minted. `manifest_attachments` carries the bytes
        // (base64) for the fresh spawn manifest.
        let (attachments, manifest_attachments) =
            resolve_attachments(pool, &params.attachment_ids).await?;

        let thread_id = Uuid::now_v7();

        let started = start_run::start_run(
            pool,
            hubs,
            StartRunParams {
                thread_id,
                // Cloned: the titler below needs the prompt after the verb
                // moves its copy into the Worker spawn.
                prompt: params.prompt.clone(),
                manifest_attachments,
                persist_step: PersistStep::CreateThread {
                    run_id: Uuid::now_v7(),
                    user_message_id: Uuid::now_v7(),
                    assistant_message_id: Uuid::now_v7(),
                    attachments,
                    title,
                    now: db::now_ms(),
                },
                // A brand-new Thread has no prior exchange — skip the history
                // read; the Worker gets an empty history.
                skip_history: true,
                deferred_spawn: false,
            },
            start_run::default_spawn,
        )
        .await
        .map_err(HandlerError::from)?;

        // Fire the one-shot title Worker (ADR-0046) — fire-and-forget, so the
        // create RESPONSE never waits on it. `started.provider` is the
        // resolved Workflow's provider, guaranteed connected (the verb's
        // ADR-0062 gate rejects a disconnected one before this point).
        // `out_tx.clone()` is this connection's outbound channel: on a
        // successful generation the titler frames a `thread/titled`
        // notification onto it (ADR-0047) so the creating tab's sidebar
        // updates live. On empty/whitespace output it silently keeps the
        // prompt-derived placeholder and pushes nothing. Ordering: this now
        // fires AFTER the Run's `worker::spawn` (inside the verb) instead of
        // between hub-create and spawn — equivalent, because both are
        // fire-and-forget onto independent subsystems (the titler is a
        // one-shot non-Run worker sharing no state with the Run worker), so
        // the swap is not wire-observable.
        worker::spawn_title_generation(
            thread_id,
            params.prompt,
            started.provider,
            pool.clone(),
            out_tx.clone(),
        );

        Ok(ThreadCreateResult {
            thread_id: thread_id.to_string(),
            run_id: started.run_id.to_string(),
        })
    })
    .await;
}
