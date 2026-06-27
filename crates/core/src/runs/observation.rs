//! `observation/*` handlers (ADR-0053): direct Client writes and time-range
//! reads for Observation records over the existing JSON-RPC request seam.

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;

use super::handler::{self, HandlerError};
use crate::observations::{
    self, ObservationQuery, ObservationRecordInput, ObservationSource, ObservationSourceInput,
    RecordObservationsInput,
};
use crate::protocol::{
    ObservationEvidence, ObservationQueryParams, ObservationQueryResult, ObservationRecordDraft,
    ObservationRecordParams, ObservationRecordResult, ObservationRow, ObservationSourceView,
};

pub(super) async fn handle_record(
    pool: &SqlitePool,
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    handler::handle(
        id,
        params,
        out_tx,
        |params: ObservationRecordParams| async move {
            let source = source_from_evidence(params.evidence)?;
            let observations = params
                .observations
                .into_iter()
                .map(|draft| record_input(draft, source.clone()))
                .collect();

            let recorded =
                observations::record_observations(pool, RecordObservationsInput { observations })
                    .await
                    .map_err(observation_error_to_handler)?;

            Ok(ObservationRecordResult {
                observation_ids: recorded.into_iter().map(|row| row.id).collect(),
            })
        },
    )
    .await;
}

pub(super) async fn handle_query(
    pool: &SqlitePool,
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    handler::handle(
        id,
        params,
        out_tx,
        |params: ObservationQueryParams| async move {
            let observations = observations::query_observations(
                pool,
                ObservationQuery {
                    schema_keys: params.schema_keys.unwrap_or_default(),
                    from: params.from,
                    to: params.to,
                    source: source_from_query_params(
                        params.source_entity_id,
                        params.source_message_id,
                    )?,
                    limit: params.limit,
                },
            )
            .await
            .map_err(observation_error_to_handler)?;

            Ok(ObservationQueryResult {
                observations: observations.into_iter().map(observation_to_wire).collect(),
            })
        },
    )
    .await;
}

fn observation_error_to_handler(err: observations::ObservationError) -> HandlerError {
    match err {
        observations::ObservationError::Invalid(reason) => HandlerError::InvalidParams(reason),
        observations::ObservationError::Internal(err) => HandlerError::Internal(err),
    }
}

fn record_input(
    draft: ObservationRecordDraft,
    source: Option<ObservationSourceInput>,
) -> ObservationRecordInput {
    ObservationRecordInput {
        schema_key: draft.schema_key,
        occurred_at: draft.occurred_at,
        ended_at: draft.ended_at,
        values: draft.values,
        note: draft.note,
        source,
    }
}

fn source_from_query_params(
    source_entity_id: Option<String>,
    source_message_id: Option<String>,
) -> Result<Option<ObservationSourceInput>, HandlerError> {
    match (source_entity_id, source_message_id) {
        (Some(id), None) => Ok(Some(ObservationSourceInput::JournalEntry { id })),
        (None, Some(id)) => Ok(Some(ObservationSourceInput::Message { id })),
        (None, None) => Ok(None),
        (Some(_), Some(_)) => Err(HandlerError::InvalidParams(
            "observation query accepts at most one of source_entity_id or source_message_id"
                .to_string(),
        )),
    }
}

fn source_from_evidence(
    evidence: Option<ObservationEvidence>,
) -> Result<Option<ObservationSourceInput>, HandlerError> {
    let Some(evidence) = evidence else {
        return Ok(None);
    };

    match (evidence.journal_entry_id, evidence.message_id) {
        (Some(id), None) => Ok(Some(ObservationSourceInput::JournalEntry { id })),
        (None, Some(id)) => Ok(Some(ObservationSourceInput::Message { id })),
        (None, None) => Ok(None),
        (Some(_), Some(_)) => Err(HandlerError::InvalidParams(
            "observation evidence accepts at most one of journal_entry_id or message_id"
                .to_string(),
        )),
    }
}

fn observation_to_wire(row: observations::Observation) -> ObservationRow {
    ObservationRow {
        id: row.id,
        schema_key: row.schema_key,
        schema_version: row.schema_version,
        occurred_at: row.occurred_at,
        ended_at: row.ended_at,
        values: row.values,
        note: row.note,
        source: row.source.map(source_to_wire),
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

fn source_to_wire(source: ObservationSource) -> ObservationSourceView {
    ObservationSourceView {
        source_entity_id: source.source_entity_id().map(str::to_string),
        source_message_id: source.source_message_id().map(str::to_string),
        relation: source.relation().as_str().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};
    use sqlx::SqlitePool;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use tokio::sync::mpsc;
    use uuid::Uuid;

    use crate::hub;
    use crate::protocol::JsonRpcRequest;

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

    async fn dispatch_rpc(pool: &SqlitePool, method: &str, params: Value) -> Value {
        let hubs = hub::new_hubs();
        let (tx, mut rx) = mpsc::unbounded_channel();
        super::super::dispatch(
            pool,
            &hubs,
            JsonRpcRequest {
                jsonrpc: "2.0".to_string(),
                id: json!(1),
                method: method.to_string(),
                params,
            },
            &tx,
        )
        .await;
        recv_json(&mut rx)
    }

    fn recv_json(rx: &mut mpsc::UnboundedReceiver<String>) -> Value {
        let line = rx.try_recv().expect("a frame was queued");
        serde_json::from_str(&line).expect("frame is JSON")
    }

    fn assert_invalid_params(value: &Value) {
        assert_eq!(value["error"]["code"], json!(-32602), "{value:?}");
        assert!(value.get("result").is_none(), "{value:?}");
    }

    fn assert_internal_error(value: &Value) {
        assert_eq!(value["error"]["code"], json!(-32603), "{value:?}");
        assert_eq!(value["error"]["message"], json!("internal error"), "{value:?}");
        assert!(value.get("result").is_none(), "{value:?}");
    }

    async fn seed_message(pool: &SqlitePool, message_id: Uuid) {
        let thread_id = Uuid::now_v7();
        let run_id = Uuid::now_v7();
        let mut tx = pool.begin().await.expect("begin message seed");
        sqlx::query(
            "INSERT INTO threads (id, title, created_at, last_activity_at) \
             VALUES (?, 'Source Thread', 1, 1)",
        )
        .bind(thread_id.to_string())
        .execute(&mut *tx)
        .await
        .expect("insert source thread");
        sqlx::query(
            "INSERT INTO runs \
             (id, thread_id, workflow_name, workflow_version, provider, model, \
              thinking_level, user_message_id, status, started_at) \
             VALUES (?, ?, 'w', '1', 'p', 'm', 'off', ?, 'completed', 1)",
        )
        .bind(run_id.to_string())
        .bind(thread_id.to_string())
        .bind(message_id.to_string())
        .execute(&mut *tx)
        .await
        .expect("insert source run");
        sqlx::query(
            "INSERT INTO messages (id, thread_id, run_id, role, status, created_at, updated_at) \
             VALUES (?, ?, ?, 'user', 'completed', 1, 1)",
        )
        .bind(message_id.to_string())
        .bind(thread_id.to_string())
        .bind(run_id.to_string())
        .execute(&mut *tx)
        .await
        .expect("insert source message");
        tx.commit().await.expect("commit message seed");
    }

    async fn seed_journal_entry(pool: &SqlitePool, journal_entry_id: Uuid) {
        sqlx::query(
            "INSERT INTO entities \
             (id, type, schema_version, data, created_by, created_at, updated_at) \
             VALUES (?, 'journal_entry', 1, '{}', 'user', 1, 1)",
        )
        .bind(journal_entry_id.to_string())
        .execute(pool)
        .await
        .expect("insert journal entry");
    }

    async fn seed_person(pool: &SqlitePool, person_id: Uuid) {
        sqlx::query(
            "INSERT INTO entities \
             (id, type, schema_version, data, created_by, created_at, updated_at) \
             VALUES (?, 'person', 1, '{\"name\":\"Source Person\"}', 'user', 1, 1)",
        )
        .bind(person_id.to_string())
        .execute(pool)
        .await
        .expect("insert person");
    }

    #[tokio::test]
    async fn observation_rpc_records_and_queries_bodyweight() {
        let pool = memory_pool().await;
        let message_id = Uuid::now_v7();
        let journal_entry_id = Uuid::now_v7();
        seed_message(&pool, message_id).await;
        seed_journal_entry(&pool, journal_entry_id).await;

        let recorded = dispatch_rpc(
            &pool,
            "observation/record",
            json!({
                "evidence": { "message_id": message_id.to_string() },
                "observations": [
                    {
                        "schema_key": "bodyweight",
                        "occurred_at": "2026-06-01T07:30:00",
                        "ended_at": "2026-06-01T07:31:00",
                        "values": { "kg": 72.4 },
                        "note": "after morning run"
                    },
                    {
                        "schema_key": "bodyweight",
                        "occurred_at": "2026-06-02T07:30:00",
                        "values": { "kg": 72.1 }
                    }
                ]
            }),
        )
        .await;
        assert!(recorded.get("error").is_none(), "{recorded:?}");
        let ids = recorded["result"]["observation_ids"]
            .as_array()
            .expect("observation_ids array");
        assert_eq!(ids.len(), 2);

        let queried = dispatch_rpc(
            &pool,
            "observation/query",
            json!({
                "schema_keys": ["bodyweight"],
                "from": "2026-06-01T00:00:00",
                "to": "2026-06-02T23:59:59",
                "source_message_id": message_id.to_string(),
                "limit": 1
            }),
        )
        .await;
        assert!(queried.get("error").is_none(), "{queried:?}");
        let observations = queried["result"]["observations"]
            .as_array()
            .expect("observations array");
        assert_eq!(observations.len(), 1);
        let row = &observations[0];
        assert_eq!(row["id"], ids[1]);
        assert_eq!(row["schema_key"], json!("bodyweight"));
        assert_eq!(row["schema_version"], json!(1));
        assert_eq!(row["occurred_at"], json!("2026-06-02T07:30:00"));
        assert_eq!(row["ended_at"], Value::Null);
        assert_eq!(row["values"], json!({ "kg": 72.1 }));
        assert_eq!(row["note"], Value::Null);
        assert_eq!(
            row["source"]["source_message_id"],
            json!(message_id.to_string())
        );
        assert_eq!(row["source"]["relation"], json!("evidenced_by"));
        assert!(row["created_at"].is_i64());
        assert!(row["updated_at"].is_i64());

        let journal_recorded = dispatch_rpc(
            &pool,
            "observation/record",
            json!({
                "evidence": { "journal_entry_id": journal_entry_id.to_string() },
                "observations": [{
                    "schema_key": "bodyweight",
                    "occurred_at": "2026-06-03T07:30:00",
                    "values": { "kg": 71.9 }
                }]
            }),
        )
        .await;
        assert!(
            journal_recorded.get("error").is_none(),
            "{journal_recorded:?}"
        );

        let by_journal = dispatch_rpc(
            &pool,
            "observation/query",
            json!({ "source_entity_id": journal_entry_id.to_string() }),
        )
        .await;
        let observations = by_journal["result"]["observations"]
            .as_array()
            .expect("journal observations array");
        assert_eq!(observations.len(), 1);
        assert_eq!(
            observations[0]["source"]["source_entity_id"],
            json!(journal_entry_id.to_string())
        );
        assert_eq!(observations[0]["source"]["relation"], json!("created_from"));

        let bare_recorded = dispatch_rpc(
            &pool,
            "observation/record",
            json!({
                "evidence": {},
                "observations": [{
                    "schema_key": "bodyweight",
                    "occurred_at": "2026-06-04T07:30:00",
                    "values": { "kg": 71.8 }
                }]
            }),
        )
        .await;
        assert!(bare_recorded.get("error").is_none(), "{bare_recorded:?}");
        let bare_id = bare_recorded["result"]["observation_ids"][0].clone();

        let latest = dispatch_rpc(
            &pool,
            "observation/query",
            json!({ "schema_keys": ["bodyweight"], "limit": 1 }),
        )
        .await;
        let observations = latest["result"]["observations"]
            .as_array()
            .expect("latest observations array");
        assert_eq!(observations[0]["id"], bare_id);
        assert_eq!(observations[0]["source"], Value::Null);
    }

    #[tokio::test]
    async fn observation_rpc_rejects_bad_record_params_as_invalid_params() {
        let pool = memory_pool().await;

        let unknown_schema = dispatch_rpc(
            &pool,
            "observation/record",
            json!({
                "observations": [{
                    "schema_key": "blood_pressure",
                    "occurred_at": "2026-06-01T07:30:00",
                    "values": { "kg": 72.4 }
                }]
            }),
        )
        .await;
        assert_invalid_params(&unknown_schema);

        let invalid_values = dispatch_rpc(
            &pool,
            "observation/record",
            json!({
                "observations": [{
                    "schema_key": "bodyweight",
                    "occurred_at": "2026-06-01T07:30:00",
                    "values": { "kg": "72.4" }
                }]
            }),
        )
        .await;
        assert_invalid_params(&invalid_values);

        let conflicting_evidence = dispatch_rpc(
            &pool,
            "observation/record",
            json!({
                "evidence": {
                    "journal_entry_id": Uuid::now_v7().to_string(),
                    "message_id": Uuid::now_v7().to_string()
                },
                "observations": [{
                    "schema_key": "bodyweight",
                    "occurred_at": "2026-06-01T07:30:00",
                    "values": { "kg": 72.4 }
                }]
            }),
        )
        .await;
        assert_invalid_params(&conflicting_evidence);

        let person_id = Uuid::now_v7();
        seed_person(&pool, person_id).await;
        let non_journal_evidence = dispatch_rpc(
            &pool,
            "observation/record",
            json!({
                "evidence": { "journal_entry_id": person_id.to_string() },
                "observations": [{
                    "schema_key": "bodyweight",
                    "occurred_at": "2026-06-01T07:30:00",
                    "values": { "kg": 72.4 }
                }]
            }),
        )
        .await;
        assert_invalid_params(&non_journal_evidence);

        let missing_message_evidence = dispatch_rpc(
            &pool,
            "observation/record",
            json!({
                "evidence": { "message_id": Uuid::now_v7().to_string() },
                "observations": [{
                    "schema_key": "bodyweight",
                    "occurred_at": "2026-06-01T07:30:00",
                    "values": { "kg": 72.4 }
                }]
            }),
        )
        .await;
        assert_invalid_params(&missing_message_evidence);
    }

    #[tokio::test]
    async fn observation_rpc_rejects_bad_query_filters_as_invalid_params() {
        let pool = memory_pool().await;

        let unknown_schema = dispatch_rpc(
            &pool,
            "observation/query",
            json!({ "schema_keys": ["blood_pressure"] }),
        )
        .await;
        assert_invalid_params(&unknown_schema);

        let malformed_from =
            dispatch_rpc(&pool, "observation/query", json!({ "from": "2026-06-01" })).await;
        assert_invalid_params(&malformed_from);

        let inverted_range = dispatch_rpc(
            &pool,
            "observation/query",
            json!({
                "from": "2026-06-02T00:00:00",
                "to": "2026-06-01T00:00:00"
            }),
        )
        .await;
        assert_invalid_params(&inverted_range);

        let invalid_limit = dispatch_rpc(&pool, "observation/query", json!({ "limit": 0 })).await;
        assert_invalid_params(&invalid_limit);
    }

    #[tokio::test]
    async fn observation_rpc_sanitizes_malformed_stored_observation() {
        let pool = memory_pool().await;
        sqlx::query(
            "INSERT INTO observations \
             (id, schema_key, schema_version, occurred_at, values_json, created_by, \
              created_at, updated_at) \
             VALUES (?1, 'bodyweight', 1, '2026-06-01T07:30:00', '{not-json', \
                     'user', 1, 1)",
        )
        .bind(Uuid::now_v7().to_string())
        .execute(&pool)
        .await
        .expect("insert malformed stored observation");

        let response = dispatch_rpc(
            &pool,
            "observation/query",
            json!({ "schema_keys": ["bodyweight"] }),
        )
        .await;
        assert_internal_error(&response);
    }
}
