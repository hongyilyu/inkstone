//! The Worker transport seam (ADR-0026).
//!
//! [`WorkerPort`] is the small interface Core's run loop depends on — pull the
//! next Worker stdout frame, send a Tool Result back, shut the Worker down. The
//! loop ([`super::run::run_loop`]) is generic over this trait, so the adapter is
//! chosen at compile time (no runtime dispatch): production uses
//! [`super::child::ChildWorker`] (the sole `Command::spawn` site); tests drive a
//! scripted in-memory adapter. The port speaks the existing wire types
//! ([`WorkerStdout`], [`ToolResult`]) unchanged.

use std::future::Future;

use crate::protocol::{ToolResult, WorkerStdout};

/// Which terminal branch the run loop took. Returned by [`super::run::run_loop`]
/// so callers and tests can assert the outcome directly; the loop still commits
/// the matching terminal transaction itself (except [`Exit::Parked`], which is
/// non-terminal per ADR-0025).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Exit {
    /// Worker emitted `done`; the loop committed `complete_run`.
    Done,
    /// Worker stdout closed without `done`; the loop committed `error_run`
    /// (`worker_disconnected`).
    Disconnected,
    /// Worker emitted an explicit `error` event; the loop committed
    /// `error_run_with_message`.
    Errored(String),
    /// A Proposal `tool_request` parked the Run (ADR-0025). Non-terminal: the
    /// loop committed no terminal transaction.
    Parked,
}

/// Everything Core's run loop needs from a spawned Worker (ADR-0026). The
/// returned futures are `Send` so the generic loop can run inside
/// `tokio::spawn`.
pub(crate) trait WorkerPort {
    /// The next Worker stdout frame, or `None` once the Worker's stdout closes
    /// (EOF) or faults. Frames that fail to decode are skipped by the adapter,
    /// so the loop only ever sees well-formed [`WorkerStdout`] values.
    fn recv(&mut self) -> impl Future<Output = Option<WorkerStdout>> + Send;

    /// Write a Tool Result back to the Worker over its kept-open stdin
    /// (ADR-0013). A no-op once the Worker has been shut down.
    fn send_tool_result(&mut self, result: ToolResult) -> impl Future<Output = ()> + Send;

    /// Shut the Worker down — drop stdin so the Worker sees EOF and exits
    /// (ADR-0013). Idempotent.
    fn shutdown(&mut self) -> impl Future<Output = ()> + Send;
}
