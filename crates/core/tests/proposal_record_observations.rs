//! A generic `record_observations` Proposal records Observation rows only after
//! the user accepts it. It is not an Entity mutation: accept returns no
//! `entity_id`, and provenance lands on `observations.created_*`.

use std::path::Path;

use sqlx::Row;
use sqlx::sqlite::SqlitePoolOptions;

mod common;
use common::{await_completed, await_parked, CoreHandle, create_and_park, rpc, rt, Workspace};

async fn create_source_journal_entry(core: &CoreHandle) -> String {
    let resp = rpc(
        core,
        11,
        "entity/mutate",
        serde_json::json!({
            "mutation_kind": "create_journal_entry",
            "payload": {
                "occurred_at": "2026-06-01T07:00:00",
                "body": [{ "type": "text", "text": "Weigh-in source note." }]
            }
        }),
    )
    .await;
    resp["result"]["entity_id"]
        .as_str()
        .unwrap_or_else(|| panic!("source entity_id is a string - body: {resp}"))
        .to_string()
}

fn write_proposal_params(path: &Path, payload: serde_json::Value) {
    std::fs::write(
        path,
        serde_json::json!({
            "mutation_kind": "record_observations",
            "payload": payload,
            "rationale": "capture tracker facts"
        })
        .to_string(),
    )
    .expect("write propose params");
}

async fn pending_proposal(core: &CoreHandle, run_id: &str) -> (String, serde_json::Value) {
    let resp = rpc(
        core,
        3,
        "proposal/get",
        serde_json::json!({ "run_id": run_id }),
    )
    .await;
    assert_eq!(
        resp["result"]["mutation_kind"].as_str(),
        Some("record_observations"),
        "proposal kind - body: {resp}"
    );
    let proposal_id = resp["result"]["proposal_id"]
        .as_str()
        .unwrap_or_else(|| panic!("proposal_id is a string - body: {resp}"))
        .to_string();
    (proposal_id, resp)
}

#[test]
fn accept_records_two_observations_with_proposal_provenance_and_source() {
    let workspace = Workspace::new();
    let params_dir = tempfile::Builder::new()
        .prefix("inkstone-record-observations-")
        .tempdir()
        .expect("create params tempdir");
    let params_path = params_dir.path().join("propose-params.json");

    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    let rt = rt();

    let (proposal_id, source_journal_entry_id) = rt.block_on(async {
        let source_journal_entry_id = create_source_journal_entry(&core).await;
        write_proposal_params(
            &params_path,
            serde_json::json!({
                "observations": [
                    {
                        "schema_key": "bodyweight",
                        "occurred_at": "2026-06-02T07:30:00",
                        "values": { "kg": 72.4 },
                        "note": "after breakfast"
                    },
                    {
                        "schema_key": "bodyweight",
                        "occurred_at": "2026-06-03T07:30:00",
                        "values": { "kg": 72.1 }
                    }
                ],
                "evidence": { "journal_entry_id": source_journal_entry_id }
            }),
        );

        let run_id = create_and_park(&core, "I weighed in twice this week.").await.0;
        let (proposal_id, _) = pending_proposal(&core, &run_id).await;

        let resp = rpc(
            &core,
            4,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "record-two"
            }),
        )
        .await;
        assert_eq!(resp["result"]["status"].as_str(), Some("accepted"));
        assert!(
            resp["result"].get("entity_id").is_none(),
            "record_observations accept returns no entity_id - body: {resp}"
        );
        await_completed(&core, &run_id).await;
        (proposal_id, source_journal_entry_id)
    });

    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        let rows = sqlx::query(
            "SELECT id, schema_key, occurred_at, values_json, note, created_by, \
                    created_via_proposal_id \
             FROM observations \
             WHERE created_via_proposal_id = ?1 \
             ORDER BY occurred_at",
        )
        .bind(&proposal_id)
        .fetch_all(&pool)
        .await
        .expect("select observations");
        assert_eq!(rows.len(), 2, "accepted Proposal records both observations");

        for row in &rows {
            let created_by: String = row.get("created_by");
            let via: Option<String> = row.get("created_via_proposal_id");
            assert_eq!(created_by, "proposal");
            assert_eq!(via.as_deref(), Some(proposal_id.as_str()));

            let observation_id: String = row.get("id");
            let revisions: Vec<(i64, Option<String>)> = sqlx::query_as(
                "SELECT seq, proposal_id \
                 FROM observation_revisions \
                 WHERE observation_id = ?1 \
                 ORDER BY seq",
            )
            .bind(&observation_id)
            .fetch_all(&pool)
            .await
            .expect("initial observation revision");
            assert_eq!(
                revisions,
                vec![(1, Some(proposal_id.clone()))],
                "accepted observation gets exactly one seq-1 revision with proposal provenance"
            );

            let source_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM observation_sources \
                 WHERE observation_id = ?1 \
                   AND source_entity_id = ?2 \
                   AND source_message_id IS NULL \
                   AND relation = 'created_from'",
            )
            .bind(&observation_id)
            .bind(&source_journal_entry_id)
            .fetch_one(&pool)
            .await
            .expect("count observation source");
            assert_eq!(source_count, 1, "observation source evidence is stored");
        }

        let first_values: String = rows[0].get("values_json");
        let first_values: serde_json::Value =
            serde_json::from_str(&first_values).expect("values_json is JSON");
        assert_eq!(first_values["kg"].as_f64(), Some(72.4));
        let first_note: Option<String> = rows[0].get("note");
        assert_eq!(first_note.as_deref(), Some("after breakfast"));
    });
}

#[test]
fn same_key_replay_does_not_record_observations_twice() {
    let workspace = Workspace::new();
    let params_dir = tempfile::Builder::new()
        .prefix("inkstone-record-observations-replay-")
        .tempdir()
        .expect("create params tempdir");
    let params_path = params_dir.path().join("propose-params.json");

    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    let rt = rt();

    let proposal_id = rt.block_on(async {
        write_proposal_params(
            &params_path,
            serde_json::json!({
                "observations": [
                    {
                        "schema_key": "bodyweight",
                        "occurred_at": "2026-06-02T07:30:00",
                        "values": { "kg": 72.4 }
                    }
                ]
            }),
        );

        let run_id = create_and_park(&core, "I weighed in twice this week.").await.0;
        let (proposal_id, _) = pending_proposal(&core, &run_id).await;

        for request_id in [4_u64, 5] {
            let resp = rpc(
                &core,
                request_id,
                "proposal/decide",
                serde_json::json!({
                    "proposal_id": proposal_id,
                    "decision": "accept",
                    "decision_idempotency_key": "record-observation-once"
                }),
            )
            .await;
            assert_eq!(resp["result"]["status"].as_str(), Some("accepted"));
            assert!(
                resp["result"].get("entity_id").is_none(),
                "record_observations replay returns no entity_id - body: {resp}"
            );
        }

        await_completed(&core, &run_id).await;
        proposal_id
    });

    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        let observation_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM observations WHERE created_via_proposal_id = ?1",
        )
        .bind(&proposal_id)
        .fetch_one(&pool)
        .await
        .expect("count observations");
        assert_eq!(
            observation_count, 1,
            "same-key replay must not duplicate observations"
        );

        let observation_id: String = sqlx::query_scalar(
            "SELECT id FROM observations WHERE created_via_proposal_id = ?1",
        )
        .bind(&proposal_id)
        .fetch_one(&pool)
        .await
        .expect("select observation id");
        let revisions: Vec<(i64, Option<String>)> = sqlx::query_as(
            "SELECT seq, proposal_id \
             FROM observation_revisions \
             WHERE observation_id = ?1 \
             ORDER BY seq",
        )
        .bind(&observation_id)
        .fetch_all(&pool)
        .await
        .expect("select observation revisions");
        assert_eq!(
            revisions,
            vec![(1, Some(proposal_id.clone()))],
            "same-key replay must not duplicate observation revisions"
        );
    });
}

#[test]
fn reject_writes_no_observations_and_resumes() {
    let workspace = Workspace::new();
    let params_dir = tempfile::Builder::new()
        .prefix("inkstone-record-observations-reject-")
        .tempdir()
        .expect("create params tempdir");
    let params_path = params_dir.path().join("propose-params.json");

    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    let rt = rt();

    let proposal_id = rt.block_on(async {
        write_proposal_params(
            &params_path,
            serde_json::json!({
                "observations": [
                    {
                        "schema_key": "bodyweight",
                        "occurred_at": "2026-06-02T07:30:00",
                        "values": { "kg": 72.4 }
                    }
                ]
            }),
        );

        let run_id = create_and_park(&core, "I weighed in twice this week.").await.0;
        let (proposal_id, _) = pending_proposal(&core, &run_id).await;

        let resp = rpc(
            &core,
            4,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "reject",
                "decision_idempotency_key": "reject-record-observation"
            }),
        )
        .await;
        assert_eq!(resp["result"]["status"].as_str(), Some("rejected"));
        assert!(
            resp["result"].get("entity_id").is_none(),
            "record_observations reject returns no entity_id - body: {resp}"
        );
        await_completed(&core, &run_id).await;
        proposal_id
    });

    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        let row = sqlx::query(
            "SELECT p.status AS proposal_status, tc.status AS tool_status \
             FROM proposals p \
             JOIN tool_calls tc ON tc.id = p.tool_call_id \
             WHERE p.id = ?1",
        )
        .bind(&proposal_id)
        .fetch_one(&pool)
        .await
        .expect("proposal exists");
        let proposal_status: String = row.get("proposal_status");
        let tool_status: String = row.get("tool_status");
        assert_eq!(proposal_status, "rejected");
        assert_eq!(tool_status, "completed");

        let observation_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM observations WHERE created_via_proposal_id = ?1",
        )
        .bind(&proposal_id)
        .fetch_one(&pool)
        .await
        .expect("count observations");
        assert_eq!(observation_count, 0, "reject writes no observations");
    });
}

#[test]
fn accept_records_message_evidence_source() {
    let workspace = Workspace::new();
    let params_dir = tempfile::Builder::new()
        .prefix("inkstone-record-observations-message-source-")
        .tempdir()
        .expect("create params tempdir");
    let params_path = params_dir.path().join("propose-params.json");

    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .env("INKSTONE_PROPOSE_DELAY_MS", "2000")
        .spawn();

    let rt = rt();

    let (proposal_id, message_id) = rt.block_on(async {
        let resp = rpc(
            &core,
            1,
            "thread/create",
            serde_json::json!({ "prompt": "I weighed in after breakfast." }),
        )
        .await;
        let run_id = resp["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string - body: {resp}"))
            .to_string();

        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");
        let message_id: String =
            sqlx::query_scalar("SELECT user_message_id FROM runs WHERE id = ?1")
                .bind(&run_id)
                .fetch_one(&pool)
                .await
                .expect("select run user_message_id");
        drop(pool);

        write_proposal_params(
            &params_path,
            serde_json::json!({
                "observations": [
                    {
                        "schema_key": "bodyweight",
                        "occurred_at": "2026-06-02T07:30:00",
                        "values": { "kg": 72.4 }
                    }
                ],
                "evidence": { "message_id": message_id }
            }),
        );

        await_parked(&core, &run_id).await;
        let (proposal_id, _) = pending_proposal(&core, &run_id).await;

        let resp = rpc(
            &core,
            4,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "message-source-record"
            }),
        )
        .await;
        assert_eq!(resp["result"]["status"].as_str(), Some("accepted"));
        await_completed(&core, &run_id).await;
        (proposal_id, message_id)
    });

    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        let observation_id: String =
            sqlx::query_scalar("SELECT id FROM observations WHERE created_via_proposal_id = ?1")
                .bind(&proposal_id)
                .fetch_one(&pool)
                .await
                .expect("accepted observation exists");

        let source_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM observation_sources \
             WHERE observation_id = ?1 \
               AND source_entity_id IS NULL \
               AND source_message_id = ?2 \
               AND relation = 'evidenced_by'",
        )
        .bind(&observation_id)
        .bind(&message_id)
        .fetch_one(&pool)
        .await
        .expect("count message evidence source");
        assert_eq!(source_count, 1, "message evidence source is stored");
    });
}

#[test]
fn invalid_edited_payload_leaves_pending_and_writes_no_observations() {
    let workspace = Workspace::new();
    let params_dir = tempfile::Builder::new()
        .prefix("inkstone-record-observations-invalid-")
        .tempdir()
        .expect("create params tempdir");
    let params_path = params_dir.path().join("propose-params.json");

    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    let rt = rt();

    let proposal_id = rt.block_on(async {
        let source_journal_entry_id = create_source_journal_entry(&core).await;
        write_proposal_params(
            &params_path,
            serde_json::json!({
                "observations": [
                    {
                        "schema_key": "bodyweight",
                        "occurred_at": "2026-06-02T07:30:00",
                        "values": { "kg": 72.4 }
                    }
                ],
                "evidence": { "journal_entry_id": source_journal_entry_id }
            }),
        );

        let run_id = create_and_park(&core, "I weighed in twice this week.").await.0;
        let (proposal_id, _) = pending_proposal(&core, &run_id).await;

        let resp = rpc(
            &core,
            4,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "edit",
                "edited_payload": {
                    "observations": [
                        {
                            "schema_key": "bodyweight",
                            "occurred_at": "2026-06-02T07:30:00",
                            "values": { "kg": 72.4 }
                        },
                        {
                            "schema_key": "habit.checkin",
                            "occurred_at": "2026-06-03T07:30:00",
                            "values": {
                                "habit_id": source_journal_entry_id,
                                "state": "done"
                            }
                        }
                    ],
                    "evidence": { "journal_entry_id": source_journal_entry_id }
                },
                "decision_idempotency_key": "invalid-edit"
            }),
        )
        .await;
        assert_eq!(
            resp["error"]["code"].as_i64(),
            Some(-32602),
            "invalid edited Observation payload is invalid_params - body: {resp}"
        );
        proposal_id
    });

    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        let row = sqlx::query(
            "SELECT p.status AS proposal_status, tc.status AS tool_status \
             FROM proposals p \
             JOIN tool_calls tc ON tc.id = p.tool_call_id \
             WHERE p.id = ?1",
        )
        .bind(&proposal_id)
        .fetch_one(&pool)
        .await
        .expect("proposal exists");
        let proposal_status: String = row.get("proposal_status");
        let tool_status: String = row.get("tool_status");
        assert_eq!(
            proposal_status, "pending",
            "invalid edit leaves Proposal pending"
        );
        assert_eq!(tool_status, "pending", "invalid edit leaves tool pending");

        let observation_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM observations WHERE created_via_proposal_id = ?1",
        )
        .bind(&proposal_id)
        .fetch_one(&pool)
        .await
        .expect("count observations");
        assert_eq!(observation_count, 0, "invalid edit writes no partial rows");
    });
}

#[test]
fn whole_payload_edit_records_the_edited_observation_payload() {
    let workspace = Workspace::new();
    let params_dir = tempfile::Builder::new()
        .prefix("inkstone-record-observations-edit-")
        .tempdir()
        .expect("create params tempdir");
    let params_path = params_dir.path().join("propose-params.json");

    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    let rt = rt();

    let (proposal_id, source_journal_entry_id) = rt.block_on(async {
        let source_journal_entry_id = create_source_journal_entry(&core).await;
        write_proposal_params(
            &params_path,
            serde_json::json!({
                "observations": [
                    {
                        "schema_key": "bodyweight",
                        "occurred_at": "2026-06-02T07:30:00",
                        "values": { "kg": 73.0 },
                        "note": "rough guess"
                    }
                ],
                "evidence": { "journal_entry_id": source_journal_entry_id }
            }),
        );

        let run_id = create_and_park(&core, "I weighed in twice this week.").await.0;
        let (proposal_id, _) = pending_proposal(&core, &run_id).await;
        let edited_payload = serde_json::json!({
            "observations": [
                {
                    "schema_key": "bodyweight",
                    "occurred_at": "2026-06-04T07:30:00",
                    "values": { "kg": 72.2 },
                    "note": "corrected scale reading"
                }
            ],
            "evidence": { "journal_entry_id": source_journal_entry_id }
        });

        let resp = rpc(
            &core,
            4,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "edit",
                "edited_payload": edited_payload,
                "decision_idempotency_key": "edited-record"
            }),
        )
        .await;
        assert_eq!(resp["result"]["status"].as_str(), Some("accepted"));
        assert!(
            resp["result"].get("entity_id").is_none(),
            "record_observations edit returns no entity_id - body: {resp}"
        );
        await_completed(&core, &run_id).await;
        (proposal_id, source_journal_entry_id)
    });

    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        let row = sqlx::query(
            "SELECT occurred_at, values_json, note FROM observations \
             WHERE created_via_proposal_id = ?1",
        )
        .bind(&proposal_id)
        .fetch_one(&pool)
        .await
        .expect("edited observation exists");
        let occurred_at: String = row.get("occurred_at");
        let values_json: String = row.get("values_json");
        let note: Option<String> = row.get("note");
        let values: serde_json::Value =
            serde_json::from_str(&values_json).expect("values_json is JSON");

        assert_eq!(occurred_at, "2026-06-04T07:30:00");
        assert_eq!(values["kg"].as_f64(), Some(72.2));
        assert_eq!(note.as_deref(), Some("corrected scale reading"));

        let edited_payload: Option<String> =
            sqlx::query_scalar("SELECT edited_payload FROM proposals WHERE id = ?1")
                .bind(&proposal_id)
                .fetch_one(&pool)
                .await
                .expect("select edited_payload");
        let edited_payload: serde_json::Value = serde_json::from_str(
            edited_payload
                .as_deref()
                .expect("edited payload is recorded"),
        )
        .expect("edited_payload is JSON");
        assert_eq!(
            edited_payload,
            serde_json::json!({
                "observations": [
                    {
                        "schema_key": "bodyweight",
                        "occurred_at": "2026-06-04T07:30:00",
                        "values": { "kg": 72.2 },
                        "note": "corrected scale reading"
                    }
                ],
                "evidence": { "journal_entry_id": source_journal_entry_id }
            }),
            "Proposal records the whole edited payload"
        );

        let result_payload: Option<String> = sqlx::query_scalar(
            "SELECT tc.result_payload \
             FROM proposals p \
             JOIN tool_calls tc ON tc.id = p.tool_call_id \
             WHERE p.id = ?1",
        )
        .bind(&proposal_id)
        .fetch_one(&pool)
        .await
        .expect("select result payload");
        let result_payload: serde_json::Value = serde_json::from_str(
            result_payload
                .as_deref()
                .expect("accepted tool call has result payload"),
        )
        .expect("result_payload is JSON");
        let content = result_payload["content"]
            .as_str()
            .expect("result content is a string");
        assert!(
            content.contains("2026-06-04T07:30:00")
                && content.contains("72.2")
                && content.contains("corrected scale reading")
                && !content.contains("73.0"),
            "resume result content names the applied edit, not the stale proposal: {content}"
        );
    });
}
