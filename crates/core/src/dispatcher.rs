//! Dispatcher seam (per ADR-0011). Called once at Run creation to
//! pick the Workflow. The body is a one-liner today; slice 2's
//! capture-recognition Workflow turns this into real selection logic.

use crate::workflow::{ECHO, Workflow};

pub fn dispatch(_thread_id: uuid::Uuid, _prompt: &str) -> &'static Workflow {
    &ECHO
}
