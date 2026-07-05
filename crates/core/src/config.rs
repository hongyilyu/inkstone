//! Boot-resolved configuration. All `INKSTONE_*` env knobs for directories,
//! paths, and timeouts are read ONCE in `main()`'s fail-fast boot sequence,
//! parsed into this struct, and read by modules through the process-global
//! [`get`] accessor. Tests construct the struct directly — no env mutation, no
//! guard mutex.

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

/// The default one-shot collector timeout (titler + probe): 15 seconds.
const DEFAULT_TIMEOUT_MS: u64 = 15_000;

/// Boot-resolved configuration. Each field corresponds to one `INKSTONE_*` env
/// var; `None` means "unset, use the runtime default" (e.g. derive from the OS
/// data dir).
#[derive(Debug)]
pub struct Config {
    pub db_path_override: Option<PathBuf>,
    pub credentials_dir_override: Option<PathBuf>,
    /// An empty override is treated as unset (see `skills_dir` doc comment).
    pub skills_dir_override: Option<PathBuf>,
    /// An empty override is treated as unset (see `media_root` doc comment).
    pub media_dir_override: Option<PathBuf>,
    pub workflows_dir_override: Option<PathBuf>,
    pub log_dir_override: Option<PathBuf>,
    pub title_timeout: Duration,
    pub provider_test_timeout: Duration,
    pub worker_pre_spawn_delay: Option<Duration>,
    pub worker_log_path: Option<PathBuf>,
}

impl Default for Config {
    /// The all-unset shape — what `from_env` resolves when no `INKSTONE_*` var
    /// is set. Tests build overrides with `Config { x: Some(..), ..Default::default() }`.
    fn default() -> Self {
        Self::from_lookup(|_| None)
    }
}

impl Config {
    /// Read all `INKSTONE_*` knobs from the process environment. Called once in
    /// `main()` during the fail-fast boot sequence.
    pub fn from_env() -> Self {
        Self::from_lookup(|k| std::env::var_os(k))
    }

    /// Construct from an injected lookup — hermetic and parallel-safe for tests.
    /// Mirrors `launch::resolve_with`'s injected-predicate pattern.
    pub fn from_lookup(get: impl Fn(&str) -> Option<OsString>) -> Self {
        Self {
            db_path_override: get("INKSTONE_DB_PATH").map(PathBuf::from),
            credentials_dir_override: get("INKSTONE_CREDENTIALS_DIR").map(PathBuf::from),
            skills_dir_override: get("INKSTONE_SKILLS_DIR")
                .filter(|d| !d.is_empty())
                .map(PathBuf::from),
            media_dir_override: get("INKSTONE_MEDIA_DIR")
                .filter(|d| !d.is_empty())
                .map(PathBuf::from),
            workflows_dir_override: get("INKSTONE_WORKFLOWS_DIR").map(PathBuf::from),
            log_dir_override: get("INKSTONE_LOG_DIR").map(PathBuf::from),
            title_timeout: parse_timeout_ms(&get("INKSTONE_TITLE_TIMEOUT_MS")),
            provider_test_timeout: parse_timeout_ms(&get("INKSTONE_PROVIDER_TEST_TIMEOUT_MS")),
            worker_pre_spawn_delay: get("INKSTONE_WORKER_PRE_SPAWN_DELAY_MS")
                .and_then(|v| v.to_str().and_then(|s| s.parse::<u64>().ok()))
                .filter(|ms| *ms > 0)
                .map(Duration::from_millis),
            worker_log_path: get("INKSTONE_WORKER_LOG_PATH").map(PathBuf::from),
        }
    }
}

/// Parse a timeout env var: unset, unparseable, or `0` falls back to 15s.
/// `0` is rejected because a zero-length timeout fires instantly, turning every
/// one-shot into a silent no-op.
fn parse_timeout_ms(raw: &Option<OsString>) -> Duration {
    let ms = raw
        .as_ref()
        .and_then(|v| v.to_str())
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|ms| *ms > 0)
        .unwrap_or(DEFAULT_TIMEOUT_MS);
    Duration::from_millis(ms)
}

// ─── Process-global accessor (set once at boot) ─────────────────────────────

static CONFIG: OnceLock<Config> = OnceLock::new();

/// Initialize the process-global config. Called once in `main()`.
pub fn init(config: Config) {
    let _ = CONFIG.set(config);
}

/// The boot-resolved config. In production, panics if [`init`] has not run —
/// callers execute only after a successful boot. In unit tests (which never run
/// `main()`), resolves the thread's [`test_override`] if one is installed, else
/// the all-unset [`Config::default`] — the same shape a boot with no
/// `INKSTONE_*` vars would produce.
pub fn get() -> &'static Config {
    #[cfg(test)]
    {
        if let Some(cfg) = test_override::current() {
            return cfg;
        }
        CONFIG.get_or_init(Config::default)
    }
    #[cfg(not(test))]
    {
        CONFIG
            .get()
            .expect("config::init() must run at boot before any module reads config")
    }
}

/// Per-thread test override (the replacement for the five env-guard mutexes).
/// libtest runs each test on its own thread and every `#[tokio::test]` here is
/// current-thread, so a thread-local override is visible to the whole test —
/// including deep call stacks (`insert_media` → `media_root`) — while tests on
/// other threads keep their own value. No serialization needed.
#[cfg(test)]
pub(crate) mod test_override {
    use super::Config;
    use std::cell::Cell;

    thread_local! {
        static OVERRIDE: Cell<Option<&'static Config>> = const { Cell::new(None) };
    }

    /// RAII handle from [`install`]: restores the previous override on drop
    /// (panic-safe — an assert failure mid-test cannot leak the override).
    #[must_use = "the override is removed when the guard drops"]
    pub(crate) struct ConfigGuard {
        prev: Option<&'static Config>,
    }

    /// Install `config` as this thread's Config for the guard's lifetime. The
    /// config is leaked (a few hundred bytes per test) to satisfy the
    /// `&'static` contract of [`super::get`].
    pub(crate) fn install(config: Config) -> ConfigGuard {
        let leaked: &'static Config = Box::leak(Box::new(config));
        let prev = OVERRIDE.with(|o| o.replace(Some(leaked)));
        ConfigGuard { prev }
    }

    impl Drop for ConfigGuard {
        fn drop(&mut self) {
            let prev = self.prev;
            OVERRIDE.with(|o| o.set(prev));
        }
    }

    pub(super) fn current() -> Option<&'static Config> {
        OVERRIDE.with(|o| o.get())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn lookup<'a>(map: &'a HashMap<&'a str, &'a str>) -> impl Fn(&str) -> Option<OsString> + 'a {
        move |key| map.get(key).map(|v| OsString::from(v))
    }

    #[test]
    fn from_lookup_parses_all_fields_with_overrides() {
        let mut env = HashMap::new();
        env.insert("INKSTONE_DB_PATH", "/tmp/db.sqlite");
        env.insert("INKSTONE_CREDENTIALS_DIR", "/tmp/creds");
        env.insert("INKSTONE_SKILLS_DIR", "/tmp/skills");
        env.insert("INKSTONE_MEDIA_DIR", "/tmp/media");
        env.insert("INKSTONE_WORKFLOWS_DIR", "/tmp/workflows");
        env.insert("INKSTONE_LOG_DIR", "/tmp/logs");
        env.insert("INKSTONE_TITLE_TIMEOUT_MS", "5000");
        env.insert("INKSTONE_PROVIDER_TEST_TIMEOUT_MS", "3000");
        env.insert("INKSTONE_WORKER_PRE_SPAWN_DELAY_MS", "100");
        env.insert("INKSTONE_WORKER_LOG_PATH", "/tmp/worker.jsonl");

        let cfg = Config::from_lookup(lookup(&env));

        assert_eq!(cfg.db_path_override, Some(PathBuf::from("/tmp/db.sqlite")));
        assert_eq!(
            cfg.credentials_dir_override,
            Some(PathBuf::from("/tmp/creds"))
        );
        assert_eq!(cfg.skills_dir_override, Some(PathBuf::from("/tmp/skills")));
        assert_eq!(cfg.media_dir_override, Some(PathBuf::from("/tmp/media")));
        assert_eq!(
            cfg.workflows_dir_override,
            Some(PathBuf::from("/tmp/workflows"))
        );
        assert_eq!(cfg.log_dir_override, Some(PathBuf::from("/tmp/logs")));
        assert_eq!(cfg.title_timeout, Duration::from_millis(5000));
        assert_eq!(cfg.provider_test_timeout, Duration::from_millis(3000));
        assert_eq!(cfg.worker_pre_spawn_delay, Some(Duration::from_millis(100)));
        assert_eq!(
            cfg.worker_log_path,
            Some(PathBuf::from("/tmp/worker.jsonl"))
        );
    }

    #[test]
    fn from_lookup_defaults_on_empty_env() {
        let env: HashMap<&str, &str> = HashMap::new();
        let cfg = Config::from_lookup(lookup(&env));

        assert_eq!(cfg.db_path_override, None);
        assert_eq!(cfg.credentials_dir_override, None);
        assert_eq!(cfg.skills_dir_override, None);
        assert_eq!(cfg.media_dir_override, None);
        assert_eq!(cfg.workflows_dir_override, None);
        assert_eq!(cfg.log_dir_override, None);
        assert_eq!(cfg.title_timeout, Duration::from_millis(15_000));
        assert_eq!(cfg.provider_test_timeout, Duration::from_millis(15_000));
        assert_eq!(cfg.worker_pre_spawn_delay, None);
        assert_eq!(cfg.worker_log_path, None);
    }

    #[test]
    fn empty_string_skills_and_media_treated_as_unset() {
        let mut env = HashMap::new();
        env.insert("INKSTONE_SKILLS_DIR", "");
        env.insert("INKSTONE_MEDIA_DIR", "");

        let cfg = Config::from_lookup(lookup(&env));

        assert_eq!(cfg.skills_dir_override, None, "empty skills dir is unset");
        assert_eq!(cfg.media_dir_override, None, "empty media dir is unset");
    }

    #[test]
    fn timeout_zero_rejected_falls_back_to_default() {
        let mut env = HashMap::new();
        env.insert("INKSTONE_TITLE_TIMEOUT_MS", "0");
        env.insert("INKSTONE_PROVIDER_TEST_TIMEOUT_MS", "0");

        let cfg = Config::from_lookup(lookup(&env));

        assert_eq!(cfg.title_timeout, Duration::from_millis(15_000));
        assert_eq!(cfg.provider_test_timeout, Duration::from_millis(15_000));
    }

    #[test]
    fn timeout_unparseable_falls_back_to_default() {
        let mut env = HashMap::new();
        env.insert("INKSTONE_TITLE_TIMEOUT_MS", "not-a-number");
        env.insert("INKSTONE_PROVIDER_TEST_TIMEOUT_MS", "abc");

        let cfg = Config::from_lookup(lookup(&env));

        assert_eq!(cfg.title_timeout, Duration::from_millis(15_000));
        assert_eq!(cfg.provider_test_timeout, Duration::from_millis(15_000));
    }

    #[test]
    fn worker_pre_spawn_delay_zero_treated_as_none() {
        let mut env = HashMap::new();
        env.insert("INKSTONE_WORKER_PRE_SPAWN_DELAY_MS", "0");

        let cfg = Config::from_lookup(lookup(&env));

        assert_eq!(cfg.worker_pre_spawn_delay, None);
    }
}
