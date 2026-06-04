use std::collections::BTreeSet;
use std::io::{BufRead, BufReader};
use std::process::Stdio;
use std::time::{Duration, Instant};

use assert_cmd::cargo::CommandCargoExt;
use sqlx::Row;
use sqlx::sqlite::SqlitePoolOptions;
use tempfile::TempDir;

#[test]
fn migration_creates_all_tables() {
    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");

    let mut child = std::process::Command::cargo_bin("core")
        .expect("core binary exists")
        .env("INKSTONE_DB_PATH", &db_path)
        .env("INKSTONE_PORT", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("core spawns");

    let stdout = child.stdout.take().expect("piped stdout");
    let mut reader = BufReader::new(stdout);

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("timed out waiting for INKSTONE_LISTENING line");
        }
        let mut line = String::new();
        let read = reader.read_line(&mut line).expect("read stdout");
        if read == 0 {
            let _ = child.kill();
            let _ = child.wait();
            panic!("core stdout closed before announcing INKSTONE_LISTENING");
        }
        let trimmed = line.trim_end_matches('\n').trim_end_matches('\r');
        if trimmed.starts_with("INKSTONE_LISTENING ") {
            break;
        }
    }

    let _ = child.kill();
    let _ = child.wait();

    assert!(
        db_path.exists(),
        "Core should have created the DB file at {}",
        db_path.display()
    );

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let actual: BTreeSet<String> = rt.block_on(async {
        let url = format!("sqlite://{}?mode=ro", db_path.display());
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
        "run_events",
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
