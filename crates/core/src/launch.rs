//! One role-keyed launch-command resolver (ADR-0041). Core spawns the Worker
//! and the Provider Helper as child processes; each spawn site used to build its
//! command with an inline `env::var(...).unwrap_or_else(<tsx string>)` then a
//! `split_whitespace` — three copies that all mis-parsed a path containing a
//! space. This module collapses them into one resolver.
//!
//! Resolution (ADR-0041), in order:
//! 1. the role's `INKSTONE_*_CMD` override, if set, parsed with [`shlex`] (not
//!    whitespace-split, fixing the space-in-path bug). **Wins over everything.**
//! 2. else a sibling compiled binary (`inkstone-worker` /
//!    `inkstone-provider-helper`) next to Core's own executable, if that file
//!    exists.
//! 3. else the role's `tsx <script>` default, transcribed byte-identically from
//!    the old inline strings.
//!
//! An empty/whitespace-only override is an error (matching the old
//! "INKSTONE_*_CMD is empty" guard).
//!
//! [`resolve_with`] is the hermetic seam units exercise (exe dir + existence
//! predicate injected — no env, no `current_exe`, no real FS); [`resolve`] is
//! the production wrapper that reads the real env and Core's real `current_exe`
//! directory.

/// Which program a launch command resolves. Each role owns one `INKSTONE_*_CMD`
/// override env var and one `tsx` default (ADR-0041).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// The Worker interpreter (`packages/worker`, `cli.ts`).
    Worker,
    /// The Provider Helper in `login` mode (`packages/provider-helper`).
    ProviderLogin,
    /// The Provider Helper in `refresh` mode.
    ProviderRefresh,
}

impl Role {
    /// The env var that overrides this role's launch command.
    fn env_var(self) -> &'static str {
        match self {
            Role::Worker => "INKSTONE_WORKER_CMD",
            Role::ProviderLogin => "INKSTONE_PROVIDER_LOGIN_CMD",
            Role::ProviderRefresh => "INKSTONE_PROVIDER_HELPER_CMD",
        }
    }

    /// This role's `tsx <script>` default command, transcribed byte-identically
    /// from the old inline spawn sites.
    fn tsx_default(self) -> &'static str {
        match self {
            Role::Worker => "packages/worker/node_modules/.bin/tsx packages/worker/src/cli.ts",
            Role::ProviderLogin => {
                "packages/provider-helper/node_modules/.bin/tsx packages/provider-helper/src/provider.ts login"
            }
            Role::ProviderRefresh => {
                "packages/provider-helper/node_modules/.bin/tsx packages/provider-helper/src/provider.ts refresh"
            }
        }
    }

    /// The compiled sibling-binary file name this role looks for next to Core's
    /// executable (ADR-0041 step 2). The two helper roles share one binary
    /// (`inkstone-provider-helper`), dispatched by [`Role::binary_args`].
    fn binary_name(self) -> &'static str {
        match self {
            Role::Worker => "inkstone-worker",
            Role::ProviderLogin | Role::ProviderRefresh => "inkstone-provider-helper",
        }
    }

    /// The argv tail to pass the sibling binary. The Worker takes none (its
    /// manifest arrives on stdin); the helper binary takes its mode
    /// (`login` / `refresh`), mirroring `provider.ts <mode>`.
    fn binary_args(self) -> Vec<String> {
        match self {
            Role::Worker => Vec::new(),
            Role::ProviderLogin => vec!["login".to_string()],
            Role::ProviderRefresh => vec!["refresh".to_string()],
        }
    }
}

/// A resolved launch command: the program to exec and its argv tail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedCommand {
    pub program: String,
    pub args: Vec<String>,
}

/// Resolve `role`'s launch command from injected inputs — the hermetic,
/// parallel-safe seam units exercise (no env, no `current_exe`, no real FS).
/// Implements ADR-0041's ordered policy:
///
/// 1. `override_cmd` set → shlex-parse it (step 1). **Wins over everything.**
/// 2. else `exe_dir` given AND a sibling binary exists there (per `exists`) →
///    that binary (step 2): `{exe_dir}/inkstone-worker` with no args for the
///    Worker; `{exe_dir}/inkstone-provider-helper` + `[login]`/`[refresh]` for
///    the helper roles.
/// 3. else → the role's `tsx <script>` default (step 3, unchanged).
pub fn resolve_with(
    role: Role,
    override_cmd: Option<&str>,
    exe_dir: Option<&std::path::Path>,
    exists: &dyn Fn(&std::path::Path) -> bool,
) -> anyhow::Result<ResolvedCommand> {
    // Step 1: an explicit override always wins. Parsed (with the tsx default in
    // step 3) by `shlex_command`.
    if let Some(cmd) = override_cmd {
        return shlex_command(role, cmd);
    }

    // Step 2: a sibling compiled binary next to Core's exe, if present.
    if let Some(dir) = exe_dir {
        let binary = dir.join(role.binary_name());
        if exists(&binary) {
            return Ok(ResolvedCommand {
                program: binary.to_string_lossy().into_owned(),
                args: role.binary_args(),
            });
        }
    }

    // Step 3: the tsx-from-source default (unchanged).
    shlex_command(role, role.tsx_default())
}

/// shlex-parse `cmd` into a [`ResolvedCommand`] (not whitespace-split, so a
/// shell-quoted path containing a space stays one token — ADR-0041 step 1).
/// `None` = an unbalanced quote; an empty/whitespace-only string yields
/// `Some(vec![])` → no program, the "is empty" error path (the old guard).
fn shlex_command(role: Role, cmd: &str) -> anyhow::Result<ResolvedCommand> {
    let mut parts = shlex::split(cmd)
        .ok_or_else(|| anyhow::anyhow!("{} is not a valid command line", role.env_var()))?
        .into_iter();
    let Some(program) = parts.next() else {
        anyhow::bail!("{} is empty", role.env_var());
    };
    let args: Vec<String> = parts.collect();
    Ok(ResolvedCommand { program, args })
}

/// Resolve `role`'s launch command from the real process env and Core's own
/// executable location: reads the role's `INKSTONE_*_CMD` override (if set),
/// computes Core's exe directory (`current_exe().parent()` — non-fatal on
/// failure, so detection simply doesn't fire), uses
/// [`std::path::Path::exists`] as the sibling probe, and delegates to
/// [`resolve_with`]. This wires ADR-0041 step 2 in production; the e2e places
/// the compiled binaries next to Core's exe and boots with no override.
pub fn resolve(role: Role) -> anyhow::Result<ResolvedCommand> {
    let override_cmd = std::env::var(role.env_var()).ok();
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(std::path::Path::to_path_buf));
    resolve_with(
        role,
        override_cmd.as_deref(),
        exe_dir.as_deref(),
        &|p| p.exists(),
    )
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::*;

    /// Always-true existence predicate for the sibling-binary probe.
    fn exists_true(_: &Path) -> bool {
        true
    }

    /// Always-false existence predicate (no sibling binary on disk).
    fn exists_false(_: &Path) -> bool {
        false
    }

    /// Slice-1 seam: no override, no exe dir → the role's tsx default. With
    /// `exe_dir = None`, the existence predicate is never consulted (sibling
    /// detection can't fire).
    fn resolve_no_detection(role: Role, override_cmd: Option<&str>) -> ResolvedCommand {
        resolve_with(role, override_cmd, None, &exists_false).expect("resolves")
    }

    /// (a) With no override each role yields its unchanged `tsx` default argv.
    #[test]
    fn tsx_defaults_per_role() {
        let worker = resolve_no_detection(Role::Worker, None);
        assert_eq!(worker.program, "packages/worker/node_modules/.bin/tsx");
        assert_eq!(worker.args, vec!["packages/worker/src/cli.ts"]);

        let login = resolve_no_detection(Role::ProviderLogin, None);
        assert_eq!(
            login.program,
            "packages/provider-helper/node_modules/.bin/tsx"
        );
        assert_eq!(
            login.args,
            vec!["packages/provider-helper/src/provider.ts", "login"]
        );

        let refresh = resolve_no_detection(Role::ProviderRefresh, None);
        assert_eq!(
            refresh.program,
            "packages/provider-helper/node_modules/.bin/tsx"
        );
        assert_eq!(
            refresh.args,
            vec!["packages/provider-helper/src/provider.ts", "refresh"]
        );
    }

    /// (b) A program path containing a space — shell-quoted, as an operator or a
    /// future packaging layer would write it — stays ONE token via shlex. The old
    /// `split_whitespace` could never honor the quoting; it shattered the path
    /// into `["/Users/a", "b/.bin/tsx", ...]` regardless. Assert the program
    /// keeps its embedded space (proves shlex parsing, not whitespace-split).
    #[test]
    fn override_with_space_in_path_parses_via_shlex() {
        let resolved =
            resolve_no_detection(Role::Worker, Some("\"/Users/a b/.bin/tsx\" script.ts login"));
        assert_eq!(resolved.program, "/Users/a b/.bin/tsx");
        assert!(
            resolved.program.contains(' '),
            "program keeps its embedded space (shlex, not whitespace-split) — got {:?}",
            resolved.program
        );
        assert_eq!(resolved.args, vec!["script.ts", "login"]);
    }

    /// (c) An empty/whitespace-only override is an error per role.
    #[test]
    fn empty_override_is_error_per_role() {
        for role in [Role::Worker, Role::ProviderLogin, Role::ProviderRefresh] {
            assert!(
                resolve_with(role, Some(""), None, &exists_false).is_err(),
                "empty override → error for {role:?}"
            );
            assert!(
                resolve_with(role, Some("   "), None, &exists_false).is_err(),
                "whitespace-only override → error for {role:?}"
            );
        }
    }

    // --- Slice 2: sibling-binary auto-detection (ADR-0041 step 2) ---

    /// (a) Sibling present → the binary wins over the tsx default. Worker takes
    /// NO argv (the manifest arrives on stdin).
    #[test]
    fn sibling_worker_binary_wins_over_tsx() {
        let exe_dir = PathBuf::from("/opt/inkstone/bin");
        let resolved = resolve_with(Role::Worker, None, Some(&exe_dir), &exists_true)
            .expect("sibling worker resolves");
        assert_eq!(resolved.program, "/opt/inkstone/bin/inkstone-worker");
        assert!(
            resolved.args.is_empty(),
            "Worker binary takes no argv (manifest on stdin) — got {:?}",
            resolved.args
        );
    }

    /// (b) Sibling absent → fall back to the tsx default (slice-1 behavior),
    /// even though an exe dir is given.
    #[test]
    fn no_sibling_binary_falls_back_to_tsx() {
        let exe_dir = PathBuf::from("/opt/inkstone/bin");
        let resolved = resolve_with(Role::Worker, None, Some(&exe_dir), &exists_false)
            .expect("tsx fallback resolves");
        assert_eq!(resolved.program, "packages/worker/node_modules/.bin/tsx");
        assert_eq!(resolved.args, vec!["packages/worker/src/cli.ts"]);
    }

    /// (c) An explicit override beats a present sibling binary — ADR-0041's
    /// "override always wins".
    #[test]
    fn override_beats_present_sibling_binary() {
        let exe_dir = PathBuf::from("/opt/inkstone/bin");
        let resolved = resolve_with(
            Role::Worker,
            Some("/custom/tsx custom-cli.ts"),
            Some(&exe_dir),
            &exists_true,
        )
        .expect("override resolves");
        assert_eq!(resolved.program, "/custom/tsx");
        assert_eq!(resolved.args, vec!["custom-cli.ts"]);
    }

    /// (d) Helper roles map to one `inkstone-provider-helper` binary with the
    /// `login` / `refresh` arg (mirrors `provider.ts <mode>`).
    #[test]
    fn helper_roles_map_to_provider_helper_binary() {
        let exe_dir = PathBuf::from("/opt/inkstone/bin");

        let login = resolve_with(Role::ProviderLogin, None, Some(&exe_dir), &exists_true)
            .expect("login sibling resolves");
        assert_eq!(login.program, "/opt/inkstone/bin/inkstone-provider-helper");
        assert_eq!(login.args, vec!["login"]);

        let refresh = resolve_with(Role::ProviderRefresh, None, Some(&exe_dir), &exists_true)
            .expect("refresh sibling resolves");
        assert_eq!(
            refresh.program,
            "/opt/inkstone/bin/inkstone-provider-helper"
        );
        assert_eq!(refresh.args, vec!["refresh"]);
    }

    /// (e) No exe dir (`None`) → tsx fallback. Covers `current_exe()` failure
    /// being non-fatal: detection simply doesn't fire.
    #[test]
    fn no_exe_dir_falls_back_to_tsx() {
        let resolved = resolve_with(Role::Worker, None, None, &exists_true)
            .expect("tsx fallback with no exe dir");
        assert_eq!(resolved.program, "packages/worker/node_modules/.bin/tsx");
        assert_eq!(resolved.args, vec!["packages/worker/src/cli.ts"]);
    }
}
