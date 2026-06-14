//! The `load_skill` tool (ADR-0036). Reads one Skill's `SKILL.md` body off disk
//! by name and returns it as tool text, so the model can pull a procedure into
//! context mid-Run. The `name` is a key into the Core-managed skills directory
//! (`<data dir>/inkstone/skills/`, overridable with `INKSTONE_SKILLS_DIR`), never
//! a path — Core retains total control over what is loadable (ADR-0003). The tool
//! is read-only w.r.t. durable state: it touches no tier-2 row and no Vault export,
//! so it needs no `pool`, no Proposal, and no special policy.

use std::path::{Component, Path, PathBuf};

use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

use super::ToolError;
use crate::protocol::{AgentToolResult, CoreToolDescriptor, ToolTextContent};

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

/// Resolve the skills base directory: `INKSTONE_SKILLS_DIR` env override (tests)
/// else `<OS data dir>/inkstone/skills/`, beside the SQLite DB. Mirrors
/// `db::resolve_db_path` and `workflow::default_dir`.
fn skills_dir() -> anyhow::Result<PathBuf> {
    if let Some(dir) = std::env::var_os("INKSTONE_SKILLS_DIR") {
        return Ok(PathBuf::from(dir));
    }
    Ok(crate::db::os_data_dir()?.join("inkstone").join("skills"))
}

/// Strip a leading YAML frontmatter block from a `SKILL.md` and return the body,
/// trimmed. A file with no leading `---` fence is treated as all-body. A file
/// whose opening `---` fence is never closed is malformed (`Err`). Slice 2 reuses
/// this to peel the body off when scanning, so it lives as its own fn.
fn strip_frontmatter(content: &str) -> Result<String, ToolError> {
    // The opening fence is a first line that is exactly `---`.
    let Some((first_line, rest)) = split_first_line(content) else {
        // Empty file: empty body.
        return Ok(String::new());
    };
    if first_line != "---" {
        // No frontmatter: the whole file is the body.
        return Ok(content.trim().to_string());
    }

    // Scan for the closing `---` fence; the body is everything after it.
    let mut remaining = rest;
    loop {
        match split_first_line(remaining) {
            Some((line, after)) if line == "---" => return Ok(after.trim().to_string()),
            Some((_, after)) => remaining = after,
            None => {
                return Err(ToolError {
                    code: "malformed_skill".to_string(),
                    message: "SKILL.md frontmatter is missing its closing `---` fence".to_string(),
                });
            }
        }
    }
}

/// Split `s` into its first line (CR trimmed, no terminator) and the remainder
/// after the `\n`. `None` when `s` is empty. A trailing line with no final `\n`
/// is returned with an empty remainder.
fn split_first_line(s: &str) -> Option<(&str, &str)> {
    if s.is_empty() {
        return None;
    }
    match s.find('\n') {
        Some(nl) => Some((s[..nl].trim_end_matches('\r'), &s[nl + 1..])),
        None => Some((s.trim_end_matches('\r'), "")),
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
/// block. The `name` keys into [`skills_dir`]`/<name>/SKILL.md`. A genuinely
/// absent skill (the file does not exist) is a clean `unknown_skill` error; any
/// other read failure (unreadable, non-UTF-8, transient I/O) is `internal`, so the
/// model isn't told a present-but-unreadable skill simply doesn't exist; a file
/// whose frontmatter is unclosed is `malformed_skill`. Never panics (fail-soft,
/// ADR-0036).
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

    let dir = skills_dir().map_err(|e| ToolError {
        code: "internal".to_string(),
        message: e.to_string(),
    })?;
    let path = dir.join(&input.name).join("SKILL.md");

    // Only a genuinely absent file means "no such skill". Any other read failure
    // (permission denied, a non-UTF-8 SKILL.md, a transient I/O fault) is an
    // operational `internal` error — mislabeling it `unknown_skill` would tell the
    // model the skill doesn't exist when it's merely unreadable. Mirrors
    // `read_thread`'s not_found-vs-internal split and `credentials.rs`'s NotFound
    // handling.
    let content = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(ToolError {
                code: "unknown_skill".to_string(),
                message: format!("no skill named {:?}", input.name),
            });
        }
        Err(e) => {
            return Err(ToolError {
                code: "internal".to_string(),
                message: e.to_string(),
            });
        }
    };

    let body = strip_frontmatter(&content)?;

    Ok(AgentToolResult {
        content: vec![ToolTextContent {
            r#type: "text".to_string(),
            text: body,
        }],
        details: None,
        terminate: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::is_registered;
    use serde_json::json;
    use std::sync::Mutex;

    /// `execute` resolves the skills dir from the process-global
    /// `INKSTONE_SKILLS_DIR`, so the env-mutating tests must not run concurrently.
    /// This guard serializes set_var + execute; each test still uses its own
    /// tempdir so a panic can't leak a fixture into another test. Lock with
    /// `unwrap_or_else(|p| p.into_inner())` (as `credentials.rs` does) so a panic
    /// in one test poisons the mutex without cascading `PoisonError` into the rest.
    static ENV_GUARD: Mutex<()> = Mutex::new(());

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
    async fn no_frontmatter_returns_whole_file_as_body() {
        let _guard = ENV_GUARD.lock().unwrap_or_else(|p| p.into_inner());
        let tmp = tempfile::tempdir().expect("tempdir");
        seed_skill(tmp.path(), "plain", "# Just a body\n\nNo frontmatter here.\n");
        unsafe {
            std::env::set_var("INKSTONE_SKILLS_DIR", tmp.path());
        }

        let out = execute(json!({ "name": "plain" })).await.expect("load ok");
        assert_eq!(text(&out), "# Just a body\n\nNo frontmatter here.");

        unsafe {
            std::env::remove_var("INKSTONE_SKILLS_DIR");
        }
    }

    #[tokio::test]
    async fn empty_skill_file_returns_empty_body() {
        let _guard = ENV_GUARD.lock().unwrap_or_else(|p| p.into_inner());
        let tmp = tempfile::tempdir().expect("tempdir");
        // An empty SKILL.md (touched but unwritten) hits the `split_first_line ==
        // None` arm of `strip_frontmatter` — a distinct branch from no-frontmatter.
        seed_skill(tmp.path(), "empty", "");
        unsafe {
            std::env::set_var("INKSTONE_SKILLS_DIR", tmp.path());
        }

        let out = execute(json!({ "name": "empty" })).await.expect("load ok");
        assert_eq!(text(&out), "", "an empty SKILL.md yields an empty body");

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
