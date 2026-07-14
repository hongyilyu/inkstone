//! Proposal `accept`/`reject`/`edit` over `proposal/decide` on a parked Run:
//! apply (or not) atomically, then resume in a fresh Worker to `completed`;
//! decides are idempotent on `decision_idempotency_key` (ADR-0025).
//!
//! Driven by `tests/fixtures/propose-worker.ts`: spawn 1 proposes & parks;
//! spawn 2 detects `mode === "resume"` and finishes.


use sqlx::Row;
use sqlx::sqlite::SqlitePoolOptions;

mod common;
use common::{await_completed, create_and_park, rpc, rt, Workspace};

#[test]
fn decide_malformed_proposal_id_is_invalid_params() {
    // A non-UUID proposal_id fails at decode (ADR-0029), before any DB lookup,
    // so this needs no parked proposal. Mirrors the run/subscribe + run/cancel
    // gates: proposal/decide shares the same decode_params framing, so its
    // malformed-envelope wire code must stay invalid_params (-32602), never
    // -32603. edit_rejects_invalid_payload exercises a body-level -32602 after
    // decode succeeds; this pins the decode arm itself.
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("propose-worker.ts").spawn();

    let rt = rt();

    rt.block_on(async {
        let resp = rpc(
            &core,
            9,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": "not-a-uuid",
                "decision": "accept",
                "decision_idempotency_key": "k",
            }),
        )
        .await;
        assert_eq!(resp["id"], serde_json::json!(9), "echoed id");
        assert_eq!(
            resp["error"]["code"].as_i64(),
            Some(-32602),
            "malformed proposal_id rejected with invalid_params (-32602) — body: {resp}"
        );
    });
}

#[test]
fn accept_applies_and_resumes() {
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("propose-worker.ts").spawn();

    let rt = rt();

    let (run_id, entity_id) = rt.block_on(async {
        let run_id = create_and_park(&core, "I bought milk after daycare pickup and felt relieved.")
            .await
            .0;

        // Learn the proposal_id.
        let resp = rpc(
            &core,
            3,
            "proposal/get",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        let proposal_id = resp["result"]["proposal_id"]
            .as_str()
            .unwrap_or_else(|| panic!("proposal_id is a string — body: {resp}"))
            .to_string();

        // Decide: accept.
        let resp = rpc(
            &core,
            4,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "k1",
            }),
        )
        .await;
        let result = &resp["result"];
        assert_eq!(
            result["status"].as_str(),
            Some("accepted"),
            "decide result status — body: {resp}"
        );
        let entity_id = result["entity_id"]
            .as_str()
            .unwrap_or_else(|| panic!("entity_id is a string — body: {resp}"))
            .to_string();

        // The Run resumes in a fresh Worker and reaches completed.
        await_completed(&core, &run_id).await;

        (run_id, entity_id)
    });

    // White-box DB assertions.
    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        // One Journal Entry entity, created via the proposal.
        let row = sqlx::query(
            "SELECT type, data, created_by, created_via_proposal_id FROM entities WHERE id = ?1",
        )
        .bind(&entity_id)
        .fetch_one(&pool)
        .await
        .expect("entity row exists");
        let etype: String = row.get("type");
        let data: String = row.get("data");
        let created_by: String = row.get("created_by");
        let via: Option<String> = row.get("created_via_proposal_id");
        assert_eq!(etype, "journal_entry", "entity type is journal_entry");
        assert_eq!(created_by, "proposal", "entity created_by=proposal");
        assert!(via.is_some(), "entity carries created_via_proposal_id");
        let data_json: serde_json::Value =
            serde_json::from_str(&data).expect("entity data is JSON");
        assert_eq!(
            data_json["body"][0]["text"].as_str(),
            Some("Bought milk after daycare pickup."),
            "entity body text — got {data}"
        );

        // entity_sources records the source user Message.
        let source_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM entity_sources es \
             JOIN runs r ON r.user_message_id = es.source_message_id \
             WHERE es.entity_id = ?1 AND r.id = ?2 AND es.relation = 'created_from'",
        )
        .bind(&entity_id)
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("count entity_sources");
        assert_eq!(
            source_count, 1,
            "Journal Entry is sourced from the user Message"
        );

        // entity_revisions seq 1.
        let rev_seq: i64 = sqlx::query_scalar(
            "SELECT seq FROM entity_revisions WHERE entity_id = ?1 ORDER BY seq DESC LIMIT 1",
        )
        .bind(&entity_id)
        .fetch_one(&pool)
        .await
        .expect("entity_revision row exists");
        assert_eq!(rev_seq, 1, "first entity revision is seq 1");

        // proposals.status='accepted'.
        let prop_status: String = sqlx::query_scalar(
            "SELECT p.status FROM proposals p \
             JOIN tool_calls tc ON tc.id = p.tool_call_id WHERE tc.run_id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("proposal row exists");
        assert_eq!(prop_status, "accepted", "proposal accepted");

        // tool_calls resolved (completed).
        let tc_status: String =
            sqlx::query_scalar("SELECT status FROM tool_calls WHERE run_id = ?1")
                .bind(&run_id)
                .fetch_one(&pool)
                .await
                .expect("tool_call row exists");
        assert_eq!(tc_status, "completed", "tool_call resolved");

        // runs.status='completed'.
        let run_status: String = sqlx::query_scalar("SELECT status FROM runs WHERE id = ?1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .expect("run row exists");
        assert_eq!(run_status, "completed", "run completed");
    });
}

/// `reject` resolves the Decision without applying: no entity, Proposal
/// `rejected`, the tool_call resolves as a NORMAL (non-error) decline, and the
/// Run resumes to `completed` (ADR-0025).
#[test]
fn reject_resumes_without_applying() {
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("propose-worker.ts").spawn();

    let rt = rt();

    let run_id = rt.block_on(async {
        let run_id = create_and_park(&core, "I bought milk after daycare pickup and felt relieved.")
            .await
            .0;

        // Learn the proposal_id.
        let resp = rpc(
            &core,
            3,
            "proposal/get",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        let proposal_id = resp["result"]["proposal_id"]
            .as_str()
            .unwrap_or_else(|| panic!("proposal_id is a string — body: {resp}"))
            .to_string();

        // Decide: reject.
        let resp = rpc(
            &core,
            4,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "reject",
                "decision_idempotency_key": "r1",
            }),
        )
        .await;
        let result = &resp["result"];
        assert_eq!(
            result["status"].as_str(),
            Some("rejected"),
            "decide result status — body: {resp}"
        );
        assert!(
            result["entity_id"].is_null() || result.get("entity_id").is_none(),
            "reject result carries no entity_id — body: {resp}"
        );

        // The Run resumes in a fresh Worker and reaches completed.
        await_completed(&core, &run_id).await;
        run_id
    });

    // White-box DB assertions.
    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        // ZERO entities for this run's proposal — reject applies nothing.
        let entity_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM entities WHERE created_via_proposal_id IN \
             (SELECT p.id FROM proposals p JOIN tool_calls tc ON tc.id = p.tool_call_id \
              WHERE tc.run_id = ?1)",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("count entities");
        assert_eq!(entity_count, 0, "reject created no entity");

        // proposals.status='rejected'.
        let prop_status: String = sqlx::query_scalar(
            "SELECT p.status FROM proposals p \
             JOIN tool_calls tc ON tc.id = p.tool_call_id WHERE tc.run_id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("proposal row exists");
        assert_eq!(prop_status, "rejected", "proposal rejected");

        // tool_calls resolved (completed) — a NORMAL result, not errored.
        let row = sqlx::query("SELECT status, result_payload FROM tool_calls WHERE run_id = ?1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .expect("tool_call row exists");
        let tc_status: String = row.get("status");
        let result_payload: Option<String> = row.get("result_payload");
        assert_eq!(tc_status, "completed", "tool_call resolved (not errored)");
        let payload = result_payload.expect("tool_call carries a result_payload");
        let payload_json: serde_json::Value =
            serde_json::from_str(&payload).expect("result_payload is JSON");
        // Decline must NOT be flagged as an error so the resumed model
        // continues conversationally (ADR-0025).
        assert_ne!(
            payload_json["is_error"].as_bool(),
            Some(true),
            "decline result is not an error — payload: {payload}"
        );
        assert_ne!(
            payload_json["decision"].as_str(),
            Some("accept"),
            "decline result is a reject decision — payload: {payload}"
        );

        // runs.status='completed'.
        let run_status: String = sqlx::query_scalar("SELECT status FROM runs WHERE id = ?1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .expect("run row exists");
        assert_eq!(run_status, "completed", "run completed after reject resume");
    });
}

#[test]
fn accept_is_idempotent() {
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("propose-worker.ts").spawn();

    let rt = rt();

    let run_id = rt.block_on(async {
        let run_id = create_and_park(&core, "I bought milk after daycare pickup and felt relieved.")
            .await
            .0;

        let resp = rpc(
            &core,
            3,
            "proposal/get",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        let proposal_id = resp["result"]["proposal_id"]
            .as_str()
            .unwrap_or_else(|| panic!("proposal_id is a string — body: {resp}"))
            .to_string();

        let first = rpc(
            &core,
            4,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "same-key",
            }),
        )
        .await;
        let first_entity = first["result"]["entity_id"]
            .as_str()
            .unwrap_or_else(|| panic!("first decide entity_id — body: {first}"))
            .to_string();

        await_completed(&core, &run_id).await;

        // Second decide, same key → same result, no second entity.
        let second = rpc(
            &core,
            5,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "same-key",
            }),
        )
        .await;
        assert_eq!(
            second["result"]["status"].as_str(),
            Some("accepted"),
            "second decide returns accepted — body: {second}"
        );
        assert_eq!(
            second["result"]["entity_id"].as_str(),
            Some(first_entity.as_str()),
            "second decide returns the SAME entity_id — body: {second}"
        );

        run_id
    });

    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        let entity_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM entities WHERE created_via_proposal_id IN \
             (SELECT p.id FROM proposals p JOIN tool_calls tc ON tc.id = p.tool_call_id \
              WHERE tc.run_id = ?1)",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("count entities");
        assert_eq!(
            entity_count, 1,
            "idempotent decide created exactly one entity"
        );
    });
}

/// `edit` validates the edited Journal Entry, applies the EDITED payload,
/// records `proposals.edited_payload`, and resumes to `completed`.
#[test]
fn edit_applies_edited_payload() {
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("propose-worker.ts").spawn();

    let rt = rt();

    let (run_id, entity_id) = rt.block_on(async {
        let run_id = create_and_park(&core, "I bought milk after daycare pickup and felt relieved.")
            .await
            .0;

        let resp = rpc(
            &core,
            3,
            "proposal/get",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        let proposal_id = resp["result"]["proposal_id"]
            .as_str()
            .unwrap_or_else(|| panic!("proposal_id is a string — body: {resp}"))
            .to_string();

        // Decide: edit with a new body.
        let resp = rpc(
            &core,
            4,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "edit",
                "edited_payload": {
                    "occurred_at": "2026-06-10T10:35:00",
                    "body": [{ "type": "text", "text": "Bought oat milk after daycare pickup." }]
                },
                "decision_idempotency_key": "e1",
            }),
        )
        .await;
        let result = &resp["result"];
        assert_eq!(
            result["status"].as_str(),
            Some("accepted"),
            "edit decide result status — body: {resp}"
        );
        let entity_id = result["entity_id"]
            .as_str()
            .unwrap_or_else(|| panic!("entity_id is a string — body: {resp}"))
            .to_string();

        await_completed(&core, &run_id).await;
        (run_id, entity_id)
    });

    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        // The entity carries the EDITED body.
        let data: String = sqlx::query_scalar("SELECT data FROM entities WHERE id = ?1")
            .bind(&entity_id)
            .fetch_one(&pool)
            .await
            .expect("entity row exists");
        let data_json: serde_json::Value =
            serde_json::from_str(&data).expect("entity data is JSON");
        assert_eq!(
            data_json["body"][0]["text"].as_str(),
            Some("Bought oat milk after daycare pickup."),
            "entity body text is the EDIT — got {data}"
        );

        // proposals.status='accepted' AND edited_payload recorded.
        let row = sqlx::query(
            "SELECT p.status, p.edited_payload FROM proposals p \
             JOIN tool_calls tc ON tc.id = p.tool_call_id WHERE tc.run_id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("proposal row exists");
        let prop_status: String = row.get("status");
        let edited_payload: Option<String> = row.get("edited_payload");
        assert_eq!(prop_status, "accepted", "edit proposal accepted");
        let edited = edited_payload.expect("proposals.edited_payload is set on edit");
        let edited_json: serde_json::Value =
            serde_json::from_str(&edited).expect("edited_payload is JSON");
        assert_eq!(
            edited_json["body"][0]["text"].as_str(),
            Some("Bought oat milk after daycare pickup."),
            "edited_payload carries the edit — got {edited}"
        );

        let source_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM entity_sources es \
             JOIN runs r ON r.user_message_id = es.source_message_id \
             WHERE es.entity_id = ?1 AND r.id = ?2 AND es.relation = 'created_from'",
        )
        .bind(&entity_id)
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("count entity_sources");
        assert_eq!(
            source_count, 1,
            "edited Journal Entry is still sourced from the original user Message"
        );

        // runs.status='completed'.
        let run_status: String = sqlx::query_scalar("SELECT status FROM runs WHERE id = ?1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .expect("run row exists");
        assert_eq!(run_status, "completed", "run completed after edit resume");
    });
}

/// An invalid `edited_payload` (empty body text) is rejected with
/// `invalid_params` BEFORE any DB write: no entity, Proposal stays `pending`,
/// Run stays `parked` (re-decidable).
#[test]
fn edit_rejects_invalid_payload() {
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("propose-worker.ts").spawn();

    let rt = rt();

    let run_id = rt.block_on(async {
        let run_id = create_and_park(&core, "I bought milk after daycare pickup and felt relieved.")
            .await
            .0;

        let resp = rpc(
            &core,
            3,
            "proposal/get",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        let proposal_id = resp["result"]["proposal_id"]
            .as_str()
            .unwrap_or_else(|| panic!("proposal_id is a string — body: {resp}"))
            .to_string();

        // Decide: edit with an empty body -> invalid_params, no apply.
        let resp = rpc(
            &core,
            4,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "edit",
                "edited_payload": {
                    "occurred_at": "2026-06-10T10:35:00",
                    "body": [{ "type": "text", "text": "" }]
                },
                "decision_idempotency_key": "bad1",
            }),
        )
        .await;
        assert_eq!(
            resp["error"]["code"].as_i64(),
            Some(-32602),
            "invalid edited_payload → invalid_params — body: {resp}"
        );
        run_id
    });

    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        // NO entity created.
        let entity_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM entities WHERE created_via_proposal_id IN \
             (SELECT p.id FROM proposals p JOIN tool_calls tc ON tc.id = p.tool_call_id \
              WHERE tc.run_id = ?1)",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("count entities");
        assert_eq!(entity_count, 0, "invalid edit created no entity");

        // proposals.status still 'pending'.
        let prop_status: String = sqlx::query_scalar(
            "SELECT p.status FROM proposals p \
             JOIN tool_calls tc ON tc.id = p.tool_call_id WHERE tc.run_id = ?1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("proposal row exists");
        assert_eq!(
            prop_status, "pending",
            "proposal still pending after invalid edit"
        );

        // runs.status still 'parked' (no resume).
        let run_status: String = sqlx::query_scalar("SELECT status FROM runs WHERE id = ?1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .expect("run row exists");
        assert_eq!(run_status, "parked", "run still parked after invalid edit");
    });
}

/// Multi-step transcript reconstruction (ADR-0025): the first spawn does a real
/// `read_thread` tool_call before the `propose_workspace_mutation` that parks.
/// On accept, Core must rebuild a provider-valid transcript (paired
/// `tool_result`s, no orphans); reaching `completed` proves it is well-formed.
#[test]
fn accept_resumes_after_multistep_transcript() {
    let workspace = Workspace::new();
    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_MULTISTEP", "1")
        .spawn();

    let rt = rt();

    let run_id = rt.block_on(async {
        let run_id = create_and_park(&core, "I bought milk after daycare pickup and felt relieved.")
            .await
            .0;

        let resp = rpc(
            &core,
            3,
            "proposal/get",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        let proposal_id = resp["result"]["proposal_id"]
            .as_str()
            .unwrap_or_else(|| panic!("proposal_id is a string — body: {resp}"))
            .to_string();

        let resp = rpc(
            &core,
            4,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "k-multistep",
            }),
        )
        .await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "decide result status — body: {resp}"
        );

        // Reaching completed proves the reconstructed transcript is provider-valid.
        await_completed(&core, &run_id).await;
        run_id
    });

    // Both the read_thread and propose tool_calls resolved (no orphan).
    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        let resolved: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM tool_calls WHERE run_id = ?1 AND status IN ('completed','errored')",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .expect("count tool_calls");
        assert_eq!(resolved, 2, "both read_thread and propose tool_calls resolved");

        let run_status: String = sqlx::query_scalar("SELECT status FROM runs WHERE id = ?1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .expect("run row exists");
        assert_eq!(run_status, "completed", "run completed after multi-step resume");
    });
}

/// ADR-0044: after an accept, `thread/get` carries the decided Proposal on the
/// assistant Message (`proposal.status = "accepted"`), so the "Applied." card
/// survives reload. The end-to-end complement to the DB-level
/// `thread_get_rehydrates_decided_proposal` unit test — proves the handler
/// serializes the field over the wire.
#[test]
fn thread_get_carries_decided_proposal_after_accept() {
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("propose-worker.ts").spawn();

    let rt = rt();

    rt.block_on(async {
        let (run_id, thread_id) =
            create_and_park(&core, "I bought milk after daycare pickup and felt relieved.").await;

        let resp = rpc(
            &core,
            3,
            "proposal/get",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        let proposal_id = resp["result"]["proposal_id"]
            .as_str()
            .unwrap_or_else(|| panic!("proposal_id is a string — body: {resp}"))
            .to_string();

        let resp = rpc(
            &core,
            4,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "k-rehydrate",
            }),
        )
        .await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "decide accepted — body: {resp}"
        );
        await_completed(&core, &run_id).await;

        // Rehydrate the thread: the assistant Message now carries the decided
        // Proposal (the read filters to accepted/rejected — ADR-0044).
        let resp = rpc(
            &core,
            5,
            "thread/get",
            serde_json::json!({ "thread_id": thread_id }),
        )
        .await;
        let messages = resp["result"]["messages"]
            .as_array()
            .unwrap_or_else(|| panic!("messages is an array — body: {resp}"));
        let assistant = messages
            .iter()
            .find(|m| m["role"].as_str() == Some("assistant"))
            .unwrap_or_else(|| panic!("an assistant Message — body: {resp}"));
        // The decided Proposal rehydrates as a `proposal` SEGMENT in the assistant
        // turn's ordered `segments[]` (ADR-0045 folds the former `proposal` field in).
        let proposal = assistant["segments"]
            .as_array()
            .unwrap_or_else(|| panic!("assistant segments is an array — body: {resp}"))
            .iter()
            .find(|seg| seg["kind"].as_str() == Some("proposal"))
            .unwrap_or_else(|| panic!("a decided proposal segment — body: {resp}"));
        assert_eq!(
            proposal["proposal_id"].as_str(),
            Some(proposal_id.as_str()),
            "thread/get carries the decided proposal_id — body: {resp}"
        );
        assert_eq!(
            proposal["status"].as_str(),
            Some("accepted"),
            "rehydrated proposal status is accepted — body: {resp}"
        );
        assert_eq!(
            proposal["mutation_kind"].as_str(),
            Some("create_journal_entry"),
            "rehydrated proposal carries its mutation_kind — body: {resp}"
        );

        // The user Message carries no proposal segment (it belongs to the assistant turn).
        let user = messages
            .iter()
            .find(|m| m["role"].as_str() == Some("user"))
            .unwrap_or_else(|| panic!("a user Message — body: {resp}"));
        assert!(
            user["segments"]
                .as_array()
                .is_none_or(|segs| !segs.iter().any(|s| s["kind"].as_str() == Some("proposal"))),
            "user Message carries no decided proposal segment — body: {resp}"
        );
    });
}
