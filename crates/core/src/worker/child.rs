//! Production Worker transport (ADR-0026): a child process over NDJSON stdio.
//! The sole `Command::spawn` site in Core (ADR-0001/0013) — the run loop never
//! sees a `Child`, `ChildStdin`, or a line reader.

use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use super::port::WorkerPort;
use crate::protocol::{ToolResult, WorkerStdout};

/// A spawned Worker child process with its stdio framed as NDJSON. Holds the
/// `Child` so the process stays alive for the Run; spawned `kill_on_drop(true)`,
/// so dropping this (when the loop returns) tears down and reaps the Worker —
/// no orphan outlives the Run.
pub(super) struct ChildWorker {
    #[allow(dead_code)] // held to own the process lifetime; kill_on_drop tears it down.
    child: Child,
    /// Kept open across the Run for `tool_result` writes (ADR-0013); set to
    /// `None` by [`WorkerPort::shutdown`] to send the Worker EOF.
    stdin: Option<ChildStdin>,
    lines: Lines<BufReader<ChildStdout>>,
}

impl ChildWorker {
    /// Spawn the Worker from `cmd` (whitespace-split program + args), write the
    /// serialized `manifest_line` to its stdin, and return the live transport.
    /// `Err(())` on any pre-stream failure (empty cmd, spawn failure, missing
    /// stdio) — the caller maps it to `finalize_error`.
    pub(super) async fn spawn(cmd: &str, manifest_line: String) -> Result<Self, ()> {
        let mut parts = cmd.split_whitespace();
        let Some(program) = parts.next() else {
            eprintln!("INKSTONE_WORKER_CMD is empty");
            return Err(());
        };
        let args: Vec<&str> = parts.collect();

        let mut child = match Command::new(program)
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                eprintln!("failed to spawn worker {program:?}: {e}");
                return Err(());
            }
        };

        let Some(mut stdin) = child.stdin.take() else {
            eprintln!("worker child has no stdin");
            return Err(());
        };
        if let Err(e) = stdin.write_all(manifest_line.as_bytes()).await {
            eprintln!("failed to write worker manifest: {e}");
            return Err(());
        }
        if let Err(e) = stdin.flush().await {
            // The manifest is the Worker's first input; an unflushed manifest
            // blocks it forever. Fail fast → the caller runs finalize_error.
            eprintln!("failed to flush worker manifest: {e}");
            return Err(());
        }

        let Some(stdout) = child.stdout.take() else {
            eprintln!("worker child has no stdout");
            return Err(());
        };
        let lines = BufReader::new(stdout).lines();

        Ok(Self {
            child,
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
                        eprintln!("worker emitted unknown line {line:?}: {e}");
                        continue;
                    }
                },
                Ok(None) => return None,
                Err(e) => {
                    eprintln!("worker stdout read error: {e}");
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
                    eprintln!("failed to write tool_result to worker stdin: {e}");
                }
                let _ = stdin.flush().await;
            }
            Err(e) => eprintln!("failed to serialize tool_result: {e}"),
        }
    }

    async fn shutdown(&mut self) {
        // Drop stdin → EOF: the Worker (blocked awaiting a tool_result, or done)
        // exits and closes stdout, ending the read loop.
        self.stdin = None;
    }
}
