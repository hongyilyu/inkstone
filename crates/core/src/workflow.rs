//! Workflow primitive (ADR-0011, ADR-0018). A Workflow is declarative data
//! loaded from a TOML file in `crates/core/workflows/` — name, version,
//! provider, model, system prompt, thinking level, and tool allowlist. The
//! Worker has no per-Workflow code; Core ships these fields in the spawn
//! manifest (ADR-0018 as-built).
//!
//! Slice 3 loads exactly one file (`default.toml`) into a process-global
//! `OnceLock` at boot and fails fast on malformed TOML or an invalid
//! `thinking_level`. Hot reload and user-authored Workflows are out of scope
//! (ADR-0018 "What this does not decide").

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use anyhow::{Context, Result, bail};
use serde::Deserialize;

/// The set of thinking levels the manifest's `thinking_level` may take,
/// mirroring `pi-agent-core`'s `ThinkingLevel` (`off` + the five pi-ai
/// levels). Validated at load so a typo in the TOML fails Core boot rather
/// than a Run.
const THINKING_LEVELS: [&str; 6] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/// A loaded Workflow. Pure data deserialized from TOML via serde. `tools` is
/// empty until the tools slice; `auto_approve`/`bootstrap` (ADR-0018) are not
/// modeled yet (deferred per the as-built amendment).
#[derive(Debug, Clone, Deserialize)]
pub struct Workflow {
    pub name: String,
    pub version: String,
    pub provider: String,
    pub model: String,
    pub system_prompt: String,
    pub thinking_level: String,
    #[serde(default)]
    pub tools: Vec<String>,
}

impl Workflow {
    /// Validate invariants that serde's type-check can't express. Called
    /// once at load. Currently: `thinking_level` is one of the allowed
    /// values.
    fn validate(&self) -> Result<()> {
        if !THINKING_LEVELS.contains(&self.thinking_level.as_str()) {
            bail!(
                "workflow {:?}: invalid thinking_level {:?} (expected one of {:?})",
                self.name,
                self.thinking_level,
                THINKING_LEVELS
            );
        }
        Ok(())
    }
}

static DEFAULT_WORKFLOW: OnceLock<Workflow> = OnceLock::new();

/// The directory Workflows are loaded from. `INKSTONE_WORKFLOWS_DIR` overrides
/// it (used by tests to point at a fixture dir); otherwise it is
/// `crates/core/workflows/` resolved from the crate manifest dir so it works
/// regardless of the process CWD.
fn default_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("INKSTONE_WORKFLOWS_DIR") {
        return PathBuf::from(dir);
    }
    Path::new(env!("CARGO_MANIFEST_DIR")).join("workflows")
}

/// Load and validate the single `default.toml` Workflow from `dir`. Returns
/// an error (with file path + serde line/column context) on missing file,
/// malformed TOML, or a failed invariant.
pub fn load_default_from(dir: &Path) -> Result<Workflow> {
    let path = dir.join("default.toml");
    let body = std::fs::read_to_string(&path)
        .with_context(|| format!("reading workflow {}", path.display()))?;
    let workflow: Workflow = toml::from_str(&body)
        .with_context(|| format!("parsing workflow {}", path.display()))?;
    workflow.validate()?;
    Ok(workflow)
}

/// Populate the process-global default Workflow from [`default_dir`]. Called
/// once at Core boot; a load failure aborts startup (fail-fast, ADR-0018).
pub fn init() -> Result<()> {
    let workflow = load_default_from(&default_dir())?;
    // OnceLock::set only errors if already set; in normal boot it is empty.
    let _ = DEFAULT_WORKFLOW.set(workflow);
    Ok(())
}

/// The loaded default Workflow. Panics if [`init`] has not run — callers are
/// Run-creation paths that only execute after a successful boot.
pub fn default_workflow() -> &'static Workflow {
    DEFAULT_WORKFLOW
        .get()
        .expect("workflow::init() must run at boot before a Run is created")
}
