//! Production Worker transport (ADR-0026): a child process over NDJSON stdio.
//! The sole `Command::spawn` site in Core (ADR-0001/0013) — the run loop never
//! sees a `Child`, `ChildStdin`, or a line reader.

use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use uuid::Uuid;

use super::port::WorkerPort;
use crate::protocol::{ToolResult, WorkerStdout};

/// A spawned Worker child process with its stdio framed as NDJSON. Holds the
/// `Child` so the process stays alive for the Run; spawned `kill_on_drop(true)`,
/// so dropping this (when the loop returns) tears down and reaps the Worker —
/// no orphan outlives the Run.
pub(super) struct ChildWorker {
    #[allow(dead_code)] // held to own the process lifetime; kill_on_drop tears it down.
    child: Child,
    /// The Run's id, threaded in purely so this transport's Diagnostic Log
    /// events emit `run_id` as a direct top-level field (ADR-0038 canonical) —
    /// these reader/writer sites have no enclosing fn param to draw it from.
    run_id: Uuid,
    /// Kept open across the Run for `tool_result` writes (ADR-0013); set to
    /// `None` by [`WorkerPort::shutdown`] to send the Worker EOF.
    stdin: Option<ChildStdin>,
    lines: Lines<BufReader<ChildStdout>>,
}

impl ChildWorker {
    /// Spawn the Worker from `cmd` (whitespace-split program + args), write the
    /// serialized `manifest_line` to its stdin, and return the live transport.
    /// `run_id` is carried only for Diagnostic Log correlation (ADR-0038).
    /// `Err(())` on any pre-stream failure (empty cmd, spawn failure, missing
    /// stdio) — the caller maps it to `finalize_error`.
    pub(super) async fn spawn(run_id: Uuid, cmd: &str, manifest_line: String) -> Result<Self, ()> {
        let mut parts = cmd.split_whitespace();
        let Some(program) = parts.next() else {
            tracing::error!(event = "worker.cmd_empty", %run_id);
            return Err(());
        };
        let args: Vec<&str> = parts.collect();

        let mut child = match Command::new(program)
            .args(&args)
            // ADR-0038 env seam: the Worker reads `INKSTONE_RUN_ID` to stamp its
            // worker.jsonl lines, so they join to core.jsonl by run. Set per-spawn
            // (run_id differs per Run) — no `.env_clear()`, so the child keeps
            // inheriting Core's env (e.g. INKSTONE_WORKER_LOG_PATH). #146 moves
            // this in-band into WorkerManifest.
            .env("INKSTONE_RUN_ID", run_id.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                tracing::error!(event = "worker.spawn_failed", %run_id, program, error = ?e);
                return Err(());
            }
        };

        let Some(mut stdin) = child.stdin.take() else {
            tracing::error!(event = "worker.stdin_missing", %run_id);
            return Err(());
        };
        if let Err(e) = stdin.write_all(manifest_line.as_bytes()).await {
            tracing::error!(event = "worker.manifest_write_failed", %run_id, error = ?e);
            return Err(());
        }
        if let Err(e) = stdin.flush().await {
            // The manifest is the Worker's first input; an unflushed manifest
            // blocks it forever. Fail fast → the caller runs finalize_error.
            tracing::error!(event = "worker.manifest_flush_failed", %run_id, error = ?e);
            return Err(());
        }

        let Some(stdout) = child.stdout.take() else {
            tracing::error!(event = "worker.stdout_missing", %run_id);
            return Err(());
        };
        let lines = BufReader::new(stdout).lines();

        Ok(Self {
            child,
            run_id,
            stdin: Some(stdin),
            lines,
        })
    }
}

impl WorkerPort for ChildWorker {
    async fn recv(&mut self) -> Option<WorkerStdout> {
        loop {
            match self.lines.next_line().await {
                Ok(Some(line)) => match serde_json::from_str::<WorkerStdout>(&line) {
                    Ok(msg) => return Some(msg),
                    Err(e) => {
                        tracing::warn!(
                            event = "worker.unknown_line",
                            run_id = %self.run_id,
                            line_preview = %line_preview(&line),
                            error = ?e
                        );
                        continue;
                    }
                },
                Ok(None) => return None,
                Err(e) => {
                    tracing::error!(event = "worker.stdout_read_failed", run_id = %self.run_id, error = ?e);
                    return None;
                }
            }
        }
    }

    async fn send_tool_result(&mut self, result: ToolResult) {
        let Some(stdin) = self.stdin.as_mut() else {
            return;
        };
        match serde_json::to_string(&result) {
            Ok(mut line) => {
                line.push('\n');
                if let Err(e) = stdin.write_all(line.as_bytes()).await {
                    tracing::error!(event = "worker.tool_result_write_failed", run_id = %self.run_id, error = ?e);
                }
                let _ = stdin.flush().await;
            }
            Err(e) => {
                tracing::error!(event = "worker.tool_result_serialize_failed", run_id = %self.run_id, error = ?e)
            }
        }
    }

    async fn shutdown(&mut self) {
        // Drop stdin → EOF: the Worker (blocked awaiting a tool_result, or done)
        // exits and closes stdout, ending the read loop.
        self.stdin = None;
    }
}

/// Bound an unrecognized stdout line before it rides into the trail as a field
/// (ADR-0038: variable data in fields, never unbounded). Truncates on a char
/// boundary so the preview stays valid UTF-8.
fn line_preview(line: &str) -> &str {
    const MAX: usize = 200;
    if line.len() <= MAX {
        return line;
    }
    let mut end = MAX;
    while !line.is_char_boundary(end) {
        end -= 1;
    }
    &line[..end]
}
