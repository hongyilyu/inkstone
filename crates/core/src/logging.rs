//! Diagnostic Log substrate (ADR-0036): a `tracing` subscriber that writes
//! structured JSONL events to a daily-rolling file under `INKSTONE_LOG_DIR`
//! (OS-data-dir default, mirroring [`crate::db`]'s `INKSTONE_DB_PATH` resolver).
//!
//! This is *not* the Run Log (ADR-0028) nor a Run Event (ADR-0022): it is the
//! operational fault/trace trail, authoritative for nothing, deletable with no
//! product impact. Each event carries a stable `event = "domain.thing"` key plus
//! typed fields; variable data lives in fields, never in the message.

use std::path::PathBuf;

use anyhow::{Context, Result};
use tracing_subscriber::EnvFilter;

/// File prefix for Core's trail; the daily appender suffixes it with the date,
/// e.g. `core.jsonl.2026-06-14`.
const LOG_FILE_PREFIX: &str = "core.jsonl";

/// Default verbosity directive when `INKSTONE_LOG` is unset: `INFO` overall,
/// with `sqlx::query` clamped to `WARN` so SQL statements and their bound
/// parameters are not written to disk at the default level (ADR-0036
/// redaction). `INKSTONE_LOG` overrides the whole directive when set.
const DEFAULT_DIRECTIVE: &str = "info,sqlx::query=warn";

/// Daily-rolling files to retain before the appender prunes the oldest.
const MAX_LOG_FILES: usize = 7;

/// Initialize the global `tracing` subscriber writing JSONL to the rolling log
/// file. Call this as the *first* statement of `main()` so even early fail-fast
/// paths (`workflow::init`, `db::open`) are captured.
///
/// Uses the **blocking** daily appender (not `tracing_appender::non_blocking`):
/// the non-blocking writer buffers behind a `WorkerGuard` that cannot flush on
/// SIGKILL, which the integration test relies on reading the file after. The
/// blocking appender writes each event to disk synchronously, so the trail is
/// complete the instant an event is emitted.
pub fn init() -> Result<()> {
    let dir = resolve_log_dir()?;
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("create log dir {}", dir.display()))?;

    let appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix(LOG_FILE_PREFIX)
        .max_log_files(MAX_LOG_FILES)
        .build(&dir)
        .with_context(|| format!("build rolling log appender in {}", dir.display()))?;

    // `INKSTONE_LOG` controls verbosity; absent/invalid → the redacting default.
    let filter = EnvFilter::try_from_env("INKSTONE_LOG")
        .unwrap_or_else(|_| EnvFilter::new(DEFAULT_DIRECTIVE));

    tracing_subscriber::fmt()
        .json()
        // Hoist event fields to the top level so the stable `event` key is
        // queryable as `.event` (ADR-0036's `jq -r .event | sort | uniq -c`
        // consumer), not nested under a `fields` object.
        .flatten_event(true)
        .with_env_filter(filter)
        // Blocking writer: synchronous per-event flush (see fn doc).
        .with_writer(appender)
        .init();

    Ok(())
}

/// Resolve the log directory: `INKSTONE_LOG_DIR` env override wins, else
/// `<OS data dir>/inkstone/logs`. Mirrors [`crate::db`]'s `resolve_db_path`.
fn resolve_log_dir() -> Result<PathBuf> {
    if let Some(env) = std::env::var_os("INKSTONE_LOG_DIR") {
        return Ok(PathBuf::from(env));
    }
    Ok(os_data_dir()?.join("inkstone").join("logs"))
}

// Per-OS application-data directory, duplicated from `db::os_data_dir` (which is
// private to the `db` module) to keep this slice within Core's logging file
// ownership — a one-module-local copy rather than widening another module's
// visibility. Kept byte-identical so the two resolvers cannot drift.
#[cfg(target_os = "macos")]
fn os_data_dir() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").context("$HOME not set")?;
    Ok(PathBuf::from(home)
        .join("Library")
        .join("Application Support"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn os_data_dir() -> Result<PathBuf> {
    if let Some(xdg) = std::env::var_os("XDG_DATA_HOME").filter(|s| !s.is_empty()) {
        return Ok(PathBuf::from(xdg));
    }
    let home = std::env::var_os("HOME").context("$HOME not set")?;
    Ok(PathBuf::from(home).join(".local").join("share"))
}

#[cfg(target_os = "windows")]
fn os_data_dir() -> Result<PathBuf> {
    let appdata = std::env::var_os("APPDATA").context("%APPDATA% not set")?;
    Ok(PathBuf::from(appdata))
}
