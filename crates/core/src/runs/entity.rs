//! `entity/list_todos` handler (slice 11, ADR-0004 read path): the live read
//! the Library's Todos collection consumes.
//!
//! No params — read every accepted Todo newest-first from tier 2, map each row
//! to a wire [`EntityRow`], and frame an `{entities: [...]}` result. A DB read
//! error falls back to `send_error` (internal, -32603); read-only, so there are
//! no client-input error cases to validate. Mirrors [`super::thread_list`].

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;

use super::reply::{send_error, send_response};
use crate::db;
use crate::protocol::{EntityListResult, EntityRow};

pub(super) async fn handle_list_todos(
    pool: &SqlitePool,
    id: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    let rows = match db::list_todos(pool).await {
        Ok(rows) => rows,
        Err(e) => {
            eprintln!("list_todos failed: {e}");
            send_error(out_tx, id, format!("list_todos: {e}"));
            return;
        }
    };

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

    send_response(
        out_tx,
        id,
        serde_json::to_value(EntityListResult { entities })
            .expect("EntityListResult serializes"),
    );
}
