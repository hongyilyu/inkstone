//! A newly-created active Project with no review fields supplied receives the
//! default review ritual (ADR-0031): `review_every = {interval:1, unit:"week"}`
//! and `next_review_at` = the next Sunday 20:00 in the Workspace review-anchor
//! local time, while `last_reviewed_at` stays absent. User-supplied review
//! fields are preserved verbatim, and non-active creates get no defaults.
//!
//! Driven by `tests/fixtures/propose-worker.ts`: a tempfile pointed at by
//! `INKSTONE_PROPOSE_PARAMS_FILE` supplies the raw `create_project` mutation the
//! fixture proposes; on accept the run resumes to `completed`.


use sqlx::Row;
use sqlx::sqlite::SqlitePoolOptions;

mod common;
use common::{await_completed, create_and_park, rpc, rt, Workspace};

/// Run a `create_project` proposal to acceptance under `payload`, returning the
/// stored entity `data` JSON.
fn accept_create_project(payload: serde_json::Value) -> serde_json::Value {
    let workspace = Workspace::new();

    let params_dir = tempfile::Builder::new()
        .prefix("inkstone-create-project-review-")
        .tempdir()
        .expect("create params tempdir");
    let params_path = params_dir.path().join("propose-params.json");
    std::fs::write(
        &params_path,
        serde_json::json!({
            "mutation_kind": "create_project",
            "payload": payload,
            "rationale": "create a project"
        })
        .to_string(),
    )
    .expect("write propose params file");

    let core = workspace
        .core()
        .worker_fixture("propose-worker.ts")
        .env("INKSTONE_PROPOSE_PARAMS_FILE", &params_path)
        .spawn();

    let rt = rt();

    let entity_id = rt.block_on(async {
        let run_id = create_and_park(&core, "Start a new project outcome.").await.0;

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

        await_completed(&core, &run_id).await;
        entity_id
    });

    rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");
        let row = sqlx::query("SELECT data FROM entities WHERE id = ?1")
            .bind(&entity_id)
            .fetch_one(&pool)
            .await
            .expect("entity row exists");
        let data: String = row.get("data");
        serde_json::from_str(&data).expect("entity data is JSON")
    })
}

/// 0 = Sunday, derived from the parsed civil date via the proleptic-Gregorian
/// day count (1970-01-01 is a Thursday).
fn weekday_sunday0(year: i64, month: i64, day: i64) -> i64 {
    let y = year - if month <= 2 { 1 } else { 0 };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    (days.rem_euclid(7) + 4).rem_euclid(7)
}

#[test]
fn name_only_create_project_gets_weekly_review_defaults() {
    let data = accept_create_project(serde_json::json!({ "name": "Ship API v2 migration" }));

    assert_eq!(
        data["review_every"],
        serde_json::json!({ "interval": 1, "unit": "week" }),
        "name-only active create defaults review_every to weekly — got {data}"
    );

    let next = data["next_review_at"]
        .as_str()
        .unwrap_or_else(|| panic!("next_review_at is a string — got {data}"));
    assert!(
        next.ends_with("T20:00:00"),
        "next_review_at anchors to 20:00 local — got {next}"
    );
    assert_eq!(next.len(), 19, "next_review_at is YYYY-MM-DDTHH:MM:SS — {next}");
    let year: i64 = next[0..4].parse().expect("year parses");
    let month: i64 = next[5..7].parse().expect("month parses");
    let day: i64 = next[8..10].parse().expect("day parses");
    assert_eq!(
        weekday_sunday0(year, month, day),
        0,
        "next_review_at falls on a Sunday — got {next}"
    );

    assert!(
        data.get("last_reviewed_at").is_none_or(serde_json::Value::is_null),
        "a fresh Project has no last_reviewed_at — got {data}"
    );
}

#[test]
fn explicit_review_fields_are_preserved() {
    let data = accept_create_project(serde_json::json!({
        "name": "Quarterly planning",
        "review_every": { "interval": 2, "unit": "month" },
        "next_review_at": "2026-01-01T09:00:00"
    }));

    assert_eq!(
        data["review_every"],
        serde_json::json!({ "interval": 2, "unit": "month" }),
        "user-supplied review_every is preserved — got {data}"
    );
    assert_eq!(
        data["next_review_at"].as_str(),
        Some("2026-01-01T09:00:00"),
        "user-supplied next_review_at is preserved — got {data}"
    );
}

#[test]
fn non_active_create_project_gets_no_review_defaults() {
    let data = accept_create_project(serde_json::json!({
        "name": "Someday/maybe rewrite",
        "status": "on_hold"
    }));

    assert_eq!(data["status"].as_str(), Some("on_hold"), "status preserved — got {data}");
    assert!(
        data.get("review_every").is_none(),
        "non-active create gets no review_every default — got {data}"
    );
    assert!(
        data.get("next_review_at").is_none(),
        "non-active create gets no next_review_at default — got {data}"
    );
}
