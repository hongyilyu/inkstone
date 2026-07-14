//! A parked Run survives a Core restart on the same DB (ADR-0025). Core #1
//! parks a Run on a Proposal and is killed; Core #2 boots on the same DB. The
//! boot recovery sweep (ADR-0012) errors interrupted `running`/`pending` Runs
//! but MUST preserve `parked` — so the Proposal is still `pending`, the Run is
//! still `parked`, and `proposal/decide{accept}` resumes it to `completed` with
//! a Journal Entry in tier 2. The sweep's `parked` exclusion is the unit under
//! test.
//!
//! Driven by `tests/fixtures/propose-worker.ts`: spawn 1 proposes & blocks; the
//! resume spawn detects `mode === "resume"` and finishes.


use sqlx::Row;
use sqlx::sqlite::SqlitePoolOptions;

mod common;
use common::{await_completed, create_and_park, rpc, rt, Workspace};

#[test]
fn parked_survives_restart() {
    let workspace = Workspace::new();

    let rt = rt();

    // Core #1: park a Run, then kill the process.
    let mut core1 = workspace.core().worker_fixture("propose-worker.ts").spawn();
    let run_id = rt
        .block_on(create_and_park(
            &core1,
            "I bought milk after daycare pickup and felt relieved.",
        ))
        .0;
    core1.kill();

    // Core #2: boot on the same DB — the boot recovery sweep runs here.
    let core2 = workspace.core().worker_fixture("propose-worker.ts").spawn();

    let entity_id = rt.block_on(async {
        // The parked Run survived the restart: its Proposal is still pending.
        let resp = rpc(
            &core2,
            3,
            "proposal/get",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("pending"),
            "Proposal still pending after restart — body: {resp}"
        );
        let proposal_id = resp["result"]["proposal_id"]
            .as_str()
            .unwrap_or_else(|| panic!("proposal_id is a string — body: {resp}"))
            .to_string();

        // White-box: the boot sweep preserved the parked Run (not swept to
        // errored/core_restarted).
        {
            let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect(&url)
                .await
                .expect("connect to migrated DB");
            let row = sqlx::query("SELECT status, terminal_reason FROM runs WHERE id = ?1")
                .bind(&run_id)
                .fetch_one(&pool)
                .await
                .expect("run row exists");
            let status: String = row.get("status");
            let terminal_reason: Option<String> = row.get("terminal_reason");
            assert_eq!(
                status, "parked",
                "boot recovery sweep preserved the parked Run (not swept to errored)"
            );
            assert!(
                terminal_reason.is_none(),
                "parked Run has no terminal_reason after the sweep — got {terminal_reason:?}"
            );
        }

        // The parked Run is still DECIDABLE on Core #2: accept resumes it.
        let resp = rpc(
            &core2,
            4,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "restart-k1",
            }),
        )
        .await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "decide accepted on Core #2 — body: {resp}"
        );
        let entity_id = resp["result"]["entity_id"]
            .as_str()
            .unwrap_or_else(|| panic!("entity_id is a string — body: {resp}"))
            .to_string();

        // The Run resumes in a fresh Worker on Core #2 and reaches completed.
        await_completed(&core2, &run_id).await;
        entity_id
    });

    // White-box: Run completed and the Journal Entry exists in tier 2.
    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        let run_status: String = sqlx::query_scalar("SELECT status FROM runs WHERE id = ?1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .expect("run row exists");
        assert_eq!(
            run_status, "completed",
            "run completed after restart + accept resume"
        );

        let row = sqlx::query("SELECT type, data, created_by FROM entities WHERE id = ?1")
            .bind(&entity_id)
            .fetch_one(&pool)
            .await
            .expect("entity row exists");
        let etype: String = row.get("type");
        let created_by: String = row.get("created_by");
        let data: String = row.get("data");
        assert_eq!(etype, "journal_entry", "Journal Entry created in tier 2");
        assert_eq!(created_by, "proposal", "entity created_by=proposal");
        let data_json: serde_json::Value =
            serde_json::from_str(&data).expect("entity data is JSON");
        assert_eq!(
            data_json["body"][0]["text"].as_str(),
            Some("Bought milk after daycare pickup."),
            "entity body text — got {data}"
        );
    });
}
