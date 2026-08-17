//! Production Worker transport (ADR-0026): a child process over NDJSON stdio.
//! The sole `Command::spawn` site in Core (ADR-0001/0013) — the run loop never
//! sees a `Child`, `ChildStdin`, or a line reader.

use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use uuid::Uuid;

use super::port::WorkerPort;
use crate::protocol::{ExternalToolAck, ToolResult, WorkerStdout};

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
    /// Spawn the Worker from an already-resolved `program` + `args` (the
    /// `crate::launch` resolver owns the env-override/tsx-default decision and
    /// the shlex parse — ADR-0041), write the serialized `manifest_line` to its
    /// stdin, and return the live transport. `run_id` is carried only for
    /// Diagnostic Log correlation (ADR-0038). `Err(())` on any pre-stream
    /// failure (spawn failure, missing stdio) — the caller maps it to
    /// `finalize_error`.
    pub(super) async fn spawn(
        run_id: Uuid,
        program: &str,
        args: &[String],
        manifest_line: String,
    ) -> Result<Self, ()> {
        let mut command = Command::new(program);
        command
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);

        // Point the Worker's `worker.jsonl` sink at the sibling of Core's
        // `core.jsonl` (ADR-0038), so the Worker half of the trail is written by
        // default — not only when an operator sets the path. An explicit
        // `INKSTONE_WORKER_LOG_PATH` in Core's boot config wins as the override;
        // either way the path is set explicitly on the child.
        let log_path = crate::config::get()
            .worker_log_path
            .clone()
            .or_else(crate::logging::worker_log_path);
        if let Some(path) = log_path {
            command.env("INKSTONE_WORKER_LOG_PATH", path);
        }

        let mut child = match command.spawn() {
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

async fn write_frame<T: serde::Serialize>(
    stdin: &mut Option<ChildStdin>,
    run_id: Uuid,
    frame: &T,
    serialize_event: &'static str,
    write_event: &'static str,
) -> Result<(), ()> {
    let Some(stdin) = stdin.as_mut() else {
        return Err(());
    };
    let mut line = serde_json::to_string(frame).map_err(|e| {
        tracing::error!(event = serialize_event, %run_id, error = ?e);
    })?;
    line.push('\n');
    stdin.write_all(line.as_bytes()).await.map_err(|e| {
        tracing::error!(event = write_event, %run_id, error = ?e);
    })?;
    stdin.flush().await.map_err(|e| {
        tracing::error!(event = write_event, %run_id, error = ?e);
    })
}

impl WorkerPort for ChildWorker {
    async fn recv(&mut self) -> Result<Option<WorkerStdout>, ()> {
        match self.lines.next_line().await {
            Ok(Some(line)) => match serde_json::from_str::<WorkerStdout>(&line) {
                Ok(msg) => Ok(Some(msg)),
                Err(e) => {
                    tracing::warn!(
                        event = "worker.unknown_line",
                        run_id = %self.run_id,
                        line_preview = %line_preview(&line),
                        error = ?e
                    );
                    Err(())
                }
            },
            Ok(None) => Ok(None),
            Err(e) => {
                tracing::error!(
                    event = "worker.stdout_read_failed",
                    run_id = %self.run_id,
                    error = ?e
                );
                Err(())
            }
        }
    }

    async fn send_tool_result(&mut self, result: ToolResult) {
        let _ = write_frame(
            &mut self.stdin,
            self.run_id,
            &result,
            "worker.tool_result_serialize_failed",
            "worker.tool_result_write_failed",
        )
        .await;
    }

    async fn send_external_tool_ack(&mut self, ack: ExternalToolAck) -> Result<(), ()> {
        write_frame(
            &mut self.stdin,
            self.run_id,
            &ack,
            "worker.external_ack_serialize_failed",
            "worker.external_ack_write_failed",
        )
        .await
    }

    async fn shutdown(&mut self) {
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
