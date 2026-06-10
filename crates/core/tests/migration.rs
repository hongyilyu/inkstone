use std::collections::BTreeSet;

use sqlx::Row;
use sqlx::sqlite::SqlitePoolOptions;

mod common;
use common::Workspace;

#[test]
fn migration_creates_all_tables() {
    let workspace = Workspace::new();

    // Spawning to INKSTONE_LISTENING means `sqlx::migrate!()` ran successfully.
    let core = workspace.core().spawn();
    drop(core);

    assert!(
        workspace.db_path().exists(),
        "Core should have created the DB file at {}",
        workspace.db_path().display()
    );

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let actual: BTreeSet<String> = rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");
        let rows = sqlx::query(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .fetch_all(&pool)
        .await
        .expect("read sqlite_master");
        rows.into_iter()
            .map(|r| r.get::<String, _>("name"))
            .collect()
    });

    let expected: BTreeSet<String> = [
        "_sqlx_migrations",
        "entities",
        "entity_revisions",
        "fts",
        "message_parts",
        "messages",
        "proposals",
        "run_log",
        "run_steps",
        "runs",
        "settings",
        "threads",
        "tool_calls",
    ]
    .into_iter()
    .map(String::from)
    .collect();

    assert!(
        actual.is_superset(&expected),
        "expected tables missing. actual = {:?}, expected superset of = {:?}",
        actual,
        expected
    );
}
