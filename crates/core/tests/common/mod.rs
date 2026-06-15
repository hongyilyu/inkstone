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

use assert_cmd::cargo::CommandCargoExt;
use futures_util::StreamExt;
use tempfile::TempDir;
use tokio_tungstenite::tungstenite::Message;

/// Core's default listening port. Tests bind ephemeral; this exists so
/// `ephemeral_port.rs` can name the value it must NOT be.
pub const DEFAULT_PORT: u16 = 8765;

/// The websocket transport every test threads through [`next_text`].
pub type Ws = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

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
    assert!(fixture.exists(), "fixture not found at {}", fixture.display());
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

impl Default for Workspace {
    fn default() -> Self {
        Self::new()
    }
}

/// Configures and spawns one Core process. Always binds ephemeral and runs with
/// `current_dir` = repo root (so Core's default relative worker command resolves).
pub struct CoreBuilder<'a> {
    ws: &'a Workspace,
    worker_cmd: Option<String>,
    envs: Vec<(OsString, OsString)>,
    listen_timeout: Duration,
}

impl<'a> CoreBuilder<'a> {
    fn new(ws: &'a Workspace) -> Self {
        Self {
            ws,
            worker_cmd: None,
            envs: Vec::new(),
            listen_timeout: DEFAULT_TIMEOUT,
        }
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
        let cli = repo_root().join("packages/worker/src/faux-worker.ts");
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

    /// Override the boot announce-poll budget (default 10s).
    pub fn listen_timeout(mut self, d: Duration) -> Self {
        self.listen_timeout = d;
        self
    }

    /// Spawn Core and block until it announces `INKSTONE_LISTENING`, or return
    /// the boot failure. Used by tests that assert Core *fails* to boot;
    /// everything else calls [`Self::spawn`].
    pub fn try_spawn(self) -> Result<CoreHandle, SpawnError> {
        let mut cmd = std::process::Command::cargo_bin("core").expect("core binary exists");
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
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        if let Some(ref worker_cmd) = self.worker_cmd {
            cmd.env("INKSTONE_WORKER_CMD", worker_cmd);
        }
        for (key, value) in &self.envs {
            cmd.env(key, value);
        }

        let mut child = cmd.spawn().map_err(SpawnError::Spawn)?;
        let stdout = child.stdout.take().expect("piped stdout");

        // Read Core's stdout on a dedicated thread that forwards each line over
        // a channel. This keeps `try_spawn` synchronous while making
        // `listen_timeout` enforceable even when Core stays alive but SILENT (a
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

        let deadline = Instant::now() + self.listen_timeout;
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

    /// The `ws://127.0.0.1:<port>/ws` URL.
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
