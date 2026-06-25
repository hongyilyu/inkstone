//! `entity/*` handlers: the read path (`entity/list`, ADR-0004) the Library's
//! collections consume, and the user write path (`entity/mutate`, ADR-0033) that
//! applies CRUD directly without a Proposal. Both follow the combinator seam
//! (ADR-0029): decode params, run the body, frame the outcome.

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;

use super::handler::{self, HandlerError};
use crate::db;
use crate::mutate::{self, MutateError};
use crate::db::EntityProvenance;
use crate::protocol::{
    EntityBacklinksParams, EntityBacklinksResult, EntityListParams, EntityListResult,
    EntityMutateParams, EntityMutateResult, EntityRow, EntitySourceView, ResolvedEntityRef,
    TodoPersonRefView,
};

/// Map a tier-2 [`db::EntityRow`] to its wire [`EntityRow`], carrying `refs`,
/// `person_refs`, and the "Captured from" `source` (ADR-0030/0032). Shared by
/// `entity/list` and `entity/backlinks`, which return the same row shape.
fn entity_row_to_wire(row: db::EntityRow) -> EntityRow {
    EntityRow {
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
        person_refs: row
            .person_refs
            .into_iter()
            .map(|(person_id, role)| TodoPersonRefView { person_id, role })
            .collect(),
        source: row.source.map(|source| match source {
            EntityProvenance::Message {
                thread_id,
                thread_title,
            } => EntitySourceView {
                thread_id: Some(thread_id),
                thread_title: Some(thread_title),
                journal_entry_id: None,
            },
            EntityProvenance::JournalEntry { journal_entry_id } => EntitySourceView {
                thread_id: None,
                thread_title: None,
                journal_entry_id: Some(journal_entry_id),
            },
        }),
    }
}

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

        let entities = rows.into_iter().map(entity_row_to_wire).collect();

        Ok(EntityListResult { entities })
    })
    .await;
}

/// `entity/backlinks` handler (ADR-0050): the detail Inspector's reverse-relation
/// read. Mirrors [`handle_list`] — decode, run the body, frame the outcome —
/// returning the entity's distinct "Mentioned in" Journal Entries and its linked
/// Todos, each as the same wire [`EntityRow`].
pub(super) async fn handle_backlinks(
    pool: &SqlitePool,
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    handler::handle(
        id,
        params,
        out_tx,
        |params: EntityBacklinksParams| async move {
            let backlinks = db::backlinks_for_entity(pool, &params.entity_id)
                .await
                .map_err(|e| HandlerError::Internal(e.into()))?;

            Ok(EntityBacklinksResult {
                mentioned_in: backlinks
                    .mentioned_in
                    .into_iter()
                    .map(entity_row_to_wire)
                    .collect(),
                linked_todos: backlinks
                    .linked_todos
                    .into_iter()
                    .map(entity_row_to_wire)
                    .collect(),
            })
        },
    )
    .await;
}

/// `entity/mutate` handler (ADR-0033): a user-initiated CRUD write applied
/// directly to tier 2 with no Proposal. Validate + apply via [`crate::mutate`],
/// mapping its failures to wire codes (`Invalid → -32602`, `Internal → -32603`),
/// and reply with the affected `entity_id` (absent on delete).
pub(super) async fn handle_mutate(
    pool: &SqlitePool,
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    handler::handle(id, params, out_tx, |params: EntityMutateParams| async move {
        let outcome = mutate::apply(pool, &params.mutation_kind, &params.payload)
            .await
            .map_err(|e| match e {
                MutateError::Invalid(reason) => HandlerError::InvalidParams(reason),
                MutateError::Internal(err) => HandlerError::Internal(err),
            })?;
        Ok(EntityMutateResult {
            entity_id: outcome.entity_id,
        })
    })
    .await;
}
