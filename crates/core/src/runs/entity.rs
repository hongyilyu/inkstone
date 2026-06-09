//! `entity/list` handler (ADR-0004 read path): the live read the Library's
//! collections consume.
//!
//! Decode `EntityListParams` through the combinator (a missing/non-string
//! `type` → `invalid_params`, ADR-0029), read every accepted Entity of that
//! type newest-first from tier 2, map each row to a wire [`EntityRow`], and
//! frame an `{entities: [...]}` result. A DB read error surfaces as an internal
//! error (-32603) via the combinator. Mirrors [`super::thread_get`] (params
//! decoded through the seam) and [`super::thread_list`] (rows mapped to the
//! wire shape).

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;

use super::handler::{self, HandlerError};
use crate::db;
use crate::protocol::{EntityListParams, EntityListResult, EntityRow};

pub(super) async fn handle_list(
    pool: &SqlitePool,
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    handler::handle(id, params, out_tx, |params: EntityListParams| async move {
        let rows = db::list_by_type(pool, &params.r#type)
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
