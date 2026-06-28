use serde_json::Value;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::db;
use crate::entities::parse_local_datetime;
use crate::field_spec::{Field, FieldSpec, ObjErr, PayloadSpec};
use crate::mutation::EntityType;

const BODYWEIGHT_SCHEMA_KEY: &str = "bodyweight";
const BODYWEIGHT_SCHEMA_VERSION: i64 = 1;
const BODYWEIGHT_SCHEMA_KEY_DOMAIN: &[&str] = &[BODYWEIGHT_SCHEMA_KEY];
const HABIT_CHECKIN_SCHEMA_KEY: &str = "habit.checkin";
const HABIT_CHECKIN_SCHEMA_VERSION: i64 = 1;
const HABIT_CHECKIN_SCHEMA_KEY_DOMAIN: &[&str] = &[HABIT_CHECKIN_SCHEMA_KEY];
const NUTRITION_INTAKE_SCHEMA_KEY: &str = "nutrition.intake";
const NUTRITION_INTAKE_SCHEMA_VERSION: i64 = 1;
const NUTRITION_INTAKE_SCHEMA_KEY_DOMAIN: &[&str] = &[NUTRITION_INTAKE_SCHEMA_KEY];

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
pub(crate) struct ObservationUpdateInput {
    pub(crate) schema_key: String,
    pub(crate) occurred_at: String,
    pub(crate) ended_at: Option<String>,
    pub(crate) values: Value,
    pub(crate) note: Option<String>,
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
    pub(crate) source: Option<ObservationSourceInput>,
    pub(crate) related_entity_id: Option<String>,
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
    let (inserts, observations) = prepare_observations(input, "user", None, now_ms)?;
    db::insert_observations(pool, inserts, now_ms)
        .await
        .map_err(observation_insert_error)?;
    Ok(observations)
}

pub(crate) async fn update_observation(
    pool: &SqlitePool,
    observation_id: &str,
    record: ObservationUpdateInput,
) -> Result<String, ObservationError> {
    let observation_id =
        normalize_uuid(observation_id, "observation_id").map_err(ObservationError::Invalid)?;

    let now_ms = db::now_ms();
    let update = prepare_observation_update(observation_id.clone(), record)?;
    db::update_observation(pool, update, now_ms)
        .await
        .map_err(observation_update_error)?;
    Ok(observation_id)
}

pub(crate) fn record_observations_payload_spec() -> PayloadSpec {
    let journal_evidence = PayloadSpec::nested(
        "observation evidence",
        ObjErr::Object,
        vec![
            Field::required("journal_entry_id", FieldSpec::Uuid { schema_regex: true }),
            Field::optional("message_id", FieldSpec::Never),
        ],
    );
    let message_evidence = PayloadSpec::nested(
        "observation evidence",
        ObjErr::Object,
        vec![
            Field::required("message_id", FieldSpec::Uuid { schema_regex: true }),
            Field::optional("journal_entry_id", FieldSpec::Never),
        ],
    );
    PayloadSpec::payload(
        "record_observations",
        vec![
            Field::required(
                "observations",
                FieldSpec::OneOfArray {
                    variants: record_observation_payload_variants(),
                    min_items: Some(1),
                },
            ),
            Field::optional(
                "evidence",
                FieldSpec::OneOfObject {
                    variants: vec![journal_evidence, message_evidence],
                },
            ),
        ],
    )
}

pub(crate) fn validate_record_observations_payload(payload: &Value) -> Result<(), String> {
    record_observations_input_from_payload(payload).map(|_| ())
}

pub(crate) fn record_observations_input_from_payload(
    payload: &Value,
) -> Result<RecordObservationsInput, String> {
    record_observations_payload_spec().check(payload)?;
    let params: crate::protocol::ObservationRecordParams = serde_json::from_value(payload.clone())
        .map_err(|e| format!("record_observations payload is invalid: {e}"))?;
    let input = record_observations_input_from_params(params)?;
    validate_record_observations_input(&input)?;
    Ok(input)
}

pub(crate) fn observation_update_payload_spec() -> PayloadSpec {
    PayloadSpec::payload(
        "update_observation",
        vec![
            Field::required("observation_id", FieldSpec::Uuid { schema_regex: true }),
            Field::required(
                "observation",
                FieldSpec::OneOfObject {
                    variants: record_observation_payload_variants(),
                },
            ),
        ],
    )
}

pub(crate) fn observation_update_input_from_payload(
    payload: &Value,
) -> Result<(String, ObservationUpdateInput), String> {
    observation_update_payload_spec().check(payload)?;
    let params: crate::protocol::ObservationUpdateParams = serde_json::from_value(payload.clone())
        .map_err(|e| format!("update_observation payload is invalid: {e}"))?;
    Ok(observation_update_input_from_params(params))
}

pub(crate) fn record_observations_input_from_params(
    params: crate::protocol::ObservationRecordParams,
) -> Result<RecordObservationsInput, String> {
    let source = source_from_evidence(params.evidence)?;
    Ok(RecordObservationsInput {
        observations: params
            .observations
            .into_iter()
            .map(|draft| ObservationRecordInput {
                schema_key: draft.schema_key,
                occurred_at: draft.occurred_at,
                ended_at: draft.ended_at,
                values: draft.values,
                note: draft.note,
                source: source.clone(),
            })
            .collect(),
    })
}

pub(crate) fn observation_update_input_from_params(
    params: crate::protocol::ObservationUpdateParams,
) -> (String, ObservationUpdateInput) {
    let draft = params.observation;
    (
        params.observation_id.to_string(),
        ObservationUpdateInput {
            schema_key: draft.schema_key,
            occurred_at: draft.occurred_at,
            ended_at: draft.ended_at,
            values: draft.values,
            note: draft.note,
        },
    )
}

fn validate_record_observations_input(input: &RecordObservationsInput) -> Result<(), String> {
    if input.observations.is_empty() {
        return Err("observations must have at least 1 item(s)".to_string());
    }
    for record in &input.observations {
        validate_observation_fields(
            &record.schema_key,
            &record.occurred_at,
            record.ended_at.as_deref(),
            &record.values,
        )?;
        if let Some(source) = &record.source {
            validated_source(source)?;
        }
    }
    Ok(())
}

pub(crate) fn prepare_observations(
    input: RecordObservationsInput,
    created_by: &str,
    proposal_id: Option<&str>,
    now_ms: i64,
) -> Result<(Vec<db::ObservationInsert>, Vec<Observation>), ObservationError> {
    if input.observations.is_empty() {
        // Direct-call backstop; live RPC/proposal paths reject this in PayloadSpec first.
        return Err(ObservationError::Invalid(
            "observations must have at least 1 item(s)".to_string(),
        ));
    }

    let mut inserts = Vec::with_capacity(input.observations.len());
    let mut observations = Vec::with_capacity(input.observations.len());

    for record in input.observations {
        let snapshot = prepare_observation_snapshot(
            record.schema_key,
            record.occurred_at,
            record.ended_at,
            record.values,
            record.note,
        )?;
        let id = Uuid::now_v7().to_string();
        let source = record
            .source
            .as_ref()
            .map(validated_source)
            .transpose()
            .map_err(ObservationError::Invalid)?;
        let PreparedObservationSnapshot {
            schema_key,
            schema_version,
            occurred_at,
            ended_at,
            values,
            values_json,
            note,
            relations,
        } = snapshot;

        inserts.push(db::ObservationInsert {
            id: id.clone(),
            schema_key: schema_key.clone(),
            schema_version,
            occurred_at: occurred_at.clone(),
            ended_at: ended_at.clone(),
            values_json,
            note: note.clone(),
            created_by: created_by.to_string(),
            created_via_proposal_id: proposal_id.map(str::to_string),
            relations,
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
            schema_key,
            schema_version,
            occurred_at,
            ended_at,
            values,
            note,
            source,
            created_at: now_ms,
            updated_at: now_ms,
        });
    }

    Ok((inserts, observations))
}

fn prepare_observation_update(
    id: String,
    record: ObservationUpdateInput,
) -> Result<db::ObservationUpdate, ObservationError> {
    let snapshot = prepare_observation_snapshot(
        record.schema_key,
        record.occurred_at,
        record.ended_at,
        record.values,
        record.note,
    )?;

    Ok(db::ObservationUpdate {
        id,
        schema_key: snapshot.schema_key,
        schema_version: snapshot.schema_version,
        occurred_at: snapshot.occurred_at,
        ended_at: snapshot.ended_at,
        values_json: snapshot.values_json,
        note: snapshot.note,
        relations: snapshot.relations,
    })
}

struct PreparedObservationSnapshot {
    schema_key: String,
    schema_version: i64,
    occurred_at: String,
    ended_at: Option<String>,
    values: Value,
    values_json: String,
    note: Option<String>,
    relations: Vec<db::ObservationRelationInsert>,
}

fn prepare_observation_snapshot(
    schema_key: String,
    occurred_at: String,
    ended_at: Option<String>,
    values: Value,
    note: Option<String>,
) -> Result<PreparedObservationSnapshot, ObservationError> {
    let schema = validate_observation_fields(
        &schema_key,
        &occurred_at,
        ended_at.as_deref(),
        &values,
    )
    .map_err(ObservationError::Invalid)?;
    let (values, relations) = relation_checks(schema.relation_fields, &values)
        .map_err(ObservationError::Invalid)?;
    let values_json = serde_json::to_string(&values)
        .map_err(|e| ObservationError::Internal(anyhow::Error::new(e)))?;

    Ok(PreparedObservationSnapshot {
        schema_key: schema.key.to_string(),
        schema_version: schema.version,
        occurred_at,
        ended_at,
        values,
        values_json,
        note,
        relations,
    })
}

pub(crate) fn render_accept(observations: &[Observation]) -> String {
    let count = observations.len();
    let details = observations
        .iter()
        .map(observation_accept_text)
        .collect::<Vec<_>>()
        .join("; ");
    if details.is_empty() {
        format!("Accepted. Recorded {count} observations.")
    } else {
        format!("Accepted. Recorded {count} observations ({details}).")
    }
}

fn observation_accept_text(observation: &Observation) -> String {
    let ended_at = observation
        .ended_at
        .as_ref()
        .map(|value| format!(", ended_at={value}"))
        .unwrap_or_default();
    let values = observation.values.to_string();
    let note = observation
        .note
        .as_ref()
        .map(|value| format!(", note={value}"))
        .unwrap_or_default();
    format!(
        "{} at {}{}, values={}{}",
        observation.schema_key, observation.occurred_at, ended_at, values, note
    )
}

pub(crate) fn observation_insert_error(e: db::ObservationInsertError) -> ObservationError {
    match e {
        db::ObservationInsertError::InvalidSource(reason) => ObservationError::Invalid(reason),
        db::ObservationInsertError::InvalidRelation(reason) => ObservationError::Invalid(reason),
        db::ObservationInsertError::Sqlx(err) => ObservationError::Internal(err.into()),
    }
}

pub(crate) fn observation_update_error(e: db::ObservationUpdateError) -> ObservationError {
    match e {
        db::ObservationUpdateError::InvalidRelation(reason) => ObservationError::Invalid(reason),
        db::ObservationUpdateError::SchemaMismatch => {
            ObservationError::Invalid("observation schema_key cannot change".to_string())
        }
        db::ObservationUpdateError::NotFound => {
            ObservationError::Invalid("observation not found".to_string())
        }
        db::ObservationUpdateError::Sqlx(err) => ObservationError::Internal(err.into()),
    }
}

pub(crate) async fn query_observations(
    pool: &SqlitePool,
    filter: ObservationQuery,
) -> Result<Vec<Observation>, ObservationError> {
    validate_query(&filter).map_err(ObservationError::Invalid)?;
    let related_entity_id = filter
        .related_entity_id
        .as_deref()
        .map(|id| normalize_uuid(id, "related_entity_id"))
        .transpose()
        .map_err(ObservationError::Invalid)?;
    let source = filter
        .source
        .as_ref()
        .map(validated_source)
        .transpose()
        .map_err(ObservationError::Invalid)?
        .map(|source| match source {
            ObservationSource::JournalEntry { id } => {
                db::ObservationSourceFilter::JournalEntry { id }
            }
            ObservationSource::Message { id } => db::ObservationSourceFilter::Message { id },
        });
    let rows = db::query_observations(
        pool,
        db::ObservationFilter {
            schema_keys: filter.schema_keys,
            from: filter.from,
            to: filter.to,
            source,
            related_entity_id,
            limit: filter.limit,
        },
    )
    .await
    .map_err(|e| ObservationError::Internal(e.into()))?;

    rows.into_iter().map(observation_from_row).collect()
}

struct ObservationSchema {
    key: &'static str,
    key_domain: &'static [&'static str],
    key_error: &'static str,
    version: i64,
    values: PayloadSpec,
    relation_fields: &'static [ObservationRelationField],
}

struct ObservationRelationField {
    name: &'static str,
    target_entity_type: EntityType,
}

fn schema_for(schema_key: &str) -> Option<ObservationSchema> {
    match schema_key {
        BODYWEIGHT_SCHEMA_KEY => Some(bodyweight_schema()),
        HABIT_CHECKIN_SCHEMA_KEY => Some(habit_checkin_schema()),
        NUTRITION_INTAKE_SCHEMA_KEY => Some(nutrition_intake_schema()),
        _ => None,
    }
}

fn bodyweight_schema() -> ObservationSchema {
    ObservationSchema {
        key: BODYWEIGHT_SCHEMA_KEY,
        key_domain: BODYWEIGHT_SCHEMA_KEY_DOMAIN,
        key_error: "schema_key must be bodyweight",
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
        relation_fields: &[],
    }
}

fn habit_checkin_schema() -> ObservationSchema {
    ObservationSchema {
        key: HABIT_CHECKIN_SCHEMA_KEY,
        key_domain: HABIT_CHECKIN_SCHEMA_KEY_DOMAIN,
        key_error: "schema_key must be habit.checkin",
        version: HABIT_CHECKIN_SCHEMA_VERSION,
        values: PayloadSpec::payload(
            "habit.checkin values",
            vec![
                Field::required("habit_id", FieldSpec::Uuid { schema_regex: true }),
                Field::required(
                    "state",
                    FieldSpec::EnumStr {
                        domain: &["done", "skipped", "missed"],
                        err: "habit.checkin state must be one of done, skipped, missed",
                    },
                ),
                Field::optional(
                    "quantity",
                    FieldSpec::Number {
                        min: None,
                        max: None,
                        integer: false,
                    },
                ),
            ],
        ),
        relation_fields: &[ObservationRelationField {
            name: "habit_id",
            target_entity_type: EntityType::Habit,
        }],
    }
}

fn nutrition_intake_schema() -> ObservationSchema {
    ObservationSchema {
        key: NUTRITION_INTAKE_SCHEMA_KEY,
        key_domain: NUTRITION_INTAKE_SCHEMA_KEY_DOMAIN,
        key_error: "schema_key must be nutrition.intake",
        version: NUTRITION_INTAKE_SCHEMA_VERSION,
        values: PayloadSpec::payload(
            "nutrition.intake values",
            vec![
                Field::required(
                    "kcal",
                    FieldSpec::Number {
                        min: Some(0.0),
                        max: None,
                        integer: false,
                    },
                ),
                Field::optional(
                    "protein_g",
                    FieldSpec::Number {
                        min: Some(0.0),
                        max: None,
                        integer: false,
                    },
                ),
                Field::optional(
                    "carbs_g",
                    FieldSpec::Number {
                        min: Some(0.0),
                        max: None,
                        integer: false,
                    },
                ),
                Field::optional(
                    "fat_g",
                    FieldSpec::Number {
                        min: Some(0.0),
                        max: None,
                        integer: false,
                    },
                ),
                Field::optional("label", FieldSpec::string()),
            ],
        ),
        relation_fields: &[],
    }
}

pub(crate) fn record_observation_payload_variants() -> Vec<PayloadSpec> {
    [
        bodyweight_schema(),
        habit_checkin_schema(),
        nutrition_intake_schema(),
    ]
    .into_iter()
    .map(record_observation_payload_variant)
    .collect()
}

fn record_observation_payload_variant(schema: ObservationSchema) -> PayloadSpec {
    PayloadSpec::nested(
        "observation",
        crate::field_spec::ObjErr::JsonObject,
        vec![
            Field::required(
                "schema_key",
                FieldSpec::EnumStr {
                    domain: schema.key_domain,
                    err: schema.key_error,
                },
            ),
            Field::datetime("occurred_at").require(),
            Field::datetime("ended_at"),
            Field::required("values", FieldSpec::Object(schema.values)),
            Field::optional("note", FieldSpec::string()),
        ],
    )
}

fn validate_observation_fields(
    schema_key: &str,
    occurred_at: &str,
    ended_at: Option<&str>,
    values: &Value,
) -> Result<ObservationSchema, String> {
    let schema =
        schema_for(schema_key).ok_or_else(|| format!("unknown observation schema {schema_key:?}"))?;

    let occurred = parse_local_datetime(occurred_at, "occurred_at")?;
    if let Some(ended_at) = ended_at {
        let ended = parse_local_datetime(ended_at, "ended_at")?;
        if ended < occurred {
            return Err("ended_at must be greater than or equal to occurred_at".to_string());
        }
    }
    schema.values.check(values)?;
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
    if let Some(source) = &filter.source {
        validated_source(source)?;
    }
    if let Some(related_entity_id) = &filter.related_entity_id {
        parse_uuid(related_entity_id, "related_entity_id")?;
    }
    Ok(())
}

fn validated_source(source: &ObservationSourceInput) -> Result<ObservationSource, String> {
    match source {
        ObservationSourceInput::JournalEntry { id } => {
            let id = normalize_uuid(id, "source_entity_id")?;
            Ok(ObservationSource::JournalEntry { id })
        }
        ObservationSourceInput::Message { id } => {
            let id = normalize_uuid(id, "source_message_id")?;
            Ok(ObservationSource::Message { id })
        }
    }
}

fn source_from_evidence(
    evidence: Option<crate::protocol::ObservationEvidence>,
) -> Result<Option<ObservationSourceInput>, String> {
    let Some(evidence) = evidence else {
        return Ok(None);
    };
    match (evidence.journal_entry_id, evidence.message_id) {
        (Some(id), None) => Ok(Some(ObservationSourceInput::JournalEntry { id })),
        (None, Some(id)) => Ok(Some(ObservationSourceInput::Message { id })),
        (None, None) => Err(
            "observation evidence must name one of journal_entry_id or message_id".to_string(),
        ),
        (Some(_), Some(_)) => Err(
            "observation evidence must name only one of journal_entry_id or message_id".to_string(),
        ),
    }
}

fn relation_checks(
    fields: &'static [ObservationRelationField],
    values: &Value,
) -> Result<(Value, Vec<db::ObservationRelationInsert>), String> {
    let mut normalized_values = values.clone();
    let mut relations = Vec::with_capacity(fields.len());
    for field in fields {
        let Some(entity_id) = values.get(field.name).and_then(Value::as_str) else {
            return Err(format!("{} must be a UUID", field.name));
        };
        let canonical_entity_id = normalize_uuid(entity_id, field.name)?;
        if let Some(object) = normalized_values.as_object_mut() {
            object.insert(
                field.name.to_string(),
                Value::String(canonical_entity_id.clone()),
            );
        }
        relations.push(db::ObservationRelationInsert {
            field_name: field.name,
            entity_id: canonical_entity_id,
            target_entity_type: field.target_entity_type,
        });
    }
    Ok((normalized_values, relations))
}

fn parse_uuid(value: &str, field: &str) -> Result<(), String> {
    normalize_uuid(value, field).map(|_| ())
}

fn normalize_uuid(value: &str, field: &str) -> Result<String, String> {
    Uuid::parse_str(value)
        .map(|uuid| uuid.to_string())
        .map_err(|_| format!("{field} must be a UUID"))
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
mod observations_tests;
