//! Run lifecycle: JSON-RPC method dispatch + per-method handlers.
//!
//! [`dispatch`] applies the connection scheduling policy, then
//! [`dispatch_inline`] is the single `match` over the wire method; each arm
//! routes to a dedicated handler module. Shared wire-framing lives in [`reply`],
//! SQL in [`crate::db`], Worker management in [`crate::worker`], the per-run hub
//! in [`crate::hub`].

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
mod ticktick;
pub(crate) mod title;

use std::future::Future;

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;

use crate::hub::Hubs;
use crate::protocol::{JsonRpcRequest, SubscribeParams};

/// Keep the connection's single read/write loop live while a remote handler is
/// in flight. Detached responses remain paired by request id and may interleave
/// with later responses or Run Events on the same connection.
pub async fn dispatch(
    pool: &SqlitePool,
    hubs: &Hubs,
    req: JsonRpcRequest,
    out_tx: &UnboundedSender<String>,
) {
    if is_long_remote_handler(&req.method) {
        let pool = pool.clone();
        let hubs = hubs.clone();
        let dispatch_tx = out_tx.clone();
        spawn_detached_handler(
            req.method.clone(),
            req.id.clone(),
            out_tx.clone(),
            async move {
                dispatch_inline(&pool, &hubs, req, &dispatch_tx).await;
            },
        );
        return;
    }

    dispatch_inline(pool, hubs, req, out_tx).await;
}

/// Remote round trips that must not hold the socket's single read/write loop.
fn is_long_remote_handler(method: &str) -> bool {
    matches!(method, "ticktick/tasks/list" | "provider/test")
}

fn spawn_detached_handler<F>(
    method: String,
    id: serde_json::Value,
    out_tx: UnboundedSender<String>,
    future: F,
) where
    F: Future<Output = ()> + Send + 'static,
{
    tokio::spawn(async move {
        if let Err(error) = tokio::spawn(future).await {
            handler::frame_error(
                &out_tx,
                id,
                handler::HandlerError::Internal(anyhow::anyhow!(
                    "detached handler {method} failed: {error}"
                )),
            );
        }
    });
}

/// Route a decoded JSON-RPC request to its handler, one `match` arm per
/// method. An unknown method is answered with a JSON-RPC `-32601` (method not
/// found) so a typo'd or misrouted verb fails loud instead of leaving the
/// client's request future awaiting a reply that never comes.
async fn dispatch_inline(
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
        "ticktick/status" => {
            ticktick::handle_status(req.id, req.params, out_tx).await;
        }
        "ticktick/tasks/list" => {
            ticktick::handle_tasks_list(req.id, req.params, out_tx).await;
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

    #[test]
    fn only_long_remote_handlers_detach() {
        assert!(super::is_long_remote_handler("ticktick/tasks/list"));
        assert!(super::is_long_remote_handler("provider/test"));
        assert!(!super::is_long_remote_handler("settings/set"));
        assert!(!super::is_long_remote_handler("proposal/decide"));
    }

    async fn dispatch_rpc(
        pool: &SqlitePool,
        method: &str,
        params: serde_json::Value,
    ) -> Option<Value> {
        let hubs = hub::new_hubs();
        let (tx, mut rx) = mpsc::unbounded_channel();
        super::dispatch(
            pool,
            &hubs,
            JsonRpcRequest {
                jsonrpc: "2.0".to_string(),
                id: json!(7),
                method: method.to_string(),
                params,
            },
            &tx,
        )
        .await;
        tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
            .await
            .expect("dispatch replies within the test deadline")
            .map(|line| serde_json::from_str(&line).expect("frame is JSON"))
    }

    #[tokio::test]
    async fn detached_handler_panic_replies_internal_error() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        super::spawn_detached_handler("test/panic".to_string(), json!(8), tx, async move {
            panic!("detached test panic")
        });
        let line = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
            .await
            .expect("panic recovery replies within the test deadline")
            .expect("panic recovery queues a frame");
        let frame: Value = serde_json::from_str(&line).expect("frame is JSON");
        assert_eq!(frame["id"], json!(8));
        assert_eq!(frame["error"]["code"], json!(-32603));
        assert_eq!(frame["error"]["message"], json!("internal error"));
    }

    #[tokio::test]
    async fn detached_provider_test_name_is_routable() {
        let pool = memory_pool().await;
        let frame = dispatch_rpc(&pool, "provider/test", json!({}))
            .await
            .expect("detached method replies");
        assert_eq!(frame["error"]["code"], json!(-32602), "{frame:?}");
    }

    #[tokio::test]
    async fn unknown_method_replies_method_not_found() {
        let pool = memory_pool().await;
        let frame = dispatch_rpc(&pool, "does/not_exist", json!({}))
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
