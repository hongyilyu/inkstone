//! Diagnostic Log substrate (ADR-0038): a `tracing` subscriber that writes
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

/// Filename for the Worker's sibling trail, written next to `core.jsonl`.
const WORKER_LOG_FILE: &str = "worker.jsonl";

/// Default verbosity directive when `INKSTONE_LOG` is unset: `INFO` overall,
/// with `sqlx::query` clamped to `WARN` so SQL statements and their bound
/// parameters are not written to disk at the default level (ADR-0038
/// redaction). `INKSTONE_LOG` overrides the whole directive when set.
const DEFAULT_DIRECTIVE: &str = "info,sqlx::query=warn";

/// Daily-rolling files to retain before the appender prunes the oldest.
const MAX_LOG_FILES: usize = 7;

/// Initialize the global `tracing` subscriber writing JSONL to the rolling log
/// file. Call this immediately after `config::init` in `main()` —
/// `resolve_log_dir()` reads `config::get()`, which panics pre-init — so even
/// early fail-fast paths (`workflow::init`, `db::open`) are captured.
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
        // queryable as `.event` (ADR-0038's `jq -r .event | sort | uniq -c`
        // consumer), not nested under a `fields` object.
        .flatten_event(true)
        .with_env_filter(filter)
        // Blocking writer: synchronous per-event flush (see fn doc).
        .with_writer(appender)
        .init();

    Ok(())
}

/// Resolve the log directory: the boot-resolved `INKSTONE_LOG_DIR` override
/// wins, else `<OS data dir>/inkstone/logs`. Reuses `db::os_data_dir` (already
/// `pub(crate)`) so the log dir and the DB dir resolve through the same per-OS
/// logic and can never drift apart.
fn resolve_log_dir() -> Result<PathBuf> {
    if let Some(ref dir) = crate::config::get().log_dir_override {
        return Ok(dir.clone());
    }
    Ok(crate::db::os_data_dir()?.join("inkstone").join("logs"))
}

/// The default path for the Worker's `worker.jsonl` sibling trail — the same
/// log dir Core writes `core.jsonl` into, plus `worker.jsonl`. Core hands this
/// to the spawned Worker as `INKSTONE_WORKER_LOG_PATH` (the Worker's sink reads
/// that env var), so the Worker half of the trail is written by default,
/// joinable to `core.jsonl`. Returns `None` if the log dir can't be resolved —
/// logging is best-effort and must never block a Worker spawn.
pub(crate) fn worker_log_path() -> Option<PathBuf> {
    resolve_log_dir().ok().map(|d| d.join(WORKER_LOG_FILE))
}
