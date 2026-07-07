//! Observation storage facade. SQL stays in `queries`, matching the DB module's
//! one-statement query convention; this module owns the observation storage
//! shapes and transaction boundary.

use sqlx::{Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

use super::ApplyError;
use super::decide_proposal;
use super::queries;
use crate::mutation::EntityType;

pub(crate) struct ObservationInsert {
    pub id: String,
    pub schema_key: String,
    pub schema_version: i64,
    pub occurred_at: String,
    pub ended_at: Option<String>,
    pub values_json: String,
    pub note: Option<String>,
    pub created_by: String,
    pub created_via_proposal_id: Option<String>,
    pub relations: Vec<ObservationRelationInsert>,
    pub source: Option<ObservationSourceInsert>,
}

pub(crate) struct ObservationUpdate {
    pub id: String,
    pub schema_key: String,
    pub schema_version: i64,
    pub occurred_at: String,
    pub ended_at: Option<String>,
    pub values_json: String,
    pub note: Option<String>,
    pub relations: Vec<ObservationRelationInsert>,
}

pub(crate) struct ObservationRelationInsert {
    pub field_name: &'static str,
    pub entity_id: String,
    pub target_entity_type: EntityType,
}

pub(crate) enum ObservationSourceInsert {
    JournalEntry { id: String },
    Message { id: String },
}

impl ObservationSourceInsert {
    fn relation(&self) -> &'static str {
        match self {
            ObservationSourceInsert::JournalEntry { .. } => "created_from",
            ObservationSourceInsert::Message { .. } => "evidenced_by",
        }
    }

    fn source_entity_id(&self) -> Option<&str> {
        match self {
            ObservationSourceInsert::JournalEntry { id } => Some(id),
            ObservationSourceInsert::Message { .. } => None,
        }
    }

    fn source_message_id(&self) -> Option<&str> {
        match self {
            ObservationSourceInsert::JournalEntry { .. } => None,
            ObservationSourceInsert::Message { id } => Some(id),
        }
    }
}

pub(crate) struct ObservationFilter {
    pub schema_keys: Vec<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub source: Option<ObservationSourceFilter>,
    pub related_entity_id: Option<String>,
    pub limit: Option<i64>,
}

pub(crate) enum ObservationSourceFilter {
    JournalEntry { id: String },
    Message { id: String },
}

pub(crate) struct ObservationRow {
    pub id: String,
    pub schema_key: String,
    pub schema_version: i64,
    pub occurred_at: String,
    pub ended_at: Option<String>,
    pub values_json: String,
    pub note: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub source_relation: Option<String>,
    pub source_entity_id: Option<String>,
    pub source_message_id: Option<String>,
}

/// One `observation_revisions` row, the correction-history projection read by
/// `observation/get_history`. Raw `values_json` is parsed by `crate::observations`,
/// matching `ObservationRow`'s layering. `proposal_id` is NULL for user edits.
pub(crate) struct ObservationRevisionRow {
    pub seq: i64,
    pub schema_key: String,
    pub schema_version: i64,
    pub occurred_at: String,
    pub ended_at: Option<String>,
    pub values_json: String,
    pub note: Option<String>,
    pub proposal_id: Option<String>,
    pub created_at: i64,
}

#[derive(Debug)]
pub(crate) enum ObservationInsertError {
    InvalidSource(String),
    InvalidRelation(String),
    Sqlx(sqlx::Error),
}

#[derive(Debug)]
pub(crate) enum ObservationUpdateError {
    InvalidRelation(String),
    Sqlx(sqlx::Error),
}

impl From<sqlx::Error> for ObservationInsertError {
    fn from(value: sqlx::Error) -> Self {
        ObservationInsertError::Sqlx(value)
    }
}

impl From<sqlx::Error> for ObservationUpdateError {
    fn from(value: sqlx::Error) -> Self {
        ObservationUpdateError::Sqlx(value)
    }
}

/// Insert a batch of validated Observations atomically. Validation and JSON
/// serialization live in `crate::observations`; source existence/type checks
/// happen here because they need the same write transaction as the insert.
pub(crate) async fn insert_observations(
    pool: &SqlitePool,
    rows: Vec<ObservationInsert>,
    now_ms: i64,
) -> Result<(), ObservationInsertError> {
    let mut tx = pool.begin().await?;
    insert_observations_in_tx(&mut tx, rows, now_ms).await?;
    tx.commit().await?;
    Ok(())
}

pub(super) async fn insert_observations_in_tx(
    tx: &mut Transaction<'_, Sqlite>,
    rows: Vec<ObservationInsert>,
    now_ms: i64,
) -> Result<(), ObservationInsertError> {
    for row in rows {
        if let Some(reason) = invalid_relation_reason(tx, &row.relations).await? {
            return Err(ObservationInsertError::InvalidRelation(reason));
        }
        queries::insert_observation(
            &mut **tx,
            &row.id,
            &row.schema_key,
            row.schema_version,
            &row.occurred_at,
            row.ended_at.as_deref(),
            &row.values_json,
            row.note.as_deref(),
            &row.created_by,
            row.created_via_proposal_id.as_deref(),
            now_ms,
        )
        .await?;
        queries::insert_next_observation_revision(
            &mut **tx,
            &row.id,
            &row.schema_key,
            row.schema_version,
            &row.occurred_at,
            row.ended_at.as_deref(),
            &row.values_json,
            row.note.as_deref(),
            row.created_via_proposal_id.as_deref(),
            now_ms,
        )
        .await?;
        if let Some(source) = row.source {
            match &source {
                ObservationSourceInsert::JournalEntry { id } => {
                    if !queries::entity_is_type(
                        &mut **tx,
                        id,
                        crate::mutation::EntityType::JournalEntry.as_str(),
                    )
                    .await?
                    {
                        return Err(ObservationInsertError::InvalidSource(
                            "observation source_entity_id must name a journal_entry".to_string(),
                        ));
                    }
                }
                ObservationSourceInsert::Message { id } => {
                    if !queries::message_exists(&mut **tx, id).await? {
                        return Err(ObservationInsertError::InvalidSource(
                            "observation source_message_id must name an existing message"
                                .to_string(),
                        ));
                    }
                }
            }
            queries::insert_observation_source(
                &mut **tx,
                &Uuid::now_v7().to_string(),
                &row.id,
                source.source_entity_id(),
                source.source_message_id(),
                source.relation(),
                now_ms,
            )
            .await?;
        }
    }
    Ok(())
}

pub(crate) async fn update_observation(
    pool: &SqlitePool,
    row: ObservationUpdate,
    now_ms: i64,
) -> Result<(), ObservationUpdateError> {
    let mut tx = pool.begin().await?;

    if let Some(reason) = invalid_relation_reason(&mut tx, &row.relations).await? {
        return Err(ObservationUpdateError::InvalidRelation(reason));
    }

    queries::update_observation(
        &mut *tx,
        &row.id,
        row.schema_version,
        &row.occurred_at,
        row.ended_at.as_deref(),
        &row.values_json,
        row.note.as_deref(),
        now_ms,
    )
    .await?;

    queries::insert_next_observation_revision(
        &mut *tx,
        &row.id,
        &row.schema_key,
        row.schema_version,
        &row.occurred_at,
        row.ended_at.as_deref(),
        &row.values_json,
        row.note.as_deref(),
        None,
        now_ms,
    )
    .await?;

    tx.commit().await?;
    Ok(())
}

/// The stored `schema_key` of an Observation, or `None` if no such row exists.
/// `observation/update` derives the schema from the stored row (#256), so the
/// update path loads this before its write transaction.
pub(crate) async fn observation_schema_key(
    pool: &SqlitePool,
    observation_id: &str,
) -> sqlx::Result<Option<String>> {
    queries::observation_schema_key(pool, observation_id).await
}

async fn invalid_relation_reason(
    tx: &mut Transaction<'_, Sqlite>,
    relations: &[ObservationRelationInsert],
) -> sqlx::Result<Option<String>> {
    for relation in relations {
        if !queries::entity_is_type(
            &mut **tx,
            &relation.entity_id,
            relation.target_entity_type.as_str(),
        )
        .await?
        {
            return Ok(Some(format!(
                "observation {} must name a {}",
                relation.field_name,
                relation.target_entity_type.as_str()
            )));
        }
    }
    Ok(None)
}

/// Apply an accepted `record_observations` Proposal via the one decide envelope
/// (see [`decide_proposal`]): this function contributes the observation family's
/// in-tx writer (the batched [`insert_observations_in_tx`]). Unlike the entity
/// families, the Decision payload arrives PRE-RENDERED from the caller —
/// Observations mint no Entity id for the resume transcript to carry — so the
/// writer just hands it through.
pub(crate) async fn apply_record_observations_proposal(
    pool: &SqlitePool,
    ctx: decide_proposal::DecisionCtx<'_>,
    rows: Vec<ObservationInsert>,
    edited_payload: Option<&serde_json::Value>,
    decision_result_payload: &str,
) -> Result<(), ApplyError> {
    let edited_str = edited_payload.map(|v| v.to_string());
    // `accept` consumes `ctx`; the writer needs `now_ms` (Copy), so bind it as
    // a local before building the closure.
    let now_ms = ctx.now_ms;

    let writer = |mut tx: Transaction<'static, Sqlite>| {
        Box::pin(async move {
            insert_observations_in_tx(&mut tx, rows, now_ms)
                .await
                .map_err(observation_insert_to_apply)?;
            Ok((tx, (), decision_result_payload.to_string()))
        }) as decide_proposal::WriterFuture<'_, ()>
    };

    decide_proposal::accept(pool, ctx, edited_str.as_deref(), writer).await
}

fn observation_insert_to_apply(err: ObservationInsertError) -> ApplyError {
    match err {
        ObservationInsertError::InvalidSource(reason)
        | ObservationInsertError::InvalidRelation(reason) => ApplyError::InvalidMutation(reason),
        ObservationInsertError::Sqlx(err) => ApplyError::Sql(err),
    }
}

/// Read stored Observations by schema/time/source filters. Raw JSON is returned
/// here and parsed by `crate::observations`, matching the Entity read layering.
pub(crate) async fn query_observations(
    pool: &SqlitePool,
    filter: ObservationFilter,
) -> sqlx::Result<Vec<ObservationRow>> {
    queries::query_observations(pool, &filter).await
}

/// Read an Observation's correction history (`observation_revisions`) ordered
/// `seq ASC`. Raw JSON returned here and parsed by `crate::observations`.
pub(crate) async fn observation_revisions(
    pool: &SqlitePool,
    observation_id: &str,
) -> sqlx::Result<Vec<ObservationRevisionRow>> {
    queries::observation_revisions(pool, observation_id).await
}
