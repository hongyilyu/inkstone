//! Core binds an ephemeral port when `INKSTONE_PORT=0` (ADR-0019): the
//! announced `INKSTONE_LISTENING` port is OS-assigned (non-zero, not the fixed
//! `DEFAULT_PORT`) and the server is reachable there — the guarantee parallel
//! test workers depend on to avoid port collisions.

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
