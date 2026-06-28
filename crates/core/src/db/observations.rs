//! Observation storage facade. SQL stays in `queries`, matching the DB module's
//! one-statement query convention; this module owns the observation storage
//! shapes and transaction boundary.

use sqlx::{Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

use super::ApplyError;
use super::lifecycle::ProposalStatus;
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

#[derive(Debug)]
pub(crate) enum ObservationInsertError {
    InvalidSource(String),
    InvalidRelation(String),
    Sqlx(sqlx::Error),
}

impl From<sqlx::Error> for ObservationInsertError {
    fn from(value: sqlx::Error) -> Self {
        ObservationInsertError::Sqlx(value)
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
        for relation in row.relations {
            if !queries::entity_is_type(
                &mut **tx,
                &relation.entity_id,
                relation.target_entity_type.as_str(),
            )
            .await?
            {
                return Err(ObservationInsertError::InvalidRelation(format!(
                    "observation {} must name a {}",
                    relation.field_name,
                    relation.target_entity_type.as_str()
                )));
            }
        }
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

#[allow(clippy::too_many_arguments)]
pub(crate) async fn apply_record_observations_proposal(
    pool: &SqlitePool,
    run_id: Uuid,
    proposal_id: &str,
    tool_call_id: &str,
    rows: Vec<ObservationInsert>,
    edited_payload: Option<&serde_json::Value>,
    decision_idempotency_key: Option<&str>,
    decision_result_payload: &str,
    now_ms: i64,
) -> Result<(), ApplyError> {
    let edited_str = edited_payload.map(|v| v.to_string());
    let mut tx = pool.begin().await?;

    let accepted = ProposalStatus::accept(
        &mut *tx,
        run_id,
        proposal_id,
        edited_str.as_deref(),
        decision_idempotency_key,
        now_ms,
    )
    .await?;
    if !accepted.won() {
        return Err(ApplyError::NotPending);
    }

    insert_observations_in_tx(&mut tx, rows, now_ms)
        .await
        .map_err(observation_insert_to_apply)?;

    queries::resolve_tool_call(
        &mut *tx,
        tool_call_id,
        "completed",
        decision_result_payload,
        now_ms,
    )
    .await?;

    tx.commit().await?;
    Ok(())
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
