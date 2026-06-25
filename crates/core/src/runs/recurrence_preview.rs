//! `recurrence/preview` handler (ADR-0039 amendment, #227): a read-only RPC that
//! previews the next occurrence of a draft Recurrence Rule. Pure — it touches no
//! DB and no Worker; it decodes the draft rule + the editing Todo's current
//! `defer_at`/`due_at` and runs the same `recurrence::next_occurrence` math the
//! completion path uses, so the editor's preview matches what completion will
//! actually spawn. A `None` (series ended, or a malformed/partial draft rule) is
//! a normal `{ended: true}` result, never an error — the editor sends in-progress
//! rules, and a bounded series ending is expected. The `pool` is unused (the math
//! is pure) but kept in the signature so dispatch routes every handler uniformly.

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;

use super::handler::{self, HandlerError};
use crate::protocol::{RecurrencePreviewParams, RecurrencePreviewResult};
use crate::recurrence::next_occurrence;

pub(super) async fn handle(
    _pool: &SqlitePool,
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    handler::handle(
        id,
        params,
        out_tx,
        |p: RecurrencePreviewParams| async move {
            let result = match next_occurrence(
                &p.recurrence,
                p.defer_at.as_deref(),
                p.due_at.as_deref(),
            ) {
                Some(next) => RecurrencePreviewResult {
                    ended: false,
                    defer_at: next.defer_at,
                    due_at: next.due_at,
                },
                None => RecurrencePreviewResult {
                    ended: true,
                    defer_at: None,
                    due_at: None,
                },
            };
            Ok::<_, HandlerError>(result)
        },
    )
    .await;
}
