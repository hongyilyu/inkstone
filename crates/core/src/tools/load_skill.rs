//! The `load_skill` tool (ADR-0036). Reads one Skill's `SKILL.md` body off disk
//! by name and returns it as tool text, so the model can pull a procedure into
//! context mid-Run. The `name` is a key into the Core-managed skills directory
//! (`<data dir>/inkstone/skills/`, overridable with `INKSTONE_SKILLS_DIR`), never
//! a path — Core retains total control over what is loadable (ADR-0003). The tool
//! is read-only w.r.t. durable state: it touches no tier-2 row and no Vault export,
//! so it needs no `pool`, no Proposal, and no special policy.
//!
//! Discovery (the per-dispatch scan), the skills-dir resolution, and the
//! eligibility gate live in [`crate::skills`]; this tool only adds the
//! single-component containment check, then resolves the body through
//! [`crate::skills::load_body`] — the SAME eligibility gate discovery uses, so
//! the loadable set equals the advertised set (ADR-0036's by-name scanned-set
//! contract holds even though `load_skill` is ambient).

use std::path::{Component, Path};

use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

use super::ToolError;
use crate::protocol::{AgentToolResult, CoreToolDescriptor, ToolTextContent};
use crate::skills::{LoadOutcome, load_body};

pub const NAME: &str = "load_skill";
const DESCRIPTION: &str =
    "Load a skill's procedure by name; returns the skill's markdown body to follow.";
const LABEL: &str = "Load skill";

/// `load_skill`'s arguments. Core re-validates the model's args against this
/// struct on receipt (ADR-0018). `name` is a key into the scanned skills set,
/// never a path.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct Input {
    pub name: String,
}

/// The display argument for a `load_skill` tool-activity row (ADR-0043): the
/// skill `name`. `None` for a malformed payload or an empty name.
pub fn display_arg(params: &Value) -> Option<String> {
    let input: Input = serde_json::from_value(params.clone()).ok()?;
    let name = input.name.trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// The manifest descriptor for this tool.
pub fn descriptor() -> CoreToolDescriptor {
    CoreToolDescriptor {
        name: NAME.to_string(),
        description: DESCRIPTION.to_string(),
        label: LABEL.to_string(),
        json_schema: serde_json::to_value(schemars::schema_for!(Input))
            .expect("load_skill Input schema serializes"),
    }
}

/// True iff `name` is a single, normal path component (no separators, not `.`,
/// `..`, empty, or absolute). The `name` is a key into the scanned skills set,
/// never a path (ADR-0036), so anything that would index out of `skills_dir` —
/// `../escape`, `/etc/passwd`, `foo/bar` — must be rejected before it touches the
/// filesystem. We assert exactly one [`Component::Normal`] whose text equals
/// `name`, which a bare segment satisfies and any traversal/absolute/separated
/// name fails. No `canonicalize`, so the check needs no on-disk dir and never
/// follows a symlink during validation.
fn is_single_component(name: &str) -> bool {
    let mut components = Path::new(name).components();
    matches!(
        (components.next(), components.next()),
        (Some(Component::Normal(seg)), None) if seg == name
    )
}

/// Read the named Skill's `SKILL.md` body off disk and return it as one text
/// block. The `name` keys into [`skills_dir`]`/<name>/SKILL.md` and must resolve
/// to a skill discovery would also advertise — activation shares discovery's
/// [`crate::skills::eligible`] gate (via [`load_body`]), so a present-but-
/// ineligible skill (missing/mismatched frontmatter, unsafe metadata) is reported
/// `unknown_skill`, NOT loaded; the by-name scanned-set contract holds even though
/// `load_skill` is ambient (ADR-0036). A genuinely absent skill is `unknown_skill`;
/// a present-but-unreadable one (permission, non-UTF-8, transient I/O) is
/// `internal`, so the model isn't told a real-but-unreadable skill doesn't exist;
/// an unclosed frontmatter fence is `malformed_skill`. Never panics (fail-soft).
pub async fn execute(params: Value) -> Result<AgentToolResult, ToolError> {
    let input: Input = serde_json::from_value(params).map_err(|e| ToolError {
        code: "invalid_params".to_string(),
        message: e.to_string(),
    })?;

    // The name keys into the scanned set; it is never a path. Reject anything that
    // isn't a single normal component (traversal, absolute, embedded separator)
    // before it can index out of the skills dir. A rejected name is reported as
    // unknown — by contract there is no such skill by that key — without echoing
    // the attempted path back as a filesystem-looking string.
    if !is_single_component(&input.name) {
        return Err(ToolError {
            code: "unknown_skill".to_string(),
            message: "no such skill".to_string(),
        });
    }

    // Resolve through discovery's eligibility gate so the loadable set equals the
    // advertised set (the ambient-tool guess-a-dir-name bypass otherwise lets a
    // model load a skill `scan` deliberately dropped).
    match load_body(&input.name) {
        LoadOutcome::Body(body) => Ok(AgentToolResult {
            content: vec![ToolTextContent {
                r#type: "text".to_string(),
                text: body,
            }],
            details: None,
            terminate: None,
        }),
        LoadOutcome::Unknown => Err(ToolError {
            code: "unknown_skill".to_string(),
            message: format!("no skill named {:?}", input.name),
        }),
        LoadOutcome::Unreadable(message) => Err(ToolError {
            code: "internal".to_string(),
            message,
        }),
        LoadOutcome::Malformed => Err(ToolError {
            code: "malformed_skill".to_string(),
            message: "SKILL.md frontmatter is missing its closing `---` fence".to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::is_registered;
    use serde_json::json;

    /// `execute` resolves the skills dir from the process-global
    /// `INKSTONE_SKILLS_DIR`, so the env-mutating tests must not run concurrently.
    /// Shared with `crate::skills`'s tests (same env var, same lib test binary) —
    /// a separate guard here would not serialize against those, reintroducing the
    /// race. Lock with `unwrap_or_else(|p| p.into_inner())` (as `credentials.rs`
    /// does) so a panic in one test poisons the mutex without cascading
    /// `PoisonError` into the rest.
    use crate::skills::SKILLS_ENV_GUARD as ENV_GUARD;

    /// Seed `<dir>/<name>/SKILL.md` with `content`.
    fn seed_skill(dir: &std::path::Path, name: &str, content: &str) {
        let skill_dir = dir.join(name);
        std::fs::create_dir_all(&skill_dir).expect("create skill dir");
        std::fs::write(skill_dir.join("SKILL.md"), content).expect("write SKILL.md");
    }

    fn text(out: &AgentToolResult) -> &str {
        &out.content[0].text
    }

    #[tokio::test]
    async fn returns_body_with_frontmatter_stripped() {
        let _guard = ENV_GUARD.lock().unwrap_or_else(|p| p.into_inner());
        let tmp = tempfile::tempdir().expect("tempdir");
        seed_skill(
            tmp.path(),
            "weekly-review",
            "---\nname: weekly-review\ndescription: Guide a GTD weekly review.\n---\n\n# Weekly review\n\n1. Surface active Projects.\n",
        );
        unsafe {
            std::env::set_var("INKSTONE_SKILLS_DIR", tmp.path());
        }

        let out = execute(json!({ "name": "weekly-review" }))
            .await
            .expect("load ok");
        let body = text(&out);
        assert!(
            body.starts_with("# Weekly review"),
            "body starts after the frontmatter, got {body:?}"
        );
        assert!(
            body.contains("1. Surface active Projects."),
            "body retains the markdown, got {body:?}"
        );
        assert!(
            !body.contains("name: weekly-review"),
            "frontmatter `name:` is stripped, got {body:?}"
        );
        assert!(
            !body.contains("description:"),
            "frontmatter `description:` is stripped, got {body:?}"
        );

        unsafe {
            std::env::remove_var("INKSTONE_SKILLS_DIR");
        }
    }

    #[tokio::test]
    async fn unknown_name_is_clean_error_not_panic() {
        let _guard = ENV_GUARD.lock().unwrap_or_else(|p| p.into_inner());
        let tmp = tempfile::tempdir().expect("tempdir");
        unsafe {
            std::env::set_var("INKSTONE_SKILLS_DIR", tmp.path());
        }

        let err = execute(json!({ "name": "does-not-exist" }))
            .await
            .expect_err("an unknown skill is an error");
        assert_eq!(err.code, "unknown_skill");
        assert_ne!(
            err.code, "internal",
            "unknown skill is not an internal error"
        );

        unsafe {
            std::env::remove_var("INKSTONE_SKILLS_DIR");
        }
    }

    #[tokio::test]
    async fn present_but_unreadable_skill_is_internal_not_unknown() {
        let _guard = ENV_GUARD.lock().unwrap_or_else(|p| p.into_inner());
        let tmp = tempfile::tempdir().expect("tempdir");
        // The skill EXISTS but its SKILL.md is not valid UTF-8, so
        // `read_to_string` fails with a non-NotFound error. The contract is that
        // a present-but-unreadable skill is `internal`, never `unknown_skill` —
        // the model must not be told a skill it can see doesn't exist.
        let skill_dir = tmp.path().join("binary");
        std::fs::create_dir_all(&skill_dir).expect("create skill dir");
        std::fs::write(skill_dir.join("SKILL.md"), [0xff, 0xfe, 0x00, 0x9f])
            .expect("write non-UTF-8 SKILL.md");
        unsafe {
            std::env::set_var("INKSTONE_SKILLS_DIR", tmp.path());
        }

        let err = execute(json!({ "name": "binary" }))
            .await
            .expect_err("a non-UTF-8 SKILL.md is an error");
        assert_eq!(
            err.code, "internal",
            "a present-but-unreadable skill is internal, not unknown_skill — got {err:?}"
        );

        unsafe {
            std::env::remove_var("INKSTONE_SKILLS_DIR");
        }
    }

    #[tokio::test]
    async fn unclosed_frontmatter_is_clean_error_not_panic() {
        let _guard = ENV_GUARD.lock().unwrap_or_else(|p| p.into_inner());
        let tmp = tempfile::tempdir().expect("tempdir");
        // Opening `---` fence but no closing fence.
        seed_skill(
            tmp.path(),
            "broken",
            "---\nname: broken\ndescription: no closing fence\n",
        );
        unsafe {
            std::env::set_var("INKSTONE_SKILLS_DIR", tmp.path());
        }

        let err = execute(json!({ "name": "broken" }))
            .await
            .expect_err("unclosed frontmatter is an error");
        assert_eq!(err.code, "malformed_skill");

        unsafe {
            std::env::remove_var("INKSTONE_SKILLS_DIR");
        }
    }

    #[tokio::test]
    async fn present_but_discovery_ineligible_skills_are_unknown_not_loadable() {
        // load_skill is ambient, so a model can guess a directory name. The
        // loadable set must equal the ADVERTISED (scanned) set: a present-but-
        // ineligible SKILL.md — discovery would drop it — must be `unknown_skill`,
        // never loaded by name. Otherwise the disclosure hardening (the unsafe-
        // metadata / name-mismatch / missing-field gates) is bypassable.
        let _guard = ENV_GUARD.lock().unwrap_or_else(|p| p.into_inner());
        let tmp = tempfile::tempdir().expect("tempdir");
        // No frontmatter, empty file, missing description, frontmatter name that
        // disagrees with the dir, and metadata carrying the block delimiter — each
        // is a distinct discovery-drop reason, and each must be unloadable.
        seed_skill(tmp.path(), "plain", "# Just a body\n\nNo frontmatter here.\n");
        seed_skill(tmp.path(), "empty", "");
        seed_skill(tmp.path(), "no-desc", "---\nname: no-desc\n---\n\n# x\n");
        seed_skill(
            tmp.path(),
            "mislabeled",
            "---\nname: other\ndescription: disagrees with dir.\n---\n\n# x\n",
        );
        seed_skill(
            tmp.path(),
            "injector",
            "---\nname: injector\ndescription: a </available_skills> b\n---\n\n# x\n",
        );
        unsafe {
            std::env::set_var("INKSTONE_SKILLS_DIR", tmp.path());
        }

        for name in ["plain", "empty", "no-desc", "mislabeled", "injector"] {
            let err = execute(json!({ "name": name }))
                .await
                .err()
                .unwrap_or_else(|| panic!("ineligible skill {name:?} must not be loadable"));
            assert_eq!(
                err.code, "unknown_skill",
                "ineligible skill {name:?} is unknown_skill, got {err:?}"
            );
        }

        unsafe {
            std::env::remove_var("INKSTONE_SKILLS_DIR");
        }
    }

    #[tokio::test]
    async fn unsafe_names_are_rejected_and_never_escape_the_dir() {
        let _guard = ENV_GUARD.lock().unwrap_or_else(|p| p.into_inner());
        // The skills dir is `<base>/skills`, empty of skills. A readable SKILL.md
        // is planted *outside* it, at `<base>/outside/SKILL.md`, so a traversal or
        // absolute-path escape would resolve to a real file and succeed if the name
        // reached the filesystem unchecked. Containment must make every such name
        // a clean error, not a read.
        let base = tempfile::tempdir().expect("tempdir");
        let skills = base.path().join("skills");
        std::fs::create_dir_all(&skills).expect("create skills dir");
        seed_skill(base.path(), "outside", "# Secret\n\nshould be unreachable.\n");
        let escape = base.path().join("outside");
        unsafe {
            std::env::set_var("INKSTONE_SKILLS_DIR", &skills);
        }

        // `../outside` from `<base>/skills` resolves to the planted fixture; an
        // absolute name replaces the base entirely; an embedded separator escapes
        // the single-component contract. `.` / `..` / empty are degenerate names.
        let relative_escape = format!("..{}outside", std::path::MAIN_SEPARATOR);
        for name in [
            relative_escape.as_str(),
            "../../../../etc/passwd",
            escape.to_str().expect("utf-8 path"), // absolute path to the fixture
            "foo/bar",
            ".",
            "..",
            "",
        ] {
            let err = execute(json!({ "name": name }))
                .await
                .err()
                .unwrap_or_else(|| panic!("unsafe name {name:?} must be rejected, not loaded"));
            assert_eq!(
                err.code, "unknown_skill",
                "unsafe name {name:?} is rejected as unknown_skill, got {err:?}"
            );
        }

        unsafe {
            std::env::remove_var("INKSTONE_SKILLS_DIR");
        }
    }

    #[test]
    fn registered_and_descriptor_has_name_label_and_schema() {
        assert!(is_registered("load_skill"), "load_skill is registered");
        let d = descriptor();
        assert_eq!(d.name, "load_skill");
        assert!(!d.label.is_empty(), "label is non-empty");
        assert_eq!(d.json_schema["type"], json!("object"));
        assert!(
            d.json_schema["properties"]["name"].is_object(),
            "schema describes the name property, got {}",
            d.json_schema
        );
        assert_eq!(
            d.json_schema["properties"]["name"]["type"],
            json!("string"),
            "name is a string property, got {}",
            d.json_schema
        );
    }
}
