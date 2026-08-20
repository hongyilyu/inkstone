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

/// The one write body Core ever sends (ticktick-writes W-A6): title, optional
/// note (`content` — W1: `desc` is the checklist-description field and does
/// not surface as the note), and the optional due tuple passed through
/// verbatim (W1: `dueDate` accepts offset-bearing datetimes and normalizes
/// them; `timeZone` is display-only). No `projectId` — every create lands in
/// Inbox (the v1 payload cut). Typed, so no generic request builder exists.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateTaskBody {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_all_day: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_zone: Option<String>,
}

/// The classified outcome of one write call (ticktick-writes W-A3): the
/// three-valued verdict plus the provenance columns the `ticktick_writes` row
/// records. `Failed` means "TickTick deterministically did not create this";
/// everything ambiguous is `Unknown` — a `failed` that was actually created
/// invites a duplicate re-propose, so ambiguity NEVER classifies `Failed`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum WriteOutcome {
    Created { task_id: String },
    Failed { http_status: Option<i64> },
    Unknown { http_status: Option<i64> },
}

/// What phase B observed on the wire, normalized for classification: either an
/// HTTP response (status + raw body) or a transport failure reduced to the one
/// predicate that matters (`pre_send_connect` — reqwest `is_connect`, nothing
/// was sent). A pure data shape so the classifier's full table — including the
/// default arm — is unit-testable without HTTP.
#[derive(Debug)]
pub(crate) enum WireObservation {
    Response { status: u16, body: String },
    Transport { pre_send_connect: bool },
}

/// The EXHAUSTIVE outcome classifier (W-A3; table confirmed by W1). A match
/// over (status, transport predicate) whose DEFAULT arm is `Unknown` — a novel
/// status class or transport failure can never classify `Failed`:
///
/// - 2xx with a decoded NON-EMPTY task id → `Created` (W1: the create response
///   is the created task; an undecodable 2xx exists in the wild, so the id
///   requirement is load-bearing).
/// - 2xx otherwise (undecodable / id-less / decodable error envelope) →
///   `Unknown` — creation cannot be confirmed.
/// - Deterministic 4xx (all but 408) → `Failed` (W1: 401 confirmed; TickTick
///   wears validation rejections as 500, so this arm is mostly auth/protocol).
/// - 408, any 5xx (a gateway error can follow an upstream commit — and W1
///   shows TickTick 500s deterministic rejections too, indistinguishable),
///   and anything else (1xx/3xx/novel) → `Unknown`.
/// - Transport: pre-send connect failure → `Failed` (nothing was sent);
///   timeouts, mid-flight resets, response-read failures, and every other
///   transport error → `Unknown`.
pub(crate) fn classify(observation: &WireObservation) -> WriteOutcome {
    match observation {
        WireObservation::Response { status, body } => {
            let http_status = Some(i64::from(*status));
            match status {
                200..=299 => match decoded_task_id(body) {
                    Some(task_id) => WriteOutcome::Created { task_id },
                    None => WriteOutcome::Unknown { http_status },
                },
                408 => WriteOutcome::Unknown { http_status },
                400..=499 => WriteOutcome::Failed { http_status },
                // The default arm: 1xx, 3xx, 5xx, and anything novel.
                _ => WriteOutcome::Unknown { http_status },
            }
        }
        WireObservation::Transport { pre_send_connect } => {
            if *pre_send_connect {
                WriteOutcome::Failed { http_status: None }
            } else {
                WriteOutcome::Unknown { http_status: None }
            }
        }
    }
}

/// The created task's non-empty `id` from a 2xx body, or `None` when the body
/// is undecodable, id-less, or the id is empty/not a string.
fn decoded_task_id(body: &str) -> Option<String> {
    let decoded: serde_json::Value = serde_json::from_str(body).ok()?;
    let id = decoded.get("id")?.as_str()?;
    if id.is_empty() {
        return None;
    }
    Some(id.to_string())
}

/// Execute exactly one `POST /open/v1/task` (ticktick-writes phase B) and
/// classify the observation. Runs under the A7 per-request timeout and the
/// loopback-guarded base override, like the reads. NEVER retries — the caller
/// (the write state machine) owns once-only semantics; ambiguity classifies
/// `Unknown`, not a re-send.
pub(crate) async fn create_task(token: &str, body: &CreateTaskBody) -> WriteOutcome {
    let base = base_url();
    let client = http_client();
    let timeout = crate::config::get().ticktick_timeout;

    let observation = match client
        .post(format!("{base}/open/v1/task"))
        .timeout(timeout)
        .bearer_auth(token)
        .json(body)
        .send()
        .await
    {
        Ok(response) => {
            let status = response.status().as_u16();
            match response.text().await {
                Ok(body) => WireObservation::Response { status, body },
                // The response ARRIVED but its body could not be read — the
                // request may have committed upstream: not pre-send.
                Err(_) => WireObservation::Transport {
                    pre_send_connect: false,
                },
            }
        }
        Err(error) => WireObservation::Transport {
            pre_send_connect: error.is_connect(),
        },
    };
    classify(&observation)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The full classification table (W-A3, confirmed by W1), INCLUDING the
    /// default arm: a novel status class or transport error classifies
    /// `Unknown`, never `Failed`; `Created` requires a decoded non-empty id.
    #[test]
    fn classifier_covers_the_full_table_with_default_unknown() {
        let response = |status: u16, body: &str| WireObservation::Response {
            status,
            body: body.to_string(),
        };
        let cases: Vec<(WireObservation, WriteOutcome)> = vec![
            // 2xx + decoded non-empty id → Created (200 and 201 alike).
            (
                response(200, r#"{"id":"tt-1","projectId":"inbox123"}"#),
                WriteOutcome::Created {
                    task_id: "tt-1".to_string(),
                },
            ),
            (
                response(201, r#"{"id":"tt-2"}"#),
                WriteOutcome::Created {
                    task_id: "tt-2".to_string(),
                },
            ),
            // 2xx undecodable (observed in the wild by W1) → Unknown.
            (
                response(200, "<html>gateway</html>"),
                WriteOutcome::Unknown {
                    http_status: Some(200),
                },
            ),
            // 2xx decodable but id-less / empty-id / non-string id — including
            // a DECODABLE error envelope — → Unknown, never Created.
            (
                response(200, r#"{"projectId":"inbox123"}"#),
                WriteOutcome::Unknown {
                    http_status: Some(200),
                },
            ),
            (
                response(200, r#"{"id":""}"#),
                WriteOutcome::Unknown {
                    http_status: Some(200),
                },
            ),
            (
                response(200, r#"{"id":42}"#),
                WriteOutcome::Unknown {
                    http_status: Some(200),
                },
            ),
            (
                response(200, r#"{"errorCode":"x","errorMessage":"boom"}"#),
                WriteOutcome::Unknown {
                    http_status: Some(200),
                },
            ),
            // Deterministic 4xx family → Failed (the W1-probed statuses).
            (
                response(400, r#"{"errorCode":"bad"}"#),
                WriteOutcome::Failed {
                    http_status: Some(400),
                },
            ),
            (
                response(401, r#"{"error":"invalid_token"}"#),
                WriteOutcome::Failed {
                    http_status: Some(401),
                },
            ),
            (
                response(403, ""),
                WriteOutcome::Failed {
                    http_status: Some(403),
                },
            ),
            (
                response(404, ""),
                WriteOutcome::Failed {
                    http_status: Some(404),
                },
            ),
            (
                response(413, ""),
                WriteOutcome::Failed {
                    http_status: Some(413),
                },
            ),
            (
                response(422, ""),
                WriteOutcome::Failed {
                    http_status: Some(422),
                },
            ),
            (
                response(429, ""),
                WriteOutcome::Failed {
                    http_status: Some(429),
                },
            ),
            // 408 is the 4xx exception → Unknown.
            (
                response(408, ""),
                WriteOutcome::Unknown {
                    http_status: Some(408),
                },
            ),
            // Any 5xx → Unknown (W1: TickTick 500s deterministic validation
            // rejections too — indistinguishable from a gateway fault).
            (
                response(500, r#"{"errorCode":"title_empty"}"#),
                WriteOutcome::Unknown {
                    http_status: Some(500),
                },
            ),
            (
                response(502, ""),
                WriteOutcome::Unknown {
                    http_status: Some(502),
                },
            ),
            (
                response(503, ""),
                WriteOutcome::Unknown {
                    http_status: Some(503),
                },
            ),
            // The default arm: novel status classes → Unknown.
            (
                response(100, ""),
                WriteOutcome::Unknown {
                    http_status: Some(100),
                },
            ),
            (
                response(302, ""),
                WriteOutcome::Unknown {
                    http_status: Some(302),
                },
            ),
            (
                response(599, ""),
                WriteOutcome::Unknown {
                    http_status: Some(599),
                },
            ),
            // Transport: pre-send connect failure → Failed (nothing sent);
            // everything else (timeout, mid-flight reset, body-read failure —
            // the novel-transport default) → Unknown.
            (
                WireObservation::Transport {
                    pre_send_connect: true,
                },
                WriteOutcome::Failed { http_status: None },
            ),
            (
                WireObservation::Transport {
                    pre_send_connect: false,
                },
                WriteOutcome::Unknown { http_status: None },
            ),
        ];
        for (observation, expected) in cases {
            assert_eq!(
                classify(&observation),
                expected,
                "classification of {observation:?}"
            );
        }
    }

    /// The write body serializes to TickTick's exact camelCase keys, omitting
    /// absent optionals (the minimal Inbox capture is `{"title": …}` alone).
    #[test]
    fn create_task_body_serializes_camel_case_and_omits_absent() {
        let minimal = CreateTaskBody {
            title: "buy milk".to_string(),
            content: None,
            due_date: None,
            is_all_day: None,
            time_zone: None,
        };
        assert_eq!(
            serde_json::to_value(&minimal).unwrap(),
            serde_json::json!({ "title": "buy milk" })
        );
        let full = CreateTaskBody {
            title: "buy milk".to_string(),
            content: Some("2%".to_string()),
            due_date: Some("2026-09-01T17:30:00-0700".to_string()),
            is_all_day: Some(false),
            time_zone: Some("America/Los_Angeles".to_string()),
        };
        assert_eq!(
            serde_json::to_value(&full).unwrap(),
            serde_json::json!({
                "title": "buy milk",
                "content": "2%",
                "dueDate": "2026-09-01T17:30:00-0700",
                "isAllDay": false,
                "timeZone": "America/Los_Angeles"
            })
        );
    }

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
