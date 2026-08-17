//! The concrete TickTick OpenAPI client (external-task-views A2): two reads
//! (`GET /open/v1/project`, `POST /open/v1/task/filter {"status":[0]}`) against
//! a compile-time-const base URL (test-only override), decoded into the private
//! `wire` transport types and normalized into `TickTickTaskRow`s. No provider
//! interface, no Core task cache — one read per call.

use std::sync::OnceLock;

use crate::protocol::TickTickTasksListResult;

use super::wire::{self, RawProject, RawTask};

/// TickTick's OpenAPI base. The boot-read bearer token is sent here, so the
/// `INKSTONE_TICKTICK_API_URL` override — which points the fake-HTTP-server
/// harness at a local server — is honored ONLY for a loopback host: a
/// stray/hostile env var can never redirect the credential to an arbitrary
/// origin. Non-loopback → log + fall back to the const.
const OPENAPI_BASE: &str = "https://api.ticktick.com";

/// The process-wide HTTP client, built once so its connection pool is reused
/// across calls. The base URL AND the A7 timeout are applied per-request (never
/// baked into the client), so the boot-resolved config knob and the loopback
/// test override both take effect (review R12 #6). `build` fails only on a
/// system-TLS init fault — a boot-level invariant, not a per-call error.
fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::new())
}

fn base_url() -> String {
    super::guarded_override(
        crate::config::get().ticktick_api_url_override.clone(),
        OPENAPI_BASE,
        "ticktick.api_url_override_rejected",
    )
}

/// Fetch + normalize the open-task view for the Web lane (A2). Runs the two
/// reads against `token`, decodes into private transport types, and returns the
/// `{tasks, source_limit_reached}` envelope. Any transport/HTTP/decode failure
/// (including a 401 from an expired credential — A5: no re-read, restart to
/// change) rides `anyhow::Error`; the verb maps it to the read's error state.
pub async fn fetch_tasks(token: &str) -> anyhow::Result<TickTickTasksListResult> {
    let base = base_url();
    let client = http_client();
    // A7's per-request bound, boot-resolved (`INKSTONE_TICKTICK_TIMEOUT_MS`,
    // default 30s — review R12 #6); applied per request so tests can exercise
    // the stalled path with a tiny bound.
    let timeout = crate::config::get().ticktick_timeout;

    // The two reads are independent (list of projects + open-task page), so
    // run them concurrently — one round-trip's latency, not two.
    let projects_req = client
        .get(format!("{base}/open/v1/project"))
        .timeout(timeout)
        .bearer_auth(token)
        .send();
    let tasks_req = client
        .post(format!("{base}/open/v1/task/filter"))
        .timeout(timeout)
        .bearer_auth(token)
        .json(&serde_json::json!({ "status": [0] }))
        .send();
    let (projects_resp, tasks_resp) = tokio::try_join!(projects_req, tasks_req)?;

    let projects: Vec<RawProject> = projects_resp.error_for_status()?.json().await?;
    let raw_tasks: Vec<RawTask> = tasks_resp.error_for_status()?.json().await?;

    let (tasks, source_limit_reached) = wire::normalize(&projects, &raw_tasks);
    Ok(TickTickTasksListResult {
        tasks,
        source_limit_reached,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// LIVE OpenAPI contract smoke (review R10 #3): drives the PRODUCTION decode
    /// path — [`fetch_tasks`] is the real reqwest → `wire.rs` serde decode →
    /// `normalize` pipeline — against the live service, so upstream drift that
    /// would break production decoding fails HERE, not in a hand-mirrored
    /// validator. `#[ignore]`d: the scheduled `ticktick-live-smoke` workflow
    /// opts in with `--ignored`; the PR gate never runs it. NON-CAPTURING:
    /// prints counts only. The smoke account must stage representative rows —
    /// ≥1 all-day, ≥1 timed (with zone), ≥1 tagged, ≥1 checklist, ≥1 repeating
    /// — or the assertions fail: wire.rs defaults absent fields, so an account
    /// without them can't detect an upstream field removal (review R11 #3).
    #[tokio::test]
    #[ignore = "live network + credential; run by .github/workflows/ticktick-live-smoke.yml"]
    async fn live_openapi_contract_smoke() {
        let token = std::env::var("TICKTICK_ACCESS_TOKEN")
            .expect("TICKTICK_ACCESS_TOKEN must be set (full-scope repo secret)");
        let result = fetch_tasks(&token)
            .await
            .expect("both live reads decode through the production wire types");

        let tasks = &result.tasks;
        assert!(
            !tasks.is_empty(),
            "smoke account must keep ≥1 open task so decode drift is detectable"
        );
        let with_due = tasks.iter().filter(|t| t.due.is_some()).count();
        let all_day = tasks
            .iter()
            .filter(|t| t.due.as_ref().is_some_and(|d| d.is_all_day))
            .count();
        let with_tags = tasks.iter().filter(|t| !t.tags.is_empty()).count();
        let with_checklist = tasks
            .iter()
            .filter(|t| !t.checklist_items.is_empty())
            .count();
        let with_repeat = tasks.iter().filter(|t| t.repeat_flag.is_some()).count();
        let list_resolved = tasks.iter().filter(|t| t.list_name.is_some()).count();
        println!(
            "live smoke: tasks={} with_due={all_day}/{with_due} (all_day/total) \
             with_tags={with_tags} with_checklist={with_checklist} \
             with_repeat={with_repeat} list_resolved={list_resolved} \
             at_page_cap={}",
            tasks.len(),
            result.source_limit_reached,
        );
        // Representative-shape counters (review R10 #3 / R11 #3): EVERY optional
        // decode branch must be exercised by live rows — wire.rs defaults absent
        // fields, so an upstream field REMOVAL stays green unless a staged row
        // asserts the branch.
        assert!(with_due >= 1, "stage ≥1 due-bearing task in the smoke account");
        assert!(all_day >= 1, "stage ≥1 ALL-DAY task in the smoke account");
        let timed_with_zone = tasks
            .iter()
            .filter(|t| {
                t.due
                    .as_ref()
                    .is_some_and(|d| !d.is_all_day && !d.time_zone.is_empty())
            })
            .count();
        assert!(
            timed_with_zone >= 1,
            "stage ≥1 TIMED task; its due tuple must carry a non-empty time_zone \
             (upstream dropping timeZone would default to \"\" and stay green otherwise)"
        );
        assert!(with_tags >= 1, "stage ≥1 tagged task in the smoke account");
        assert!(
            with_checklist >= 1,
            "stage ≥1 checklist task in the smoke account"
        );
        assert!(
            with_repeat >= 1,
            "stage ≥1 repeating task in the smoke account"
        );
        assert!(
            list_resolved >= 1,
            "≥1 task resolves a /project list name (projects read + join)"
        );
    }

    #[test]
    fn base_url_override_is_loopback_only() {
        // A loopback override (the fake HTTP server) is honored; a non-loopback
        // one falls back to the const, so the bearer token never leaves for it.
        for (url, expected) in [
            ("http://127.0.0.1:8123", "http://127.0.0.1:8123"),
            ("http://localhost:9", "http://localhost:9"),
            ("https://evil.example.com", OPENAPI_BASE),
            ("http://169.254.169.254", OPENAPI_BASE),
        ] {
            let _guard = crate::config::test_override::install(crate::config::Config {
                ticktick_api_url_override: Some(url.to_string()),
                ..Default::default()
            });
            assert_eq!(base_url(), expected, "override {url}");
        }
    }
}
