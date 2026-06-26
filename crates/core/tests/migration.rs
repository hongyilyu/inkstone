use std::collections::BTreeSet;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};

mod common;
use common::Workspace;

async fn migrated_pool() -> SqlitePool {
    let options = SqliteConnectOptions::new()
        .filename(":memory:")
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("open sqlite pool");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("run migrations");
    pool
}

async fn insert_entity(pool: &SqlitePool, id: &str, entity_type: &str) {
    sqlx::query(
        "INSERT INTO entities \
         (id, type, schema_version, data, created_by, created_at, updated_at) \
         VALUES (?1, ?2, 1, '{}', 'user', 1000, 1000)",
    )
    .bind(id)
    .bind(entity_type)
    .execute(pool)
    .await
    .expect("insert entity");
}

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

    let (actual, entity_ref_indexes): (BTreeSet<String>, BTreeSet<String>) = rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("connect to migrated DB");
        let rows = sqlx::query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .fetch_all(&pool)
            .await
            .expect("read sqlite_master");
        let tables = rows
            .into_iter()
            .map(|r| r.get::<String, _>("name"))
            .collect();
        let rows = sqlx::query(
            "SELECT name FROM sqlite_master \
             WHERE type = 'index' AND tbl_name = 'entity_refs' \
             ORDER BY name",
        )
        .fetch_all(&pool)
        .await
        .expect("read entity_refs indexes");
        let indexes = rows
            .into_iter()
            .map(|r| r.get::<String, _>("name"))
            .collect();
        (tables, indexes)
    });

    let expected: BTreeSet<String> = [
        "_sqlx_migrations",
        "entities",
        "entity_refs",
        "entity_revisions",
        "entity_sources",
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
    assert!(
        entity_ref_indexes.contains("idx_entity_refs_target_entity"),
        "entity_refs target lookup index missing. actual = {:?}",
        entity_ref_indexes
    );
}

#[tokio::test]
async fn entity_refs_cascade_when_source_or_target_entity_is_deleted() {
    let pool = migrated_pool().await;

    insert_entity(&pool, "entry-1", "journal_entry").await;
    insert_entity(&pool, "person-1", "person").await;
    sqlx::query(
        "INSERT INTO entity_refs \
         (id, source_entity_id, target_entity_id, label_snapshot, created_at) \
         VALUES ('ref-1', 'entry-1', 'person-1', 'Alice', 1000)",
    )
    .execute(&pool)
    .await
    .expect("insert entity ref");

    sqlx::query("DELETE FROM entities WHERE id = 'entry-1'")
        .execute(&pool)
        .await
        .expect("delete source entity");
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM entity_refs")
        .fetch_one(&pool)
        .await
        .expect("count refs after source delete");
    assert_eq!(count, 0, "deleting the source entity cascades entity_refs");

    insert_entity(&pool, "entry-1", "journal_entry").await;
    sqlx::query(
        "INSERT INTO entity_refs \
         (id, source_entity_id, target_entity_id, label_snapshot, created_at) \
         VALUES ('ref-2', 'entry-1', 'person-1', 'Alice', 1000)",
    )
    .execute(&pool)
    .await
    .expect("insert second entity ref");

    sqlx::query("DELETE FROM entities WHERE id = 'person-1'")
        .execute(&pool)
        .await
        .expect("delete target entity");
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM entity_refs")
        .fetch_one(&pool)
        .await
        .expect("count refs after target delete");
    assert_eq!(count, 0, "deleting the target entity cascades entity_refs");
}

#[tokio::test]
async fn entity_refs_reject_duplicate_source_target_pair() {
    let pool = migrated_pool().await;

    insert_entity(&pool, "entry-1", "journal_entry").await;
    insert_entity(&pool, "person-1", "person").await;
    sqlx::query(
        "INSERT INTO entity_refs \
         (id, source_entity_id, target_entity_id, label_snapshot, created_at) \
         VALUES ('ref-1', 'entry-1', 'person-1', 'Alice', 1000)",
    )
    .execute(&pool)
    .await
    .expect("insert entity ref");

    sqlx::query(
        "INSERT INTO entity_refs \
         (id, source_entity_id, target_entity_id, label_snapshot, created_at) \
         VALUES ('ref-2', 'entry-1', 'person-1', 'Alice again', 1001)",
    )
    .execute(&pool)
    .await
    .expect_err("duplicate source/target entity refs are rejected");
}
