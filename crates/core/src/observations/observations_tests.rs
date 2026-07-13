use super::*;
use crate::db::test_support::memory_pool;
use serde_json::json;

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

fn nutrition_intake_at(occurred_at: &str, values: Value) -> ObservationRecordInput {
    ObservationRecordInput {
        schema_key: "nutrition.intake".to_string(),
        occurred_at: occurred_at.to_string(),
        ended_at: None,
        values,
        note: None,
        source: None,
    }
}

fn habit_checkin_at(occurred_at: &str, habit_id: &str, state: &str) -> ObservationRecordInput {
    ObservationRecordInput {
        schema_key: "habit.checkin".to_string(),
        occurred_at: occurred_at.to_string(),
        ended_at: None,
        values: json!({
            "habit_id": habit_id,
            "state": state,
            "quantity": 1
        }),
        note: None,
        source: None,
    }
}

fn update_from(record: ObservationRecordInput) -> ObservationUpdateInput {
    ObservationUpdateInput {
        occurred_at: record.occurred_at,
        ended_at: record.ended_at,
        values: record.values,
        note: record.note,
    }
}

fn invalid_reason(err: ObservationError) -> String {
    match err {
        ObservationError::Invalid(reason) => reason,
        ObservationError::Internal(err) => panic!("expected invalid observation error: {err:?}"),
    }
}

async fn revision_count(pool: &SqlitePool, observation_id: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM observation_revisions WHERE observation_id = ?1")
        .bind(observation_id)
        .fetch_one(pool)
        .await
        .expect("count observation revisions")
}

#[test]
fn typed_record_params_reject_present_empty_evidence() {
    let reason = record_observations_input_from_params(crate::protocol::ObservationRecordParams {
        observations: vec![crate::protocol::ObservationRecordDraft {
            schema_key: "bodyweight".to_string(),
            occurred_at: "2026-06-04T07:30:00".to_string(),
            ended_at: None,
            values: json!({ "kg": 72.4 }),
            note: None,
        }],
        evidence: Some(crate::protocol::ObservationEvidence {
            journal_entry_id: None,
            message_id: None,
        }),
    })
    .expect_err("present empty evidence rejects");

    assert_eq!(
        reason,
        "observation evidence must name one of journal_entry_id or message_id"
    );
}

#[test]
fn render_accept_uses_prepared_observation_rows() {
    let raw_habit_id = "0190D3C1-ABCD-7000-8000-ABCDEF000001";
    let expected_habit_id = "0190d3c1-abcd-7000-8000-abcdef000001";
    let (_, observations) = prepare_observations(
        RecordObservationsInput {
            observations: vec![ObservationRecordInput {
                schema_key: "habit.checkin".to_string(),
                occurred_at: "2026-06-04T07:30:00".to_string(),
                ended_at: None,
                values: json!({
                    "habit_id": raw_habit_id,
                    "state": "done"
                }),
                note: Some("morning walk".to_string()),
                source: None,
            }],
        },
        "proposal",
        Some("proposal-observation-render"),
        1,
    )
    .expect("prepare habit checkin");

    let text = render_accept(&observations);

    assert!(text.contains("Recorded 1 observations"));
    assert!(text.contains("habit.checkin"));
    assert!(text.contains("2026-06-04T07:30:00"));
    assert!(text.contains(expected_habit_id));
    assert!(!text.contains(raw_habit_id));
    assert!(text.contains("morning walk"));
}

#[tokio::test]
async fn observations_record_writes_initial_revision() {
    let pool = memory_pool().await;
    let mut input = bodyweight_at("2026-06-01T07:30:00", json!(72.4));
    input.note = Some("morning".to_string());

    let recorded = record_observations(
        &pool,
        RecordObservationsInput {
            observations: vec![input],
        },
    )
    .await
    .expect("record bodyweight");

    let row: (
        i64,
        String,
        i64,
        String,
        Option<String>,
        String,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT seq, schema_key, schema_version, occurred_at, ended_at, values_json, note \
             FROM observation_revisions \
             WHERE observation_id = ?1",
    )
    .bind(&recorded[0].id)
    .fetch_one(&pool)
    .await
    .expect("initial revision");

    assert_eq!(row.0, 1);
    assert_eq!(row.1, "bodyweight");
    assert_eq!(row.2, 1);
    assert_eq!(row.3, "2026-06-01T07:30:00");
    assert_eq!(row.4, None);
    assert_eq!(row.5, json!({ "kg": 72.4 }).to_string());
    assert_eq!(row.6.as_deref(), Some("morning"));
}

#[tokio::test]
async fn observations_update_appends_revision_and_query_returns_current_state() {
    let pool = memory_pool().await;
    let recorded = record_observations(
        &pool,
        RecordObservationsInput {
            observations: vec![bodyweight_at("2026-06-01T07:30:00", json!(72.4))],
        },
    )
    .await
    .expect("record bodyweight");
    let mut replacement = bodyweight_at("2026-06-02T07:35:00", json!(71.8));
    replacement.ended_at = Some("2026-06-02T07:40:00".to_string());
    replacement.note = Some("corrected".to_string());

    update_observation(&pool, &recorded[0].id, update_from(replacement))
        .await
        .expect("update observation");

    let revisions: Vec<(i64, String, Option<String>, String, Option<String>)> = sqlx::query_as(
        "SELECT seq, occurred_at, ended_at, values_json, note \
             FROM observation_revisions \
             WHERE observation_id = ?1 \
             ORDER BY seq",
    )
    .bind(&recorded[0].id)
    .fetch_all(&pool)
    .await
    .expect("observation revisions");
    assert_eq!(revisions.len(), 2);
    assert_eq!(revisions[0].0, 1);
    assert_eq!(revisions[0].1, "2026-06-01T07:30:00");
    assert_eq!(revisions[0].3, json!({ "kg": 72.4 }).to_string());
    assert_eq!(revisions[1].0, 2);
    assert_eq!(revisions[1].1, "2026-06-02T07:35:00");
    assert_eq!(revisions[1].2.as_deref(), Some("2026-06-02T07:40:00"));
    assert_eq!(revisions[1].3, json!({ "kg": 71.8 }).to_string());
    assert_eq!(revisions[1].4.as_deref(), Some("corrected"));

    let rows = query_observations(
        &pool,
        ObservationQuery {
            schema_keys: vec!["bodyweight".to_string()],
            ..ObservationQuery::default()
        },
    )
    .await
    .expect("query current observations");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, recorded[0].id);
    assert_eq!(rows[0].occurred_at, "2026-06-02T07:35:00");
    assert_eq!(rows[0].ended_at.as_deref(), Some("2026-06-02T07:40:00"));
    assert_eq!(rows[0].values, json!({ "kg": 71.8 }));
    assert_eq!(rows[0].note.as_deref(), Some("corrected"));
}

#[tokio::test]
async fn observations_update_clears_optional_fields_when_omitted() {
    let pool = memory_pool().await;
    let mut original = bodyweight_at("2026-06-01T07:30:00", json!(72.4));
    original.ended_at = Some("2026-06-01T07:35:00".to_string());
    original.note = Some("original note".to_string());
    let recorded = record_observations(
        &pool,
        RecordObservationsInput {
            observations: vec![original],
        },
    )
    .await
    .expect("record bodyweight");

    update_observation(
        &pool,
        &recorded[0].id,
        update_from(bodyweight_at("2026-06-02T07:30:00", json!(71.8))),
    )
    .await
    .expect("clear optional fields");

    let revisions: Vec<(i64, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT seq, ended_at, note \
             FROM observation_revisions \
             WHERE observation_id = ?1 \
             ORDER BY seq",
    )
    .bind(&recorded[0].id)
    .fetch_all(&pool)
    .await
    .expect("observation revisions");
    assert_eq!(revisions.len(), 2);
    assert_eq!(revisions[0].0, 1);
    assert_eq!(revisions[0].1.as_deref(), Some("2026-06-01T07:35:00"));
    assert_eq!(revisions[0].2.as_deref(), Some("original note"));
    assert_eq!(revisions[1].0, 2);
    assert_eq!(revisions[1].1, None);
    assert_eq!(revisions[1].2, None);

    let rows = query_observations(
        &pool,
        ObservationQuery {
            schema_keys: vec!["bodyweight".to_string()],
            ..ObservationQuery::default()
        },
    )
    .await
    .expect("query current observations");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, recorded[0].id);
    assert_eq!(rows[0].occurred_at, "2026-06-02T07:30:00");
    assert_eq!(rows[0].ended_at, None);
    assert_eq!(rows[0].note, None);
}

#[tokio::test]
async fn observations_failed_update_writes_no_revision_and_leaves_current_state() {
    let pool = memory_pool().await;
    let recorded = record_observations(
        &pool,
        RecordObservationsInput {
            observations: vec![bodyweight_at("2026-06-01T07:30:00", json!(72.4))],
        },
    )
    .await
    .expect("record bodyweight");

    let reason = update_observation(
        &pool,
        &recorded[0].id,
        update_from(bodyweight_at("2026-06-02T07:30:00", json!("71.8"))),
    )
    .await
    .expect_err("invalid replacement rejects");
    assert_eq!(invalid_reason(reason), "kg must be a number");
    assert_eq!(revision_count(&pool, &recorded[0].id).await, 1);

    let rows = query_observations(&pool, ObservationQuery::default())
        .await
        .expect("query current observations");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, recorded[0].id);
    assert_eq!(rows[0].occurred_at, "2026-06-01T07:30:00");
    assert_eq!(rows[0].values, json!({ "kg": 72.4 }));
}

#[tokio::test]
async fn observations_update_missing_observation_rejects_without_revision() {
    let pool = memory_pool().await;
    let missing_id = "018f0000-0000-7000-8000-000000000304";

    let reason = update_observation(
        &pool,
        missing_id,
        update_from(bodyweight_at("2026-06-02T07:30:00", json!(71.8))),
    )
    .await
    .expect_err("missing observation rejects");

    assert_eq!(invalid_reason(reason), "observation not found");
    let observation_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM observations")
        .fetch_one(&pool)
        .await
        .expect("count observations");
    assert_eq!(observation_count, 0);
    assert_eq!(revision_count(&pool, missing_id).await, 0);
}

#[tokio::test]
async fn observations_update_habit_checkin_validates_relation_target() {
    let pool = memory_pool().await;
    let habit_id = "018f0000-0000-7000-8000-000000000301";
    let other_habit_id = "018f0000-0000-7000-8000-000000000302";
    let person_id = "018f0000-0000-7000-8000-000000000303";
    seed_habit(&pool, habit_id).await;
    seed_habit(&pool, other_habit_id).await;
    seed_person(&pool, person_id).await;
    let recorded = record_observations(
        &pool,
        RecordObservationsInput {
            observations: vec![habit_checkin_at("2026-06-01T07:30:00", habit_id, "done")],
        },
    )
    .await
    .expect("record habit check-in");

    update_observation(
        &pool,
        &recorded[0].id,
        update_from(habit_checkin_at(
            "2026-06-02T07:30:00",
            &other_habit_id.to_ascii_uppercase(),
            "skipped",
        )),
    )
    .await
    .expect("update to another habit");

    let reason = update_observation(
        &pool,
        &recorded[0].id,
        update_from(habit_checkin_at(
            "2026-06-03T07:30:00",
            person_id,
            "missed",
        )),
    )
    .await
    .expect_err("wrong relation target type rejects");
    assert_eq!(
        invalid_reason(reason),
        "observation habit_id must name a habit"
    );
    assert_eq!(revision_count(&pool, &recorded[0].id).await, 2);

    let rows = query_observations(&pool, ObservationQuery::default())
        .await
        .expect("query current observations");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].occurred_at, "2026-06-02T07:30:00");
    assert_eq!(rows[0].values["habit_id"], json!(other_habit_id));
    assert_eq!(rows[0].values["state"], json!("skipped"));

    let old_habit_rows = query_observations(
        &pool,
        ObservationQuery {
            related_entity_id: Some(habit_id.to_string()),
            ..ObservationQuery::default()
        },
    )
    .await
    .expect("query old relation");
    assert!(old_habit_rows.is_empty());

    let new_habit_rows = query_observations(
        &pool,
        ObservationQuery {
            related_entity_id: Some(other_habit_id.to_string()),
            ..ObservationQuery::default()
        },
    )
    .await
    .expect("query corrected relation");
    assert_eq!(new_habit_rows.len(), 1);
    assert_eq!(new_habit_rows[0].id, recorded[0].id);
    assert_eq!(new_habit_rows[0].values["habit_id"], json!(other_habit_id));
}

#[tokio::test]
async fn observations_update_validates_values_against_stored_schema() {
    let pool = memory_pool().await;
    let habit_id = "018f0000-0000-7000-8000-000000000301";
    seed_habit(&pool, habit_id).await;
    let recorded = record_observations(
        &pool,
        RecordObservationsInput {
            observations: vec![habit_checkin_at("2026-06-01T07:30:00", habit_id, "done")],
        },
    )
    .await
    .expect("record habit check-in");

    // The wire no longer carries `schema_key`; `values` are validated against the
    // schema of the STORED row (habit.checkin), so a bodyweight-shaped `values`
    // blob fails the habit.checkin schema (its `kg` is an unsupported field)
    // rather than being rejected as a schema change.
    let reason = update_observation(
        &pool,
        &recorded[0].id,
        update_from(bodyweight_at("2026-06-02T07:30:00", json!(71.8))),
    )
    .await
    .expect_err("bodyweight values rejected against stored habit.checkin schema");
    assert_eq!(
        invalid_reason(reason),
        "unsupported habit.checkin values field \"kg\""
    );
    assert_eq!(revision_count(&pool, &recorded[0].id).await, 1);
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

async fn seed_habit(pool: &SqlitePool, entity_id: &str) {
    sqlx::query(
        "INSERT INTO entities \
         (id, type, schema_version, data, created_by, created_at, updated_at) \
         VALUES (?1, 'habit', 1, \
                 '{\"name\":\"Morning walk\",\"cadence\":{\"interval\":1,\"unit\":\"day\"}}', \
                 'user', 1, 1)",
    )
    .bind(entity_id)
    .execute(pool)
    .await
    .expect("insert habit entity");
}

async fn seed_person(pool: &SqlitePool, entity_id: &str) {
    sqlx::query(
        "INSERT INTO entities \
         (id, type, schema_version, data, created_by, created_at, updated_at) \
         VALUES (?1, 'person', 1, '{\"name\":\"Al\"}', 'user', 1, 1)",
    )
    .bind(entity_id)
    .execute(pool)
    .await
    .expect("insert person entity");
}

#[tokio::test]
async fn observations_record_bodyweight_validate_and_query_filters() {
    let pool = memory_pool().await;
    seed_message(&pool, "018f0000-0000-7000-8000-000000000001").await;
    seed_entity(&pool, "018f0000-0000-7000-8000-000000000002").await;

    let reason = record_observations(
        &pool,
        RecordObservationsInput {
            observations: Vec::new(),
        },
    )
    .await
    .expect_err("empty observation batches are rejected");
    assert_eq!(
        invalid_reason(reason),
        "observations must have at least 1 item(s)"
    );

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

    // bodyweight is relation-free (no entry in OBSERVATION_RELATIONS), so a
    // related_entity_id query never matches it — proven here on the production
    // descriptor path (unfiltered schema_keys), not just the synthetic-slice unit test.
    let by_relation = query_observations(
        &pool,
        ObservationQuery {
            related_entity_id: Some(recorded[0].id.clone()),
            ..ObservationQuery::default()
        },
    )
    .await
    .expect("query bodyweight by related_entity_id");
    assert!(by_relation.is_empty());

    let message_id_upper = "018f0000-0000-7000-8000-000000000001".to_ascii_uppercase();
    let journal_entry_id_upper = "018f0000-0000-7000-8000-000000000002".to_ascii_uppercase();
    let mut from_message = bodyweight_at("2026-06-02T07:30:00", json!(72.1));
    from_message.source = Some(ObservationSourceInput::Message {
        id: message_id_upper.clone(),
    });
    let mut from_entity = bodyweight_at("2026-06-03T07:30:00", json!(71.9));
    from_entity.source = Some(ObservationSourceInput::JournalEntry {
        id: journal_entry_id_upper.clone(),
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
            source: Some(ObservationSourceInput::Message {
                id: message_id_upper,
            }),
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
            source: Some(ObservationSourceInput::JournalEntry {
                id: journal_entry_id_upper,
            }),
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

    let mismatched_source = sqlx::query(
        "INSERT INTO observation_sources \
         (id, observation_id, source_message_id, relation, created_at) \
         VALUES ('mismatched-observation-source', ?1, \
                 '018f0000-0000-7000-8000-000000000001', 'created_from', 1)",
    )
    .bind(&recorded[0].id)
    .execute(&pool)
    .await
    .expect_err("message sources must use evidenced_by");
    assert!(mismatched_source.to_string().contains("CHECK"));

    let mismatched_entity_source = sqlx::query(
        "INSERT INTO observation_sources \
         (id, observation_id, source_entity_id, relation, created_at) \
         VALUES ('mismatched-observation-entity-source', ?1, \
                 '018f0000-0000-7000-8000-000000000002', 'evidenced_by', 1)",
    )
    .bind(&recorded[0].id)
    .execute(&pool)
    .await
    .expect_err("entity sources must use created_from");
    assert!(mismatched_entity_source.to_string().contains("CHECK"));

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

#[tokio::test]
async fn observations_record_batch_rolls_back_when_later_source_is_invalid() {
    let pool = memory_pool().await;
    let valid = bodyweight_at("2026-06-01T07:30:00", json!(72.4));
    let mut invalid_source = bodyweight_at("2026-06-02T07:30:00", json!(72.1));
    invalid_source.source = Some(ObservationSourceInput::Message {
        id: "018f0000-0000-7000-8000-000000000099".to_string(),
    });

    let reason = record_observations(
        &pool,
        RecordObservationsInput {
            observations: vec![valid, invalid_source],
        },
    )
    .await
    .expect_err("invalid second source rejects the batch");
    let reason = invalid_reason(reason);
    assert_eq!(
        reason,
        "observation source_message_id must name an existing message"
    );

    let rows = query_observations(&pool, ObservationQuery::default())
        .await
        .expect("query after rolled-back batch");
    assert_eq!(rows.len(), 0);
}

#[tokio::test]
async fn observations_record_habit_checkin_validates_relation_and_query_filter() {
    let pool = memory_pool().await;
    let habit_id = "018f0000-0000-7000-8000-abcdefabcdef";
    let habit_id_input = habit_id.to_ascii_uppercase();
    let other_habit_id = "018f0000-0000-7000-8000-000000000103";
    let person_id = "018f0000-0000-7000-8000-000000000102";
    seed_habit(&pool, habit_id).await;
    seed_habit(&pool, other_habit_id).await;
    seed_person(&pool, person_id).await;

    let recorded = record_observations(
        &pool,
        RecordObservationsInput {
            observations: vec![
                habit_checkin_at("2026-06-01T07:30:00", &habit_id_input, "done"),
                habit_checkin_at("2026-06-01T08:30:00", other_habit_id, "done"),
            ],
        },
    )
    .await
    .expect("record habit check-ins");
    assert_eq!(recorded.len(), 2);
    assert_eq!(recorded[0].schema_key, "habit.checkin");
    assert_eq!(recorded[0].schema_version, 1);
    assert_eq!(recorded[0].values["habit_id"], json!(habit_id));
    assert_eq!(recorded[0].values["state"], json!("done"));

    let by_habit = query_observations(
        &pool,
        ObservationQuery {
            related_entity_id: Some(habit_id_input),
            ..ObservationQuery::default()
        },
    )
    .await
    .expect("query check-ins by related habit");
    assert_eq!(by_habit.len(), 1);
    assert_eq!(by_habit[0].id, recorded[0].id);

    let malformed = ObservationRecordInput {
        values: json!({ "habit_id": "not-a-uuid", "state": "done", "quantity": 1 }),
        ..habit_checkin_at("2026-06-02T07:30:00", habit_id, "done")
    };
    let reason = record_observations(
        &pool,
        RecordObservationsInput {
            observations: vec![malformed],
        },
    )
    .await
    .expect_err("malformed habit_id rejects");
    assert_eq!(invalid_reason(reason), "habit_id must be a UUID");

    let missing_id = ObservationRecordInput {
        values: json!({ "state": "done", "quantity": 1 }),
        ..habit_checkin_at("2026-06-02T07:30:00", habit_id, "done")
    };
    let reason = record_observations(
        &pool,
        RecordObservationsInput {
            observations: vec![missing_id],
        },
    )
    .await
    .expect_err("missing habit_id rejects");
    assert_eq!(invalid_reason(reason), "habit_id is required");

    let missing_target = habit_checkin_at(
        "2026-06-02T07:30:00",
        "018f0000-0000-7000-8000-000000000199",
        "done",
    );
    let reason = record_observations(
        &pool,
        RecordObservationsInput {
            observations: vec![missing_target],
        },
    )
    .await
    .expect_err("missing Habit target rejects");
    assert_eq!(
        invalid_reason(reason),
        "observation habit_id must name a habit"
    );

    let wrong_type = habit_checkin_at("2026-06-02T07:30:00", person_id, "done");
    let reason = record_observations(
        &pool,
        RecordObservationsInput {
            observations: vec![wrong_type],
        },
    )
    .await
    .expect_err("non-Habit target rejects");
    assert_eq!(
        invalid_reason(reason),
        "observation habit_id must name a habit"
    );

    let reason = query_observations(
        &pool,
        ObservationQuery {
            related_entity_id: Some("not-a-uuid".to_string()),
            ..ObservationQuery::default()
        },
    )
    .await
    .expect_err("malformed related_entity_id rejects");
    assert_eq!(invalid_reason(reason), "related_entity_id must be a UUID");
}

#[tokio::test]
async fn observations_record_batch_rolls_back_when_later_relation_is_invalid() {
    let pool = memory_pool().await;
    let habit_id = "018f0000-0000-7000-8000-000000000201";
    seed_habit(&pool, habit_id).await;
    let valid = habit_checkin_at("2026-06-01T07:30:00", habit_id, "done");
    let invalid_relation = habit_checkin_at(
        "2026-06-02T07:30:00",
        "018f0000-0000-7000-8000-000000000299",
        "done",
    );

    let reason = record_observations(
        &pool,
        RecordObservationsInput {
            observations: vec![valid, invalid_relation],
        },
    )
    .await
    .expect_err("invalid second relation rejects the batch");
    assert_eq!(
        invalid_reason(reason),
        "observation habit_id must name a habit"
    );

    let rows = query_observations(&pool, ObservationQuery::default())
        .await
        .expect("query after rolled-back relation batch");
    assert_eq!(rows.len(), 0);
}

#[tokio::test]
async fn observations_record_nutrition_intake_validate_and_query() {
    let pool = memory_pool().await;

    let full = nutrition_intake_at(
        "2026-06-04T12:30:00",
        json!({
            "kcal": 650.0,
            "protein_g": 45.0,
            "carbs_g": 70.0,
            "fat_g": 18.0,
            "label": "lunch"
        }),
    );
    record_observations(
        &pool,
        RecordObservationsInput {
            observations: vec![full],
        },
    )
    .await
    .expect("record full nutrition.intake");

    let rows = query_observations(
        &pool,
        ObservationQuery {
            schema_keys: vec!["nutrition.intake".to_string()],
            ..ObservationQuery::default()
        },
    )
    .await
    .expect("query nutrition.intake");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].schema_key, "nutrition.intake");
    assert_eq!(rows[0].schema_version, 1);
    assert_eq!(rows[0].values["kcal"], json!(650.0));
    assert_eq!(rows[0].values["protein_g"], json!(45.0));
    assert_eq!(rows[0].values["carbs_g"], json!(70.0));
    assert_eq!(rows[0].values["fat_g"], json!(18.0));
    assert_eq!(rows[0].values["label"], json!("lunch"));

    let required_only = nutrition_intake_at("2026-06-05T12:30:00", json!({ "kcal": 500.0 }));
    record_observations(
        &pool,
        RecordObservationsInput {
            observations: vec![required_only],
        },
    )
    .await
    .expect("record required-only nutrition.intake");

    let after_required_only = query_observations(
        &pool,
        ObservationQuery {
            schema_keys: vec!["nutrition.intake".to_string()],
            from: Some("2026-06-05T00:00:00".to_string()),
            to: Some("2026-06-05T23:59:59".to_string()),
            ..ObservationQuery::default()
        },
    )
    .await
    .expect("query required-only nutrition.intake");
    assert_eq!(after_required_only.len(), 1);
    assert_eq!(after_required_only[0].values, json!({ "kcal": 500.0 }));

    let reason = record_observations(
        &pool,
        RecordObservationsInput {
            observations: vec![nutrition_intake_at(
                "2026-06-06T12:30:00",
                json!({ "kcal": "450" }),
            )],
        },
    )
    .await
    .expect_err("non-numeric kcal is rejected");
    assert_eq!(invalid_reason(reason), "kcal must be a number");

    let reason = record_observations(
        &pool,
        RecordObservationsInput {
            observations: vec![nutrition_intake_at(
                "2026-06-06T12:30:00",
                json!({ "kcal": -1.0 }),
            )],
        },
    )
    .await
    .expect_err("negative kcal is rejected");
    assert_eq!(invalid_reason(reason), "kcal must be at least 0");
}
