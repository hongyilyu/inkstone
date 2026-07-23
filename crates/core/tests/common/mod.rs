//! Shared spawn/connect support for Core's black-box integration tests
//! (ADR-0014): a per-test [`Workspace`], a [`CoreBuilder`] that wires
//! worker/env, a reaped-on-drop [`CoreHandle`], and the [`Ws`] / [`next_text`]
//! read helpers. Not the Playwright "Test Harness" (ADR-0019) — this is
//! in-crate Rust support.
//!
//! Port strategy: always ephemeral (`INKSTONE_PORT=0`), then read the announced
//! `INKSTONE_LISTENING <url>` from stdout.

#![allow(dead_code)] // each test binary links only a subset of this module.

use std::ffi::{OsStr, OsString};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Executor, Row, SqlitePool};
use tempfile::TempDir;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

/// Core's default listening port. Tests bind ephemeral; this exists so
/// `ephemeral_port.rs` can name the value it must NOT be.
pub const DEFAULT_PORT: u16 = 8765;

/// The websocket transport every test threads through [`next_text`].
pub type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Budget for the boot announce-poll and [`next_text`]. Generous so slow boot
/// paths never flake; only a hang guard, never asserted on.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);

/// Repo root, resolved from this crate's manifest dir (`<repo>/crates/core`).
pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("repo root resolves from <repo>/crates/core")
        .to_path_buf()
}

/// Absolute path to the Worker's `tsx` binary, panicking if `pnpm install`
/// has not been run.
pub fn tsx_bin() -> PathBuf {
    let p = repo_root().join("packages/worker/node_modules/.bin/tsx");
    assert!(
        p.exists(),
        "worker tsx not installed at {} — run `pnpm install` at repo root",
        p.display()
    );
    p
}

/// Absolute path to a fixture under `crates/core/tests/fixtures/`.
pub fn fixture_path(file: &str) -> PathBuf {
    let fixture = repo_root().join("crates/core/tests/fixtures").join(file);
    assert!(
        fixture.exists(),
        "fixture not found at {}",
        fixture.display()
    );
    fixture
}

/// Build a `tsx <fixtures/file> [args..]` command line for an `INKSTONE_*_CMD`
/// env var. Core whitespace-splits the command, so paths must be space-free.
pub fn fixture_cmd(file: &str, args: &[&str]) -> String {
    let mut cmd = format!("{} {}", tsx_bin().display(), fixture_path(file).display());
    for arg in args {
        // Core whitespace-splits the command, so an arg with a space would be
        // mis-parsed as two — guard future callers.
        debug_assert!(
            !arg.contains(char::is_whitespace),
            "fixture_cmd arg {arg:?} contains whitespace; Core would mis-split the command"
        );
        cmd.push(' ');
        cmd.push_str(arg);
    }
    cmd
}

/// Read every non-empty line of every file under `dir` — the Diagnostic Log
/// trail (ADR-0038). The daily appender suffixes the file with a date, so the
/// exact name is not assumed; logging tests read after `core.kill()` (the
/// blocking appender has each event on disk by then).
pub fn read_jsonl_lines(dir: &Path) -> Vec<String> {
    let mut lines = Vec::new();
    let entries =
        std::fs::read_dir(dir).unwrap_or_else(|e| panic!("read_dir {}: {e}", dir.display()));
    for entry in entries {
        let path = entry.expect("dir entry").path();
        if path.is_file() {
            let body = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
            lines.extend(body.lines().filter(|l| !l.is_empty()).map(str::to_owned));
        }
    }
    lines
}

/// A per-test Workspace (ADR-0019): the on-disk state Core opens. Owns the
/// tempdir so it outlives the [`CoreHandle`] — a test can kill Core, then read
/// the DB or respawn against the same DB.
pub struct Workspace {
    tmp: TempDir,
    db_path: PathBuf,
}

impl Workspace {
    /// Fresh `inkstone-test-*` tempdir with `db.sqlite` as the DB path.
    pub fn new() -> Self {
        let tmp = tempfile::Builder::new()
            .prefix("inkstone-test-")
            .tempdir()
            .expect("create tempdir");
        let db_path = tmp.path().join("db.sqlite");
        Self { tmp, db_path }
    }

    /// The tempdir root — join onto it for dirs the test points Core at via
    /// [`CoreBuilder::env`].
    pub fn path(&self) -> &Path {
        self.tmp.path()
    }

    /// `INKSTONE_DB_PATH` for this Workspace; valid after Core is killed.
    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    /// Start configuring a Core process against this Workspace.
    pub fn core(&self) -> CoreBuilder<'_> {
        CoreBuilder::new(self)
    }
}

/// Configures and spawns one Core process. Always binds ephemeral and runs with
/// `current_dir` = repo root (so Core's default relative worker command resolves).
pub struct CoreBuilder<'a> {
    ws: &'a Workspace,
    worker_cmd: Option<String>,
    envs: Vec<(OsString, OsString)>,
    seed_provider_credentials: bool,
}

impl<'a> CoreBuilder<'a> {
    fn new(ws: &'a Workspace) -> Self {
        Self {
            ws,
            worker_cmd: None,
            envs: Vec::new(),
            // Default: seed connected credentials for every provider a Run can
            // route to so the run-creation provider gate (ADR-0062) passes. A test
            // that asserts the DISCONNECTED state
            // (provider_status/configure/test/login/refresh) opts out via
            // `no_seeded_credential()` and manages its own credentials dir.
            seed_provider_credentials: true,
        }
    }

    /// Opt OUT of the default connected-provider credential (ADR-0062). Tests that
    /// exercise the disconnected state or manage `INKSTONE_CREDENTIALS_DIR`
    /// themselves call this so the harness does not seed a credential underneath
    /// them.
    pub fn no_seeded_credential(mut self) -> Self {
        self.seed_provider_credentials = false;
        self
    }

    /// Point `INKSTONE_WORKER_CMD` at a worker fixture in `tests/fixtures/`.
    pub fn worker_fixture(mut self, file: &str) -> Self {
        self.worker_cmd = Some(fixture_cmd(file, &[]));
        self
    }

    /// Point `INKSTONE_WORKER_CMD` at the test-only faux interpreter entry — the
    /// offline `faux` provider path that drives the *real* interpreter, not the
    /// production `cli.ts` nor a dumb fixture worker.
    pub fn worker_faux(mut self) -> Self {
        let cli = repo_root().join("packages/worker/src/faux/faux-worker.ts");
        self.worker_cmd = Some(format!("{} {}", tsx_bin().display(), cli.display()));
        self
    }

    /// Set `INKSTONE_WORKER_CMD` to an explicit command (escape hatch).
    pub fn worker_cmd(mut self, cmd: impl Into<String>) -> Self {
        self.worker_cmd = Some(cmd.into());
        self
    }

    /// Pass an arbitrary env var through to Core (and, by inheritance, the
    /// Worker / Provider Helper it spawns).
    pub fn env(mut self, key: impl AsRef<OsStr>, value: impl AsRef<OsStr>) -> Self {
        self.envs
            .push((key.as_ref().to_owned(), value.as_ref().to_owned()));
        self
    }

    /// Spawn Core and block until it announces `INKSTONE_LISTENING`, or return
    /// the boot failure. Used by tests that assert Core *fails* to boot;
    /// everything else calls [`Self::spawn`].
    pub fn try_spawn(self) -> Result<CoreHandle, SpawnError> {
        let mut cmd = std::process::Command::new(env!("CARGO_BIN_EXE_core"));
        cmd.current_dir(repo_root())
            .env("INKSTONE_PORT", "0")
            .env("INKSTONE_DB_PATH", self.ws.db_path())
            // Default the Diagnostic Log dir (ADR-0038) into the Workspace
            // tempdir so tests that don't set it stay hermetic — otherwise
            // `logging::init` falls back to the real OS data dir and writes
            // core.jsonl into the developer's/CI home. Per-test `.env(...)`
            // overrides still win: the `self.envs` loop below runs after this,
            // and last `cmd.env` for a key wins. `logging::init` creates the
            // dir itself (`create_dir_all`), so it need not pre-exist.
            .env("INKSTONE_LOG_DIR", self.ws.path().join("logs"))
            // Default the skills dir (ADR-0036) into the Workspace tempdir so a
            // test that doesn't set it stays hermetic — otherwise boot's
            // `skills::seed_if_absent` writes the bundled skills into the
            // developer's/CI real OS data dir. Per-test `.env(...)` still wins
            // (the `self.envs` loop runs after this; last `cmd.env` for a key
            // wins). The dir is absent in a fresh tempdir, so boot seeds it —
            // making the bundled skills the default fixture for any test that
            // boots Core without overriding.
            .env("INKSTONE_SKILLS_DIR", self.ws.path().join("skills"))
            // Default the media root (ADR-0058) into the Workspace tempdir so a
            // test that doesn't set it stays hermetic — otherwise `media/upload`
            // writes uploaded bytes into the developer's/CI real OS data dir.
            // Per-test `.env(...)` overrides still win (the `self.envs` loop
            // below runs after this; last `cmd.env` for a key wins).
            // `insert_media` creates the dir itself, so it need not pre-exist.
            .env("INKSTONE_MEDIA_DIR", self.ws.path().join("media"))
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        if let Some(ref worker_cmd) = self.worker_cmd {
            cmd.env("INKSTONE_WORKER_CMD", worker_cmd);
        }
        for (key, value) in &self.envs {
            cmd.env(key, value);
        }

        // Seed connected credentials so the run-creation provider gate (ADR-0062)
        // passes for the many tests that post a message / create a thread. Skipped
        // when a test opted out (`no_seeded_credential`). Written into the
        // credentials dir Core will resolve: the per-test `INKSTONE_CREDENTIALS_DIR`
        // if the test set one, else the default `<db parent>/credentials`. Both the
        // production default provider (`openai-codex`) AND the offline test provider
        // (`faux`, used by custom test workflows) get a credential so either
        // resolved provider is "connected". Mirrors the fixture shape
        // provider_status.rs writes (kind:"oauth", far-future expiry).
        if self.seed_provider_credentials {
            let creds_dir = self
                .envs
                .iter()
                .find(|(k, _)| k == "INKSTONE_CREDENTIALS_DIR")
                .map(|(_, v)| PathBuf::from(v))
                .unwrap_or_else(|| {
                    self.ws
                        .db_path()
                        .parent()
                        .map(|p| p.join("credentials"))
                        .expect("db path has a parent")
                });
            std::fs::create_dir_all(&creds_dir).expect("create seeded credentials dir");
            // Seed the credential SHAPE each provider actually uses (ADR-0062), not a
            // blanket oauth blob: `openai-codex`/`faux` are OAuth, `openrouter` is a
            // static api_key. is_connected only checks file presence today, but
            // seeding the true shape keeps the fixture honest against any future
            // shape-sensitive path. Every provider a resolved Run can route to gets one.
            const OAUTH: &str = r#"{"kind":"oauth","access":"tok","refresh":"ref","expires":9999999999999,"account_id":"acct"}"#;
            const API_KEY: &str = r#"{"kind":"api_key","key":"sk-test"}"#;
            for (provider, cred) in [
                ("openai-codex", OAUTH),
                ("openrouter", API_KEY),
                ("faux", OAUTH),
            ] {
                std::fs::write(creds_dir.join(format!("{provider}.json")), cred)
                    .expect("write seeded credential");
            }
        }

        let mut child = cmd.spawn().map_err(SpawnError::Spawn)?;
        let stdout = child.stdout.take().expect("piped stdout");

        // Read Core's stdout on a dedicated thread that forwards each line over
        // a channel. This keeps `try_spawn` synchronous while making the listen
        // deadline enforceable even when Core stays alive but SILENT (a
        // blocking `read_line` would never observe the deadline, hanging CI).
        // The thread ends on the announce line, EOF, or a dropped receiver, so
        // it never outlives Core.
        let (tx, rx) = std::sync::mpsc::channel::<std::io::Result<String>>();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => break, // EOF: Core closed stdout.
                    Ok(_) => {
                        if tx.send(Ok(line)).is_err() {
                            break; // receiver dropped — URL found (or spawn aborted).
                        }
                    }
                    Err(e) => {
                        let _ = tx.send(Err(e));
                        break;
                    }
                }
            }
        });

        let deadline = Instant::now() + DEFAULT_TIMEOUT;
        let http_url = loop {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                let _ = child.kill();
                let _ = child.wait();
                return Err(SpawnError::Timeout);
            };
            match rx.recv_timeout(remaining) {
                Ok(Ok(line)) => {
                    let trimmed = line.trim_end_matches('\n').trim_end_matches('\r');
                    if let Some(rest) = trimmed.strip_prefix("INKSTONE_LISTENING ") {
                        break rest.to_string();
                    }
                    // Any other line (Core diagnostics): keep waiting.
                }
                Ok(Err(e)) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(SpawnError::Io(e));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(SpawnError::Timeout);
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    // Reader ended without announcing → Core closed stdout
                    // before listening (fail-fast boot).
                    let status = child.wait().ok();
                    return Err(SpawnError::ExitedBeforeListening(status));
                }
            }
        };
        // Drop the receiver so the reader's next send fails and it stops.
        drop(rx);

        let ws_url = http_url
            .strip_prefix("http://")
            .map(|host| format!("ws://{host}/ws"))
            .ok_or_else(|| SpawnError::BadUrl(http_url.clone()))?;

        Ok(CoreHandle {
            child: Some(child),
            http_url,
            ws_url,
        })
    }

    /// Spawn Core, panicking if it does not announce within the budget.
    pub fn spawn(self) -> CoreHandle {
        self.try_spawn()
            .expect("core spawns and announces INKSTONE_LISTENING")
    }
}

/// Why a [`CoreBuilder::try_spawn`] failed to reach `INKSTONE_LISTENING`.
#[derive(Debug)]
pub enum SpawnError {
    /// `Command::spawn` itself failed (binary missing, etc.).
    Spawn(std::io::Error),
    /// Reading Core's stdout failed.
    Io(std::io::Error),
    /// Core stayed up but never announced within the budget.
    Timeout,
    /// Core exited (closed stdout) before announcing — the fail-fast boot path.
    ExitedBeforeListening(Option<std::process::ExitStatus>),
    /// The announced URL was not the expected `http://host:port` shape.
    BadUrl(String),
}

/// A running Core process. SIGKILLs and reaps the child on drop so a panicking
/// test never leaks Core; [`Self::kill`] does the same eagerly.
pub struct CoreHandle {
    child: Option<Child>,
    http_url: String,
    ws_url: String,
}

impl CoreHandle {
    /// The `http://127.0.0.1:<port>` base URL.
    pub fn http_url(&self) -> &str {
        &self.http_url
    }

    /// The `ws://127.0.0.1:<port>/ws` endpoint URL [`Self::connect`] uses.
    pub fn ws_url(&self) -> &str {
        &self.ws_url
    }

    /// The resolved listening port parsed from the announced URL.
    pub fn port(&self) -> u16 {
        self.http_url
            .rsplit(':')
            .next()
            .and_then(|p| p.parse().ok())
            .unwrap_or_else(|| panic!("listening URL has a numeric port — got {}", self.http_url))
    }

    /// SIGKILL and reap Core now (idempotent; also runs on drop).
    pub fn kill(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// Open a WebSocket to Core's `/ws` endpoint.
    pub async fn connect(&self) -> Ws {
        let (ws, _resp) = tokio_tungstenite::connect_async(&self.ws_url)
            .await
            .expect("ws handshake succeeds");
        ws
    }
}

impl Drop for CoreHandle {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Read the next text frame, bounded by [`DEFAULT_TIMEOUT`] so a hang fails fast.
pub async fn next_text(ws: &mut Ws) -> String {
    let frame = tokio::time::timeout(DEFAULT_TIMEOUT, ws.next())
        .await
        .expect("frame within timeout")
        .expect("frame present")
        .expect("frame ok");
    match frame {
        Message::Text(t) => t.to_string(),
        other => panic!("expected text frame, got {other:?}"),
    }
}

/// Read the next text frame within `timeout`, returning `None` if none arrives
/// (vs. [`next_text`], which panics on timeout). For assertions that a frame is
/// ABSENT within a bounded window — the negative half of a push test.
pub async fn try_next_text(ws: &mut Ws, timeout: Duration) -> Option<String> {
    match tokio::time::timeout(timeout, ws.next()).await {
        Ok(Some(Ok(Message::Text(t)))) => Some(t.to_string()),
        Ok(Some(Ok(other))) => panic!("expected text frame, got {other:?}"),
        // Stream ended / errored — treat as "no text frame arrived".
        Ok(_) => None,
        // Timed out — the bounded window elapsed with no frame.
        Err(_) => None,
    }
}

/// The current-thread Tokio runtime every test drives via `block_on`. A shared
/// fn (not `#[tokio::test]`) because tests kill Core and call
/// `reqwest::blocking` between `block_on` sections, so the explicit runtime
/// handle must stay.
pub fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds")
}

/// Open a fresh socket, send a single request, return the parsed response.
pub async fn rpc(
    core: &CoreHandle,
    id: u64,
    method: &str,
    params: serde_json::Value,
) -> serde_json::Value {
    let mut ws = core.connect().await;
    let req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    ws.send(Message::Text(req.to_string().into()))
        .await
        .expect("send request frame");
    let body = next_text(&mut ws).await;
    ws.close(None).await.ok();
    serde_json::from_str(&body).unwrap_or_else(|e| panic!("response is JSON: {e} — body: {body}"))
}

/// Send one text frame.
pub async fn send(ws: &mut Ws, frame: String) {
    ws.send(Message::Text(frame.into()))
        .await
        .expect("send frame");
}

/// Read frames until one whose `id` matches `want_id`, skipping interleaved
/// `run/event` notifications.
pub async fn read_response_with_id(ws: &mut Ws, want_id: i64) -> serde_json::Value {
    loop {
        let body = next_text(ws).await;
        let v: serde_json::Value = serde_json::from_str(&body)
            .unwrap_or_else(|e| panic!("frame is JSON: {e} — body: {body}"));
        if v["id"] == serde_json::json!(want_id) {
            return v;
        }
    }
}

/// Poll `run/subscribe` until the Run reports `want`; panics after `timeout`
/// (a hang guard, never asserted on).
pub async fn await_status(core: &CoreHandle, run_id: &str, want: &str, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        if Instant::now() > deadline {
            panic!("timed out waiting for run to reach {want}");
        }
        let resp = rpc(
            core,
            2,
            "run/subscribe",
            serde_json::json!({ "run_id": run_id }),
        )
        .await;
        if resp["result"]["status"].as_str() == Some(want) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

/// Poll run/subscribe until the Run parks; panics on timeout.
pub async fn await_parked(core: &CoreHandle, run_id: &str) {
    await_status(core, run_id, "parked", Duration::from_secs(10)).await;
}

/// Poll run/subscribe until the Run reaches `completed`; panics on timeout.
pub async fn await_completed(core: &CoreHandle, run_id: &str) {
    await_status(core, run_id, "completed", Duration::from_secs(15)).await;
}

/// `thread/create` with `prompt`, then poll run/subscribe until the Run parks.
/// Returns `(run_id, thread_id)`.
pub async fn create_and_park(core: &CoreHandle, prompt: &str) -> (String, String) {
    let resp = rpc(
        core,
        1,
        "thread/create",
        serde_json::json!({ "prompt": prompt }),
    )
    .await;
    let run_id = resp["result"]["run_id"]
        .as_str()
        .unwrap_or_else(|| panic!("result.run_id is a string — body: {resp}"))
        .to_string();
    let thread_id = resp["result"]["thread_id"]
        .as_str()
        .unwrap_or_else(|| panic!("result.thread_id is a string — body: {resp}"))
        .to_string();
    await_parked(core, &run_id).await;
    (run_id, thread_id)
}

/// Extract `result.proposal_id` from a `proposal/get` response.
pub fn proposal_id_of(resp: &serde_json::Value) -> String {
    resp["result"]["proposal_id"]
        .as_str()
        .unwrap_or_else(|| panic!("proposal_id is a string — body: {resp}"))
        .to_string()
}

/// Read a Run's pending proposal_id via `proposal/get`.
pub async fn proposal_id_for(core: &CoreHandle, run_id: &str) -> String {
    let resp = rpc(
        core,
        3,
        "proposal/get",
        serde_json::json!({ "run_id": run_id }),
    )
    .await;
    proposal_id_of(&resp)
}

/// `run/post_message` on an existing thread, poll until the Run parks, and
/// return `(run_id, proposal/get response)`. When `expected_kind` is set,
/// asserts the parked Proposal's mutation_kind.
pub async fn park_proposal(
    core: &CoreHandle,
    thread_id: Uuid,
    prompt: &str,
    expected_kind: Option<&str>,
) -> (String, serde_json::Value) {
    let resp = rpc(
        core,
        1,
        "run/post_message",
        serde_json::json!({ "thread_id": thread_id, "prompt": prompt }),
    )
    .await;
    let run_id = resp["result"]["run_id"]
        .as_str()
        .unwrap_or_else(|| panic!("result.run_id is a string — body: {resp}"))
        .to_string();
    await_parked(core, &run_id).await;

    let proposal = rpc(
        core,
        3,
        "proposal/get",
        serde_json::json!({ "run_id": run_id }),
    )
    .await;
    if let Some(kind) = expected_kind {
        assert_eq!(
            proposal["result"]["mutation_kind"].as_str(),
            Some(kind),
            "parked Proposal mutation_kind — body: {proposal}"
        );
    }
    (run_id, proposal)
}

/// `proposal/decide{accept}` under `key`, returning the response.
pub async fn decide_accept(core: &CoreHandle, proposal_id: &str, key: &str) -> serde_json::Value {
    rpc(
        core,
        4,
        "proposal/decide",
        serde_json::json!({
            "proposal_id": proposal_id,
            "decision": "accept",
            "decision_idempotency_key": key,
        }),
    )
    .await
}

/// Open a migrated read-write pool against the Workspace DB so a test can seed
/// rows directly before Core spawns.
pub async fn migrated_pool(workspace: &Workspace) -> SqlitePool {
    let options = SqliteConnectOptions::new()
        .filename(workspace.db_path())
        .create_if_missing(true)
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

/// Open a read-only pool against the Workspace DB (valid after Core is killed).
pub async fn open_readonly_pool(workspace: &Workspace) -> SqlitePool {
    let url = format!("sqlite://{}?mode=ro", workspace.db_path().display());
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .expect("connect to migrated DB")
}

pub async fn seed_thread(pool: &SqlitePool, thread_id: Uuid, title: &str, now_ms: i64) {
    sqlx::query(
        "INSERT INTO threads (id, title, created_at, last_activity_at) VALUES (?1, ?2, ?3, ?3)",
    )
    .bind(thread_id.to_string())
    .bind(title)
    .bind(now_ms)
    .execute(pool)
    .await
    .expect("insert thread");
}

/// [`seed_accepted_journal_entry_full`] with a fresh entity id, no `ended_at`,
/// and a `user`-authored source Message.
pub async fn seed_accepted_journal_entry(
    pool: &SqlitePool,
    thread_id: Uuid,
    occurred_at: &str,
    body_text: &str,
    created_at: i64,
) -> Uuid {
    seed_accepted_journal_entry_full(
        pool,
        thread_id,
        Uuid::now_v7(),
        occurred_at,
        None,
        body_text,
        created_at,
        "user",
    )
    .await
}

/// Seed the full row set of a completed Run whose accepted
/// `create_journal_entry` Proposal produced `entity_id`: run, source +
/// assistant Messages, tool_call, proposal, entity, revision, and entity
/// source. `source_role` is the source Message's role (`"user"` normally;
/// `"assistant"` for the non-user-created_from rejection tests).
pub async fn seed_accepted_journal_entry_full(
    pool: &SqlitePool,
    thread_id: Uuid,
    entity_id: Uuid,
    occurred_at: &str,
    ended_at: Option<&str>,
    body_text: &str,
    created_at: i64,
    source_role: &str,
) -> Uuid {
    let run_id = Uuid::now_v7();
    let user_message_id = Uuid::now_v7();
    let assistant_message_id = Uuid::now_v7();
    let tool_call_id = format!("tc_{entity_id}");
    let proposal_id = Uuid::now_v7().to_string();
    let source_id = Uuid::now_v7().to_string();
    let mut payload = serde_json::json!({
        "occurred_at": occurred_at,
        "body": [{ "type": "text", "text": body_text }]
    });
    if let Some(ended_at) = ended_at {
        payload["ended_at"] = serde_json::json!(ended_at);
    }
    let payload_str = payload.to_string();

    let mut tx = pool.begin().await.expect("begin seed tx");
    tx.execute(sqlx::query(
        "INSERT INTO runs \
         (id, thread_id, workflow_name, workflow_version, provider, model, thinking_level, user_message_id, status, started_at, ended_at, terminal_reason) \
         VALUES (?1, ?2, 'default', '1.0.0', 'faux', 'fake-model', 'off', ?3, 'completed', ?4, ?4, 'completed')",
    )
    .bind(run_id.to_string())
    .bind(thread_id.to_string())
    .bind(user_message_id.to_string())
    .bind(created_at))
    .await
    .expect("insert run");
    tx.execute(
        sqlx::query(
            "INSERT INTO messages (id, thread_id, run_id, role, status, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, 'completed', ?5, ?5)",
        )
        .bind(user_message_id.to_string())
        .bind(thread_id.to_string())
        .bind(run_id.to_string())
        .bind(source_role)
        .bind(created_at),
    )
    .await
    .expect("insert source message");
    tx.execute(
        sqlx::query(
            "INSERT INTO messages (id, thread_id, run_id, role, status, created_at, updated_at) \
             VALUES (?1, ?2, ?3, 'assistant', 'completed', ?4, ?4)",
        )
        .bind(assistant_message_id.to_string())
        .bind(thread_id.to_string())
        .bind(run_id.to_string())
        .bind(created_at),
    )
    .await
    .expect("insert assistant message");
    tx.execute(
        sqlx::query(
            "INSERT INTO message_parts (message_id, seq, type, text) VALUES (?1, 0, 'text', ?2)",
        )
        .bind(user_message_id.to_string())
        .bind(body_text),
    )
    .await
    .expect("insert source text");
    tx.execute(
        sqlx::query(
            "INSERT INTO message_parts (message_id, seq, type, text) VALUES (?1, 0, 'text', '')",
        )
        .bind(assistant_message_id.to_string()),
    )
    .await
    .expect("insert assistant text");
    tx.execute(sqlx::query(
        "INSERT INTO tool_calls (id, run_id, name, request_payload, status, result_payload, requested_at, resolved_at) \
         VALUES (?1, ?2, 'propose_workspace_mutation', ?3, 'completed', '{}', ?4, ?4)",
    )
    .bind(&tool_call_id)
    .bind(run_id.to_string())
    .bind(serde_json::json!({ "mutation_kind": "create_journal_entry", "payload": payload }).to_string())
    .bind(created_at))
    .await
    .expect("insert tool call");
    tx.execute(sqlx::query(
        "INSERT INTO proposals (id, tool_call_id, mutation_kind, status, decided_by, decided_at, applied_at) \
         VALUES (?1, ?2, 'create_journal_entry', 'accepted', 'user', ?3, ?3)",
    )
    .bind(&proposal_id)
    .bind(&tool_call_id)
    .bind(created_at))
    .await
    .expect("insert proposal");
    tx.execute(sqlx::query(
        "INSERT INTO entities (id, type, schema_version, data, created_by, created_via_proposal_id, created_at, updated_at) \
         VALUES (?1, 'journal_entry', 1, ?2, 'proposal', ?3, ?4, ?4)",
    )
    .bind(entity_id.to_string())
    .bind(&payload_str)
    .bind(&proposal_id)
    .bind(created_at))
    .await
    .expect("insert entity");
    tx.execute(
        sqlx::query(
            "INSERT INTO entity_revisions (entity_id, seq, data, proposal_id, created_at) \
             VALUES (?1, 1, ?2, ?3, ?4)",
        )
        .bind(entity_id.to_string())
        .bind(&payload_str)
        .bind(&proposal_id)
        .bind(created_at),
    )
    .await
    .expect("insert entity revision");
    tx.execute(
        sqlx::query(
            "INSERT INTO entity_sources (id, entity_id, source_message_id, relation, created_at) \
             VALUES (?1, ?2, ?3, 'created_from', ?4)",
        )
        .bind(&source_id)
        .bind(entity_id.to_string())
        .bind(user_message_id.to_string())
        .bind(created_at),
    )
    .await
    .expect("insert entity source");

    tx.commit().await.expect("commit seed tx");
    entity_id
}

/// The current `entities.data` JSON for `entity_id`.
pub async fn entity_data(pool: &SqlitePool, entity_id: &str) -> serde_json::Value {
    let data: String = sqlx::query_scalar("SELECT data FROM entities WHERE id = ?1")
        .bind(entity_id)
        .fetch_one(pool)
        .await
        .expect("entity row exists");
    serde_json::from_str(&data).expect("entity data is JSON")
}

/// The highest `entity_revisions.seq` for `entity_id`.
pub async fn max_revision_seq(pool: &SqlitePool, entity_id: &str) -> i64 {
    sqlx::query_scalar("SELECT MAX(seq) FROM entity_revisions WHERE entity_id = ?1")
        .bind(entity_id)
        .fetch_one(pool)
        .await
        .expect("max revision seq")
}

/// How many `updated_from` Entity Sources link `entity_id` to `run_id`'s user
/// Message.
pub async fn updated_from_count_for_run(pool: &SqlitePool, entity_id: &str, run_id: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM entity_sources es \
         JOIN runs r ON r.user_message_id = es.source_message_id \
         WHERE es.entity_id = ?1 AND r.id = ?2 AND es.relation = 'updated_from'",
    )
    .bind(entity_id)
    .bind(run_id)
    .fetch_one(pool)
    .await
    .expect("count updated_from sources")
}

/// The `(proposal.status, tool_call.status)` pair for `run_id`'s proposal.
pub async fn proposal_and_tool_status_for_run(pool: &SqlitePool, run_id: &str) -> (String, String) {
    let row = sqlx::query(
        "SELECT p.status, tc.status AS tool_status \
         FROM proposals p JOIN tool_calls tc ON tc.id = p.tool_call_id \
         WHERE tc.run_id = ?1",
    )
    .bind(run_id)
    .fetch_one(pool)
    .await
    .expect("proposal row exists");
    (row.get("status"), row.get("tool_status"))
}
