//! `observation/*` handlers (ADR-0053): direct Client writes and time-range
//! reads for Observation records over the existing JSON-RPC request seam.

use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;

use super::handler::{self, HandlerError};
use crate::observations::{self, ObservationQuery, ObservationSource, ObservationSourceInput};
use crate::protocol::{
    ObservationQueryParams, ObservationQueryResult, ObservationRecordResult, ObservationRow,
    ObservationSourceView, ObservationUpdateResult,
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
        |params: serde_json::Value| async move {
            let input = observations::record_observations_input_from_payload(&params)
                .map_err(HandlerError::InvalidParams)?;
            let recorded = observations::record_observations(pool, input)
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
        |raw: serde_json::Value| async move {
            let params: ObservationQueryParams = if raw.is_null() {
                ObservationQueryParams::default()
            } else {
                serde_json::from_value(raw)
                    .map_err(|e| HandlerError::InvalidParams(format!("invalid params: {e}")))?
            };
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
                    related_entity_id: params.related_entity_id,
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

pub(super) async fn handle_update(
    pool: &SqlitePool,
    id: serde_json::Value,
    params: serde_json::Value,
    out_tx: &UnboundedSender<String>,
) {
    handler::handle(
        id,
        params,
        out_tx,
        |raw: serde_json::Value| async move {
            let (observation_id, input) = observations::observation_update_input_from_payload(&raw)
                .map_err(HandlerError::InvalidParams)?;
            let observation_id = observations::update_observation(pool, &observation_id, input)
                .await
                .map_err(observation_error_to_handler)?;

            Ok(ObservationUpdateResult { observation_id })
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
        dispatch_request(
            pool,
            JsonRpcRequest {
                jsonrpc: "2.0".to_string(),
                id: json!(1),
                method: method.to_string(),
                params,
            },
        )
        .await
    }

    async fn dispatch_request(pool: &SqlitePool, request: JsonRpcRequest) -> Value {
        let hubs = hub::new_hubs();
        let (tx, mut rx) = mpsc::unbounded_channel();
        super::super::dispatch(pool, &hubs, request, &tx).await;
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

    fn assert_invalid_params_contains(value: &Value, expected: &str) {
        assert_invalid_params(value);
        let message = value["error"]["message"]
            .as_str()
            .expect("invalid params message");
        assert!(
            message.contains(expected),
            "expected message to contain {expected:?}, got {message:?}"
        );
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

    async fn seed_habit(pool: &SqlitePool, habit_id: Uuid) {
        sqlx::query(
            "INSERT INTO entities \
             (id, type, schema_version, data, created_by, created_at, updated_at) \
             VALUES (?, 'habit', 1, \
                     '{\"name\":\"Morning walk\",\"cadence\":{\"interval\":1,\"unit\":\"day\"}}', \
                     'user', 1, 1)",
        )
        .bind(habit_id.to_string())
        .execute(pool)
        .await
        .expect("insert habit");
    }

    #[tokio::test]
    async fn observation_rpc_records_and_queries_bodyweight() {
        let pool = memory_pool().await;
        let message_id = Uuid::now_v7();
        let journal_entry_id = Uuid::now_v7();
        seed_message(&pool, message_id).await;
        seed_journal_entry(&pool, journal_entry_id).await;
        let message_id_upper = message_id.to_string().to_ascii_uppercase();
        let journal_entry_id_upper = journal_entry_id.to_string().to_ascii_uppercase();

        let recorded = dispatch_rpc(
            &pool,
            "observation/record",
            json!({
                "evidence": { "message_id": message_id_upper },
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
                "source_message_id": message_id.to_string().to_ascii_uppercase(),
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
                "evidence": { "journal_entry_id": journal_entry_id_upper },
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
            json!({ "source_entity_id": journal_entry_id.to_string().to_ascii_uppercase() }),
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
    async fn observation_rpc_updates_bodyweight_and_appends_revision() {
        let pool = memory_pool().await;

        let recorded = dispatch_rpc(
            &pool,
            "observation/record",
            json!({
                "observations": [{
                    "schema_key": "bodyweight",
                    "occurred_at": "2026-06-01T07:30:00",
                    "values": { "kg": 72.4 }
                }]
            }),
        )
        .await;
        assert!(recorded.get("error").is_none(), "{recorded:?}");
        let observation_id = recorded["result"]["observation_ids"][0]
            .as_str()
            .expect("observation id")
            .to_string();

        let updated = dispatch_rpc(
            &pool,
            "observation/update",
            json!({
                "observation_id": observation_id.to_ascii_uppercase(),
                "observation": {
                    "schema_key": "bodyweight",
                    "occurred_at": "2026-06-02T07:35:00",
                    "ended_at": "2026-06-02T07:40:00",
                    "values": { "kg": 71.8 },
                    "note": "corrected"
                }
            }),
        )
        .await;
        assert!(updated.get("error").is_none(), "{updated:?}");
        assert_eq!(updated["result"]["observation_id"], json!(observation_id));

        let queried = dispatch_rpc(
            &pool,
            "observation/query",
            json!({ "schema_keys": ["bodyweight"] }),
        )
        .await;
        assert!(queried.get("error").is_none(), "{queried:?}");
        let row = &queried["result"]["observations"][0];
        assert_eq!(row["id"], json!(observation_id));
        assert_eq!(row["occurred_at"], json!("2026-06-02T07:35:00"));
        assert_eq!(row["ended_at"], json!("2026-06-02T07:40:00"));
        assert_eq!(row["values"], json!({ "kg": 71.8 }));
        assert_eq!(row["note"], json!("corrected"));

        let revisions: Vec<(i64, String)> = sqlx::query_as(
            "SELECT seq, values_json \
             FROM observation_revisions \
             WHERE observation_id = ?1 \
             ORDER BY seq",
        )
        .bind(&observation_id)
        .fetch_all(&pool)
        .await
        .expect("observation revisions");
        assert_eq!(revisions.len(), 2);
        assert_eq!(revisions[0].0, 1);
        assert_eq!(revisions[0].1, json!({ "kg": 72.4 }).to_string());
        assert_eq!(revisions[1].0, 2);
        assert_eq!(revisions[1].1, json!({ "kg": 71.8 }).to_string());
    }

    #[tokio::test]
    async fn observation_rpc_accepts_omitted_and_null_query_params() {
        let pool = memory_pool().await;
        let recorded = dispatch_rpc(
            &pool,
            "observation/record",
            json!({
                "observations": [{
                    "schema_key": "bodyweight",
                    "occurred_at": "2026-06-01T07:30:00",
                    "values": { "kg": 72.4 }
                }]
            }),
        )
        .await;
        assert!(recorded.get("error").is_none(), "{recorded:?}");

        let null_params = dispatch_rpc(&pool, "observation/query", Value::Null).await;
        assert!(null_params.get("error").is_none(), "{null_params:?}");
        assert_eq!(
            null_params["result"]["observations"]
                .as_array()
                .expect("null params observations")
                .len(),
            1
        );

        let omitted_request: JsonRpcRequest = serde_json::from_value(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "observation/query"
        }))
        .expect("omitted params request decodes");
        let omitted_params = dispatch_request(&pool, omitted_request).await;
        assert!(omitted_params.get("error").is_none(), "{omitted_params:?}");
        assert_eq!(
            omitted_params["result"]["observations"]
                .as_array()
                .expect("omitted params observations")
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn observation_rpc_records_and_queries_habit_checkin_by_related_entity() {
        let pool = memory_pool().await;
        let habit_id = Uuid::now_v7();
        let other_habit_id = Uuid::now_v7();
        seed_habit(&pool, habit_id).await;
        seed_habit(&pool, other_habit_id).await;

        let recorded = dispatch_rpc(
            &pool,
            "observation/record",
            json!({
                "observations": [
                    {
                        "schema_key": "habit.checkin",
                        "occurred_at": "2026-06-01T07:30:00",
                        "values": {
                            "habit_id": habit_id.to_string(),
                            "state": "done",
                            "quantity": 1
                        }
                    },
                    {
                        "schema_key": "habit.checkin",
                        "occurred_at": "2026-06-01T08:30:00",
                        "values": {
                            "habit_id": other_habit_id.to_string(),
                            "state": "done"
                        }
                    }
                ]
            }),
        )
        .await;
        assert!(recorded.get("error").is_none(), "{recorded:?}");
        let observation_id = recorded["result"]["observation_ids"][0].clone();

        let queried = dispatch_rpc(
            &pool,
            "observation/query",
            json!({
                "schema_keys": ["habit.checkin"],
                "related_entity_id": habit_id.to_string()
            }),
        )
        .await;
        assert!(queried.get("error").is_none(), "{queried:?}");
        let observations = queried["result"]["observations"]
            .as_array()
            .expect("habit check-in observations");
        assert_eq!(observations.len(), 1);
        assert_eq!(observations[0]["id"], observation_id);
        assert_eq!(observations[0]["schema_key"], json!("habit.checkin"));
        assert_eq!(
            observations[0]["values"]["habit_id"],
            json!(habit_id.to_string())
        );
        assert_eq!(observations[0]["values"]["state"], json!("done"));
    }

    #[tokio::test]
    async fn observation_rpc_rejects_bad_record_params_as_invalid_params() {
        let pool = memory_pool().await;

        let null_params = dispatch_rpc(&pool, "observation/record", Value::Null).await;
        assert_invalid_params(&null_params);

        let extra_top_level_key = dispatch_rpc(
            &pool,
            "observation/record",
            json!({
                "observations": [{
                    "schema_key": "bodyweight",
                    "occurred_at": "2026-06-01T07:30:00",
                    "values": { "kg": 72.4 }
                }],
                "debug": true
            }),
        )
        .await;
        assert_invalid_params(&extra_top_level_key);

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

        let empty_evidence = dispatch_rpc(
            &pool,
            "observation/record",
            json!({
                "evidence": {},
                "observations": [{
                    "schema_key": "bodyweight",
                    "occurred_at": "2026-06-01T07:30:00",
                    "values": { "kg": 72.4 }
                }]
            }),
        )
        .await;
        assert_invalid_params(&empty_evidence);

        let null_evidence = dispatch_rpc(
            &pool,
            "observation/record",
            json!({
                "evidence": null,
                "observations": [{
                    "schema_key": "bodyweight",
                    "occurred_at": "2026-06-01T07:30:00",
                    "values": { "kg": 72.4 }
                }]
            }),
        )
        .await;
        assert_invalid_params(&null_evidence);

        let extra_evidence_key = dispatch_rpc(
            &pool,
            "observation/record",
            json!({
                "evidence": {
                    "message_id": Uuid::now_v7().to_string(),
                    "source": "chat"
                },
                "observations": [{
                    "schema_key": "bodyweight",
                    "occurred_at": "2026-06-01T07:30:00",
                    "values": { "kg": 72.4 }
                }]
            }),
        )
        .await;
        assert_invalid_params(&extra_evidence_key);

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

        let missing_habit = dispatch_rpc(
            &pool,
            "observation/record",
            json!({
                "observations": [{
                    "schema_key": "habit.checkin",
                    "occurred_at": "2026-06-01T07:30:00",
                    "values": {
                        "habit_id": Uuid::now_v7().to_string(),
                        "state": "done"
                    }
                }]
            }),
        )
        .await;
        assert_invalid_params(&missing_habit);

        let non_habit_id = Uuid::now_v7();
        seed_person(&pool, non_habit_id).await;
        let non_habit_target = dispatch_rpc(
            &pool,
            "observation/record",
            json!({
                "observations": [{
                    "schema_key": "habit.checkin",
                    "occurred_at": "2026-06-01T07:30:00",
                    "values": {
                        "habit_id": non_habit_id.to_string(),
                        "state": "done"
                    }
                }]
            }),
        )
        .await;
        assert_invalid_params(&non_habit_target);

        let valid_habit_id = Uuid::now_v7();
        seed_habit(&pool, valid_habit_id).await;
        let recorded = dispatch_rpc(
            &pool,
            "observation/record",
            json!({
                "observations": [{
                    "schema_key": "habit.checkin",
                    "occurred_at": "2026-06-01T07:30:00",
                    "values": {
                        "habit_id": valid_habit_id.to_string(),
                        "state": "done"
                    }
                }]
            }),
        )
        .await;
        assert!(recorded.get("error").is_none(), "{recorded:?}");
        let observation_id = recorded["result"]["observation_ids"][0]
            .as_str()
            .expect("observation id");

        // These two cases assert the *exact* null-field message through the full RPC
        // path. That depends on variant order: `check_one_of` surfaces the last
        // `oneOf` variant's error, so the payload uses `nutrition.intake` (currently
        // last) to get its field message rather than a sibling's `schema_key`
        // mismatch. (Payload validation runs before the stored-schema check, so the
        // stored `habit.checkin` schema is irrelevant here.) The order-INDEPENDENT
        // guarantee — that a present-null `ended_at`/`note` is rejected with
        // "must be a string" — is pinned directly on the field spec in
        // `field_spec::observations_number_tests::optional_datetime_and_string_fields_reject_present_null`;
        // if a future schema is appended after `nutrition.intake`, update the
        // `schema_key` here to whichever variant is last (that test stays green).
        let update_with_null_ended_at = dispatch_rpc(
            &pool,
            "observation/update",
            json!({
                "observation_id": observation_id,
                "observation": {
                    "schema_key": "nutrition.intake",
                    "occurred_at": "2026-06-01T07:30:00",
                    "ended_at": null,
                    "values": {
                        "kcal": 1
                    }
                }
            }),
        )
        .await;
        assert_invalid_params_contains(&update_with_null_ended_at, "ended_at must be a string");

        let update_with_null_note = dispatch_rpc(
            &pool,
            "observation/update",
            json!({
                "observation_id": observation_id,
                "observation": {
                    "schema_key": "nutrition.intake",
                    "occurred_at": "2026-06-01T07:30:00",
                    "values": {
                        "kcal": 1
                    },
                    "note": null
                }
            }),
        )
        .await;
        assert_invalid_params_contains(&update_with_null_note, "note must be a string");

        let update_with_evidence = dispatch_rpc(
            &pool,
            "observation/update",
            json!({
                "observation_id": observation_id,
                "observation": {
                    "schema_key": "habit.checkin",
                    "occurred_at": "2026-06-01T07:30:00",
                    "values": {
                        "habit_id": valid_habit_id.to_string(),
                        "state": "done"
                    },
                    "evidence": { "message_id": Uuid::now_v7().to_string() }
                }
            }),
        )
        .await;
        assert_invalid_params_contains(&update_with_evidence, "unsupported observation field");
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

        let invalid_related = dispatch_rpc(
            &pool,
            "observation/query",
            json!({ "related_entity_id": "not-a-uuid" }),
        )
        .await;
        assert_invalid_params(&invalid_related);
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
