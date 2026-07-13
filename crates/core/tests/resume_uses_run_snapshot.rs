//! A resumed Run executes under the model/effort it snapshotted at Run start,
//! NOT the live settings at decide time (ADR-0024: "a setting changed mid-Run
//! affects the next Run, not the running one").
//!
//! The Run parks under effort A (`high`); the user then changes effort to B
//! (`low`) before deciding the Proposal. On `proposal/decide{accept}` Core
//! rebuilds the resume Workflow from the `runs` snapshot — so the resume
//! manifest carries A, never B. This is the load-bearing proof that resume
//! reads `db::run_workflow_snapshot`, not `resolve_effective_workflow` against
//! live settings.
//!
//! Driven by `tests/fixtures/propose-worker.ts` with
//! `INKSTONE_ECHO_RESUME_EFFORT=1`: spawn 1 proposes & parks; the resume spawn
//! echoes the manifest's `thinking_level` as `resume-effort=<e>` so the value
//! is observable in the assistant text.

use std::time::{Duration, Instant};

use futures_util::SinkExt;
use sqlx::Row;
use sqlx::sqlite::SqlitePoolOptions;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{create_and_park, next_text, rpc, rt, Workspace};

#[test]
fn resume_executes_under_snapshotted_effort_not_live_settings() {
    let workspace = Workspace::new();

    let rt = rt();

    // The resume spawn echoes the manifest's thinking_level as the assistant
    // text, so the resolved effort is observable from the DB.
    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_ECHO_RESUME_EFFORT", "1")
        .spawn();

    let run_id = rt.block_on(async {
        let mut ws = core.connect().await;

        // Effort A (high): the value the Run must snapshot at start.
        let set = {
            let req = serde_json::json!({
                "jsonrpc": "2.0", "id": 10, "method": "settings/set",
                "params": { "effort": "high" }
            });
            ws.send(Message::Text(req.to_string().into()))
                .await
                .expect("send settings/set A");
            let body = next_text(&mut ws).await;
            serde_json::from_str::<serde_json::Value>(&body).expect("json response")
        };
        assert_eq!(
            set["result"]["effort"],
            serde_json::json!("high"),
            "settings/set A applied — body: {set}"
        );
        ws.close(None).await.ok();

        create_and_park(&core, "I bought milk after daycare pickup and felt relieved.")
            .await
            .0
    });

    // White-box: the parked Run snapshotted effort A.
    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");
        let level: String = sqlx::query_scalar("SELECT thinking_level FROM runs WHERE id = ?1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .expect("run row exists");
        assert_eq!(
            level, "high",
            "runs.thinking_level snapshots the resolved effort at Run start"
        );
    });

    let proposal_id = rt.block_on(async {
        let resp = rpc(
            &core,
            3,
            "proposal/get",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        resp["result"]["proposal_id"]
            .as_str()
            .unwrap_or_else(|| panic!("proposal_id is a string — body: {resp}"))
            .to_string()
    });

    // Change to effort B (low) BEFORE deciding. If resume re-resolved live
    // settings (the latent bug), the resume manifest would carry B.
    rt.block_on(async {
        let resp = rpc(
            &core,
            4,
            "settings/set",
            serde_json::json!({ "effort": "low" }),
        )
        .await;
        assert_eq!(
            resp["result"]["effort"],
            serde_json::json!("low"),
            "settings/set B applied — body: {resp}"
        );
    });

    // Decide → resume. The resume spawn echoes the manifest's effort.
    rt.block_on(async {
        let resp = rpc(
            &core,
            5,
            "proposal/decide",
            serde_json::json!({
                "proposal_id": proposal_id,
                "decision": "accept",
                "decision_idempotency_key": "snapshot-k1",
            }),
        )
        .await;
        assert_eq!(
            resp["result"]["status"].as_str(),
            Some("accepted"),
            "decide accepted — body: {resp}"
        );
    });

    // The resumed Run's assistant text echoes the effort the resume manifest
    // carried. It MUST be A (high) — the snapshot — not B (low) — live settings.
    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");

        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let row = sqlx::query(
                "SELECT mp.text AS text \
                 FROM runs r \
                 JOIN messages m ON m.run_id = r.id AND m.role = 'assistant' \
                 JOIN message_parts mp ON mp.message_id = m.id AND mp.seq = 0 \
                 WHERE r.id = ?1",
            )
            .bind(&run_id)
            .fetch_optional(&pool)
            .await
            .expect("query assistant text");

            if let Some(row) = row {
                let text: String = row.get("text");
                if !text.is_empty() {
                    assert_eq!(
                        text, "resume-effort=high",
                        "resume executed under the SNAPSHOTTED effort (A), not live settings (B)"
                    );
                    break;
                }
            }
            if Instant::now() > deadline {
                panic!("timed out waiting for the resumed assistant text");
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });
}
