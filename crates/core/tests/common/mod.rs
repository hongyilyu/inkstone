//! Shared spawn/connect support for Core's black-box integration tests.
//!
//! Every test in `crates/core/tests/` drives the compiled `core` binary over a
//! loopback WebSocket (JSON-RPC, ADR-0014). This module is the single home for
//! the spawn → announce-poll → connect surface they all need: a per-test
//! [`Workspace`] (on-disk state that outlives Core), a [`CoreBuilder`] that
//! wires the worker/env, a reaped-on-drop [`CoreHandle`] (a running Core
//! process), and the [`Ws`] / [`next_text`] read helpers.
//!
//! NOTE: this is NOT the "Test Harness" in the `CONTEXT.md` / ADR-0019 sense —
//! that term is reserved for the Playwright `tests/e2e/` package that drives a
//! real browser. This is in-crate support for Core's Rust integration tests.
//!
//! Port strategy (ADR-0019, as-built): always ephemeral — `INKSTONE_PORT=0`,
//! then read the announced `INKSTONE_LISTENING <url>` from stdout. The former
//! fixed-port (`DEFAULT_PORT`) + `port_lock` strategy is gone.

#![allow(dead_code)] // each test binary links only the subset of this module it uses.

use std::ffi::{OsStr, OsString};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

use assert_cmd::cargo::CommandCargoExt;
use futures_util::StreamExt;
use tempfile::TempDir;
use tokio_tungstenite::tungstenite::Message;

/// Core's default listening port (when `INKSTONE_PORT` is unset). Tests bind
/// ephemeral (`0`) instead; this constant exists so the one test that proves
/// ephemeral resolution (`ephemeral_port.rs`) can name the value it must NOT be.
pub const DEFAULT_PORT: u16 = 8765;

/// The websocket transport type every test threads through [`next_text`].
pub type Ws = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

/// Default budget for the boot announce-poll and for [`next_text`]. Generous so
/// the slow real-interpreter / provider-helper / boot paths never flake; no
/// test asserts on this value — it is only a hang guard.
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

/// Build a `tsx <fixtures/file> [args..]` command line (absolute paths) for an
/// `INKSTONE_*_CMD` env var — a worker fixture or a Provider Helper stub. Core
/// whitespace-splits these commands, so the absolute paths must be space-free
/// (the repo path is).
pub fn fixture_cmd(file: &str, args: &[&str]) -> String {
    let mut cmd = format!("{} {}", tsx_bin().display(), fixture_path(file).display());
    for arg in args {
        // Core whitespace-splits the command, so an arg containing a space would
        // be parsed as two — guard future callers (all current args are single
        // tokens, and the repo path is space-free).
        debug_assert!(
            !arg.contains(char::is_whitespace),
            "fixture_cmd arg {arg:?} contains whitespace; Core would mis-split the command"
        );
        cmd.push(' ');
        cmd.push_str(arg);
    }
    cmd
}

/// A per-test Workspace (ADR-0019): the on-disk state Core opens. Owns the
/// tempdir, so it outlives the [`CoreHandle`] — a test can kill Core and then
/// read the DB, or respawn a fresh Core against the same DB (the reload flows).
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

    /// The tempdir root — join onto it for workflows / credentials / web / gate
    /// dirs the test creates and points Core at via [`CoreBuilder::env`].
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

/// Configures and spawns one Core process. Always binds ephemeral
/// (`INKSTONE_PORT=0`) and runs with `current_dir` = repo root (so Core's
/// default relative worker command resolves).
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

    /// Point `INKSTONE_WORKER_CMD` at the real generic interpreter
    /// (`packages/worker/src/cli.ts`) — the offline `faux` provider path, not a
    /// fixture worker.
    pub fn worker_interpreter(mut self) -> Self {
        let cli = repo_root().join("packages/worker/src/cli.ts");
        self.worker_cmd = Some(format!("{} {}", tsx_bin().display(), cli.display()));
        self
    }

    /// Set `INKSTONE_WORKER_CMD` to an explicit command (escape hatch).
    pub fn worker_cmd(mut self, cmd: impl Into<String>) -> Self {
        self.worker_cmd = Some(cmd.into());
        self
    }

    /// Pass an arbitrary env var through to Core (and, by inheritance, the
    /// Worker / Provider Helper it spawns) — `INKSTONE_FAUX_*`,
    /// `INKSTONE_FIXTURE_*`, `INKSTONE_WORKFLOWS_DIR`, `INKSTONE_CREDENTIALS_DIR`,
    /// `INKSTONE_WEB_DIR`, `INKSTONE_PROVIDER_*_CMD`, etc.
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
    /// the boot failure. Used directly by tests that assert Core *fails* to boot
    /// (e.g. `workflow_load.rs`); everything else calls [`Self::spawn`].
    pub fn try_spawn(self) -> Result<CoreHandle, SpawnError> {
        let mut cmd = std::process::Command::cargo_bin("core").expect("core binary exists");
        cmd.current_dir(repo_root())
            .env("INKSTONE_PORT", "0")
            .env("INKSTONE_DB_PATH", self.ws.db_path())
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
        // a channel. This keeps `try_spawn` synchronous (tests build their own
        // runtime afterward) while making `listen_timeout` enforceable even when
        // Core stays alive but SILENT: a blocking `read_line` on this thread
        // would never observe the deadline, so a boot deadlock would hang CI
        // indefinitely instead of failing fast. The thread runs until it reads
        // the announce line, hits EOF (Core exited), or the receiver goes away;
        // a `kill()` unblocks it via EOF, so it never outlives Core.
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
                    // The reader thread ended without announcing → Core closed
                    // stdout before listening (fail-fast boot).
                    let status = child.wait().ok();
                    return Err(SpawnError::ExitedBeforeListening(status));
                }
            }
        };
        // The reader thread keeps draining stdout until Core exits; dropping the
        // receiver makes its next send fail so it stops once Core is gone.
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
/// test never leaks Core; [`Self::kill`] does the same eagerly so a test can
/// stop Core, then read its DB or respawn against the same [`Workspace`].
pub struct CoreHandle {
    child: Option<Child>,
    http_url: String,
    ws_url: String,
}

impl CoreHandle {
    /// The `http://127.0.0.1:<port>` base URL (for `reqwest` GETs).
    pub fn http_url(&self) -> &str {
        &self.http_url
    }

    /// The `ws://127.0.0.1:<port>/ws` URL (for [`Self::connect`]).
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
