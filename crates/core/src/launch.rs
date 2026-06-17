//! One role-keyed launch-command resolver (ADR-0041). Core spawns the Worker
//! and the Provider Helper as child processes; each spawn site used to build its
//! command with an inline `env::var(...).unwrap_or_else(<tsx string>)` then a
//! `split_whitespace` — three copies that all mis-parsed a path containing a
//! space. This module collapses them into one resolver.
//!
//! Resolution (slice 1 of ADR-0041): the role's `INKSTONE_*_CMD` override, if
//! set, parsed with [`shlex`] (not whitespace-split, fixing the space-in-path
//! bug) → else the role's `tsx <script>` default, transcribed byte-identically
//! from the old inline strings. An empty/whitespace-only override is an error
//! (matching the old "INKSTONE_*_CMD is empty" guard).
//!
//! ADR-0041 step 2 (a sibling compiled binary next to `current_exe`) is NOT
//! implemented here yet — slice 2 adds it between the override and the tsx
//! fallback. [`resolve_from`] is the hermetic seam units exercise (no env
//! access); [`resolve`] is the thin wrapper that reads the real env.

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
}

/// A resolved launch command: the program to exec and its argv tail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedCommand {
    pub program: String,
    pub args: Vec<String>,
}

/// Resolve `role`'s launch command from an explicit `override_cmd` (no env
/// access — the hermetic seam). `Some(s)` is parsed; `None` is the role's `tsx`
/// default. An empty/whitespace-only override is an error.
pub fn resolve_from(role: Role, override_cmd: Option<&str>) -> anyhow::Result<ResolvedCommand> {
    let cmd = override_cmd.unwrap_or_else(|| role.tsx_default());
    // shlex (not whitespace-split) so a shell-quoted path containing a space
    // stays one token (ADR-0041 step 1). `None` = an unbalanced quote; an
    // empty/whitespace-only string yields `Some(vec![])` → no program, the "is
    // empty" error path (matching the old guard).
    let mut parts = shlex::split(cmd)
        .ok_or_else(|| anyhow::anyhow!("{} is not a valid command line", role.env_var()))?
        .into_iter();
    let Some(program) = parts.next() else {
        anyhow::bail!("{} is empty", role.env_var());
    };
    let args: Vec<String> = parts.collect();
    Ok(ResolvedCommand { program, args })
}

/// Resolve `role`'s launch command from the real process env: reads the role's
/// `INKSTONE_*_CMD` override (if set) and delegates to [`resolve_from`].
pub fn resolve(role: Role) -> anyhow::Result<ResolvedCommand> {
    let override_cmd = std::env::var(role.env_var()).ok();
    resolve_from(role, override_cmd.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// (a) With no override each role yields its unchanged `tsx` default argv.
    #[test]
    fn tsx_defaults_per_role() {
        let worker = resolve_from(Role::Worker, None).expect("worker default");
        assert_eq!(worker.program, "packages/worker/node_modules/.bin/tsx");
        assert_eq!(worker.args, vec!["packages/worker/src/cli.ts"]);

        let login = resolve_from(Role::ProviderLogin, None).expect("login default");
        assert_eq!(
            login.program,
            "packages/provider-helper/node_modules/.bin/tsx"
        );
        assert_eq!(
            login.args,
            vec!["packages/provider-helper/src/provider.ts", "login"]
        );

        let refresh = resolve_from(Role::ProviderRefresh, None).expect("refresh default");
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
            resolve_from(Role::Worker, Some("\"/Users/a b/.bin/tsx\" script.ts login"))
                .expect("spaced override");
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
                resolve_from(role, Some("")).is_err(),
                "empty override → error for {role:?}"
            );
            assert!(
                resolve_from(role, Some("   ")).is_err(),
                "whitespace-only override → error for {role:?}"
            );
        }
    }
}
