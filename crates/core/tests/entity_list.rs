//! `entity/list` returns accepted Entities of the requested type newest-first
//! and filters out other types.



mod common;
use common::{CoreHandle, create_and_park, rpc, rt, Workspace};

async fn park_and_accept(core: &CoreHandle, idempotency_key: &str, body_text: &str) -> String {
    let run_id = create_and_park(core, "I bought milk after daycare pickup and felt relieved.")
        .await
        .0;

    let resp = rpc(
        core,
        3,
        "proposal/get",
        serde_json::json!({ "run_id": run_id }),
    )
    .await;
    let proposal_id = resp["result"]["proposal_id"]
        .as_str()
        .unwrap_or_else(|| panic!("proposal_id is a string - body: {resp}"))
        .to_string();

    let resp = rpc(
        core,
        4,
        "proposal/decide",
        serde_json::json!({
            "proposal_id": proposal_id,
            "decision": "edit",
            "edited_payload": {
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "text", "text": body_text }]
            },
            "decision_idempotency_key": idempotency_key,
        }),
    )
    .await;
    resp["result"]["entity_id"]
        .as_str()
        .unwrap_or_else(|| panic!("entity_id is a string - body: {resp}"))
        .to_string()
}

#[test]
fn list_journal_entries_returns_accepted() {
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("propose-worker.ts").spawn();

    let rt = rt();

    rt.block_on(async {
        let first_entity_id = park_and_accept(&core, "k1", "First journal entry.").await;
        let second_entity_id = park_and_accept(&core, "k2", "Second journal entry.").await;

        let resp = rpc(
            &core,
            5,
            "entity/list",
            serde_json::json!({ "type": "journal_entry" }),
        )
        .await;
        let entities = resp["result"]["entities"]
            .as_array()
            .unwrap_or_else(|| panic!("result.entities is an array - body: {resp}"));
        assert_eq!(
            entities.len(),
            2,
            "two Journal Entries listed - body: {resp}"
        );

        let newest = &entities[0];
        let oldest = &entities[1];
        assert_eq!(
            newest["id"].as_str(),
            Some(second_entity_id.as_str()),
            "newest row is first - body: {resp}"
        );
        assert_eq!(
            oldest["id"].as_str(),
            Some(first_entity_id.as_str()),
            "oldest row is second - body: {resp}"
        );
        assert_eq!(
            newest["type"].as_str(),
            Some("journal_entry"),
            "newest row type is journal_entry"
        );
        assert_eq!(
            oldest["type"].as_str(),
            Some("journal_entry"),
            "oldest row type is journal_entry"
        );
        assert_eq!(
            newest["data"]["body"][0]["text"].as_str(),
            Some("Second journal entry."),
            "newest row data body text is the second Journal Entry - body: {resp}"
        );
        assert_eq!(
            oldest["data"]["body"][0]["text"].as_str(),
            Some("First journal entry."),
            "oldest row data body text is the first Journal Entry - body: {resp}"
        );
        assert!(
            newest["created_at"].is_number(),
            "newest row carries a numeric created_at - body: {resp}"
        );
        assert!(
            newest["updated_at"].is_number(),
            "newest row carries a numeric updated_at - body: {resp}"
        );

        let resp = rpc(
            &core,
            6,
            "entity/list",
            serde_json::json!({ "type": "person" }),
        )
        .await;
        let entities = resp["result"]["entities"]
            .as_array()
            .unwrap_or_else(|| panic!("result.entities is an array - body: {resp}"));
        assert!(
            entities.is_empty(),
            "no People listed from a Journal Entry-only workspace - body: {resp}"
        );
    });
}
