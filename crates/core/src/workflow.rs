//! Workflow primitive (ADR-0011, ADR-0018). A Workflow is declarative data
//! loaded from a TOML file in `crates/core/workflows/`; Core ships its fields in
//! the spawn manifest, the Worker has no per-Workflow code.
//!
//! Today exactly one file (`default.toml`) is loaded into a process-global
//! `OnceLock` at boot, failing fast on malformed TOML or an invalid
//! `thinking_level`. Hot reload and user-authored Workflows are out of scope.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use anyhow::{Context, Result, bail};
use serde::Deserialize;

/// The thinking levels `thinking_level` may take, mirroring `pi-agent-core`'s
/// `ThinkingLevel`. Validated at load so a TOML typo fails boot, not a Run.
const THINKING_LEVELS: [&str; 6] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/// Whether `level` is a valid thinking level (ADR-0024). Backs the `settings/set`
/// effort validator, sharing one allowed-set with the loader's `validate`.
pub fn is_valid_thinking_level(level: &str) -> bool {
    THINKING_LEVELS.contains(&level)
}

/// A loaded Workflow: pure data deserialized from TOML.
///
/// `model` and `thinking_level` are optional (ADR-0024): production
/// `default.toml` no longer authors them — they come from user settings,
/// resolved per-Run by `dispatcher::resolve_effective_workflow`. The TOML fields
/// remain as an ultimate fallback (test fixtures still set them).
#[derive(Debug, Clone, Deserialize)]
pub struct Workflow {
    pub name: String,
    pub version: String,
    pub provider: String,
    #[serde(default)]
    pub model: Option<String>,
    pub system_prompt: String,
    #[serde(default)]
    pub thinking_level: Option<String>,
    #[serde(default)]
    pub tools: Vec<String>,
}

impl Workflow {
    /// Validate invariants serde's type-check can't express. Currently: when
    /// present, `thinking_level` is one of the allowed values.
    fn validate(&self) -> Result<()> {
        if let Some(ref level) = self.thinking_level {
            if !THINKING_LEVELS.contains(&level.as_str()) {
                bail!(
                    "workflow {:?}: invalid thinking_level {:?} (expected one of {:?})",
                    self.name,
                    level,
                    THINKING_LEVELS
                );
            }
        }
        Ok(())
    }
}

static DEFAULT_WORKFLOW: OnceLock<Workflow> = OnceLock::new();

/// The directory Workflows are loaded from. `INKSTONE_WORKFLOWS_DIR` overrides
/// it (tests); otherwise `crates/core/workflows/` resolved from the crate
/// manifest dir, so it works regardless of the process CWD.
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
    // `set` only errors if already set; in normal boot it is empty.
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
