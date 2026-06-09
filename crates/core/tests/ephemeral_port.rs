//! Slice 1 RED test: Core binds an ephemeral port when `INKSTONE_PORT=0`.
//!
//! The harness (ADR-0019) spawns one fresh Core per test and needs each to
//! bind a distinct port so parallel Playwright workers don't collide. Core
//! already announces `INKSTONE_LISTENING <url>` on stdout; this test proves
//! that with `INKSTONE_PORT=0` the announced port is OS-assigned (non-zero and
//! not the fixed default `DEFAULT_PORT`) and the server is actually reachable
//! there.
//!
//! Ephemeral is now the only port strategy (`common::Workspace` always sets
//! `INKSTONE_PORT=0`); this test pins the guarantee the harness depends on.

mod common;
use common::{DEFAULT_PORT, Workspace};

#[test]
fn ephemeral_port_binds_nonzero_and_serves() {
    let workspace = Workspace::new();
    let core = workspace.core().spawn();

    // The announced URL must carry the *resolved* ephemeral port, not 0.
    let port = core.port();
    assert_ne!(port, 0, "ephemeral port must be resolved to a real port");
    assert_ne!(port, DEFAULT_PORT, "INKSTONE_PORT=0 must not bind the fixed default");

    let response = reqwest::blocking::get(core.http_url()).expect("GET / succeeds");
    assert_eq!(response.status().as_u16(), 200, "GET / returns 200");
}
