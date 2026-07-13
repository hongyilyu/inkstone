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
mod media;
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
/// method. An unknown method is answered with a JSON-RPC `-32601` (method not
/// found) so a typo'd or misrouted verb fails loud instead of leaving the
/// client's request future awaiting a reply that never comes.
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
        "media/upload" => {
            media::handle_upload(pool, req.id, req.params, out_tx).await;
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
        "provider/test" => {
            provider::handle_test(req.id, req.params, out_tx).await;
        }
        // Unknown method: answer with JSON-RPC -32601 rather than dropping the
        // frame, so the client's pending request rejects with a diagnostic
        // instead of hanging until the socket closes.
        other => {
            reply::send_rpc_error(
                out_tx,
                req.id,
                -32601,
                format!("method not found: {other}"),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::db::test_support::memory_pool;
    use serde_json::{json, Value};
    use sqlx::SqlitePool;
    use tokio::sync::mpsc;

    use crate::hub;
    use crate::protocol::JsonRpcRequest;

    async fn dispatch_rpc(pool: &SqlitePool, method: &str) -> Option<Value> {
        let hubs = hub::new_hubs();
        let (tx, mut rx) = mpsc::unbounded_channel();
        super::dispatch(
            pool,
            &hubs,
            JsonRpcRequest {
                jsonrpc: "2.0".to_string(),
                id: json!(7),
                method: method.to_string(),
                params: json!({}),
            },
            &tx,
        )
        .await;
        rx.try_recv()
            .ok()
            .map(|line| serde_json::from_str(&line).expect("frame is JSON"))
    }

    #[tokio::test]
    async fn unknown_method_replies_method_not_found() {
        let pool = memory_pool().await;
        let frame = dispatch_rpc(&pool, "does/not_exist")
            .await
            .expect("a frame was queued (previously the arm dropped it silently)");
        assert_eq!(frame["error"]["code"], json!(-32601), "{frame:?}");
        assert_eq!(frame["id"], json!(7), "{frame:?}");
        let message = frame["error"]["message"]
            .as_str()
            .expect("error message");
        assert!(
            message.contains("does/not_exist"),
            "expected the offending method in the message, got {message:?}"
        );
        assert!(frame.get("result").is_none(), "{frame:?}");
    }
}
