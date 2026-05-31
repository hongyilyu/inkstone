use std::io::{BufRead, BufReader};
use std::process::Stdio;
use std::time::{Duration, Instant};

use assert_cmd::cargo::CommandCargoExt;
use tempfile::TempDir;

#[test]
fn core_announces_listening_url_and_serves_root() {
    let tmp = TempDir::new().expect("tempdir");
    let db_path = tmp.path().join("db.sqlite");

    let mut child = std::process::Command::cargo_bin("core")
        .expect("core binary exists")
        .env("INKSTONE_DB_PATH", &db_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("core spawns");

    let stdout = child.stdout.take().expect("piped stdout");
    let mut reader = BufReader::new(stdout);

    // Read lines with a 5s budget; bail loudly if Core never announces.
    let deadline = Instant::now() + Duration::from_secs(5);
    let url = loop {
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
        if let Some(rest) = trimmed.strip_prefix("INKSTONE_LISTENING ") {
            break rest.to_string();
        }
    };

    let response = reqwest::blocking::get(&url).expect("GET / succeeds");
    let status = response.status();
    let body = response.text().expect("body decodes");

    let _ = child.kill();
    let _ = child.wait();

    assert_eq!(status.as_u16(), 200, "GET / returns 200");
    assert_eq!(body, "Inkstone Core", "GET / body matches");
}
