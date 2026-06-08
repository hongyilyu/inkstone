//! `entity/list_todos` handler (slice 11, ADR-0004 read path): the live read
//! the Library's Todos collection consumes.
//!
//! No params — read every accepted Todo newest-first from tier 2, map each row
//! to a wire [`EntityRow`], and frame an `{entities: [...]}` result. A DB read
//! error surfaces as an internal error (-32603) via the combinator (ADR-0029);
//! read-only, so there are no client-input error cases to validate. Mirrors
//! [`super::thread_list`].

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;

use super::handler::{self, HandlerError};
use crate::db;
use crate::protocol::{EntityListResult, EntityRow};

pub(super) async fn handle_list_todos(
    pool: &SqlitePool,
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    handler::handle(id, params, out_tx, |_p: serde_json::Value| async move {
        let rows = db::list_todos(pool)
            .await
            .map_err(|e| HandlerError::Internal(e.into()))?;

        let entities = rows
            .into_iter()
            .map(|row| EntityRow {
                id: row.id,
                r#type: row.r#type,
                data: row.data,
                created_at: row.created_at,
                updated_at: row.updated_at,
            })
            .collect();

        Ok(EntityListResult { entities })
    })
    .await;
}
