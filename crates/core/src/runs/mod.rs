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
mod post_message;
mod proposal;
mod provider;
mod reply;
mod settings;
mod subscribe;
mod thread_create;
mod thread_get;
mod thread_list;

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
            match serde_json::from_value::<SubscribeParams>(req.params) {
                Ok(params) => subscribe::handle(pool, hubs, req.id, params, out_tx).await,
                Err(e) => handler::frame_error(
                    out_tx,
                    req.id,
                    handler::HandlerError::InvalidParams(format!("invalid params: {e}")),
                ),
            }
        }
        "run/cancel" => {
            cancel::handle_cancel(pool, hubs, req.id, req.params, out_tx).await;
        }
        "thread/create" => {
            thread_create::handle(pool, hubs, req.id, req.params, out_tx).await;
        }
        "thread/list" => {
            thread_list::handle(pool, req.id, req.params, out_tx).await;
        }
        "thread/get" => {
            // The combinator (ADR-0029) owns decode + framing; pass raw params.
            thread_get::handle(pool, req.id, req.params, out_tx).await;
        }
        "entity/list" => {
            entity::handle_list(pool, req.id, req.params, out_tx).await;
        }
        "entity/mutate" => {
            entity::handle_mutate(pool, req.id, req.params, out_tx).await;
        }
        "proposal/get" => {
            proposal::handle_get(pool, req.id, req.params, out_tx).await;
        }
        "proposal/decide" => {
            // Hand-written (idempotent multi-step); decode framing matches the
            // combinator — a malformed id is invalid_params (ADR-0029).
            match serde_json::from_value::<crate::protocol::ProposalDecideParams>(req.params) {
                Ok(params) => proposal::handle_decide(pool, hubs, req.id, params, out_tx).await,
                Err(e) => handler::frame_error(
                    out_tx,
                    req.id,
                    handler::HandlerError::InvalidParams(format!("invalid params: {e}")),
                ),
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
        // Other methods: drop silently for the skeleton.
        _ => {}
    }
}
