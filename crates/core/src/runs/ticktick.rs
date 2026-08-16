//! `ticktick/status` + `ticktick/tasks/list` handlers (external-task-views A2).
//! Both read the boot-read connection (`crate::ticktick::connection`) — Core
//! holds no task state, so `tasks/list` fetches + normalizes per call.

use tokio::sync::mpsc::UnboundedSender;

use super::handler::{self, HandlerError};
use crate::protocol::TickTickStatusResult;

/// `ticktick/status` (A2/A5): the connection state + opaque boot-scoped
/// connection ID the Web keys its task query on. `connected` iff a credential
/// loaded at boot; the ID is present only then. Params are ignored.
pub(super) async fn handle_status(
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    handler::handle(id, params, out_tx, |_p: serde_json::Value| async move {
        Ok::<_, HandlerError>(match crate::ticktick::connection() {
            Some(conn) => TickTickStatusResult::Connected {
                connection_id: conn.connection_id.clone(),
            },
            None => TickTickStatusResult::NotConnected,
        })
    })
    .await;
}

/// `ticktick/tasks/list` (A2): the two-read OpenAPI fetch + normalization,
/// returning `{tasks, source_limit_reached}`. Not connected → `-32004`
/// (mirrors the run-creation provider gate) so the Web shows the disconnected
/// state; a transport/HTTP/decode failure (incl. a 401 from an expired
/// credential — A5) rides `Internal` so the query lands in its error state.
pub(super) async fn handle_tasks_list(
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    handler::handle(id, params, out_tx, |_p: serde_json::Value| async move {
        let Some(conn) = crate::ticktick::connection() else {
            return Err(HandlerError::ProviderNotConnected {
                provider: "ticktick".to_string(),
            });
        };
        crate::ticktick::client::fetch_tasks(&conn.access_token)
            .await
            .map_err(HandlerError::Internal)
    })
    .await;
}
