//! Run lifecycle: JSON-RPC method dispatch + per-method handlers.
//!
//! [`dispatch`] is the single `match` over the wire method; each arm routes to
//! a dedicated handler module. Shared wire-framing lives in [`reply`], SQL in
//! [`crate::db`], Worker management in [`crate::worker`], the per-run hub in
//! [`crate::hub`].

mod cancel;
mod catalog;
mod entity;
mod handler;
mod journal_entry;
mod message;
mod observation;
mod post_message;
mod proposal;
mod provider;
mod recurrence_preview;
// `pub(crate)` so the non-Run titler (`crate::worker::title`) can frame a
// `thread/titled` notification onto its connection (ADR-0047); the request
// handlers reach it as `super::reply`.
pub(crate) mod reply;
mod retry;
mod run_history;
mod settings;
mod subscribe;
mod thread_create;
mod thread_get;
mod thread_list;
mod thread_list_archived;
mod thread_mutate;
pub(crate) mod title;

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;

use crate::hub::Hubs;
use crate::protocol::{JsonRpcRequest, SubscribeParams};

/// Route a decoded JSON-RPC request to its handler, one `match` arm per
/// method. An unknown method is dropped silently so the connection keeps
/// serving subsequent frames.
pub async fn dispatch(
    pool: &SqlitePool,
    hubs: &Hubs,
    req: JsonRpcRequest,
    out_tx: &UnboundedSender<String>,
) {
    match req.method.as_str() {
        "run/post_message" => {
            post_message::handle(pool, hubs, req.id, req.params, out_tx).await;
        }
        "run/subscribe" => {
            // Hand-written (streaming); decode framing matches the combinator —
            // a malformed id is invalid_params (ADR-0029).
            if let Some(params) =
                handler::decode_params::<SubscribeParams>(out_tx, req.id.clone(), req.params)
            {
                subscribe::handle(pool, hubs, req.id, params, out_tx).await;
            }
        }
        "run/cancel" => {
            cancel::handle_cancel(pool, hubs, req.id, req.params, out_tx).await;
        }
        "run/retry" => {
            retry::handle_retry(pool, hubs, req.id, req.params, out_tx).await;
        }
        "thread/create" => {
            thread_create::handle(pool, hubs, req.id, req.params, out_tx).await;
        }
        "thread/list" => {
            thread_list::handle(pool, req.id, req.params, out_tx).await;
        }
        "run/get_history" => {
            run_history::handle(pool, req.id, req.params, out_tx).await;
        }
        "recurrence/preview" => {
            recurrence_preview::handle(pool, req.id, req.params, out_tx).await;
        }
        "thread/get" => {
            // The combinator (ADR-0029) owns decode + framing; pass raw params.
            thread_get::handle(pool, req.id, req.params, out_tx).await;
        }
        "thread/rename" => {
            thread_mutate::handle_rename(pool, req.id, req.params, out_tx).await;
        }
        "thread/archive" => {
            thread_mutate::handle_archive(pool, req.id, req.params, out_tx).await;
        }
        "thread/unarchive" => {
            thread_mutate::handle_unarchive(pool, req.id, req.params, out_tx).await;
        }
        "thread/list_archived" => {
            thread_list_archived::handle(pool, req.id, req.params, out_tx).await;
        }
        "entity/list" => {
            entity::handle_list(pool, req.id, req.params, out_tx).await;
        }
        "entity/backlinks" => {
            entity::handle_backlinks(pool, req.id, req.params, out_tx).await;
        }
        "entity/mutate" => {
            entity::handle_mutate(pool, req.id, req.params, out_tx).await;
        }
        "journal_entry/rescan" => {
            journal_entry::handle(pool, hubs, req.id, req.params, out_tx).await;
        }
        "message/search" => {
            message::handle_search(pool, req.id, req.params, out_tx).await;
        }
        "observation/record" => {
            observation::handle_record(pool, req.id, req.params, out_tx).await;
        }
        "observation/update" => {
            observation::handle_update(pool, req.id, req.params, out_tx).await;
        }
        "observation/query" => {
            observation::handle_query(pool, req.id, req.params, out_tx).await;
        }
        "observation/get_history" => {
            observation::handle_get_history(pool, req.id, req.params, out_tx).await;
        }
        "proposal/get" => {
            proposal::handle_get(pool, req.id, req.params, out_tx).await;
        }
        "proposal/decide" => {
            // Hand-written (idempotent multi-step); decode framing matches the
            // combinator — a malformed id is invalid_params (ADR-0029).
            if let Some(params) = handler::decode_params::<crate::protocol::ProposalDecideParams>(
                out_tx,
                req.id.clone(),
                req.params,
            ) {
                proposal::handle_decide(pool, hubs, req.id, params, out_tx).await;
            }
        }
        "provider/status" => {
            provider::handle(req.id, req.params, out_tx).await;
        }
        "model/catalog" => {
            catalog::handle(req.id, req.params, out_tx).await;
        }
        "settings/get" => {
            settings::handle_get(pool, req.id, req.params, out_tx).await;
        }
        "settings/set" => {
            settings::handle_set(pool, req.id, req.params, out_tx).await;
        }
        "provider/login_start" => {
            provider::handle_login_start(req.id, req.params, out_tx).await;
        }
        "provider/configure" => {
            provider::handle_configure(req.id, req.params, out_tx).await;
        }
        // Other methods: drop silently for the skeleton.
        _ => {}
    }
}
