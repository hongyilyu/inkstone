//! The Worker transport seam (ADR-0026).
//!
//! [`WorkerPort`] is the small interface Core's run loop depends on — pull the
//! next Worker stdout frame, send a Tool Result back, shut the Worker down. The
//! loop ([`super::run::run_loop`]) is generic over this trait, so the adapter is
//! chosen at compile time: production uses [`super::child::ChildWorker`]; tests
//! drive a scripted in-memory adapter.

use std::future::Future;

use crate::protocol::{ExternalToolAck, ToolResult, WorkerStdout};

/// Which terminal branch the run loop took, so callers and tests can assert the
/// outcome. The loop commits the matching terminal transaction itself, except
/// [`Exit::Parked`] (non-terminal per ADR-0025).
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
    /// Core accepted cancellation and signalled the live Worker. The terminal
    /// transaction and `cancelled` event were owned by `run/cancel`.
    Cancelled,
    /// Every attempt to persist the terminal transition failed. The hub remains
    /// registered and the driver terminates Core so boot recovery can settle it.
    FatalPersistence,
}

/// Everything Core's run loop needs from a spawned Worker (ADR-0026). Futures
/// are `Send` so the generic loop can run inside `tokio::spawn`.
pub(crate) trait WorkerPort {
    /// The next Worker stdout frame, `Ok(None)` on EOF, or `Err(())` when
    /// stdout faults or a frame violates the protocol. Invalid frames terminate
    /// the Run; they are never skipped.
    fn recv(&mut self) -> impl Future<Output = Result<Option<WorkerStdout>, ()>> + Send;

    /// Write a Tool Result back over the Worker's kept-open stdin (ADR-0013).
    /// A no-op once the Worker has been shut down.
    fn send_tool_result(&mut self, result: ToolResult) -> impl Future<Output = ()> + Send;

    /// Acknowledge one external lifecycle frame after its durable transition.
    fn send_external_tool_ack(
        &mut self,
        ack: ExternalToolAck,
    ) -> impl Future<Output = Result<(), ()>> + Send;

    /// Shut the Worker down — drop stdin so the Worker sees EOF and exits
    /// (ADR-0013). Idempotent.
    fn shutdown(&mut self) -> impl Future<Output = ()> + Send;
}
