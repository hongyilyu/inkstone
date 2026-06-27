use serde_json::Value;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::db;
use crate::entities::parse_local_datetime;
use crate::field_spec::{Field, FieldSpec, PayloadSpec};

const BODYWEIGHT_SCHEMA_KEY: &str = "bodyweight";
const BODYWEIGHT_SCHEMA_VERSION: i64 = 1;

#[derive(Clone, Debug)]
pub(crate) struct RecordObservationsInput {
    pub(crate) observations: Vec<ObservationRecordInput>,
}

#[derive(Clone, Debug)]
pub(crate) struct ObservationRecordInput {
    pub(crate) schema_key: String,
    pub(crate) occurred_at: String,
    pub(crate) ended_at: Option<String>,
    pub(crate) values: Value,
    pub(crate) note: Option<String>,
    pub(crate) source: Option<ObservationSourceInput>,
}

#[derive(Clone, Debug)]
pub(crate) enum ObservationSourceInput {
    JournalEntry { id: String },
    Message { id: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ObservationSourceRelation {
    CreatedFrom,
    EvidencedBy,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct ObservationQuery {
    pub(crate) schema_keys: Vec<String>,
    pub(crate) from: Option<String>,
    pub(crate) to: Option<String>,
    pub(crate) source_entity_id: Option<String>,
    pub(crate) source_message_id: Option<String>,
    pub(crate) limit: Option<i64>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Observation {
    pub(crate) id: String,
    pub(crate) schema_key: String,
    pub(crate) schema_version: i64,
    pub(crate) occurred_at: String,
    pub(crate) ended_at: Option<String>,
    pub(crate) values: Value,
    pub(crate) note: Option<String>,
    pub(crate) source: Option<ObservationSource>,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ObservationSource {
    JournalEntry { id: String },
    Message { id: String },
}

#[derive(Debug)]
pub(crate) enum ObservationError {
    Invalid(String),
    Internal(anyhow::Error),
}

pub(crate) async fn record_observations(
    pool: &SqlitePool,
    input: RecordObservationsInput,
) -> Result<Vec<Observation>, ObservationError> {
    let now_ms = db::now_ms();
    let mut inserts = Vec::with_capacity(input.observations.len());
    let mut observations = Vec::with_capacity(input.observations.len());

    for record in input.observations {
        let schema = validate_record(&record).map_err(ObservationError::Invalid)?;
        let id = Uuid::now_v7().to_string();
        let values_json = serde_json::to_string(&record.values)
            .map_err(|e| ObservationError::Internal(anyhow::Error::new(e)))?;
        let source = record
            .source
            .as_ref()
            .map(validated_source)
            .transpose()
            .map_err(ObservationError::Invalid)?;

        inserts.push(db::ObservationInsert {
            id: id.clone(),
            schema_key: schema.key.to_string(),
            schema_version: schema.version,
            occurred_at: record.occurred_at.clone(),
            ended_at: record.ended_at.clone(),
            values_json,
            note: record.note.clone(),
            created_by: "user".to_string(),
            created_via_proposal_id: None,
            source: source.as_ref().map(|source| match source {
                ObservationSource::JournalEntry { id } => {
                    db::ObservationSourceInsert::JournalEntry { id: id.clone() }
                }
                ObservationSource::Message { id } => {
                    db::ObservationSourceInsert::Message { id: id.clone() }
                }
            }),
        });
        observations.push(Observation {
            id,
            schema_key: schema.key.to_string(),
            schema_version: schema.version,
            occurred_at: record.occurred_at,
            ended_at: record.ended_at,
            values: record.values,
            note: record.note,
            source,
            created_at: now_ms,
            updated_at: now_ms,
        });
    }

    db::insert_observations(pool, inserts, now_ms)
        .await
        .map_err(|e| match e {
            db::ObservationInsertError::InvalidSource(reason) => ObservationError::Invalid(reason),
            db::ObservationInsertError::Sqlx(err) => ObservationError::Internal(err.into()),
        })?;
    Ok(observations)
}

pub(crate) async fn query_observations(
    pool: &SqlitePool,
    filter: ObservationQuery,
) -> Result<Vec<Observation>, ObservationError> {
    validate_query(&filter).map_err(ObservationError::Invalid)?;
    let rows = db::query_observations(
        pool,
        db::ObservationFilter {
            schema_keys: filter.schema_keys,
            from: filter.from,
            to: filter.to,
            source_entity_id: filter.source_entity_id,
            source_message_id: filter.source_message_id,
            limit: filter.limit,
        },
    )
    .await
    .map_err(|e| ObservationError::Internal(e.into()))?;

    rows.into_iter().map(observation_from_row).collect()
}

struct ObservationSchema {
    key: &'static str,
    version: i64,
    values: PayloadSpec,
}

fn schema_for(schema_key: &str) -> Option<ObservationSchema> {
    match schema_key {
        BODYWEIGHT_SCHEMA_KEY => Some(ObservationSchema {
            key: BODYWEIGHT_SCHEMA_KEY,
            version: BODYWEIGHT_SCHEMA_VERSION,
            values: PayloadSpec::payload(
                "bodyweight values",
                vec![Field::required(
                    "kg",
                    FieldSpec::Number {
                        min: Some(0.0),
                        max: None,
                        integer: false,
                    },
                )],
            ),
        }),
        _ => None,
    }
}

fn validate_record(record: &ObservationRecordInput) -> Result<ObservationSchema, String> {
    let schema = schema_for(&record.schema_key)
        .ok_or_else(|| format!("unknown observation schema {:?}", record.schema_key))?;

    let occurred = parse_local_datetime(&record.occurred_at, "occurred_at")?;
    if let Some(ended_at) = &record.ended_at {
        let ended = parse_local_datetime(ended_at, "ended_at")?;
        if ended < occurred {
            return Err("ended_at must be greater than or equal to occurred_at".to_string());
        }
    }
    schema.values.check(&record.values)?;
    Ok(schema)
}

fn validate_query(filter: &ObservationQuery) -> Result<(), String> {
    for schema_key in &filter.schema_keys {
        if schema_for(schema_key).is_none() {
            return Err(format!("unknown observation schema {schema_key:?}"));
        }
    }
    let mut parsed_from = None;
    if let Some(from) = &filter.from {
        parsed_from = Some(parse_local_datetime(from, "from")?);
    }
    let mut parsed_to = None;
    if let Some(to) = &filter.to {
        parsed_to = Some(parse_local_datetime(to, "to")?);
    }
    if let (Some(from), Some(to)) = (parsed_from, parsed_to)
        && to < from
    {
        return Err("to must be greater than or equal to from".to_string());
    }
    if let Some(limit) = filter.limit
        && limit < 1
    {
        return Err("limit must be positive".to_string());
    }
    if let Some(source_entity_id) = &filter.source_entity_id {
        parse_uuid(source_entity_id, "source_entity_id")?;
    }
    if let Some(source_message_id) = &filter.source_message_id {
        parse_uuid(source_message_id, "source_message_id")?;
    }
    Ok(())
}

fn validated_source(source: &ObservationSourceInput) -> Result<ObservationSource, String> {
    match source {
        ObservationSourceInput::JournalEntry { id } => {
            parse_uuid(id, "source_entity_id")?;
            Ok(ObservationSource::JournalEntry { id: id.clone() })
        }
        ObservationSourceInput::Message { id } => {
            parse_uuid(id, "source_message_id")?;
            Ok(ObservationSource::Message { id: id.clone() })
        }
    }
}

fn parse_uuid(value: &str, field: &str) -> Result<(), String> {
    Uuid::parse_str(value).map_err(|_| format!("{field} must be a UUID"))?;
    Ok(())
}

fn observation_from_row(row: db::ObservationRow) -> Result<Observation, ObservationError> {
    let values = serde_json::from_str(&row.values_json).map_err(|e| {
        ObservationError::Internal(anyhow::anyhow!(
            "observation {} values are malformed JSON: {e}",
            row.id
        ))
    })?;
    let source = match (
        row.source_relation,
        row.source_entity_id,
        row.source_message_id,
    ) {
        (Some(relation), Some(source_entity_id), None) => {
            match relation_from_str(&relation).map_err(|reason| {
                ObservationError::Internal(anyhow::anyhow!(
                    "observation {} source relation is malformed: {reason}",
                    row.id
                ))
            })? {
                ObservationSourceRelation::CreatedFrom => Some(ObservationSource::JournalEntry {
                    id: source_entity_id,
                }),
                ObservationSourceRelation::EvidencedBy => {
                    return Err(ObservationError::Internal(anyhow::anyhow!(
                        "observation {} source row has entity evidence with evidenced_by relation",
                        row.id
                    )));
                }
            }
        }
        (Some(relation), None, Some(source_message_id)) => {
            match relation_from_str(&relation).map_err(|reason| {
                ObservationError::Internal(anyhow::anyhow!(
                    "observation {} source relation is malformed: {reason}",
                    row.id
                ))
            })? {
                ObservationSourceRelation::EvidencedBy => Some(ObservationSource::Message {
                    id: source_message_id,
                }),
                ObservationSourceRelation::CreatedFrom => {
                    return Err(ObservationError::Internal(anyhow::anyhow!(
                        "observation {} source row has message evidence with created_from relation",
                        row.id
                    )));
                }
            }
        }
        (None, None, None) => None,
        _ => {
            return Err(ObservationError::Internal(anyhow::anyhow!(
                "observation {} source row is malformed",
                row.id
            )));
        }
    };
    Ok(Observation {
        id: row.id,
        schema_key: row.schema_key,
        schema_version: row.schema_version,
        occurred_at: row.occurred_at,
        ended_at: row.ended_at,
        values,
        note: row.note,
        source,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

fn relation_from_str(value: &str) -> Result<ObservationSourceRelation, String> {
    match value {
        "created_from" => Ok(ObservationSourceRelation::CreatedFrom),
        "evidenced_by" => Ok(ObservationSourceRelation::EvidencedBy),
        _ => Err(format!("unknown observation source relation {value:?}")),
    }
}

impl ObservationSourceRelation {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ObservationSourceRelation::CreatedFrom => "created_from",
            ObservationSourceRelation::EvidencedBy => "evidenced_by",
        }
    }
}

impl ObservationSource {
    pub(crate) fn relation(&self) -> ObservationSourceRelation {
        match self {
            ObservationSource::JournalEntry { .. } => ObservationSourceRelation::CreatedFrom,
            ObservationSource::Message { .. } => ObservationSourceRelation::EvidencedBy,
        }
    }

    pub(crate) fn source_entity_id(&self) -> Option<&str> {
        match self {
            ObservationSource::JournalEntry { id } => Some(id),
            ObservationSource::Message { .. } => None,
        }
    }

    pub(crate) fn source_message_id(&self) -> Option<&str> {
        match self {
            ObservationSource::JournalEntry { .. } => None,
            ObservationSource::Message { id } => Some(id),
        }
    }
}

#[cfg(test)]
mod observations_tests {
    use super::*;
    use serde_json::json;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    async fn memory_pool() -> SqlitePool {
        let options = SqliteConnectOptions::new()
            .filename(":memory:")
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("open in-memory sqlite");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        pool
    }

    fn bodyweight_at(occurred_at: &str, kg: Value) -> ObservationRecordInput {
        ObservationRecordInput {
            schema_key: "bodyweight".to_string(),
            occurred_at: occurred_at.to_string(),
            ended_at: None,
            values: json!({ "kg": kg }),
            note: None,
            source: None,
        }
    }

    fn invalid_reason(err: ObservationError) -> String {
        match err {
            ObservationError::Invalid(reason) => reason,
            ObservationError::Internal(err) => panic!("expected invalid observation error: {err:?}"),
        }
    }

    async fn seed_message(pool: &SqlitePool, message_id: &str) {
        let mut tx = pool.begin().await.expect("begin source message seed");
        sqlx::query(
            "INSERT INTO threads (id, title, created_at, last_activity_at) \
             VALUES ('thread-source', 'Source Thread', 1, 1)",
        )
        .execute(&mut *tx)
        .await
        .expect("insert source thread");
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, \
              thinking_level, user_message_id, status, started_at) \
             VALUES ('run-source', 'thread-source', 'w', '1', 'p', 'm', 'off', ?1, 'completed', 1)",
        )
        .bind(message_id)
        .execute(&mut *tx)
        .await
        .expect("insert source run");
        sqlx::query(
            "INSERT INTO messages (id, thread_id, run_id, role, status, created_at, updated_at) \
             VALUES (?1, 'thread-source', 'run-source', 'user', 'completed', 1, 1)",
        )
        .bind(message_id)
        .execute(&mut *tx)
        .await
        .expect("insert source message");
        tx.commit().await.expect("commit source message seed");
    }

    async fn seed_entity(pool: &SqlitePool, entity_id: &str) {
        sqlx::query(
            "INSERT INTO entities \
             (id, type, schema_version, data, created_by, created_at, updated_at) \
             VALUES (?1, 'journal_entry', 1, '{}', 'user', 1, 1)",
        )
        .bind(entity_id)
        .execute(pool)
        .await
        .expect("insert source entity");
    }

    #[tokio::test]
    async fn observations_record_bodyweight_validate_and_query_filters() {
        let pool = memory_pool().await;
        seed_message(&pool, "018f0000-0000-7000-8000-000000000001").await;
        seed_entity(&pool, "018f0000-0000-7000-8000-000000000002").await;

        let mut direct = bodyweight_at("2026-06-01T07:30:00", json!(72.4));
        direct.note = Some("morning".to_string());
        let recorded = record_observations(
            &pool,
            RecordObservationsInput {
                observations: vec![direct],
            },
        )
        .await
        .expect("record direct bodyweight");
        assert_eq!(recorded.len(), 1);

        let (created_by, created_via): (String, Option<String>) = sqlx::query_as(
            "SELECT created_by, created_via_proposal_id FROM observations WHERE id = ?1",
        )
        .bind(&recorded[0].id)
        .fetch_one(&pool)
        .await
        .expect("observation row");
        assert_eq!(created_by, "user");
        assert_eq!(created_via, None);
        assert_eq!(recorded[0].updated_at, recorded[0].created_at);

        sqlx::query(
            "INSERT INTO tool_calls (id, run_id, name, request_payload, status, requested_at) \
             VALUES ('tool-call-observation-check', 'run-source', 'record_observations', '{}', \
                     'pending', 1)",
        )
        .execute(&pool)
        .await
        .expect("insert observation check tool call");
        sqlx::query(
            "INSERT INTO proposals (id, tool_call_id, mutation_kind, status) \
             VALUES ('proposal-observation-check', 'tool-call-observation-check', \
                     'record_observations', 'pending')",
        )
        .execute(&pool)
        .await
        .expect("insert observation check proposal");
        let err = sqlx::query(
            "INSERT INTO observations \
             (id, schema_key, schema_version, occurred_at, values_json, created_by, \
              created_via_proposal_id, created_at, updated_at) \
             VALUES ('observation-invalid-user-proposal', 'bodyweight', 1, \
                     '2026-06-01T07:30:00', '{\"kg\":72.4}', 'user', \
                     'proposal-observation-check', 1, 1)",
        )
        .execute(&pool)
        .await
        .expect_err("user observations cannot carry a proposal id");
        assert!(err.to_string().contains("CHECK constraint failed"));

        let by_time = query_observations(
            &pool,
            ObservationQuery {
                schema_keys: vec!["bodyweight".to_string()],
                from: Some("2026-06-01T00:00:00".to_string()),
                to: Some("2026-06-01T23:59:59".to_string()),
                limit: Some(10),
                ..ObservationQuery::default()
            },
        )
        .await
        .expect("query bodyweight by schema and time");
        assert_eq!(by_time.len(), 1);
        assert_eq!(by_time[0].schema_key, "bodyweight");
        assert_eq!(by_time[0].schema_version, 1);
        assert_eq!(by_time[0].occurred_at, "2026-06-01T07:30:00");
        assert_eq!(by_time[0].values, json!({ "kg": 72.4 }));
        assert_eq!(by_time[0].note.as_deref(), Some("morning"));
        assert_eq!(by_time[0].updated_at, by_time[0].created_at);

        let mut from_message = bodyweight_at("2026-06-02T07:30:00", json!(72.1));
        from_message.source = Some(ObservationSourceInput::Message {
            id: "018f0000-0000-7000-8000-000000000001".to_string(),
        });
        let mut from_entity = bodyweight_at("2026-06-03T07:30:00", json!(71.9));
        from_entity.source = Some(ObservationSourceInput::JournalEntry {
            id: "018f0000-0000-7000-8000-000000000002".to_string(),
        });
        let sourced = record_observations(
            &pool,
            RecordObservationsInput {
                observations: vec![from_message, from_entity],
            },
        )
        .await
        .expect("record sourced observations");

        let by_message = query_observations(
            &pool,
            ObservationQuery {
                source_message_id: Some("018f0000-0000-7000-8000-000000000001".to_string()),
                ..ObservationQuery::default()
            },
        )
        .await
        .expect("query by source message");
        assert_eq!(by_message.len(), 1);
        assert_eq!(by_message[0].values, json!({ "kg": 72.1 }));

        let by_entity = query_observations(
            &pool,
            ObservationQuery {
                source_entity_id: Some("018f0000-0000-7000-8000-000000000002".to_string()),
                ..ObservationQuery::default()
            },
        )
        .await
        .expect("query by source entity");
        assert_eq!(by_entity.len(), 1);
        assert_eq!(by_entity[0].values, json!({ "kg": 71.9 }));

        let duplicate_source = sqlx::query(
            "INSERT INTO observation_sources \
             (id, observation_id, source_message_id, relation, created_at) \
             VALUES ('duplicate-observation-source', ?1, \
                     '018f0000-0000-7000-8000-000000000001', 'evidenced_by', 1)",
        )
        .bind(&sourced[1].id)
        .execute(&pool)
        .await
        .expect_err("one observation accepts at most one source row");
        assert!(duplicate_source.to_string().contains("UNIQUE"));

        let limited = query_observations(
            &pool,
            ObservationQuery {
                schema_keys: vec!["bodyweight".to_string()],
                limit: Some(2),
                ..ObservationQuery::default()
            },
        )
        .await
        .expect("query with limit");
        assert_eq!(limited.len(), 2);
        assert_eq!(limited[0].occurred_at, "2026-06-03T07:30:00");
        assert_eq!(limited[1].occurred_at, "2026-06-02T07:30:00");

        let unknown_schema = ObservationRecordInput {
            schema_key: "blood_pressure".to_string(),
            ..bodyweight_at("2026-06-04T07:30:00", json!(120.0))
        };
        let reason = record_observations(
            &pool,
            RecordObservationsInput {
                observations: vec![unknown_schema],
            },
        )
        .await
        .expect_err("unknown schema is rejected");
        let reason = invalid_reason(reason);
        assert!(reason.contains("unknown observation schema"));

        let reason = record_observations(
            &pool,
            RecordObservationsInput {
                observations: vec![bodyweight_at("2026-06-04T07:30:00", json!("72.0"))],
            },
        )
        .await
        .expect_err("bodyweight kg must be numeric");
        let reason = invalid_reason(reason);
        assert_eq!(reason, "kg must be a number");

        let reason = record_observations(
            &pool,
            RecordObservationsInput {
                observations: vec![bodyweight_at("2026-06-04T07:30:00", json!(-1.0))],
            },
        )
        .await
        .expect_err("negative bodyweight is rejected");
        let reason = invalid_reason(reason);
        assert_eq!(reason, "kg must be at least 0");

        let ended_before_start = ObservationRecordInput {
            ended_at: Some("2026-06-04T07:29:59".to_string()),
            ..bodyweight_at("2026-06-04T07:30:00", json!(72.0))
        };
        let reason = record_observations(
            &pool,
            RecordObservationsInput {
                observations: vec![ended_before_start],
            },
        )
        .await
        .expect_err("ended_at before occurred_at is rejected");
        let reason = invalid_reason(reason);
        assert_eq!(
            reason,
            "ended_at must be greater than or equal to occurred_at"
        );
    }
}
