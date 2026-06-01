//! Run lifecycle: JSON-RPC method dispatch + per-method handlers.
//!
//! [`dispatch`] is the single `match` over the wire method; each arm routes
//! to a dedicated handler module ([`post_message`], [`subscribe`],
//! [`thread_create`], [`thread_list`], [`thread_get`]). Shared wire-framing (response/notification/error
//! envelopes) lives in [`reply`]. The actual SQL is in [`crate::db`]; Worker
//! process management is in [`crate::worker`]; the per-run hub is in
//! [`crate::hub`].

mod post_message;
mod reply;
mod subscribe;
mod thread_create;
mod thread_get;
mod thread_list;

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;

use crate::hub::Hubs;
use crate::protocol::{
    JsonRpcRequest, PostMessageParams, SubscribeParams, ThreadCreateParams, ThreadGetParams,
};

/// Route a decoded JSON-RPC request to its handler. One `match` arm per
/// method; each arm deserializes its params then delegates to the method's
/// module. Malformed params or an unknown method are dropped silently (the
/// skeleton's behavior — a connection keeps serving subsequent frames).
pub async fn dispatch(
    pool: &SqlitePool,
    hubs: &Hubs,
    req: JsonRpcRequest,
    out_tx: &UnboundedSender<String>,
) {
    match req.method.as_str() {
        "run/post_message" => {
            let Ok(params) = serde_json::from_value::<PostMessageParams>(req.params) else {
                return;
            };
            post_message::handle(pool, hubs, req.id, params, out_tx).await;
        }
        "run/subscribe" => {
            let Ok(params) = serde_json::from_value::<SubscribeParams>(req.params) else {
                return;
            };
            subscribe::handle(pool, hubs, req.id, params, out_tx).await;
        }
        "thread/create" => {
            let Ok(params) = serde_json::from_value::<ThreadCreateParams>(req.params) else {
                return;
            };
            thread_create::handle(pool, hubs, req.id, params, out_tx).await;
        }
        "thread/list" => {
            // Read-only, no params (ADR-0022 read path) — skip param
            // deserialization entirely.
            thread_list::handle(pool, req.id, out_tx).await;
        }
        "thread/get" => {
            let Ok(params) = serde_json::from_value::<ThreadGetParams>(req.params) else {
                return;
            };
            thread_get::handle(pool, req.id, params, out_tx).await;
        }
        // Other methods: drop silently for the skeleton.
        _ => {}
    }
}
