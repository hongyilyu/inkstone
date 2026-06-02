//! Dispatcher seam (per ADR-0011). Called once at Run creation to
//! pick the Workflow. The body is a one-liner today; a future
//! capture-recognition Workflow turns this into real selection logic.

use crate::workflow::{self, Workflow};

pub fn dispatch(_thread_id: uuid::Uuid, _prompt: &str) -> &'static Workflow {
    workflow::default_workflow()
}
