//! Run lifecycle: JSON-RPC method dispatch + per-method handlers.
//!
//! [`dispatch`] is the single `match` over the wire method; each arm routes
//! to a dedicated handler module ([`post_message`], [`subscribe`],
//! [`thread_create`], [`thread_list`], [`thread_get`]). Shared wire-framing (response/notification/error
//! envelopes) lives in [`reply`]. The actual SQL is in [`crate::db`]; Worker
//! process management is in [`crate::worker`]; the per-run hub is in
//! [`crate::hub`].

mod post_message;
mod proposal;
mod provider;
mod catalog;
mod reply;
mod settings;
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
        "proposal/get" => {
            let Ok(params) =
                serde_json::from_value::<crate::protocol::ProposalGetParams>(req.params)
            else {
                return;
            };
            proposal::handle_get(pool, req.id, params, out_tx).await;
        }
        "proposal/decide" => {
            let id = req.id.clone();
            let Ok(params) =
                serde_json::from_value::<crate::protocol::ProposalDecideParams>(req.params)
            else {
                // Don't leave the client hanging on malformed params — reply
                // with invalid_params, matching the other input-validating
                // handlers (review m2).
                reply::send_invalid_params(
                    out_tx,
                    id,
                    "invalid proposal/decide params".to_string(),
                );
                return;
            };
            proposal::handle_decide(pool, hubs, req.id, params, out_tx).await;
        }
        "provider/status" => {
            // Read-only, no params — the credential store is the only input.
            provider::handle(req.id, out_tx).await;
        }
        "model/catalog" => {
            // Read-only, no params — the embedded model catalog is the only input.
            catalog::handle(req.id, out_tx);
        }
        "settings/get" => {
            // Read-only, no params — reads the settings table + default Workflow.
            settings::handle_get(pool, req.id, out_tx).await;
        }
        "settings/set" => {
            let Ok(params) =
                serde_json::from_value::<crate::protocol::SettingsSetParams>(req.params)
            else {
                return;
            };
            settings::handle_set(pool, req.id, params, out_tx).await;
        }
        "provider/login_start" => {
            let Ok(params) =
                serde_json::from_value::<crate::protocol::ProviderLoginStartParams>(req.params)
            else {
                return;
            };
            provider::handle_login_start(req.id, params, out_tx).await;
        }
        // Other methods: drop silently for the skeleton.
        _ => {}
    }
}
