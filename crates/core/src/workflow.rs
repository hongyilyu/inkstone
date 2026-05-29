//! Workflow primitive (per ADR-0011). One Workflow exists in the
//! skeleton — `ECHO` — but the type is a struct so adding a second
//! Workflow later is a Dispatcher change, not a structural one.

#[allow(dead_code)] // fields read once Worker spawn lands in slice 7
pub struct Workflow {
    pub name: &'static str,
    pub version: u32,
}

pub const ECHO: Workflow = Workflow {
    name: "echo",
    version: 1,
};
