//! `entity/list` handler (ADR-0004 read path): the live read the Library's
//! collections consume. Read every accepted Entity of the requested `type`
//! newest-first, map each row to a wire [`EntityRow`], and frame
//! `{entities: [...]}`. A missing/non-string `type` → `invalid_params`
//! (ADR-0029).

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;

use super::handler::{self, HandlerError};
use crate::db;
use crate::protocol::{EntityListParams, EntityListResult, EntityRow, ResolvedEntityRef};

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
                refs: row
                    .refs
                    .into_iter()
                    .map(|r| ResolvedEntityRef {
                        id: r.id,
                        source_entity_id: r.source_entity_id,
                        target_entity_id: r.target_entity_id,
                        target_entity_type: r.target_entity_type,
                        target_title: r.target_title,
                        label_snapshot: r.label_snapshot,
                    })
                    .collect(),
            })
            .collect();

        Ok(EntityListResult { entities })
    })
    .await;
}
